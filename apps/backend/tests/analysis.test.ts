/**
 * Unit tests for GoalTextParser, the structure analyzer (nesting) and the
 * dependency analyzer (Invariant 4: every edge carries evidence).
 */
import { describe, expect, it } from "vitest";
import { extractDependencies } from "../src/analysis/DependencyAnalyzer";
import { HeuristicStructureAnalyzer } from "../src/analysis/StructureAnalyzer";
import { parseGoalText } from "../src/lean/GoalTextParser";

describe("parseGoalText", () => {
  it("parses case tag, grouped hypotheses, and target", () => {
    const g = parseGoalText("case left\nx y : ℕ\nh : x ≤ y\n⊢ x < y + 1");
    expect(g.caseName).toBe("left");
    expect(g.context.map((c) => c.name)).toEqual(["x", "y", "h"]);
    expect(g.context[0]!.type).toBe("ℕ");
    expect(g.target).toBe("x < y + 1");
  });

  it("handles multi-line types and let-values", () => {
    const g = parseGoalText("h : ∀ x,\n  x = x\nn : ℕ := 5\n⊢ True");
    expect(g.context[0]!.type).toBe("∀ x,\nx = x");
    expect(g.context[1]).toMatchObject({ name: "n", type: "ℕ", value: "5" });
  });
});

const FILE = [
  "import Mathlib",
  "",
  "lemma helper (n : Nat) : n + 0 = n := by",
  "  simp",
  "",
  "theorem main (n : Nat) : n + 0 = n := by",
  "  have h : n + 0 = n := by",
  "    have g : n = n := by",
  "      rfl",
  "    exact helper n",
  "  have k : n = n := rfl",
  "  exact h",
].join("\n");

describe("HeuristicStructureAnalyzer", () => {
  const analysis = new HeuristicStructureAnalyzer().analyze("f", FILE);
  const byName = (n: string) => analysis.units.find((u) => u.unit.name === n)!;

  it("finds declarations and imports", () => {
    expect(analysis.imports).toEqual(["Mathlib"]);
    expect(byName("helper").unit.type).toBe("lemma");
    expect(byName("main").unit.type).toBe("theorem");
  });

  it("distinguishes `have := by` (sub-proof) from term-mode `have` (Invariant: not identical)", () => {
    expect(byName("h").unit.type).toBe("local_have");
    expect(byName("h").proof).toBeDefined();
    expect(byName("k").unit.type).toBe("intermediate_result");
    expect(byName("k").proof).toBeUndefined();
  });

  it("nests sub-proofs to arbitrary depth (Invariant 7)", () => {
    const g = byName("g").unit;
    expect(g.parentId).toBe(byName("h").unit.id);
    expect(byName("h").unit.parentId).toBe(byName("main").unit.id);
  });

  it("main's script has 3 steps: have h, have k, exact h", () => {
    expect(byName("main").proof!.script.map((c) => c.text.split("\n")[0])).toEqual([
      "have h : n + 0 = n := by",
      "have k : n = n := rfl",
      "exact h",
    ]);
  });
});

describe("extractDependencies", () => {
  const analysis = new HeuristicStructureAnalyzer().analyze("f", FILE);
  const edges = extractDependencies(analysis);

  it("links the use of `helper` to the INNERMOST unit containing it", () => {
    const e = edges.find((x) => x.toUnitId.includes(":lemma:helper"))!;
    expect(e.fromUnitId).toContain(":local_have:h:");
  });

  it("attaches evidence pointing at the exact token (Invariant 4)", () => {
    for (const e of edges) {
      expect(e.evidence.kind).toBe("syntactic");
      const { startLine, startColumn, endColumn } = e.evidence.range;
      const line = analysis.lines[startLine]!;
      const target = analysis.units.find((u) => u.unit.id === e.toUnitId)!.unit.name!;
      expect(line.slice(startColumn, endColumn)).toBe(target);
    }
  });

  it("does not invent edges to names that are not declared units", () => {
    expect(edges.every((e) => analysis.units.some((u) => u.unit.id === e.toUnitId))).toBe(true);
  });
});
