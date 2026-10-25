/**
 * CheckpointManager - decides WHEN to checkpoint and answers "which
 * checkpoint should I restore from to reach step N?".
 *
 *   S0 ... S100* ... S200* ... S300*        (* = checkpoint, interval = 100)
 *
 * Jumping to step 743 loads S700 and deterministically replays 43 transitions
 * (see ProofEngine.materialize). Only checkpoints keep a full state body in
 * the repository; every other step stores a compact hash. That is the "do not
 * duplicate every state" requirement from the spec.
 *
 * This class holds the index only; it performs no I/O and no Lean calls, so it
 * is trivially unit-testable.
 */
import type { Checkpoint } from "@proof-explorer/protocol";

export class CheckpointManager {
  /** Sorted ascending by step. */
  private checkpoints: Checkpoint[] = [];

  constructor(private readonly interval: number) {
    if (!Number.isInteger(interval) || interval < 1) {
      throw new Error("checkpoint interval must be a positive integer");
    }
  }

  /** Step 0 is always a checkpoint so replay always has a base to start from. */
  shouldCheckpoint(step: number): boolean {
    return step === 0 || step % this.interval === 0;
  }

  record(cp: Checkpoint): void {
    this.checkpoints = this.checkpoints.filter((c) => c.step !== cp.step);
    this.checkpoints.push(cp);
    this.checkpoints.sort((a, b) => a.step - b.step);
  }

  /** Latest checkpoint with step <= `step`, or undefined if none exists. */
  nearestAtOrBefore(step: number): Checkpoint | undefined {
    let best: Checkpoint | undefined;
    for (const c of this.checkpoints) {
      if (c.step <= step) best = c;
      else break;
    }
    return best;
  }

  list(): readonly Checkpoint[] {
    return this.checkpoints;
  }
}
