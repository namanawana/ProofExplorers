/**
 * Runs the analyzers over the real .lean fixtures in lean/test-project.
 * (These checks need no Lean toolchain; stepping them through real Lean is
 * the separate integration suite, docs/TASKS.md P1-03.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractDependencies } from "../src/analysis/DependencyAnalyzer";
import { HeuristicStructureAnalyzer, type AnalyzedFile } from "../src/analysis/StructureAnalyzer";

const load = (name: string): AnalyzedFile => {
  const path = fileURLToPath(new URL(`../../../lean/test-project/TestProject/${name}`, import.meta.url));
  return new HeuristicStructureAnalyzer().analyze(name, readFileSync(path, "utf8"));
};
const unit = (a: AnalyzedFile, name: string) => a.units.find((u) => u.unit.name === name)!;

describe("fixture: Deep.lean (Invariant 7)", () => {
  const a = load("Deep.lean");

  it("nests four local proofs under the theorem with no depth cap", () => {
    const chain: string[] = [];
    let cur = unit(a, "d").unit;
    while (cur.parentId) {
      chain.push(cur.name ?? cur.type);
      cur = a.units.find((u) => u.unit.id === cur.parentId)!.unit;
    }
    // d -> c -> b -> a -> deep (the theorem), whose parent is the file unit.
    expect(chain).toEqual(["d", "c", "b", "a", "deep"]);
    expect(cur.type).toBe("file");
  });

  it("gives every level its own executable script", () => {
    expect(unit(a, "a").proof!.script.map((c) => c.text.split("\n")[0])).toEqual([
      "have b : n = n := by",
      "exact b",
    ]);
    expect(unit(a, "d").proof!.script.map((c) => c.text)).toEqual(["rfl"]);
  });
});

describe("fixture: Chain.lean (dependency DAG)", () => {
  const a = load("Chain.lean");
  const edges = extractDependencies(a);
  const label = (id: string) => a.units.find((u) => u.unit.id === id)!.unit.name;

  it("finds exactly the supported edges, each attached to the innermost unit", () => {
    const pairs = edges.map((e) => `${label(e.fromUnitId)}->${label(e.toUnitId)}`).sort();
    expect(pairs).toEqual(["h->lemA", "h1->lemB", "h2->lemA"]);
  });

  it("derives theorem-level dependencies through local haves (via the unit tree)", () => {
    // `h1`/`h2` are children of thmC, so thmC transitively needs lemA and lemB.
    const children = unit(a, "thmC").unit.children.map((id) => label(id));
    expect(children).toEqual(["h1", "h2"]);
  });
});

describe("fixture: Failed.lean / Basic.lean", () => {
  it("produces the expected three steps for the failing proof", () => {
    const a = load("Failed.lean");
    expect(unit(a, "will_fail").proof!.script.map((c) => c.text)).toEqual([
      "constructor",
      "· exact hp",
      "· exact hp",
    ]);
  });

  it("separates sub-proof haves from term-mode haves in Basic.lean", () => {
    const a = load("Basic.lean");
    expect(unit(a, "h").unit.type).toBe("local_have");
    expect(unit(a, "k").unit.type).toBe("intermediate_result");
  });
});
