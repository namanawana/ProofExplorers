/**
 * Determinism property test (P2-05).
 *
 * Property: no matter what sequence of Next / Previous / Jump / Reset a user
 * performs, and no matter how aggressively state bodies are evicted, the state
 * hash shown at step N always equals the hash from a straight-line run.
 * This is what makes "checkpoint restore + deterministic replay" trustworthy.
 *
 * A seeded PRNG keeps failures reproducible (the seed is in the test name).
 */
import { describe, expect, it } from "vitest";
import { HeuristicStructureAnalyzer } from "../src/analysis/StructureAnalyzer";
import { InMemoryEventStore } from "../src/engine/EventStore";
import { ProofEngine, type ProofTarget } from "../src/engine/ProofEngine";
import { InMemoryProofRepository } from "../src/engine/ProofRepository";
import { nullLogger, systemClock } from "../src/util/index";
import { FakeLeanAdapter } from "./FakeLeanAdapter";

/** A longer proof so checkpoints and replay windows are non-trivial. */
const N = 12;
const SOURCE = [
  "theorem long (p : Prop) (h : p) : p := by",
  ...Array.from({ length: N }, (_, i) => `  skip_${i}`),
].join("\n");

/** mulberry32: tiny deterministic PRNG. */
function prng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rig(interval: number, cacheSize: number) {
  const analysis = new HeuristicStructureAnalyzer().analyze("f", SOURCE);
  const entry = analysis.units.find((u) => u.unit.type === "theorem")!;
  const target: ProofTarget = {
    unitId: entry.unit.id,
    unitRange: entry.unit.sourceRange!,
    documentUri: "file:///long.lean",
    initialPosition: entry.proof!.initialPosition,
    script: entry.proof!.script,
  };
  const adapter = new FakeLeanAdapter();
  // Each step k leaves k+1 goals-worth of difference so every hash is distinct.
  const goalsAt = (k: number) =>
    Array.from({ length: Math.min(k + 1, 4) }, (_, i) => `h : p\n⊢ goal_${k}_${i}`);
  const init = target.initialPosition;
  adapter.goalsByPosition.set(`${init.line}:${init.column}`, goalsAt(0));
  target.script.forEach((c, i) =>
    adapter.goalsByPosition.set(`${c.range.endLine}:${c.range.endColumn}`, goalsAt(i + 1)),
  );
  const engine = new ProofEngine({
    sessionId: "s",
    adapter,
    leanSession: { id: "x", leanVersion: "fake" },
    target,
    repo: new InMemoryProofRepository(),
    events: new InMemoryEventStore(systemClock),
    clock: systemClock,
    logger: nullLogger,
    config: { checkpointInterval: interval, elaborationTimeoutMs: 1000, stateCacheSize: cacheSize },
  });
  return engine;
}

async function straightLineHashes(): Promise<string[]> {
  const e = rig(1000, 1000);
  const hashes = [(await e.initialize()).state.stateHash];
  for (let i = 0; i < N; i++) hashes.push((await e.next()).state.stateHash);
  return hashes;
}

describe("determinism under arbitrary navigation", () => {
  for (const seed of [1, 2, 3, 42, 1337]) {
    it(`matches the straight-line run (seed ${seed}, interval 3, cache 1)`, async () => {
      const expected = await straightLineHashes();
      const rnd = prng(seed);
      const engine = rig(3, 1); // tiny cache + frequent checkpoints => lots of replay
      await engine.initialize();

      for (let i = 0; i < 60; i++) {
        const { cursor, frontier } = engine.progress();
        const roll = rnd();
        let outcome;
        if (roll < 0.35 && frontier < N) outcome = await engine.next();
        else if (roll < 0.55 && cursor > 0) outcome = await engine.previous();
        else if (roll < 0.65) outcome = await engine.reset();
        else outcome = await engine.jump(Math.floor(rnd() * (N + 1)));
        const step = outcome.state.stepNumber;
        expect(outcome.state.stateHash, `step ${step} after op #${i}`).toBe(expected[step]);
      }
    });
  }
});
