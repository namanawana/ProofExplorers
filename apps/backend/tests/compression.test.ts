import { describe, expect, it } from "vitest";
import { compressStateDelta, decompressStateDelta } from "../src/engine/StateCompression";
import { hashGoals } from "../src/engine/GoalManager";
import type { Goal, ProofState } from "@proof-explorer/protocol";

describe("P7-03: Proof State Body Delta Compression", () => {
  const g1: Goal = {
    id: "g1",
    createdAtStep: 0,
    status: "focused",
    target: "P ∧ Q",
    localContext: [{ name: "hp", type: "P" }],
    isAuthoritative: true,
  };
  const g2: Goal = {
    id: "g2",
    createdAtStep: 0,
    status: "open",
    target: "R",
    localContext: [],
    isAuthoritative: true,
  };

  const base: ProofState = {
    id: "base_state",
    proofUnitId: "thm1",
    stepNumber: 0,
    goals: [g1, g2],
    focusedGoalId: "g1",
    localContext: [{ name: "hp", type: "P" }],
    stateHash: hashGoals([g1, g2]),
    timestamp: 1000,
  };

  it("compresses and decompresses with exact bit-for-bit reconstruction", () => {
    // Current state: g1 was solved/closed, g2 modified, and g3 created
    const g2Mod: Goal = { ...g2, target: "R_simplified", status: "focused" };
    const g3: Goal = {
      id: "g3",
      createdAtStep: 1,
      status: "open",
      target: "S",
      localContext: [],
      isAuthoritative: true,
    };

    const current: ProofState = {
      id: "current_state",
      proofUnitId: "thm1",
      stepNumber: 1,
      goals: [g2Mod, g3],
      focusedGoalId: "g2",
      localContext: [],
      stateHash: hashGoals([g2Mod, g3]),
      timestamp: 2000,
    };

    const delta = compressStateDelta(base, current);
    expect(delta.closedGoalIds).toEqual(["g1"]);
    expect(delta.createdGoals).toHaveLength(1);
    expect(delta.modifiedGoals).toHaveLength(1);

    const reconstructed = decompressStateDelta(base, delta);
    expect(reconstructed.stepNumber).toBe(1);
    expect(reconstructed.stateHash).toBe(current.stateHash);
    expect(reconstructed.goals.map((g) => g.id)).toEqual(["g2", "g3"]);
    expect(reconstructed.goals[0]!.target).toBe("R_simplified");
  });

  it("detects corrupted delta checksums and fails closed", () => {
    const current: ProofState = {
      ...base,
      stepNumber: 1,
      stateHash: base.stateHash,
    };
    const delta = compressStateDelta(base, current);
    // Tamper with checksum
    delta.checksum = "bad_checksum";

    expect(() => decompressStateDelta(base, delta)).toThrow("State delta checksum verification failed");
  });

  it("detects diverged state hash during reconstruction", () => {
    const current: ProofState = {
      ...base,
      stepNumber: 1,
      stateHash: base.stateHash,
    };
    const delta = compressStateDelta(base, current);
    // Tamper with target state hash
    delta.stateHash = "diverged_hash";
    delta.checksum = "recomputed"; // Even if checksum passed, divergence check fails

    expect(() => decompressStateDelta(base, delta)).toThrow("checksum verification failed");
  });
});
