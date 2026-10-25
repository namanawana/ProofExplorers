/**
 * Minimal JSON-RPC 2.0 client over LSP-style `Content-Length` framing.
 *
 * Responsibilities (and nothing more):
 *   - frame/unframe messages on a pair of byte streams
 *   - correlate responses with requests, with per-request timeouts
 *   - fan out server notifications to registered handlers
 *   - politely answer server->client requests (Lean sends a few, e.g.
 *     `client/registerCapability`) so the server never blocks on us
 *
 * It has no knowledge of Lean; that lives in LspLeanAdapter.
 */
import type { Readable, Writable } from "node:stream";

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

type NotificationHandler = (params: unknown) => void;

interface IncomingMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class JsonRpcConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers = new Map<string, NotificationHandler[]>();

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    input.on("data", (chunk: Buffer) => this.onData(chunk));
    input.on("close", () => this.close(new Error("Lean connection closed")));
    // A write to a dead process emits 'error' on stdin; swallow it here -
    // the exit handler in the adapter is what reports the crash.
    output.on("error", () => undefined);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Fail every in-flight request and stop accepting new ones. */
  close(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  // -- framing --------------------------------------------------------------

  private send(message: object): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.output.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return; // need more bytes

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const bodyStart = headerEnd + 4;
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed header block: drop it and resynchronise on the next one.
        this.buffer = this.buffer.subarray(bodyStart);
        continue;
      }
      const length = Number(match[1]);
      if (this.buffer.length < bodyStart + length) return; // body incomplete

      const body = this.buffer
        .subarray(bodyStart, bodyStart + length)
        .toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);

      try {
        this.dispatch(JSON.parse(body) as IncomingMessage);
      } catch {
        // A single undecodable message must never kill the connection.
      }
    }
  }

  private dispatch(msg: IncomingMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new JsonRpcError(msg.error.code, msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // Server -> client request: acknowledge with a null result.
    if (msg.id !== undefined && msg.method !== undefined) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    // Notification.
    if (msg.method !== undefined) {
      for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
    }
  }
}
