import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LeanNativeSyntaxAnalyzer, type AnalyzedFile } from "../src/analysis/StructureAnalyzer";

const load = (name: string): AnalyzedFile => {
  const path = fileURLToPath(new URL(`../../../lean/test-project/TestProject/${name}`, import.meta.url));
  return new LeanNativeSyntaxAnalyzer().analyze(name, readFileSync(path, "utf8"));
};

const findUnit = (a: AnalyzedFile, name: string) => {
  const u = a.units.find((x) => x.unit.name === name);
  if (!u) throw new Error(`Unit ${name} not found in ${a.fileId}`);
  return u;
};

describe("P5-01 Structure Oracle: All 12 Fixtures Verified", () => {
  it("fixture 1: Basic.lean (simple proof, multiple goals, nested have)", () => {
    const a = load("Basic.lean");
    const andSwap = findUnit(a, "and_swap");
    expect(andSwap.unit.type).toBe("theorem");
    expect(andSwap.proof?.script.map((s) => s.text)).toEqual([
      "constructor",
      "· exact hp",
      "· exact hq",
    ]);

    const nested = findUnit(a, "nested");
    expect(nested.unit.children.length).toBeGreaterThan(0);
    const h = findUnit(a, "h");
    expect(h.unit.type).toBe("local_have");
    expect(h.proof?.script.map((s) => s.text)).toEqual(["exact helper_add_zero n"]);
    const k = findUnit(a, "k");
    expect(k.unit.type).toBe("intermediate_result");
  });

  it("fixture 2: Chain.lean (dependent lemmas)", () => {
    const a = load("Chain.lean");
    expect(findUnit(a, "lemA").unit.type).toBe("lemma");
    expect(findUnit(a, "lemB").unit.type).toBe("lemma");
    expect(findUnit(a, "thmC").unit.type).toBe("theorem");
  });

  it("fixture 3: Deep.lean (deep nesting of 4 subproofs)", () => {
    const a = load("Deep.lean");
    const d = findUnit(a, "d");
    expect(d.unit.type).toBe("local_have");
    expect(d.proof?.script.map((s) => s.text)).toEqual(["rfl"]);
  });

  it("fixture 4: Failed.lean (failing tactic proof)", () => {
    const a = load("Failed.lean");
    const fail = findUnit(a, "will_fail");
    expect(fail.proof?.script.map((s) => s.text)).toEqual([
      "constructor",
      "· exact hp",
      "· exact hp",
    ]);
  });

  it("fixture 5: MultipleGoals.lean (nested goal splits)", () => {
    const a = load("MultipleGoals.lean");
    const u = findUnit(a, "multi_goals");
    expect(u.unit.type).toBe("theorem");
    expect(u.proof?.script.length).toBeGreaterThanOrEqual(2);
  });

  it("fixture 6: BulletProof.lean (bullet branches as sub-units)", () => {
    const a = load("BulletProof.lean");
    const u = findUnit(a, "bullet_proof");
    expect(u.unit.type).toBe("theorem");
    const bullets = a.units.filter((x) => x.unit.type === "subproof" && x.unit.name === "·");
    expect(bullets.length).toBeGreaterThanOrEqual(2);
    expect(bullets[0]!.proof?.script.length).toBeGreaterThanOrEqual(1);
  });

  it("fixture 7: CaseBlock.lean (case branches as sub-units)", () => {
    const a = load("CaseBlock.lean");
    const u = findUnit(a, "case_blocks");
    expect(u.unit.type).toBe("theorem");
    const leftCase = a.units.find((x) => x.unit.name === "left");
    const rightCase = a.units.find((x) => x.unit.name === "right");
    expect(leftCase?.unit.type).toBe("subproof");
    expect(rightCase?.unit.type).toBe("subproof");
    expect(leftCase?.proof?.script.map((s) => s.text)).toEqual(["exact hp"]);
    expect(rightCase?.proof?.script.map((s) => s.text)).toEqual(["exact hq"]);
  });

  it("fixture 8: WrappedStatement.lean (multiline wrapped declaration)", () => {
    const a = load("WrappedStatement.lean");
    const u = findUnit(a, "wrapped_statement");
    expect(u.unit.type).toBe("theorem");
    expect(u.proof?.script.map((s) => s.text)).toEqual([
      "constructor",
      "· exact hp",
      "· exact hq",
    ]);
  });

  it("fixture 9: TermBy.lean (by in terms and have subproof)", () => {
    const a = load("TermBy.lean");
    const u = findUnit(a, "term_by_example");
    expect(u.unit.type).toBe("theorem");
    const h1 = findUnit(a, "h1");
    expect(h1.unit.type).toBe("local_have");
    expect(h1.proof?.script.map((s) => s.text)).toEqual(["exact Nat.add_zero n"]);
  });

  it("fixture 10: ImportA.lean (base definition and theorem)", () => {
    const a = load("ImportA.lean");
    expect(findUnit(a, "base_const").unit.type).toBe("definition");
    expect(findUnit(a, "base_thm").unit.type).toBe("theorem");
  });

  it("fixture 11: ImportB.lean (cross-module import and reference)", () => {
    const a = load("ImportB.lean");
    expect(a.imports).toContain("TestProject.ImportA");
    expect(findUnit(a, "derived_thm").unit.type).toBe("theorem");
  });

  it("fixture 12: LongProof.lean (multi-step proof)", () => {
    const a = load("LongProof.lean");
    const u = findUnit(a, "long_proof");
    expect(u.proof?.script.length).toBeGreaterThanOrEqual(4);
  });

  it("fixture 13: NavigableLarge.lean (namespaces and multiple declarations)", () => {
    const a = load("NavigableLarge.lean");
    const geom = a.units.find((x) => x.unit.name === "Geometry" && x.unit.type === "namespace");
    expect(geom).toBeDefined();
    const alg = a.units.find((x) => x.unit.name === "Algebra" && x.unit.type === "namespace");
    expect(alg).toBeDefined();
  });
});
