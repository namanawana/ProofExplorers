/**
 * GoalManager - gives goals a stable identity and lineage across steps.
 *
 * Implements P2-04:
 *   1. Authoritative metavariable ID tracking when Lean's interactive RPC
 *      provides `mvarId`. In this mode, goal identity and lineage are kernel-backed
 *      truths, not heuristic guesswork.
 *   2. When Lean returns plain-text goals without `mvarId`, identity is represented
 *      as state-local / non-authoritative (`isAuthoritative: false`). We do NOT invent
 *      parentage when ambiguous.
 *
 * Determinism is strictly preserved:
 *   (previous open goals, goals Lean reports now, step) -> new ledger
 */
import type { Goal } from "@proof-explorer/protocol";
import type { RawGoal } from "../lean/LeanAdapter";
import { sha256, stableStringify } from "../util/index";

export interface ReconcileInput {
  unitId: string;
  /** The step number this reconciliation produces. */
  step: number;
  previousOpen: Goal[];
  raw: RawGoal[];
}

export interface ReconcileResult {
  /** Goals open after this step, in Lean's order. First one is focused. */
  open: Goal[];
  /** Goals that left the open set at this step (solved / replaced). */
  closed: Goal[];
  /** Goals first seen at this step (subset of `open`). */
  created: Goal[];
}

const fingerprint = (g: {
  caseName?: string;
  target: string;
  context: unknown;
}): string =>
  sha256(
    stableStringify({ c: g.caseName, t: g.target, x: g.context }),
  ).slice(0, 16);

/** Stable hash of a goal list; stored on every state for divergence checks. */
export function hashGoals(goals: Goal[]): string {
  return sha256(
    stableStringify(
      goals.map((g) => ({
        id: g.id,
        mvarId: g.mvarId,
        parent: g.parentGoalId,
        isAuthoritative: g.isAuthoritative,
        fp: fingerprint({
          caseName: g.caseName,
          target: g.target,
          context: g.localContext,
        }),
      })),
    ),
  );
}

export function reconcileGoals(input: ReconcileInput): ReconcileResult {
  const { unitId, step, previousOpen, raw } = input;

  const hasAuthoritativeIds = raw.length > 0 && raw.some((r) => r.mvarId !== undefined);

  if (hasAuthoritativeIds) {
    return reconcileWithAuthoritativeIds(unitId, step, previousOpen, raw);
  }

  return reconcileStateLocalGoals(unitId, step, previousOpen, raw);
}

/**
 * Authoritative reconciliation using Lean's kernel metavariable IDs.
 */
function reconcileWithAuthoritativeIds(
  unitId: string,
  step: number,
  previousOpen: Goal[],
  raw: RawGoal[],
): ReconcileResult {
  const prevByMvar = new Map<string, Goal>();
  for (const g of previousOpen) {
    const key = g.mvarId ?? g.id;
    prevByMvar.set(key, g);
  }

  const open: Goal[] = [];
  const created: Goal[] = [];
  const closed: Goal[] = [];
  const matchedPrevKeys = new Set<string>();

  // Determine which previous goals vanished
  const rawMvarSet = new Set(raw.map((r, i) => r.mvarId ?? `${unitId}#s${step}.g${i}`));
  for (const prev of previousOpen) {
    const key = prev.mvarId ?? prev.id;
    if (!rawMvarSet.has(key)) {
      closed.push({ ...prev, status: "solved", solvedAtStep: step });
    }
  }

  // Unambiguous parent goal: if exactly one goal was closed, new goals are its children
  const unambiguousParent = closed.length === 1 ? closed[0] : undefined;

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    const mvar = r.mvarId ?? `${unitId}#s${step}.g${i}`;
    const prev = prevByMvar.get(mvar);

    if (prev) {
      matchedPrevKeys.add(mvar);
      open.push({
        ...prev,
        status: "open",
        caseName: r.caseName,
        target: r.target,
        localContext: r.context,
        isAuthoritative: true,
      });
    } else {
      const newGoal: Goal = {
        id: `${unitId}#${mvar}`,
        mvarId: r.mvarId,
        parentGoalId: unambiguousParent?.id,
        createdAtStep: step,
        status: "open",
        caseName: r.caseName,
        target: r.target,
        localContext: r.context,
        isAuthoritative: true,
      };
      open.push(newGoal);
      created.push(newGoal);
    }
  }

  if (open.length > 0 && open[0]) {
    open[0].status = "focused";
  }

  return { open, closed, created };
}

/**
 * State-local reconciliation when Lean does not provide metavariable IDs.
 * Explicitly marks `isAuthoritative: false` and avoids inventing fabricated lineage.
 */
function reconcileStateLocalGoals(
  unitId: string,
  step: number,
  previousOpen: Goal[],
  raw: RawGoal[],
): ReconcileResult {
  // If this is step 0, all raw goals are freshly created
  if (step === 0 || previousOpen.length === 0) {
    const open = raw.map((r, i) => {
      const g: Goal = {
        id: `${unitId}#g${step}.${i}`,
        createdAtStep: step,
        status: (i === 0 ? "focused" : "open") as Goal["status"],
        caseName: r.caseName,
        target: r.target,
        localContext: r.context,
        isAuthoritative: false,
      };
      return g;
    });
    return { open, closed: [], created: [...open] };
  }

  const closed: Goal[] = [];
  const created: Goal[] = [];
  const open: Goal[] = [];

  // If one goal splits into multiple (e.g. constructor)
  if (previousOpen.length === 1 && raw.length > 1) {
    const parent = previousOpen[0]!;
    closed.push({ ...parent, status: "solved", solvedAtStep: step });
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]!;
      const g: Goal = {
        id: `${unitId}#g${step}.${i}`,
        parentGoalId: parent.id,
        createdAtStep: step,
        status: "open",
        caseName: r.caseName,
        target: r.target,
        localContext: r.context,
        isAuthoritative: false,
      };
      open.push(g);
      created.push(g);
    }
  } else if (raw.length === previousOpen.length) {
    // 1-to-1 transition (rewrite / tactic modifying current goal)
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]!;
      const prev = previousOpen[i]!;
      open.push({
        ...prev,
        status: "open",
        caseName: r.caseName,
        target: r.target,
        localContext: r.context,
        isAuthoritative: false,
      });
    }
  } else if (raw.length < previousOpen.length) {
    // Solved some goals: focused goal was solved, remaining goals match remaining raw
    const solvedCount = previousOpen.length - raw.length;
    for (let i = 0; i < solvedCount; i++) {
      closed.push({ ...previousOpen[i]!, status: "solved", solvedAtStep: step });
    }
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]!;
      const prev = previousOpen[solvedCount + i]!;
      open.push({
        ...prev,
        status: "open",
        caseName: r.caseName,
        target: r.target,
        localContext: r.context,
        isAuthoritative: false,
      });
    }
  } else {
    // Ambiguous multi-goal change: close all previous, create all new
    for (const p of previousOpen) {
      closed.push({ ...p, status: "solved", solvedAtStep: step });
    }
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]!;
      const g: Goal = {
        id: `${unitId}#g${step}.${i}`,
        createdAtStep: step,
        status: "open",
        caseName: r.caseName,
        target: r.target,
        localContext: r.context,
        isAuthoritative: false,
      };
      open.push(g);
      created.push(g);
    }
  }

  if (open.length > 0 && open[0]) {
    open[0].status = "focused";
  }

  return { open, closed, created };
}
