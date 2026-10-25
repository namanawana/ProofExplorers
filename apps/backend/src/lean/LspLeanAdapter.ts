/**
 * LspLeanAdapter - LeanAdapter implemented on top of Lean's language server.
 *
 * LSP surface actually used (all part of the standard LSP spec or documented
 * Lean extensions; re-verify each against the pinned Lean version before
 * relying on it - see docs/TASKS.md, task P1-02):
 *
 *   -> initialize / initialized
 *   -> textDocument/didOpen, textDocument/didChange   (full-text sync)
 *   <- textDocument/publishDiagnostics                (errors, warnings)
 *   <- $/lean/fileProgress                            (elaboration progress;
 *                                                      empty `processing` list
 *                                                      == file fully checked)
 *   -> $/lean/plainGoal                               (goals at a position)
 *
 * We deliberately avoid RPC-session APIs (`$/lean/rpc/*`) in v1. They return
 * richer data (e.g. metavariable ids for goal identity) and are the planned
 * upgrade path, but they are the part most likely to change between releases.
 */
import { pathToFileURL } from "node:url";
import type {
  Diagnostic,
  DiagnosticSeverity,
  SourcePosition,
} from "@proof-explorer/protocol";
import { AppError, makeRange, newId, type Logger } from "../util/index";
import { parseGoalText } from "./GoalTextParser";
import type {
  GoalSnapshot,
  LeanAdapter,
  LeanDocument,
  LeanSessionHandle,
  LeanSessionOptions,
} from "./LeanAdapter";
import { JsonRpcConnection } from "./JsonRpcConnection";
import type { LeanProcess, LeanProcessLauncher } from "./LeanProcessLauncher";

/** Per-document bookkeeping, mutated only by notification handlers. */
interface DocState {
  fileId: string;
  text: string;
  version: number;
  /** True from didOpen/didChange until Lean confirms the document is settled. */
  elaborating: boolean;
  /** Set when Lean has emitted at least one progress notification for this version. */
  progressSeen: boolean;
  /** A fatal fileProgress notification means the document cannot be trusted. */
  fatalError: boolean;
  diagnostics: Diagnostic[];
  waiters: Array<() => void>;
}

interface SessionCtx {
  handle: LeanSessionHandle;
  proc: LeanProcess;
  conn: JsonRpcConnection;
  docs: Map<string, DocState>;
  crashListeners: Array<() => void>;
  disposed: boolean;
}

const REQUEST_TIMEOUT_MS = 30_000;

const SEVERITY: Record<number, DiagnosticSeverity> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

export class LspLeanAdapter implements LeanAdapter {
  private readonly sessions = new Map<string, SessionCtx>();

  constructor(
    private readonly launcher: LeanProcessLauncher,
    private readonly logger: Logger,
    /** If set, a mismatch with the server's reported version is logged. */
    private readonly pinnedLeanVersion?: string,
  ) {}

  // -- lifecycle ------------------------------------------------------------

  async createSession(options: LeanSessionOptions): Promise<LeanSessionHandle> {
    const proc = this.launcher.launch({ projectRoot: options.projectRoot });
    const conn = new JsonRpcConnection(proc.stdout, proc.stdin);
    const id = newId();
    const ctx: SessionCtx = {
      handle: { id, leanVersion: "unknown" },
      proc,
      conn,
      docs: new Map(),
      crashListeners: [],
      disposed: false,
    };
    this.sessions.set(id, ctx);

    conn.onNotification("textDocument/publishDiagnostics", (p) =>
      this.onDiagnostics(ctx, p),
    );
    conn.onNotification("$/lean/fileProgress", (p) =>
      this.onFileProgress(ctx, p),
    );
    proc.onExit((code) => this.onExit(ctx, code));

    try {
      const init = await conn.request<{
        serverInfo?: { name?: string; version?: string };
      }>(
        "initialize",
        {
          processId: null,
          rootUri: pathToFileURL(options.projectRoot).href,
          capabilities: {},
        },
        options.startupTimeoutMs,
      );
      conn.notify("initialized", {});

      const leanVersion = init?.serverInfo?.version ?? "unknown";
      ctx.handle = { id, leanVersion };
      if (this.pinnedLeanVersion && leanVersion !== this.pinnedLeanVersion) {
        this.logger.warn("lean version differs from pinned version", {
          pinned: this.pinnedLeanVersion,
          actual: leanVersion,
        });
      }
      return ctx.handle;
    } catch (err) {
      await this.disposeSession(ctx.handle);
      throw new AppError(
        "LEAN_CRASHED",
        `Lean failed to start: ${(err as Error).message}`,
      );
    }
  }

  async disposeSession(session: LeanSessionHandle): Promise<void> {
    const ctx = this.sessions.get(session.id);
    if (!ctx || ctx.disposed) return;
    ctx.disposed = true;
    ctx.conn.close(new Error("session disposed"));
    ctx.proc.kill();
    this.sessions.delete(session.id);
  }

  onCrash(session: LeanSessionHandle, listener: () => void): void {
    this.ctx(session).crashListeners.push(listener);
  }

  // -- documents ------------------------------------------------------------

  async openDocument(
    session: LeanSessionHandle,
    doc: LeanDocument,
  ): Promise<void> {
    const ctx = this.ctx(session);
    ctx.docs.set(doc.uri, {
      fileId: doc.fileId,
      text: doc.text,
      version: 1,
      elaborating: true,
      progressSeen: false,
      fatalError: false,
      diagnostics: [],
      waiters: [],
    });
    ctx.conn.notify("textDocument/didOpen", {
      textDocument: {
        uri: doc.uri,
        languageId: "lean4",
        version: 1,
        text: doc.text,
      },
    });
  }

  async replaceDocument(
    session: LeanSessionHandle,
    uri: string,
    text: string,
  ): Promise<void> {
    const ctx = this.ctx(session);
    const doc = this.doc(ctx, uri);
    doc.version += 1;
    doc.text = text;
    doc.elaborating = true;
    doc.progressSeen = false;
    doc.fatalError = false;
    doc.diagnostics = [];
    ctx.conn.notify("textDocument/didChange", {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text }], // full-document sync
    });
  }

  async awaitElaboration(
    session: LeanSessionHandle,
    uri: string,
    timeoutMs: number,
  ): Promise<void> {
    const ctx = this.ctx(session);
    const doc = this.doc(ctx, uri);
    if (!doc.elaborating) {
      if (doc.fatalError) throw new AppError("LEAN_CRASHED", "Lean reported a fatal file error");
      return;
    }

    // Lean normally emits $/lean/fileProgress, but a client can miss the
    // initial notification if it arrives immediately after didOpen. Use
    // plainGoal as a second completion barrier: Lean's request handler waits
    // for the relevant document snapshot before answering. This prevents a
    // false 120s timeout on fast/cached files or Lean versions that differ in
    // their progress-notification timing.
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (err?: Error): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        doc.waiters = doc.waiters.filter((w) => w !== onProgressDone);
        if (err) reject(err);
        else resolve();
      };
      const onProgressDone = (): void => finish();
      const timer = setTimeout(() => {
        finish(new AppError("LEAN_TIMEOUT", "Lean elaboration timed out"));
      }, timeoutMs);

      if (!doc.elaborating) {
        finish();
        return;
      }
      doc.waiters.push(onProgressDone);

      const lines = doc.text.split(/\r?\n/);
      const endLine = Math.max(0, lines.length - 1);
      const endCharacter = (lines[endLine] ?? "").length;
      void ctx.conn.request<unknown>(
        "$/lean/plainGoal",
        { textDocument: { uri }, position: { line: endLine, character: endCharacter } },
        timeoutMs,
      ).then(() => finish()).catch((err) => finish(
        new AppError("LEAN_TIMEOUT", (err as Error).message),
      ));
    });

    if (doc.fatalError) {
      throw new AppError("LEAN_CRASHED", "Lean reported a fatal file error");
    }
  }

  async getDiagnostics(
    session: LeanSessionHandle,
    uri: string,
  ): Promise<Diagnostic[]> {
    return [...this.doc(this.ctx(session), uri).diagnostics];
  }

  // -- proof state ----------------------------------------------------------

  async getGoalsAt(
    session: LeanSessionHandle,
    uri: string,
    position: SourcePosition,
  ): Promise<GoalSnapshot> {
    const ctx = this.ctx(session);
    const doc = this.doc(ctx, uri);
    try {
      // Result is `null` when there is no tactic block at the position.
      const res = await ctx.conn.request<{
        rendered?: string;
        goals?: string[];
      } | null>(
        "$/lean/plainGoal",
        {
          textDocument: { uri },
          position: { line: position.line, character: position.column },
        },
        REQUEST_TIMEOUT_MS,
      );
      return {
        goals: (res?.goals ?? []).map(parseGoalText),
        rendered: res?.rendered ?? "",
        documentVersion: doc.version,
      };
    } catch (err) {
      if (ctx.disposed) throw new AppError("LEAN_CRASHED", "Lean is gone");
      throw new AppError("LEAN_TIMEOUT", (err as Error).message);
    }
  }

  // -- notification handlers ------------------------------------------------

  private onDiagnostics(ctx: SessionCtx, params: unknown): void {
    const p = params as {
      uri: string;
      diagnostics: Array<{
        severity?: number;
        message: string;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      }>;
    };
    const doc = ctx.docs.get(p.uri);
    if (!doc) return;
    // Lean republishes the full list for the document each time.
    doc.diagnostics = p.diagnostics.map((d) => ({
      severity: SEVERITY[d.severity ?? 1] ?? "error",
      message: d.message,
      range: makeRange(
        doc.fileId,
        { line: d.range.start.line, column: d.range.start.character },
        { line: d.range.end.line, column: d.range.end.character },
      ),
    }));
  }

  private onFileProgress(ctx: SessionCtx, params: unknown): void {
    const p = params as {
      textDocument?: { uri?: string };
      processing?: Array<{ kind?: number }>;
    };
    const uri = p.textDocument?.uri;
    const doc = uri ? ctx.docs.get(uri) : undefined;
    if (!doc) return;

    doc.progressSeen = true;
    const processing = Array.isArray(p.processing) ? p.processing : [];
    doc.fatalError = processing.some((item) => item?.kind === 2);
    doc.elaborating = processing.length > 0 && !doc.fatalError;

    if (!doc.elaborating) {
      const waiters = doc.waiters;
      doc.waiters = [];
      for (const w of waiters) w();
    }
  }

  private onExit(ctx: SessionCtx, code: number | null): void {
    if (ctx.disposed) return; // expected shutdown
    this.logger.error("lean process exited unexpectedly", { code });
    ctx.disposed = true;
    ctx.conn.close(new Error("Lean process exited"));
    this.sessions.delete(ctx.handle.id);
    for (const l of ctx.crashListeners) l();
  }

  // -- helpers --------------------------------------------------------------

  private ctx(session: LeanSessionHandle): SessionCtx {
    const ctx = this.sessions.get(session.id);
    if (!ctx) throw new AppError("LEAN_CRASHED", "Unknown or dead Lean session");
    return ctx;
  }

  private doc(ctx: SessionCtx, uri: string): DocState {
    const doc = ctx.docs.get(uri);
    if (!doc) throw new AppError("INTERNAL", `Document not open: ${uri}`);
    return doc;
  }
}
