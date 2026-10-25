/**
 * Benchmarks (P7-01). Run with:  npm --workspace apps/backend run bench
 *
 * Purpose: MEASURE before optimising (spec section 33). Everything here runs
 * against the FakeLeanAdapter, so these numbers isolate OUR overhead
 * (analysis, engine bookkeeping, checkpoint replay logic) and deliberately
 * exclude Lean's own elaboration time, which dominates in production and must
 * be benchmarked separately against real Lean (P1-03/P7-01).
 */
import { performance } from "node:perf_hooks";
import { extractDependencies } from "../src/analysis/DependencyAnalyzer";
import { HeuristicStructureAnalyzer } from "../src/analysis/StructureAnalyzer";
import { InMemoryEventStore } from "../src/engine/EventStore";
import { ProofEngine, type ProofTarget } from "../src/engine/ProofEngine";
import { InMemoryProofRepository } from "../src/engine/ProofRepository";
import { nullLogger, systemClock } from "../src/util/index";
import { FakeLeanAdapter } from "../tests/FakeLeanAdapter";

const rows: Array<[string, string]> = [];
const time = async <T>(label: string, fn: () => Promise<T> | T, unit = ""): Promise<T> => {
  const t0 = performance.now();
  const out = await fn();
  rows.push([label, `${(performance.now() - t0).toFixed(1)} ms${unit}`]);
  return out;
};

/** ~10k-line development: many lemmas, each used by later ones. */
function bigFile(lemmas: number): string {
  const out: string[] = ["import Mathlib", ""];
  for (let i = 0; i < lemmas; i++) {
    out.push(`lemma lem_${i} (n : Nat) : n + 0 = n := by`);
    out.push(i > 0 ? `  have h : n + 0 = n := lem_${i - 1} n` : "  skip");
    out.push("  simp");
    out.push("  rfl");
    out.push("");
  }
  return out.join("\n");
}

async function main() {
  const text = bigFile(2000);
  const lines = text.split("\n").length;
  const analyzer = new HeuristicStructureAnalyzer();

  const analysis = await time(`structure analysis (${lines} lines)`, () => analyzer.analyze("big", text));
  const edges = await time(`dependency extraction (${analysis.units.length} units)`, () => extractDependencies(analysis));
  rows.push(["  edges found", String(edges.length)]);

  // ---- engine over one long proof (3000 steps) ---------------------------------
  const STEPS = 3000;
  const src = ["theorem long (p : Prop) (h : p) : p := by", ...Array.from({ length: STEPS }, (_, i) => `  step_${i}`)].join("\n");
  const entry = analyzer.analyze("f", src).units.find((u) => u.unit.type === "theorem")!;
  const target: ProofTarget = {
    unitId: entry.unit.id,
    unitRange: entry.unit.sourceRange!,
    documentUri: "file:///long.lean",
    initialPosition: entry.proof!.initialPosition,
    script: entry.proof!.script,
  };
  const adapter = new FakeLeanAdapter();
  const goalsAt = (k: number) => [`h : p\n⊢ goal_${k}`];
  adapter.goalsByPosition.set(`${target.initialPosition.line}:${target.initialPosition.column}`, goalsAt(0));
  target.script.forEach((c, i) => adapter.goalsByPosition.set(`${c.range.endLine}:${c.range.endColumn}`, goalsAt(i + 1)));

  const engine = new ProofEngine({
    sessionId: "bench",
    adapter,
    leanSession: { id: "x", leanVersion: "fake" },
    target,
    repo: new InMemoryProofRepository(),
    events: new InMemoryEventStore(systemClock),
    clock: systemClock,
    logger: nullLogger,
    config: { checkpointInterval: 100, elaborationTimeoutMs: 1000, stateCacheSize: 256 },
  });

  await engine.initialize();
  await time(`engine: ${STEPS} sequential Next (commit incl. events)`, async () => {
    for (let i = 0; i < STEPS; i++) await engine.next();
  });

  // Worst case for replay: just before the next checkpoint (99 steps to replay).
  // Destinations must lie OUTSIDE the 256-entry LRU, which still holds the last
  // 256 steps (2745..3000) after the sequential run; otherwise we'd be
  // measuring a cache hit rather than a restore.
  await engine.jump(0);
  for (const dest of [1599, 2599]) {
    await engine.jump(0);
    await time(`checkpoint restore + replay to step ${dest} (99 replays)`, () => engine.jump(dest));
  }
  await time("cache hit: Previous", () => engine.previous());

  const w = Math.max(...rows.map(([k]) => k.length));
  console.log("\nProof Explorer benchmarks (fake Lean: excludes Lean elaboration time)\n");
  for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
  console.log();
}

void main();
