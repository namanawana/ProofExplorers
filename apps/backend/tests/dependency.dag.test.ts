import { describe, expect, it } from "vitest";
import { extractDependencies, computeGraphDelta } from "../src/analysis/DependencyAnalyzer";
import { LeanNativeSyntaxAnalyzer } from "../src/analysis/StructureAnalyzer";
import type { ProofUnit, Dependency } from "@proof-explorer/protocol";
import { makeRange } from "../src/util/index";

const SOURCE = `
theorem helper (n : Nat) : n + 0 = n := by
  exact Nat.add_zero n

theorem main (n : Nat) : n + 0 = n := by
  exact helper n
`;

describe("P6 Dependency DAG: Evidence, Elaborated Edges & GraphDelta", () => {
  it("Invariant 4: every dependency edge MUST carry evidence", () => {
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const a = analyzer.analyze("file1", SOURCE);
    const edges = extractDependencies(a, { includeExternal: true });

    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.evidence).toBeDefined();
      expect(["syntactic", "elaborated"]).toContain(e.evidence.kind);
      expect(e.evidence.range).toBeDefined();
      expect(e.evidence.range.fileId).toBe("file1");
    }
  });

  it("elaborated dependencies supersede syntactic dependencies", () => {
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const a = analyzer.analyze("file1", SOURCE);
    const helperUnit = a.units.find((u) => u.unit.name === "helper")!;
    const mainUnit = a.units.find((u) => u.unit.name === "main")!;

    const elabRange = makeRange("file1", { line: 5, column: 8 }, { line: 5, column: 14 });
    const edges = extractDependencies(a, {
      elaboratedDependencies: [
        {
          fromUnitId: mainUnit.unit.id,
          toUnitId: helperUnit.unit.id,
          range: elabRange,
        },
      ],
    });

    const edge = edges.find((e) => e.fromUnitId === mainUnit.unit.id && e.toUnitId === helperUnit.unit.id);
    expect(edge).toBeDefined();
    expect(edge!.evidence.kind).toBe("elaborated");
  });

  it("creates external theorem stubs for imported declarations (P6-03)", () => {
    const analyzer = new LeanNativeSyntaxAnalyzer();
    const a = analyzer.analyze("file1", SOURCE);
    const externalUnits: ProofUnit[] = [];
    const edges = extractDependencies(a, {
      includeExternal: true,
      externalUnitsOut: externalUnits,
    });

    const extUnit = externalUnits.find((u) => u.name === "Nat.add_zero");
    expect(extUnit).toBeDefined();
    expect(extUnit?.metadata?.external).toBe(true);

    const extEdge = edges.find((e) => e.toUnitId === extUnit?.id);
    expect(extEdge).toBeDefined();
  });

  it("computes typed, versioned GraphDelta correctly (P6-04)", () => {
    const u1: ProofUnit = {
      id: "u1",
      type: "theorem",
      name: "T1",
      dependencies: [],
      children: [],
      status: "verified",
      states: [],
    };
    const u2: ProofUnit = {
      id: "u2",
      type: "theorem",
      name: "T2",
      dependencies: [],
      children: [],
      status: "verified",
      states: [],
    };
    const u3: ProofUnit = {
      id: "u3",
      type: "theorem",
      name: "T3",
      dependencies: [],
      children: [],
      status: "verified",
      states: [],
    };

    const dep1: Dependency = {
      id: "d1",
      fromUnitId: "u2",
      toUnitId: "u1",
      kind: "depends_on",
      evidence: { kind: "syntactic", range: makeRange("f", { line: 0, column: 0 }, { line: 0, column: 1 }) },
    };
    const dep2: Dependency = {
      id: "d2",
      fromUnitId: "u3",
      toUnitId: "u2",
      kind: "depends_on",
      evidence: { kind: "syntactic", range: makeRange("f", { line: 1, column: 0 }, { line: 1, column: 1 }) },
    };

    // Expanding from [u1, u2] to [u1, u2, u3]
    const delta = computeGraphDelta([u1, u2], [u1, u2, u3], [dep1], [dep1, dep2]);
    expect(delta.addedUnits).toEqual([u3]);
    expect(delta.addedDependencies).toEqual([dep2]);
    expect(delta.removedUnitIds).toEqual([]);
  });
});
