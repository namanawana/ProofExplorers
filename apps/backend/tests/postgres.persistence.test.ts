import { describe, expect, it } from "vitest";
import { PostgresProofRepository } from "../src/engine/PostgresProofRepository";
import { PostgresEventStore } from "../src/engine/PostgresEventStore";
import { systemClock } from "../src/util/index";
import type { Pool, PoolClient } from "pg";
import type { CommitRecord } from "../src/engine/ProofRepository";
import type { ProofState } from "@proof-explorer/protocol";

// Lightweight in-memory query simulator for verifying SQL contracts and transactions
class MockPool {
  queries: Array<{ text: string; values?: unknown[] }> = [];
  rowsByQuery: Record<string, unknown[]> = {};
  transactionActive = false;
  shouldFailCommit = false;

  async query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });
    if (text === "BEGIN") this.transactionActive = true;
    if (text === "COMMIT") this.transactionActive = false;
    if (text === "ROLLBACK") this.transactionActive = false;

    if (text.includes("SELECT COALESCE(MAX(seq), 0) + 1")) {
      return { rows: [{ next_seq: "1" }] as unknown as T[] };
    }
    if (text.includes("SELECT state_hash FROM proof_states")) {
      return { rows: [{ state_hash: "mockhash123" }] as unknown as T[] };
    }
    return { rows: [] };
  }

  async connect(): Promise<PoolClient> {
    const client = {
      query: async (text: string, values?: unknown[]) => {
        this.queries.push({ text, values });
        if (text === "BEGIN") this.transactionActive = true;
        if (text === "COMMIT") {
          if (this.shouldFailCommit) throw new Error("database write error");
          this.transactionActive = false;
        }
        if (text === "ROLLBACK") this.transactionActive = false;
        return { rows: [] };
      },
      release: () => {},
    };
    return client as unknown as PoolClient;
  }
}

describe("P8-01: Postgres Persistence, Transactions and Invariants", () => {
  it("commits proof transitions atomically in a single transaction", async () => {
    const mock = new MockPool();
    const repo = new PostgresProofRepository(mock as unknown as Pool);

    const state: ProofState = {
      id: "s1@1:hash",
      proofUnitId: "u1",
      stepNumber: 1,
      goals: [],
      localContext: [],
      stateHash: "mockhash123",
      timestamp: systemClock.now(),
    };

    const record: CommitRecord = {
      state,
      transition: {
        id: "t1",
        fromStateId: "s0",
        toStateId: "s1",
        command: "simp",
        verified: true,
      },
      closedGoals: [],
      createdGoals: [],
      keepBody: true,
    };

    await repo.saveCommit("s1", record);

    const sqls = mock.queries.map((q) => q.text.trim());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.some((s) => s.startsWith("INSERT INTO proof_states"))).toBe(true);
    expect(sqls.some((s) => s.startsWith("INSERT INTO proof_transitions"))).toBe(true);
    expect(sqls.at(-1)).toBe("COMMIT");
    expect(mock.transactionActive).toBe(false);
  });

  it("rolls back cleanly if a write fails mid-transaction", async () => {
    const mock = new MockPool();
    mock.shouldFailCommit = true;
    const repo = new PostgresProofRepository(mock as unknown as Pool);

    const state: ProofState = {
      id: "s1@1:hash",
      proofUnitId: "u1",
      stepNumber: 1,
      goals: [],
      localContext: [],
      stateHash: "mockhash123",
      timestamp: systemClock.now(),
    };

    const record: CommitRecord = {
      state,
      closedGoals: [],
      createdGoals: [],
      keepBody: false,
    };

    await expect(repo.saveCommit("s1", record)).rejects.toThrow("database write error");

    const sqls = mock.queries.map((q) => q.text.trim());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.at(-1)).toBe("ROLLBACK");
    expect(mock.transactionActive).toBe(false);
  });

  it("appends monotonic events to PostgreSQL event log", async () => {
    const mock = new MockPool();
    const eventStore = new PostgresEventStore(mock as unknown as Pool, systemClock);

    const event = await eventStore.append("sess-1", "COMMAND_STARTED", { step: 1 });
    expect(event.seq).toBe(1);
    expect(event.type).toBe("COMMAND_STARTED");

    const sqls = mock.queries.map((q) => q.text.trim());
    expect(sqls.some((s) => s.startsWith("INSERT INTO events"))).toBe(true);
  });
});
