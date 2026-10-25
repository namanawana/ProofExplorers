/**
 * PostgresProofRepository - durable PostgreSQL implementation of ProofRepository.
 *
 * Implements P8-01:
 *   - Atomic single-transaction commits (BEGIN -> persist state, transition, goals -> COMMIT)
 *   - Full state bodies stored at checkpoints only
 *   - State hash retained for every step
 *   - Rollback on failure
 */
import type { Pool } from "pg";
import type {
  Checkpoint,
  ProofState,
  ProofTransition,
} from "@proof-explorer/protocol";
import type { CommitRecord, ProofRepository } from "./ProofRepository";

export class PostgresProofRepository implements ProofRepository {
  constructor(private readonly pool: Pool) {}

  async saveCommit(sessionId: string, record: CommitRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const s = record.state;
      // 1. Save proof_state
      await client.query(
        `INSERT INTO proof_states (
          id, session_id, step, state_hash, parent_state_id, open_goal_ids, full_state
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (session_id, step) DO UPDATE
        SET state_hash = EXCLUDED.state_hash,
            open_goal_ids = EXCLUDED.open_goal_ids,
            full_state = EXCLUDED.full_state`,
        [
          s.id,
          sessionId,
          s.stepNumber,
          s.stateHash,
          s.parentStateId ?? null,
          s.goals.map((g) => g.id),
          record.keepBody ? JSON.stringify(s) : null,
        ],
      );

      // 2. Save transition if present
      if (record.transition) {
        const t = record.transition;
        await client.query(
          `INSERT INTO proof_transitions (
            id, session_id, step, from_state_id, to_state_id, command, duration_ms, generated_goals, solved_goals
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (session_id, step) DO NOTHING`,
          [
            t.id,
            sessionId,
            s.stepNumber,
            t.fromStateId,
            t.toStateId,
            t.command,
            t.durationMs ?? null,
            t.generatedGoals ?? [],
            t.solvedGoals ?? [],
          ],
        );
      }

      // 3. Save created goals
      for (const g of record.createdGoals) {
        await client.query(
          `INSERT INTO goals (
            id, session_id, parent_goal_id, created_at_step, solved_at_step, status, case_name, target, local_context
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (session_id, id) DO UPDATE
          SET status = EXCLUDED.status, target = EXCLUDED.target, local_context = EXCLUDED.local_context`,
          [
            g.id,
            sessionId,
            g.parentGoalId ?? null,
            g.createdAtStep,
            g.solvedAtStep ?? null,
            g.status,
            g.caseName ?? null,
            g.target,
            JSON.stringify(g.localContext),
          ],
        );
      }

      // 4. Update closed goals
      for (const g of record.closedGoals) {
        await client.query(
          `UPDATE goals
           SET status = 'solved', solved_at_step = $1
           WHERE session_id = $2 AND id = $3`,
          [s.stepNumber, sessionId, g.id],
        );
      }

      // 5. Update session frontier
      await client.query(
        `UPDATE sessions
         SET frontier_step = GREATEST(frontier_step, $1), last_active_at = now()
         WHERE id = $2`,
        [s.stepNumber, sessionId],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getState(sessionId: string, step: number): Promise<ProofState | undefined> {
    const res = await this.pool.query<{ full_state: ProofState | null }>(
      `SELECT full_state FROM proof_states WHERE session_id = $1 AND step = $2`,
      [sessionId, step],
    );
    return res.rows[0]?.full_state ?? undefined;
  }

  async getStateHash(sessionId: string, step: number): Promise<string | undefined> {
    const res = await this.pool.query<{ state_hash: string }>(
      `SELECT state_hash FROM proof_states WHERE session_id = $1 AND step = $2`,
      [sessionId, step],
    );
    return res.rows[0]?.state_hash ?? undefined;
  }

  async getTransition(sessionId: string, step: number): Promise<ProofTransition | undefined> {
    const res = await this.pool.query<{
      id: string;
      from_state_id: string;
      to_state_id: string;
      command: string;
      duration_ms: number | null;
      generated_goals: string[];
      solved_goals: string[];
    }>(
      `SELECT id, from_state_id, to_state_id, command, duration_ms, generated_goals, solved_goals
       FROM proof_transitions WHERE session_id = $1 AND step = $2`,
      [sessionId, step],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      fromStateId: row.from_state_id,
      toStateId: row.to_state_id,
      command: row.command,
      verified: true,
      durationMs: row.duration_ms ?? undefined,
      generatedGoals: row.generated_goals,
      solvedGoals: row.solved_goals,
    };
  }

  async listTransitions(
    sessionId: string,
    fromStep: number,
    limit: number,
  ): Promise<ProofTransition[]> {
    const res = await this.pool.query<{
      id: string;
      from_state_id: string;
      to_state_id: string;
      command: string;
      duration_ms: number | null;
      generated_goals: string[];
      solved_goals: string[];
    }>(
      `SELECT id, from_state_id, to_state_id, command, duration_ms, generated_goals, solved_goals
       FROM proof_transitions
       WHERE session_id = $1 AND step >= $2
       ORDER BY step ASC
       LIMIT $3`,
      [sessionId, fromStep, limit],
    );
    return res.rows.map((row) => ({
      id: row.id,
      fromStateId: row.from_state_id,
      toStateId: row.to_state_id,
      command: row.command,
      verified: true,
      durationMs: row.duration_ms ?? undefined,
      generatedGoals: row.generated_goals,
      solvedGoals: row.solved_goals,
    }));
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkpoints (
        id, session_id, proof_unit_id, step, state_id, state_hash, document_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
      ON CONFLICT (session_id, step) DO NOTHING`,
      [
        checkpoint.id,
        checkpoint.sessionId,
        checkpoint.proofUnitId,
        checkpoint.step,
        checkpoint.stateId,
        checkpoint.stateHash,
        checkpoint.documentVersion,
        checkpoint.createdAt,
      ],
    );
  }

  async listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    const res = await this.pool.query<{
      id: string;
      session_id: string;
      proof_unit_id: string;
      step: number;
      state_id: string;
      state_hash: string;
      document_version: number;
      created_at: Date;
    }>(
      `SELECT id, session_id, proof_unit_id, step, state_id, state_hash, document_version, created_at
       FROM checkpoints
       WHERE session_id = $1
       ORDER BY step ASC`,
      [sessionId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      proofUnitId: r.proof_unit_id,
      step: r.step,
      stateId: r.state_id,
      stateHash: r.state_hash,
      documentVersion: r.document_version,
      createdAt: r.created_at.getTime(),
    }));
  }
}
