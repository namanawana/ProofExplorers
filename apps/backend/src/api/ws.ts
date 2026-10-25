/**
 * WebSocket layer - the real-time proof protocol.
 *
 * Rules enforced here:
 *   - every inbound message is validated; malformed input yields an ERROR and
 *     never crashes the connection
 *   - protocolVersion is checked on every message
 *   - the server NEVER pushes a STATE_UPDATE that the engine has not committed
 *     (the client cannot advance optimistically; it waits for this message)
 *   - errors are returned with the originating requestId so the UI can show
 *     them next to the action that failed
 */
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorPayload,
  type ServerMessage,
  type SessionInfo,
} from "@proof-explorer/protocol";
import type { EventStore } from "../engine/EventStore";
import type { SessionManager } from "../session/SessionManager";
import { AppError, type Logger } from "../util/index";

const CLIENT_TYPES = new Set(["ATTACH", "DETACH", "NEXT", "PREVIOUS", "RESET", "JUMP", "ENTER_UNIT", "PING"]);

/** Runtime validation of an inbound frame. Throws AppError(INVALID_MESSAGE). */
export function parseClientMessage(raw: string): ClientMessage {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AppError("INVALID_MESSAGE", "Message is not valid JSON");
  }
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    throw new AppError(
      "PROTOCOL_VERSION_MISMATCH",
      `Server speaks protocol ${PROTOCOL_VERSION}`,
    );
  }
  if (typeof msg.type !== "string" || !CLIENT_TYPES.has(msg.type)) {
    throw new AppError("INVALID_MESSAGE", `Unknown message type`);
  }
  if (typeof msg.requestId !== "string" || typeof msg.sessionId !== "string") {
    throw new AppError("INVALID_MESSAGE", "requestId and sessionId are required");
  }
  const payload = (msg.payload ?? {}) as Record<string, unknown>;
  if (msg.type === "JUMP" && !Number.isInteger(payload.step)) {
    throw new AppError("INVALID_MESSAGE", "JUMP requires an integer step");
  }
  if (msg.type === "ENTER_UNIT" && typeof payload.proofUnitId !== "string") {
    throw new AppError("INVALID_MESSAGE", "ENTER_UNIT requires proofUnitId");
  }
  return msg as unknown as ClientMessage;
}

/** Extract requestId/sessionId from a frame that failed validation, if present. */
function bestEffortIds(raw: string): { requestId: string; sessionId: string } {
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    return {
      requestId: typeof m.requestId === "string" ? m.requestId : "unknown",
      sessionId: typeof m.sessionId === "string" ? m.sessionId : "unknown",
    };
  } catch {
    return { requestId: "unknown", sessionId: "unknown" };
  }
}

export const WS_BACKPRESSURE_LIMIT_BYTES = 512 * 1024; // 512 KB
export const WS_HARD_LIMIT_BYTES = 4 * 1024 * 1024; // 4 MB

export function attachWebSocket(
  http: HttpServer,
  deps: { sessions: SessionManager; events: EventStore; logger: Logger },
  heartbeatMs = 30_000,
): WebSocketServer {
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 64 * 1024 });
  const { sessions, events, logger } = deps;

  // Heartbeat (P3-03): ping every client periodically; a client that did not
  // answer the previous ping is considered dead and terminated, which frees
  // its subscriptions instead of leaking them.
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (socket) => {
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    /** Cleanup callbacks for subscriptions made by ATTACH. */
    const detach = new Map<string, Array<() => void>>();

    const send = (m: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

    let needsResync = false;
    const sendPush = (m: ServerMessage): void => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > WS_HARD_LIMIT_BYTES) {
        logger.warn("client buffer exceeded hard ceiling, terminating connection", {
          bufferedAmount: socket.bufferedAmount,
        });
        socket.terminate();
        return;
      }
      if (socket.bufferedAmount > WS_BACKPRESSURE_LIMIT_BYTES) {
        needsResync = true;
        // Coalesce / drop disposable realtime pushes for slow clients
        // The durable history lives in EventStore; client can fetch /events?after=
        return;
      }
      if (needsResync && socket.bufferedAmount === 0) {
        needsResync = false;
      }
      socket.send(JSON.stringify(m));
    };

    const sendError = (requestId: string, sessionId: string, err: unknown): void => {
      const app = err instanceof AppError ? err : new AppError("INTERNAL", "Internal error");
      if (!(err instanceof AppError)) logger.error("ws handler failed", { error: String(err) });
      const payload: ErrorPayload = { code: app.code, message: app.message, diagnostics: app.diagnostics };
      send({ protocolVersion: PROTOCOL_VERSION, type: "ERROR", requestId, sessionId, payload });
    };

    socket.on("message", (data) => {
      void handle(data.toString());
    });

    socket.on("close", () => {
      for (const fns of detach.values()) fns.forEach((f) => f());
      detach.clear();
    });

    async function handle(raw: string): Promise<void> {
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(raw);
      } catch (err) {
        // Echo the client's own ids when they can be read, so the UI can pin
        // the error to the request that caused it; "unknown" only as a last resort.
        const ids = bestEffortIds(raw);
        sendError(ids.requestId, ids.sessionId, err);
        return;
      }
      const base = { protocolVersion: PROTOCOL_VERSION, requestId: msg.requestId, sessionId: msg.sessionId } as const;

      try {
        switch (msg.type) {
          case "PING":
            send({ ...base, type: "PONG", payload: {} });
            return;

          case "ATTACH": {
            const info = sessions.get(msg.sessionId);
            if (!info) throw new AppError("UNKNOWN_SESSION", "No such session");
            subscribe(socket, msg.sessionId, detach, sendPush, sessions, events);
            send({ ...base, type: "SESSION_STATUS", payload: info });
            return;
          }

          case "DETACH": {
            const fns = detach.get(msg.sessionId);
            if (fns) {
              for (const fn of fns) fn();
              detach.delete(msg.sessionId);
            }
            send({ ...base, type: "PONG", payload: {} });
            return;
          }

          case "NEXT":
          case "PREVIOUS":
          case "RESET":
          case "JUMP": {
            const result =
              msg.type === "NEXT" ? await sessions.next(msg.sessionId)
              : msg.type === "PREVIOUS" ? await sessions.previous(msg.sessionId)
              : msg.type === "RESET" ? await sessions.reset(msg.sessionId)
              : await sessions.jump(msg.sessionId, msg.payload.step);
            send({
              ...base,
              type: "STATE_UPDATE",
              payload: {
                step: result.outcome.state.stepNumber,
                verified: true, // Invariant 1: only committed states reach here
                state: result.outcome.state,
                transition: result.outcome.transition,
                session: result.info,
              },
            });
            return;
          }

          case "ENTER_UNIT": {
            // Entering a nested proof opens a NEW session on that unit; the
            // client keeps the parent session so "go back" is instantaneous.
            const parent = sessions.get(msg.sessionId);
            if (!parent) throw new AppError("UNKNOWN_SESSION", "No such session");
            const { info, initial } = await sessions.create({
              projectId: parent.projectId,
              fileId: parent.fileId,
              proofUnitId: msg.payload.proofUnitId,
            });
            send({
              ...base,
              type: "STATE_UPDATE",
              payload: {
                step: initial.state.stepNumber,
                verified: true,
                state: initial.state,
                session: info,
                transition: initial.transition,
              },
            });
            return;
          }
        }
      } catch (err) {
        sendError(msg.requestId, msg.sessionId, err);
      }
    }
  });

  return wss;
}

/** Forward status changes and domain events of one session to this socket. */
function subscribe(
  socket: WebSocket,
  sessionId: string,
  detach: Map<string, Array<() => void>>,
  send: (m: ServerMessage) => void,
  sessions: SessionManager,
  events: EventStore,
): void {
  if (detach.has(sessionId)) return; // already attached
  const stopStatus = sessions.onStatus((info: SessionInfo) => {
    if (info.id === sessionId) {
      send({ protocolVersion: PROTOCOL_VERSION, type: "SESSION_STATUS", requestId: "push", sessionId, payload: info });
    }
  });
  const stopEvents = events.subscribe(sessionId, (event) =>
    send({ protocolVersion: PROTOCOL_VERSION, type: "EVENT", requestId: "push", sessionId, payload: event }),
  );
  detach.set(sessionId, [stopStatus, stopEvents]);
  void socket; // socket lifetime is handled by the caller's close handler
}
