import { describe, expect, it } from "vitest";
import { LeanNativeSyntaxAnalyzer } from "../src/analysis/StructureAnalyzer";
import { InMemoryEventStore } from "../src/engine/EventStore";
import { InMemoryProofRepository } from "../src/engine/ProofRepository";
import { SessionManager } from "../src/session/SessionManager";
import { InMemoryProjectStore } from "../src/store/ProjectStore";
import { nullLogger, systemClock } from "../src/util/index";
import { FakeLeanAdapter } from "./FakeLeanAdapter";
import { loadConfig } from "../src/config";

const SOURCE = `
theorem multi (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  have h1 : p := by
    exact hp
  have h2 : q := by
    exact hq
  constructor
  · exact h1
  · exact h2
`;

describe("P5-02 & P5-03: Document-Scoped Process Management & Nested Units", () => {
  it("shares ONE Lean process across 10 nested sessions on the same document", async () => {
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const adapter = new FakeLeanAdapter();
    const store = new InMemoryProjectStore(analyzer, systemClock);
    const repo = new InMemoryProofRepository();
    const events = new InMemoryEventStore(systemClock);
    const config = loadConfig({ MAX_SESSIONS: "50" });

    const sessions = new SessionManager({
      adapter,
      repo,
      events,
      store,
      config,
      clock: systemClock,
      logger: nullLogger,
    });

    const project = await store.createProject("test-project");
    const file = await store.addFile(project.id, "Multi.lean", SOURCE);
    const analysis = (await store.getFileAnalysis(file.id))!;

    // Collect executable units
    const units = analysis.units.filter((u) => u.proof !== undefined);
    expect(units.length).toBeGreaterThan(1);

    for (const u of units) {
      const p = u.proof!.initialPosition;
      adapter.goalsByPosition.set(`${p.line}:${p.column}`, ["⊢ p ∧ q"]);
    }

    // Open 10 sessions on units in this document
    const createdSessionIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const u = units[i % units.length]!;
      const { info } = await sessions.create({
        projectId: project.id,
        fileId: file.id,
        proofUnitId: u.unit.id,
      });
      createdSessionIds.push(info.id);
    }

    // Acceptance criterion: exactly 1 Lean process was launched for all 10 sessions!
    expect(adapter.sessionsCreated).toBe(1);

    // Verify cursors are isolated across sessions
    const s0 = createdSessionIds[0]!;
    const s1 = createdSessionIds[1]!;
    expect(sessions.get(s0)?.cursorStep).toBe(0);
    expect(sessions.get(s1)?.cursorStep).toBe(0);

    // Close 9 of the 10 sessions - process should STILL be alive
    for (let i = 0; i < 9; i++) {
      await sessions.close(createdSessionIds[i]!);
    }
    expect(sessions.get(s0)).toBeUndefined();
    expect(sessions.get(s1)).toBeUndefined();
    const lastSession = createdSessionIds[9]!;
    expect(sessions.get(lastSession)?.status).toBe("ready");

    // Close the last session - now document context is released
    await sessions.close(lastSession);
    expect(sessions.get(lastSession)).toBeUndefined();
  });
});
