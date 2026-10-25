/**
 * ProofSocket - typed WebSocket client for the proof protocol.
 *
 * Responsibilities: connect, correlate requests with responses by `requestId`,
 * and surface unsolicited server pushes (SESSION_STATUS, EVENT) via a handler.
 *
 * It holds NO proof state. The UI changes only when a STATE_UPDATE arrives, so
 * the frontend can never be a source of proof correctness (Invariant 5) and
 * never advances optimistically.
 */
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@proof-explorer/protocol";

type Pending = {
  resolve: (m: ServerMessage) => void;
  reject: (e: Error) => void;
};

/** Distributes Omit across the ClientMessage union so each variant keeps its payload type. */
type Outgoing = ClientMessage extends infer M
  ? M extends ClientMessage
    ? Omit<M, "protocolVersion" | "requestId">
    : never
  : never;

export class ProofSocket {
  private ws?: WebSocket;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private intentionalClose = false;

  constructor(
    private readonly url: string,
    /** Called for every message that is not the reply to a pending request. */
    private readonly onPush: (m: ServerMessage) => void,
    private readonly onClose: () => void,
  ) {}

  connect(): Promise<void> {
    this.intentionalClose = false;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("WebSocket connection failed"));
      this.ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error("connection closed"));
        this.pending.clear();
        if (!this.intentionalClose) this.onClose();
      };
      this.ws.onmessage = (ev) => this.receive(JSON.parse(String(ev.data)) as ServerMessage);
    });
  }

  /** Send a command and resolve with the server's reply (or reject on ERROR). */
  request(msg: Outgoing): Promise<ServerMessage> {
    const requestId = `r${++this.seq}`;
    const frame = { ...msg, protocolVersion: PROTOCOL_VERSION, requestId };
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not connected"));
        return;
      }
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify(frame));
    });
  }

  close(): void {
    this.intentionalClose = true;
    this.ws?.close();
  }

  private receive(m: ServerMessage): void {
    const p = this.pending.get(m.requestId);
    if (!p) return this.onPush(m);
    this.pending.delete(m.requestId);
    if (m.type === "ERROR") p.reject(new Error(`${m.payload.code}: ${m.payload.message}`));
    else p.resolve(m);
  }
}
