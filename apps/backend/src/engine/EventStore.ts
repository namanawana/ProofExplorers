/**
 * EventStore - append-only log of everything the engine does.
 *
 * The log is for debugging, auditing and live observation (it is streamed to
 * the browser as EVENT messages). It is NOT the correctness authority and is
 * not required to rebuild proof states: those are recomputed from Lean.
 *
 * Contract: events are never mutated or deleted. `seq` is strictly increasing
 * per session with no gaps.
 */
import type { DomainEvent, EventType } from "@proof-explorer/protocol";
import type { Clock } from "../util/index";

export type EventListener = (event: DomainEvent) => void;

export interface EventStore {
  append(
    sessionId: string,
    type: EventType,
    payload: Record<string, unknown>,
  ): Promise<DomainEvent>;

  /** Events with seq > afterSeq, oldest first (for reconnecting clients). */
  read(sessionId: string, afterSeq?: number, limit?: number): Promise<DomainEvent[]>;

  /** Live tail. Returns an unsubscribe function. */
  subscribe(sessionId: string, listener: EventListener): () => void;
}

/** In-memory implementation; the Postgres one writes to the `events` table. */
export class InMemoryEventStore implements EventStore {
  private readonly logs = new Map<string, DomainEvent[]>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly clock: Clock) {}

  async append(
    sessionId: string,
    type: EventType,
    payload: Record<string, unknown>,
  ): Promise<DomainEvent> {
    const log = this.logs.get(sessionId) ?? [];
    const event: DomainEvent = {
      seq: log.length + 1,
      sessionId,
      type,
      timestamp: this.clock.now(),
      payload,
    };
    log.push(event);
    this.logs.set(sessionId, log);
    for (const l of this.listeners.get(sessionId) ?? []) {
      try {
        l(event);
      } catch {
        // A faulty subscriber must never break event recording.
      }
    }
    return event;
  }

  async read(sessionId: string, afterSeq = 0, limit = 500): Promise<DomainEvent[]> {
    return (this.logs.get(sessionId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .slice(0, limit);
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => set.delete(listener);
  }
}
