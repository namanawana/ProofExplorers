/**
 * Engine invariant tests (spec section 31) against a scripted Lean.
 *
 * Fixture proof (zero-based lines):
 *   0: theorem and_swap (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
 *   1:   constructor
 *   2:   · exact hp
 *   3:   · exact hq
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "@proof-explorer/protocol";
import { HeuristicStructureAnalyzer } from "../src/analysis/StructureAnalyzer";
import { InMemoryEventStore } from "../src/engine/EventStore";
import { ProofEngine, type ProofTarget } from "../src/engine/ProofEngine";
import { InMemoryProofRepository } from "../src/engine/ProofRepository";
import { AppError, nullLogger, systemClock } from "../src/util/index";
import { FakeLeanAdapter } from "./FakeLeanAdapter";

const SOURCE = [
  "theorem and_swap (p q : Prop) (hp : p) (hq : q) : p ∧ q := by",
  "  constructor",
  "  · exact hp",
  "  · exact hq",
].join("\n");

const CTX = "p q : Prop\nhp : p\nhq : q";
const GOAL_BOTH = `${CTX}\n⊢ p ∧ q`;
const GOAL_LEFT = `case left\n${CTX}\n⊢ p`;
const GOAL_RIGHT = `case right\n${CTX}\n⊢ q`;

interface Rig {
  engine: ProofEngine;
  adapter: FakeLeanAdapter;
  repo: InMemoryProofRepository;
  events: InMemoryEventStore;
  target: ProofTarget;
}

function buildRig(opts: { checkpointInterval?: number; cacheSize?: number } = {}): Rig {
  const analysis = new HeuristicStructureAnalyzer().analyze("f1", SOURCE);
  const entry = analysis.units.find((u) => u.unit.type === "theorem")!;
  const target: ProofTarget = {
    unitId: entry.unit.id,
    unitRange: entry.unit.sourceRange!,
    documentUri: "file:///and_swap.lean",
    initialPosition: entry.proof!.initialPosition,
    script: entry.proof!.script,
  };

  const adapter = new FakeLeanAdapter();
  // Positions are the END of each command / the initial position.
  adapter.goalsByPosition.set(`${target.initialPosition.line}:${target.initialPosition.column}`, [GOAL_BOTH]);
  adapter.goalsByPosition.set("1:13", [GOAL_LEFT, GOAL_RIGHT]); // after constructor
  adapter.goalsByPosition.set("2:12", [GOAL_RIGHT]); // after · exact hp
  adapter.goalsByPosition.set("3:12", []); // after · exact hq -> no goals

  const repo = new InMemoryProofRepository();
  const events = new InMemoryEventStore(systemClock);
  const engine = new ProofEngine({
    sessionId: "s1",
    adapter,
    leanSession: { id: "fake", leanVersion: "fake-1.0" },
    target,
    repo,
    events,
    clock: systemClock,
    logger: nullLogger,
    config: {
      checkpointInterval: opts.checkpointInterval ?? 100,
      elaborationTimeoutMs: 1000,
      stateCacheSize: opts.cacheSize ?? 16,
    },
  });
  return { engine, adapter, repo, events, target };
}

describe("structure analysis (fixture)", () => {
  it("splits the proof into one command per top-level tactic", () => {
    const { target } = buildRig();
    expect(target.script.map((c) => c.text)).toEqual([
      "constructor",
      "· exact hp",
      "· exact hq",
    ]);
  });
});

describe("Invariant 8: multiple goals are first-class", () => {
  it("tracks goal lineage across a split and a solve", async () => {
    const { engine } = buildRig();
    const s0 = (await engine.initialize()).state;
    expect(s0.goals).toHaveLength(1);

    const s1 = (await engine.next()).state; // constructor
    expect(s1.goals.map((g) => g.caseName)).toEqual(["left", "right"]);
    // Both children point back at the goal `constructor` consumed.
    expect(s1.goals.every((g) => g.parentGoalId === s0.goals[0]!.id)).toBe(true);
    expect(s1.focusedGoalId).toBe(s1.goals[0]!.id);

    const o2 = await engine.next(); // · exact hp
    expect(o2.state.goals).toHaveLength(1);
    expect(o2.state.goals[0]!.caseName).toBe("right");
    expect(o2.transition?.solvedGoals).toEqual([s1.goals[0]!.id]);
  });
});

describe("Invariant 3: a failed command never advances committed state", () => {
  it("rejects with Lean's diagnostics and leaves frontier/history untouched", async () => {
    const { engine, adapter, repo, target } = buildRig();
    await engine.initialize();
    await engine.next(); // step 1 ok

    const bad: Diagnostic = {
      severity: "error",
      message: "unsolved goals",
      range: target.script[1]!.range, // overlaps step 2's command
    };
    adapter.diagnostics = [bad];

    const err = await engine.next().catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("TACTIC_REJECTED");
    expect((err as AppError).diagnostics).toEqual([bad]);

    expect(engine.progress().frontier).toBe(1);
    expect(engine.progress().cursor).toBe(1);
    expect(await repo.getStateHash("s1", 2)).toBeUndefined();
    expect(await repo.getTransition("s1", 2)).toBeUndefined();

    // Once Lean is happy the same step succeeds: the session was not poisoned.
    adapter.diagnostics = [];
    expect((await engine.next()).state.stepNumber).toBe(2);
  });

  it("holds the FINAL step responsible for errors anywhere in the unit", async () => {
    const { engine, adapter, target } = buildRig();
    await engine.initialize();
    await engine.next();
    await engine.next();
    // Lean reports "unsolved goals" on the theorem header, not the last tactic.
    adapter.diagnostics = [
      { severity: "error", message: "unsolved goals", range: { ...target.unitRange, endLine: 0 } },
    ];
    await expect(engine.next()).rejects.toMatchObject({ code: "TACTIC_REJECTED" });
  });
});

describe("Invariants 1 & 2: verified, recoverable history", () => {
  it("completes the proof and emits PROOF_COMPLETED", async () => {
    const { engine, events } = buildRig();
    await engine.initialize();
    await engine.next();
    await engine.next();
    const last = await engine.next();
    expect(last.state.goals).toHaveLength(0);
    const types = (await events.read("s1")).map((e) => e.type);
    expect(types).toContain("PROOF_COMPLETED");
    await expect(engine.next()).rejects.toMatchObject({ code: "NO_MORE_STEPS" });
  });

  it("restores any step by checkpoint + deterministic replay, bit-identical", async () => {
    // Interval 2 => bodies kept only for steps 0 and 2; cache of 1 forces replay.
    const { engine, adapter } = buildRig({ checkpointInterval: 2, cacheSize: 1 });
    await engine.initialize();
    const original: string[] = [];
    for (let i = 0; i < 3; i++) original.push((await engine.next()).state.stateHash);

    const before = adapter.goalQueries;
    const back = await engine.jump(1); // step 1 has no stored body
    expect(back.state.stateHash).toBe(original[0]);
    expect(adapter.goalQueries).toBeGreaterThan(before); // really replayed via Lean

    const again = await engine.jump(3);
    expect(again.state.stateHash).toBe(original[2]);
  });

  it("detects a corrupted checkpoint instead of showing unjustified state", async () => {
    const { engine, repo } = buildRig({ checkpointInterval: 2, cacheSize: 1 });
    await engine.initialize();
    for (let i = 0; i < 3; i++) await engine.next();
    repo.corruptBody("s1", 0);
    await expect(engine.jump(1)).rejects.toMatchObject({ code: "CHECKPOINT_CORRUPT" });
  });

  it("Previous/Reset only move the cursor; Next re-serves verified history", async () => {
    const { engine, adapter } = buildRig();
    await engine.initialize();
    await engine.next();
    await engine.next();
    const queries = adapter.goalQueries;

    expect((await engine.previous()).state.stepNumber).toBe(1);
    expect((await engine.reset()).state.stepNumber).toBe(0);
    expect((await engine.next()).state.stepNumber).toBe(1); // from history
    expect(adapter.goalQueries).toBe(queries); // Lean was not consulted
    await engine.reset();
    await expect(engine.previous()).rejects.toMatchObject({ code: "STEP_OUT_OF_RANGE" });
  });
});

describe("serialisation", () => {
  it("never interleaves concurrent operations on one session", async () => {
    const { engine } = buildRig();
    await engine.initialize();
    const [a, b] = await Promise.all([engine.next(), engine.next()]);
    expect([a.state.stepNumber, b.state.stepNumber]).toEqual([1, 2]);
  });
});
