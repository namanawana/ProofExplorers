import { describe, expect, it } from "vitest";
import { reconcileGoals, hashGoals } from "../src/engine/GoalManager";
import type { Goal } from "@proof-explorer/protocol";

describe("P2-04: Authoritative Goal Identity", () => {
  it("preserves distinct identity for goals with identical text but different mvarId", () => {
    const rawStep0 = [
      { mvarId: "m1", target: "Nat", context: [] },
      { mvarId: "m2", target: "Nat", context: [] },
    ];
    const res0 = reconcileGoals({
      unitId: "thm1",
      step: 0,
      previousOpen: [],
      raw: rawStep0,
    });

    expect(res0.open).toHaveLength(2);
    expect(res0.open[0]!.id).toBe("thm1#m1");
    expect(res0.open[1]!.id).toBe("thm1#m2");
    expect(res0.open[0]!.isAuthoritative).toBe(true);
    expect(res0.open[1]!.isAuthoritative).toBe(true);

    // Step 1: Solve m1, keep m2
    const rawStep1 = [
      { mvarId: "m2", target: "Nat", context: [] },
    ];
    const res1 = reconcileGoals({
      unitId: "thm1",
      step: 1,
      previousOpen: res0.open,
      raw: rawStep1,
    });

    expect(res1.open).toHaveLength(1);
    expect(res1.open[0]!.id).toBe("thm1#m2");
    expect(res1.closed).toHaveLength(1);
    expect(res1.closed[0]!.id).toBe("thm1#m1");
    expect(res1.closed[0]!.status).toBe("solved");
  });

  it("handles simultaneous two-goal change with correct lineage", () => {
    const rawStep0 = [
      { mvarId: "gA", target: "A ∧ B", context: [] },
      { mvarId: "gC", target: "C", context: [] },
    ];
    const res0 = reconcileGoals({
      unitId: "thm1",
      step: 0,
      previousOpen: [],
      raw: rawStep0,
    });

    // Step 1: gA splits into gA1 and gA2, while gC is modified in place (target changed to C')
    const rawStep1 = [
      { mvarId: "gA1", target: "A", context: [] },
      { mvarId: "gA2", target: "B", context: [] },
      { mvarId: "gC", target: "C'", context: [{ name: "h", type: "H" }] },
    ];
    const res1 = reconcileGoals({
      unitId: "thm1",
      step: 1,
      previousOpen: res0.open,
      raw: rawStep1,
    });

    expect(res1.open).toHaveLength(3);
    // gC preserves its identity even though its target and context changed
    const gC = res1.open.find((g) => g.mvarId === "gC")!;
    expect(gC.id).toBe("thm1#gC");
    expect(gC.target).toBe("C'");
    expect(gC.localContext).toEqual([{ name: "h", type: "H" }]);

    // gA was closed/split
    expect(res1.closed).toHaveLength(1);
    expect(res1.closed[0]!.id).toBe("thm1#gA");

    // gA1 and gA2 are children of gA
    const gA1 = res1.open.find((g) => g.mvarId === "gA1")!;
    const gA2 = res1.open.find((g) => g.mvarId === "gA2")!;
    expect(gA1.parentGoalId).toBe("thm1#gA");
    expect(gA2.parentGoalId).toBe("thm1#gA");
  });

  it("handles goal reordering without confusing lineage", () => {
    const rawStep0 = [
      { mvarId: "g1", target: "Goal 1", context: [] },
      { mvarId: "g2", target: "Goal 2", context: [] },
    ];
    const res0 = reconcileGoals({
      unitId: "thm1",
      step: 0,
      previousOpen: [],
      raw: rawStep0,
    });

    // Step 1: Goals are swapped in focus/order
    const rawStep1 = [
      { mvarId: "g2", target: "Goal 2", context: [] },
      { mvarId: "g1", target: "Goal 1", context: [] },
    ];
    const res1 = reconcileGoals({
      unitId: "thm1",
      step: 1,
      previousOpen: res0.open,
      raw: rawStep1,
    });

    expect(res1.open.map((g) => g.mvarId)).toEqual(["g2", "g1"]);
    expect(res1.open[0]!.status).toBe("focused");
    expect(res1.open[1]!.status).toBe("open");
    expect(res1.closed).toHaveLength(0);
    expect(res1.created).toHaveLength(0);
  });

  it("deterministic hash remains stable across re-evaluation", () => {
    const goals: Goal[] = [
      {
        id: "thm1#m1",
        mvarId: "m1",
        createdAtStep: 0,
        status: "focused",
        target: "P ∧ Q",
        localContext: [{ name: "hp", type: "P" }],
        isAuthoritative: true,
      },
      {
        id: "thm1#m2",
        mvarId: "m2",
        createdAtStep: 0,
        status: "open",
        target: "R",
        localContext: [],
        isAuthoritative: true,
      },
    ];

    const hash1 = hashGoals(goals);
    const hash2 = hashGoals([...goals]);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("marks isAuthoritative: false when fallback plain text goals are supplied", () => {
    const raw = [
      { target: "A", context: [] },
      { target: "B", context: [] },
    ];
    const res = reconcileGoals({
      unitId: "thmFallback",
      step: 0,
      previousOpen: [],
      raw,
    });

    expect(res.open.every((g) => g.isAuthoritative === false)).toBe(true);
    expect(res.open[0]!.id).toBe("thmFallback#g0.0");
    expect(res.open[1]!.id).toBe("thmFallback#g0.1");
  });
});
