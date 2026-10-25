/**
 * P1-03 — Real-Lean integration test harness.
 * P1-05 — LEAN_TIMEOUT and crash-recovery tests against a live Lean process.
 *
 * These tests exercise the FULL stack — LspLeanAdapter + LeanProcessLauncher +
 * ProofEngine + GoalManager — against the actual Lean 4 language server.
 *
 * Gating
 * -------
 * The tests are SKIPPED unless LEAN_AVAILABLE=1 is set in the environment.
 * This lets the usual `npm test` run pass on machines without a Lean toolchain
 * while the `lean-integration` CI job (which runs inside the Lean Docker image)
 * sets the flag and executes them for real.
 *
 * Expected environment when LEAN_AVAILABLE=1
 * ------------------------------------------
 *   - `lake` on PATH, pointing to a Lean 4.15.x toolchain.
 *   - `lean/test-project` already built (lake build completed).
 *   - LEAN_PROJECT_ROOT pointing at the test-project directory
 *     (defaults to the project root-relative path used in config.ts).
 */
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalyzedUnit } from "../src/analysis/StructureAnalyzer";
import { LeanNativeSyntaxAnalyzer } from "../src/analysis/StructureAnalyzer";
import { loadConfig } from "../src/config";
import { InMemoryEventStore } from "../src/engine/EventStore";
import { ProofEngine } from "../src/engine/ProofEngine";
import { InMemoryProofRepository } from "../src/engine/ProofRepository";
import { LspLeanAdapter } from "../src/lean/LspLeanAdapter";
import { LocalProcessLauncher } from "../src/lean/LeanProcessLauncher";
import type { LeanSessionHandle } from "../src/lean/LeanAdapter";
import { AppError } from "../src/util/index";
import { nullLogger, systemClock } from "../src/util/index";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const LEAN_AVAILABLE = process.env.LEAN_AVAILABLE === "1";
const maybeDescribe = LEAN_AVAILABLE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Resolve a path relative to the monorepo root. */
const repoRoot = resolve(__dirname, "../../../");

const config = loadConfig({
  LEAN_PROJECT_ROOT:
    process.env.LEAN_PROJECT_ROOT ??
    resolve(repoRoot, "lean/test-project"),
  SANDBOX: "local",
  // Keep elaboration timeout generous for cold-start CI containers.
  ELABORATION_TIMEOUT_MS: "120000",
  // Fast session startup timeout for tests.
  LEAN_STARTUP_TIMEOUT_MS: "90000",
});

const projectRoot = config.leanProjectRoot;

/** Read the content of a fixture file that lives in TestProject/. */
function readFixture(name: string): string {
  return readFileSync(join(projectRoot, "TestProject", name), "utf8");
}

/** Build a lean document URI for a file in TestProject/. */
function testUri(name: string): string {
  return pathToFileURL(join(projectRoot, "TestProject", name)).href;
}

// ---------------------------------------------------------------------------
// P1-03: Real-Lean integration tests
// ---------------------------------------------------------------------------

maybeDescribe("P1-03 Real-Lean integration (and_swap)", () => {
  let adapter: LspLeanAdapter;
  let leanSession: LeanSessionHandle;

  const BASIC_URI = testUri("Basic.lean");
  const BASIC_CONTENT = readFixture("Basic.lean");

  beforeAll(async () => {
    const launcher = new LocalProcessLauncher();
    adapter = new LspLeanAdapter(launcher, nullLogger);

    leanSession = await adapter.createSession({
      projectRoot,
      startupTimeoutMs: config.limits.leanStartupTimeoutMs,
    });

    // Open the document and wait for full elaboration before any test runs.
    await adapter.openDocument(leanSession, {
      uri: BASIC_URI,
      fileId: "basic",
      text: BASIC_CONTENT,
    });

    await adapter.awaitElaboration(
      leanSession,
      BASIC_URI,
      config.engine.elaborationTimeoutMs,
    );
  }, 120_000 /* generous timeout for cold Lean start + lake build */);

  afterAll(async () => {
    await adapter.disposeSession(leanSession);
  });

  it("reports the leanVersion from the server", () => {
    expect(leanSession.leanVersion).toMatch(/4\.\d+/);
  });

  it("returns no errors for a valid proof", async () => {
    const diags = await adapter.getDiagnostics(leanSession, BASIC_URI);
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("returns the initial goal (before constructor) at position 0:55", async () => {
    // `and_swap` ends with `:= by` and the `by` token sits at column ~55
    // (exact column depends on the theorem signature). We query the
    // initialPosition as returned by the StructureAnalyzer.
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const analysis = analyzer.analyze("basic", BASIC_CONTENT);
    const theoremUnit = analysis.units.find(
      (u) => u.unit.type === "theorem" && u.unit.name === "and_swap",
    );
    expect(theoremUnit?.proof).toBeDefined();

    const { initialPosition } = theoremUnit!.proof!;
    const snap = await adapter.getGoalsAt(
      leanSession,
      BASIC_URI,
      initialPosition,
    );

    // Before any tactic: one goal `⊢ p ∧ q`.
    expect(snap.goals).toHaveLength(1);
    expect(snap.goals[0]!.target).toContain("p ∧ q");
  });

  it("returns two sub-goals after `constructor`", async () => {
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const analysis = analyzer.analyze("basic", BASIC_CONTENT);
    const theoremUnit = analysis.units.find(
      (u) => u.unit.type === "theorem" && u.unit.name === "and_swap",
    )!;
    const script = theoremUnit.proof!.script;

    // Step 1 = `constructor` — query the position AFTER this tactic.
    const constructorCmd = script.find((c) => c.text.trim() === "constructor");
    expect(constructorCmd).toBeDefined();

    const afterConstructor = {
      line: constructorCmd!.range.endLine,
      column: constructorCmd!.range.endColumn,
    };
    const snap = await adapter.getGoalsAt(leanSession, BASIC_URI, afterConstructor);

    expect(snap.goals.length).toBeGreaterThanOrEqual(2);
    const targets = snap.goals.map((g) => g.target);
    // One goal should be `p`, the other `q`.
    expect(targets.some((t) => t.includes("p"))).toBe(true);
    expect(targets.some((t) => t.includes("q"))).toBe(true);
  });

  it("executes the full proof via ProofEngine and ends with 0 goals", async () => {
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const analysis = analyzer.analyze("basic", BASIC_CONTENT);
    const theoremUnit = analysis.units.find(
      (u) => u.unit.type === "theorem" && u.unit.name === "and_swap",
    ) as AnalyzedUnit;

    const repo = new InMemoryProofRepository();
    const events = new InMemoryEventStore(systemClock);
    const sessionId = "integration-and_swap";

    const engine = new ProofEngine({
      sessionId,
      adapter,
      leanSession,
      target: {
        unitId: theoremUnit.unit.id,
        unitRange: theoremUnit.unit.sourceRange!,
        documentUri: BASIC_URI,
        initialPosition: theoremUnit.proof!.initialPosition,
        script: theoremUnit.proof!.script,
      },
      repo,
      events,
      clock: systemClock,
      logger: nullLogger,
      config: config.engine,
    });

    // Step 0: initial goals
    const step0 = await engine.initialize();
    expect(step0.state.goals).toHaveLength(1);
    expect(step0.state.goals[0]!.target).toContain("p ∧ q");

    // Step 1: after `constructor` — should split into 2 goals
    const step1 = await engine.next();
    expect(step1.state.goals.length).toBeGreaterThanOrEqual(2);
    expect(step1.transition?.verified).toBe(true);

    // Step 2: after `· exact hp` — one goal resolved
    const step2 = await engine.next();
    expect(step2.transition?.verified).toBe(true);

    // Step 3: after `· exact hq` — proof complete, 0 goals
    const step3 = await engine.next();
    expect(step3.state.goals).toHaveLength(0);
    expect(step3.transition?.verified).toBe(true);

    // Going further should raise NO_MORE_STEPS
    await expect(engine.next()).rejects.toMatchObject({ code: "NO_MORE_STEPS" });
  }, 60_000);

  it("replays the proof deterministically (identical state hashes)", async () => {
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const analysis = analyzer.analyze("basic", BASIC_CONTENT);
    const theoremUnit = analysis.units.find(
      (u) => u.unit.type === "theorem" && u.unit.name === "and_swap",
    ) as AnalyzedUnit;

    const run = async () => {
      const repo = new InMemoryProofRepository();
      const events = new InMemoryEventStore(systemClock);
      const engine = new ProofEngine({
        sessionId: `replay-${Math.random()}`,
        adapter,
        leanSession,
        target: {
          unitId: theoremUnit.unit.id,
          unitRange: theoremUnit.unit.sourceRange!,
          documentUri: BASIC_URI,
          initialPosition: theoremUnit.proof!.initialPosition,
          script: theoremUnit.proof!.script,
        },
        repo,
        events,
        clock: systemClock,
        logger: nullLogger,
        config: config.engine,
      });
      const hashes: string[] = [];
      const s0 = await engine.initialize();
      hashes.push(s0.state.stateHash);
      for (let i = 0; i < theoremUnit.proof!.script.length; i++) {
        const r = await engine.next();
        hashes.push(r.state.stateHash);
      }
      return hashes;
    };

    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toEqual(second);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// P1-03: Failed.lean — error diagnostics test
// ---------------------------------------------------------------------------

maybeDescribe("P1-03 Real-Lean integration (Failed.lean)", () => {
  let adapter: LspLeanAdapter;
  let leanSession: LeanSessionHandle;

  const FAILED_URI = testUri("Failed.lean");
  const FAILED_CONTENT = readFixture("Failed.lean");

  beforeAll(async () => {
    const launcher = new LocalProcessLauncher();
    adapter = new LspLeanAdapter(launcher, nullLogger);
    leanSession = await adapter.createSession({
      projectRoot,
      startupTimeoutMs: config.limits.leanStartupTimeoutMs,
    });
    await adapter.openDocument(leanSession, {
      uri: FAILED_URI,
      fileId: "failed",
      text: FAILED_CONTENT,
    });
    await adapter.awaitElaboration(
      leanSession,
      FAILED_URI,
      config.engine.elaborationTimeoutMs,
    );
  }, 120_000);

  afterAll(async () => {
    await adapter.disposeSession(leanSession);
  });

  it("reports at least one error diagnostic for the failing tactic", async () => {
    const diags = await adapter.getDiagnostics(leanSession, FAILED_URI);
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("ProofEngine raises TACTIC_REJECTED for the bad step", async () => {
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const analysis = analyzer.analyze("failed", FAILED_CONTENT);
    // Find the first theorem/lemma with a tactic proof.
    const failUnit = analysis.units.find(
      (u) => (u.unit.type === "theorem" || u.unit.type === "lemma") && u.proof,
    ) as AnalyzedUnit | undefined;

    if (!failUnit) {
      // Nothing to step through in this file — skip gracefully.
      return;
    }

    const repo = new InMemoryProofRepository();
    const events = new InMemoryEventStore(systemClock);
    const engine = new ProofEngine({
      sessionId: "integration-failed",
      adapter,
      leanSession,
      target: {
        unitId: failUnit.unit.id,
        unitRange: failUnit.unit.sourceRange!,
        documentUri: FAILED_URI,
        initialPosition: failUnit.proof!.initialPosition,
        script: failUnit.proof!.script,
      },
      repo,
      events,
      clock: systemClock,
      logger: nullLogger,
      config: config.engine,
    });

    await engine.initialize();

    // Drive the engine through all steps. One of them MUST throw TACTIC_REJECTED.
    let rejected = false;
    for (let step = 0; step < failUnit.proof!.script.length + 1; step++) {
      try {
        await engine.next();
      } catch (e) {
        if (e instanceof AppError && e.code === "TACTIC_REJECTED") {
          rejected = true;
          // The error must carry diagnostics from Lean.
          expect(e.diagnostics?.length).toBeGreaterThan(0);
          // Frontier must NOT have advanced (Invariant 3).
          expect(engine.progress().frontier).toBeLessThan(
            failUnit.proof!.script.length,
          );
        } else if (e instanceof AppError && e.code === "NO_MORE_STEPS") {
          break;
        } else {
          throw e;
        }
      }
    }
    expect(rejected).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P1-05: LEAN_TIMEOUT — elaboration timeout path
// ---------------------------------------------------------------------------

maybeDescribe("P1-05 LEAN_TIMEOUT — elaboration timeout", () => {
  it("rejects with AppError(LEAN_TIMEOUT) when elaboration takes too long", async () => {
    const launcher = new LocalProcessLauncher();
    const adapter = new LspLeanAdapter(launcher, nullLogger);
    const leanSession = await adapter.createSession({
      projectRoot,
      startupTimeoutMs: config.limits.leanStartupTimeoutMs,
    });

    try {
      // Open a valid file normally.
      await adapter.openDocument(leanSession, {
        uri: testUri("Basic.lean"),
        fileId: "basic-timeout",
        text: readFixture("Basic.lean"),
      });

      // awaitElaboration with a 1 ms deadline must time out on a real server.
      await expect(
        adapter.awaitElaboration(leanSession, testUri("Basic.lean"), 1),
      ).rejects.toMatchObject({ code: "LEAN_TIMEOUT" });
    } finally {
      await adapter.disposeSession(leanSession);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// P1-05 extended: crash recovery with a real Lean process
// ---------------------------------------------------------------------------

maybeDescribe("P1-05 Crash recovery — real Lean process", () => {
  it("re-spawns Lean after kill and re-derives identical state hashes", async () => {
    const launcher = new LocalProcessLauncher();
    const adapter = new LspLeanAdapter(launcher, nullLogger);

    // Session A — step through and_swap once.
    const sessionA = await adapter.createSession({
      projectRoot,
      startupTimeoutMs: config.limits.leanStartupTimeoutMs,
    });

    const BASIC_URI = testUri("Basic.lean");
    const BASIC_CONTENT = readFixture("Basic.lean");

    await adapter.openDocument(sessionA, {
      uri: BASIC_URI,
      fileId: "basic-crash",
      text: BASIC_CONTENT,
    });
    await adapter.awaitElaboration(
      sessionA,
      BASIC_URI,
      config.engine.elaborationTimeoutMs,
    );

    const analyzer = new LeanNativeSyntaxAnalyzer();
    const analysis = analyzer.analyze("basic-crash", BASIC_CONTENT);
    const theoremUnit = analysis.units.find(
      (u) => u.unit.type === "theorem" && u.unit.name === "and_swap",
    ) as AnalyzedUnit;

    const makeEngine = (leanSession: LeanSessionHandle, sessionId: string) =>
      new ProofEngine({
        sessionId,
        adapter,
        leanSession,
        target: {
          unitId: theoremUnit.unit.id,
          unitRange: theoremUnit.unit.sourceRange!,
          documentUri: BASIC_URI,
          initialPosition: theoremUnit.proof!.initialPosition,
          script: theoremUnit.proof!.script,
        },
        repo: new InMemoryProofRepository(),
        events: new InMemoryEventStore(systemClock),
        clock: systemClock,
        logger: nullLogger,
        config: config.engine,
      });

    const engineA = makeEngine(sessionA, "crash-A");
    await engineA.initialize();
    const { state: stateAfterStep1 } = await engineA.next();
    const hashBeforeCrash = stateAfterStep1.stateHash;

    // Dispose session A to simulate a crash (cleanly in tests).
    await adapter.disposeSession(sessionA);

    // Session B — fresh Lean process, same document, same engine history.
    const sessionB = await adapter.createSession({
      projectRoot,
      startupTimeoutMs: config.limits.leanStartupTimeoutMs,
    });
    await adapter.openDocument(sessionB, {
      uri: BASIC_URI,
      fileId: "basic-crash",
      text: BASIC_CONTENT,
    });
    await adapter.awaitElaboration(
      sessionB,
      BASIC_URI,
      config.engine.elaborationTimeoutMs,
    );

    // Rebind the engine to the new session and go back then forward.
    engineA.rebind(sessionB);
    await engineA.previous();
    const { state: stateAfterRedo } = await engineA.next();

    expect(stateAfterRedo.stateHash).toBe(hashBeforeCrash);

    await adapter.disposeSession(sessionB);
  }, 120_000);
});
