/**
 * ProofRepository - durable storage port for committed proof history.
 *
 * `saveCommit` is the persistence half of the transaction described in the
 * spec (BEGIN -> ... -> persist -> COMMIT): the engine only advances its
 * in-memory frontier AFTER this promise resolves. A Postgres implementation
 * must write the state, transition and goal-ledger rows in ONE database
 * transaction so a crash can never leave a half-committed step (Invariant 2).
 */
import type {
  Checkpoint,
  Goal,
  ProofState,
  ProofTransition,
} from "@proof-explorer/protocol";

export interface CommitRecord {
  state: ProofState;
  /** Absent for step 0 (there is no transition into the initial state). */
  transition?: ProofTransition;
  closedGoals: Goal[];
  createdGoals: Goal[];
  /** Persist the full state body (true at checkpoints); otherwise hash only. */
  keepBody: boolean;
}

export interface ProofRepository {
  saveCommit(sessionId: string, record: CommitRecord): Promise<void>;

  /** Full state if its body was retained (checkpoints), else undefined. */
  getState(sessionId: string, step: number): Promise<ProofState | undefined>;
  /** Hash is retained for EVERY committed step. */
  getStateHash(sessionId: string, step: number): Promise<string | undefined>;

  getTransition(sessionId: string, step: number): Promise<ProofTransition | undefined>;
  listTransitions(
    sessionId: string,
    fromStep: number,
    limit: number,
  ): Promise<ProofTransition[]>;

  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  listCheckpoints(sessionId: string): Promise<Checkpoint[]>;
}

/**
 * In-memory implementation used by tests and local development. It mimics the
 * production storage policy: bodies are kept ONLY for checkpoint steps, which
 * forces the engine's checkpoint + replay path to be exercised for real.
 */
export class InMemoryProofRepository implements ProofRepository {
  private readonly bodies = new Map<string, ProofState>();
  private readonly hashes = new Map<string, string>();
  private readonly transitions = new Map<string, ProofTransition>();
  private readonly checkpoints = new Map<string, Checkpoint[]>();

  private static key(sessionId: string, step: number): string {
    return `${sessionId}:${step}`;
  }

  async saveCommit(sessionId: string, r: CommitRecord): Promise<void> {
    const k = InMemoryProofRepository.key(sessionId, r.state.stepNumber);
    this.hashes.set(k, r.state.stateHash);
    if (r.keepBody) this.bodies.set(k, r.state);
    if (r.transition) this.transitions.set(k, r.transition);
  }

  async getState(sessionId: string, step: number) {
    return this.bodies.get(InMemoryProofRepository.key(sessionId, step));
  }

  async getStateHash(sessionId: string, step: number) {
    return this.hashes.get(InMemoryProofRepository.key(sessionId, step));
  }

  async getTransition(sessionId: string, step: number) {
    return this.transitions.get(InMemoryProofRepository.key(sessionId, step));
  }

  async listTransitions(sessionId: string, fromStep: number, limit: number) {
    const out: ProofTransition[] = [];
    for (let s = Math.max(1, fromStep); out.length < limit; s++) {
      const t = this.transitions.get(InMemoryProofRepository.key(sessionId, s));
      if (!t) break;
      out.push(t);
    }
    return out;
  }

  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    const list = (this.checkpoints.get(cp.sessionId) ?? []).filter(
      (c) => c.step !== cp.step,
    );
    list.push(cp);
    this.checkpoints.set(cp.sessionId, list);
  }

  async listCheckpoints(sessionId: string) {
    return [...(this.checkpoints.get(sessionId) ?? [])].sort(
      (a, b) => a.step - b.step,
    );
  }

  /** TEST HOOK: simulate on-disk corruption of a stored checkpoint body. */
  corruptBody(sessionId: string, step: number): void {
    const k = InMemoryProofRepository.key(sessionId, step);
    const s = this.bodies.get(k);
    if (s) this.bodies.set(k, { ...s, stateHash: "corrupted" });
  }
}
