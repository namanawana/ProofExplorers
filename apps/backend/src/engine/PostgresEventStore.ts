/**
 * PostgresEventStore - durable PostgreSQL append-only event store.
 *
 * Implements P8-01:
 *   - Monotonic gap-free `seq` per session
 *   - Append-only `events` table
 *   - Fast query with `seq > afterSeq` for reconnect replay
 *   - In-process subscription pub/sub
 */
import type { Pool } from "pg";
import type { DomainEvent, EventType } from "@proof-explorer/protocol";
import type { Clock } from "../util/index";
import type { EventListener, EventStore } from "./EventStore";

export class PostgresEventStore implements EventStore {
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async append(
    sessionId: string,
    type: EventType,
    payload: Record<string, unknown>,
  ): Promise<DomainEvent> {
    const timestamp = this.clock.now();

    // Determine next monotonic seq for this session
    const seqRes = await this.pool.query<{ next_seq: string }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM events WHERE session_id = $1`,
      [sessionId],
    );
    const seq = Number(seqRes.rows[0]?.next_seq ?? 1);

    await this.pool.query(
      `INSERT INTO events (session_id, seq, type, timestamp, payload)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5)`,
      [sessionId, seq, type, timestamp, JSON.stringify(payload)],
    );

    const event: DomainEvent = {
      seq,
      sessionId,
      type,
      timestamp,
      payload,
    };

    // Notify live subscribers
    const subs = this.listeners.get(sessionId);
    if (subs) {
      for (const listener of subs) {
        try {
          listener(event);
        } catch {
          // Subscriber errors do not abort event commit
        }
      }
    }

    return event;
  }

  async read(sessionId: string, afterSeq = 0, limit = 200): Promise<DomainEvent[]> {
    const res = await this.pool.query<{
      seq: string;
      session_id: string;
      type: EventType;
      timestamp: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT seq, session_id, type, timestamp, payload
       FROM events
       WHERE session_id = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [sessionId, afterSeq, limit],
    );

    return res.rows.map((r) => ({
      seq: Number(r.seq),
      sessionId: r.session_id,
      type: r.type,
      timestamp: r.timestamp.getTime(),
      payload: r.payload,
    }));
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }
}
