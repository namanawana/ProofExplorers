/**
 * StateCompression - delta compression for proof state bodies against checkpoints.
 *
 * Implements P7-03:
 *   - Computes compact deltas against nearest checkpoint
 *   - Verifies exact bit-for-bit reconstruction via cryptographic checksums
 *   - Detects corrupted or tampered deltas
 */
import type { Goal, ProofState } from "@proof-explorer/protocol";
import { sha256, stableStringify, AppError } from "../util/index";
import { hashGoals } from "./GoalManager";

export interface StateDelta {
  version: 1;
  baseStateId: string;
  stepNumber: number;
  stateHash: string;
  createdGoals: Goal[];
  closedGoalIds: string[];
  modifiedGoals: Goal[];
  focusedGoalId?: string;
  checksum: string;
}

export function compressStateDelta(base: ProofState, current: ProofState): StateDelta {
  const baseGoalMap = new Map(base.goals.map((g) => [g.id, g]));
  const currentGoalMap = new Map(current.goals.map((g) => [g.id, g]));

  const createdGoals: Goal[] = [];
  const modifiedGoals: Goal[] = [];
  const closedGoalIds: string[] = [];

  for (const g of current.goals) {
    const prev = baseGoalMap.get(g.id);
    if (!prev) {
      createdGoals.push(g);
    } else {
      const changed =
        g.target !== prev.target ||
        g.status !== prev.status ||
        g.caseName !== prev.caseName ||
        JSON.stringify(g.localContext) !== JSON.stringify(prev.localContext);
      if (changed) {
        modifiedGoals.push(g);
      }
    }
  }

  for (const prev of base.goals) {
    if (!currentGoalMap.has(prev.id)) {
      closedGoalIds.push(prev.id);
    }
  }

  const deltaData = {
    version: 1 as const,
    baseStateId: base.id,
    stepNumber: current.stepNumber,
    stateHash: current.stateHash,
    createdGoals,
    closedGoalIds,
    modifiedGoals,
    focusedGoalId: current.focusedGoalId,
  };

  const checksum = sha256(stableStringify(deltaData));
  return { ...deltaData, checksum };
}

export function decompressStateDelta(base: ProofState, delta: StateDelta): ProofState {
  const expectedChecksum = sha256(
    stableStringify({
      version: delta.version,
      baseStateId: delta.baseStateId,
      stepNumber: delta.stepNumber,
      stateHash: delta.stateHash,
      createdGoals: delta.createdGoals,
      closedGoalIds: delta.closedGoalIds,
      modifiedGoals: delta.modifiedGoals,
      focusedGoalId: delta.focusedGoalId,
    }),
  );

  if (expectedChecksum !== delta.checksum) {
    throw new AppError("CHECKPOINT_CORRUPT", "State delta checksum verification failed");
  }

  if (base.id !== delta.baseStateId) {
    throw new AppError("CHECKPOINT_CORRUPT", "Base state ID mismatch during delta reconstruction");
  }

  const goalMap = new Map(base.goals.map((g) => [g.id, { ...g }]));

  // Remove closed goals
  for (const id of delta.closedGoalIds) {
    goalMap.delete(id);
  }

  // Apply modified goals
  for (const g of delta.modifiedGoals) {
    goalMap.set(g.id, g);
  }

  // Add created goals
  for (const g of delta.createdGoals) {
    goalMap.set(g.id, g);
  }

  const openGoals = [...goalMap.values()];
  const computedHash = hashGoals(openGoals);

  if (computedHash !== delta.stateHash) {
    throw new AppError("CHECKPOINT_CORRUPT", "Reconstructed state hash diverged from recorded hash");
  }

  const focused = openGoals.find((g) => g.id === delta.focusedGoalId) ?? openGoals[0];

  return {
    id: `${base.proofUnitId}@${delta.stepNumber}:${computedHash.slice(0, 12)}`,
    proofUnitId: base.proofUnitId,
    stepNumber: delta.stepNumber,
    goals: openGoals,
    focusedGoalId: focused?.id,
    localContext: focused?.localContext ?? [],
    sourcePosition: base.sourcePosition,
    sourceRange: base.sourceRange,
    stateHash: computedHash,
    parentStateId: base.id,
    timestamp: base.timestamp,
  };
}
