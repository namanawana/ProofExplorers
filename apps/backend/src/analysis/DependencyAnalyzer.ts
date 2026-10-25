/**
 * DependencyAnalyzer - builds the dependency DAG (the "why does this exist?" graph).
 *
 * Implements P6-01, P6-03, P6-04:
 *   - Invariant 4: Every dependency edge MUST carry evidence (syntactic or elaborated).
 *   - Elaborated dependencies from Lean environment supersede syntactic guesses.
 *   - External theorem stubs for imported declarations (e.g. Nat.add_zero, Mathlib).
 *   - GraphDelta calculation for incremental UI updates without re-downloading the full DAG.
 *   - Invariant 9: Kept strictly separate from the execution timeline.
 */
import type { Dependency, GraphDelta, ProofUnit, SourceRange } from "@proof-explorer/protocol";
import { makeRange, rangesOverlap } from "../util/index";
import type { AnalyzedFile } from "./StructureAnalyzer";

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_'.]*/g;
const BINDER_RE = /\(\s*([A-Za-z_][A-Za-z0-9_'\s]*?)\s*:/g;

export interface ElaboratedDependencyInfo {
  fromUnitId: string;
  toUnitId: string;
  range: SourceRange;
}

export interface DependencyExtractionOptions {
  includeExternal?: boolean;
  externalUnitsOut?: ProofUnit[];
  elaboratedDependencies?: ElaboratedDependencyInfo[];
}

export function extractDependencies(
  file: AnalyzedFile,
  options?: DependencyExtractionOptions,
): Dependency[] {
  const units = file.units.map((u) => u.unit);

  // Declarations that can be depended upon, addressable by name.
  const targets = new Map<string, ProofUnit>();
  for (const u of units) {
    if (u.name && ["theorem", "lemma", "definition"].includes(u.type)) {
      targets.set(u.name, u);
    }
  }

  // Candidate "owners" of a reference, innermost (smallest range) first.
  const owners = units
    .filter((u) => u.sourceRange && u.type !== "file" && u.type !== "namespace")
    .sort((a, b) => size(a) - size(b));

  const edges = new Map<string, Dependency>();
  const externalUnits = new Map<string, ProofUnit>();

  // 1. Syntactic extraction
  for (const declUnit of units) {
    if (!["theorem", "lemma", "example", "definition"].includes(declUnit.type)) continue;
    const r = declUnit.sourceRange;
    if (!r) continue;

    const locals = collectLocalNames(file.lines, r.startLine, r.endLine);

    for (let l = r.startLine; l <= r.endLine; l++) {
      const code = (file.lines[l] ?? "").replace(/--.*$/, "");
      for (const m of code.matchAll(IDENT_RE)) {
        const token = m[0];
        let target = targets.get(token);

        if (!target && options?.includeExternal && token.includes(".")) {
          // External stub for imported / library constants
          target = externalUnits.get(token);
          if (!target) {
            target = {
              id: `ext:${token}`,
              type: "theorem",
              name: token,
              dependencies: [],
              children: [],
              status: "verified",
              states: [],
              metadata: { external: true },
            };
            externalUnits.set(token, target);
          }
        }

        if (!target || target.id === declUnit.id) continue;
        if (locals.has(token)) continue; // shadowed by a local binding

        // Skip the declaration's own name at its header.
        if (l === r.startLine && declUnit.name === token) continue;

        const col = m.index ?? 0;
        const evidence = makeRange(
          file.fileId,
          { line: l, column: col },
          { line: l, column: col + token.length },
        );

        const owner =
          owners.find((u) => u.sourceRange && rangesOverlap(u.sourceRange, evidence)) ??
          declUnit;
        if (owner.id === target.id) continue;

        const id = `${owner.id}->${target.id}@${l}:${col}`;
        edges.set(id, {
          id,
          fromUnitId: owner.id,
          toUnitId: target.id,
          kind: "depends_on",
          evidence: { kind: "syntactic", range: evidence },
        });
      }
    }
  }

  // 2. Elaborated evidence supersedes syntactic evidence when available
  if (options?.elaboratedDependencies) {
    for (const elab of options.elaboratedDependencies) {
      const id = `${elab.fromUnitId}->${elab.toUnitId}@${elab.range.startLine}:${elab.range.startColumn}`;
      edges.set(id, {
        id,
        fromUnitId: elab.fromUnitId,
        toUnitId: elab.toUnitId,
        kind: "depends_on",
        evidence: { kind: "elaborated", range: elab.range },
      });
    }
  }

  if (options?.externalUnitsOut) {
    options.externalUnitsOut.push(...externalUnits.values());
  }

  const result = [...edges.values()];

  // Mirror edges into ProofUnit.dependencies (distinct targets per unit).
  for (const u of units) {
    u.dependencies = [
      ...new Set(result.filter((e) => e.fromUnitId === u.id).map((e) => e.toUnitId)),
    ];
  }

  return result;
}

/**
 * Computes an incremental GraphDelta between two states of the dependency graph.
 */
export function computeGraphDelta(
  oldUnits: ProofUnit[],
  newUnits: ProofUnit[],
  oldDependencies: Dependency[],
  newDependencies: Dependency[],
): GraphDelta {
  const oldUnitIds = new Set(oldUnits.map((u) => u.id));
  const newUnitIds = new Set(newUnits.map((u) => u.id));
  const oldDepIds = new Set(oldDependencies.map((d) => d.id));

  const addedUnits = newUnits.filter((u) => !oldUnitIds.has(u.id));
  const removedUnitIds = oldUnits.filter((u) => !newUnitIds.has(u.id)).map((u) => u.id);
  const addedDependencies = newDependencies.filter((d) => !oldDepIds.has(d.id));

  return {
    addedUnits,
    addedDependencies,
    removedUnitIds,
  };
}

const size = (u: ProofUnit): number => {
  const r = u.sourceRange;
  return r ? (r.endLine - r.startLine) * 10_000 + (r.endColumn - r.startColumn) : Infinity;
};

/** Names bound by theorem binders `(x : T)` or by `have x` / `intro x` etc. */
function collectLocalNames(lines: string[], from: number, to: number): Set<string> {
  const names = new Set<string>();
  for (let l = from; l <= to; l++) {
    const code = (lines[l] ?? "").replace(/--.*$/, "");
    for (const b of code.matchAll(BINDER_RE)) {
      for (const n of (b[1] ?? "").split(/\s+/)) if (n) names.add(n);
    }
    const have = /\b(?:have|obtain|intro|rintro)\s+([A-Za-z_][A-Za-z0-9_']*)/.exec(code);
    if (have?.[1]) names.add(have[1]);
  }
  return names;
}
