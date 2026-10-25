/**
 * SessionManager - owns the lifecycle of proof sessions.
 *
 * Implements P5-03:
 *   - Document-scoped Lean process sharing: multiple sessions on the same
 *     document share ONE Lean process and document context. Entering 10 nested
 *     units on a document uses 1 Lean process instead of 10.
 *   - Reference-counted process lifecycle: the Lean worker is disposed only when
 *     all sessions on that document have closed.
 *   - Concurrent operation serialization: operations sharing a document process
 *     are safely serialized to prevent LSP race conditions.
 *   - Crash recovery: when a Lean process dies, all sessions sharing that document
 *     are safely recovered and rebound.
 */
import { pathToFileURL } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  ProofState,
  SessionInfo,
  SessionStatus,
} from "@proof-explorer/protocol";
import type { AppConfig } from "../config";
import type { EventStore } from "../engine/EventStore";
import {
  ProofEngine,
  type ProofTarget,
  type StepOutcome,
} from "../engine/ProofEngine";
import type { ProofRepository } from "../engine/ProofRepository";
import type { LeanAdapter, LeanSessionHandle } from "../lean/LeanAdapter";
import type { ProjectStore } from "../store/ProjectStore";
import { AppError, newId, type Clock, type Logger } from "../util/index";

export interface SessionManagerDeps {
  adapter: LeanAdapter;
  repo: ProofRepository;
  events: EventStore;
  store: ProjectStore;
  config: AppConfig;
  clock: Clock;
  logger: Logger;
}

interface DocContext {
  documentUri: string;
  fileId: string;
  documentText: string;
  lean: LeanSessionHandle;
  refCount: number;
  lock: Promise<unknown>;
}

interface ManagedSession {
  id: string;
  projectId: string;
  fileId: string;
  unitId: string;
  documentUri: string;
  documentText: string;
  status: SessionStatus;
  engine: ProofEngine;
  lastActiveAt: number;
}

export type StatusListener = (info: SessionInfo) => void;

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly docContexts = new Map<string, DocContext>();
  private readonly statusListeners = new Set<StatusListener>();
  private reaper?: NodeJS.Timeout;

  constructor(private readonly deps: SessionManagerDeps) {}

  // -- lifecycle ------------------------------------------------------------

  async create(req: {
    projectId: string;
    fileId: string;
    proofUnitId: string;
  }): Promise<{ info: SessionInfo; initial: StepOutcome }> {
    const { config, store, adapter, logger } = this.deps;

    if (this.sessions.size >= config.limits.maxSessions) {
      throw new AppError("SESSION_BUSY", "Session quota reached; try again later");
    }

    const file = await store.getFile(req.fileId);
    const analysis = await store.getFileAnalysis(req.fileId);
    const unit = await store.getUnit(req.proofUnitId);
    if (!file || !analysis || !unit?.proof || !unit.unit.sourceRange) {
      throw new AppError("INVALID_MESSAGE", "Unit not found or has no tactic proof to execute");
    }

    const sessionId = newId();
    const relativePath = file.file.path.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!relativePath.toLowerCase().endsWith(".lean") || relativePath.includes("..")) {
      throw new AppError("INVALID_MESSAGE", "Only safe .lean paths are allowed");
    }
    const workspaceRoot = resolve(config.leanProjectRoot, ".proof-explorer-uploads", req.projectId);
    const documentPath = resolve(workspaceRoot, relativePath);
    if (documentPath !== workspaceRoot && !documentPath.startsWith(workspaceRoot + sep)) {
      throw new AppError("INVALID_MESSAGE", "File path escapes the Lean workspace");
    }
    await mkdir(dirname(documentPath), { recursive: true });
    await writeFile(documentPath, file.content, "utf8");
    const documentUri = pathToFileURL(documentPath).href;

    const docCtx = await this.acquireDocContext(documentUri, req.fileId, file.content);

    try {
      const target: ProofTarget = {
        unitId: unit.unit.id,
        unitRange: unit.unit.sourceRange,
        documentUri,
        initialPosition: unit.proof.initialPosition,
        script: unit.proof.script,
      };

      const engine = new ProofEngine({
        sessionId,
        adapter,
        leanSession: docCtx.lean,
        target,
        repo: this.deps.repo,
        events: this.deps.events,
        clock: this.deps.clock,
        logger: logger.child({ sessionId }),
        config: config.engine,
      });

      const managed: ManagedSession = {
        id: sessionId,
        projectId: req.projectId,
        fileId: req.fileId,
        unitId: unit.unit.id,
        documentUri,
        documentText: file.content,
        status: "starting",
        engine,
        lastActiveAt: this.deps.clock.now(),
      };
      this.sessions.set(sessionId, managed);

      await this.deps.events.append(sessionId, "SESSION_CREATED", {
        unitId: unit.unit.id,
        leanVersion: docCtx.lean.leanVersion,
      });
      await this.deps.events.append(sessionId, "DOCUMENT_LOADED", { fileId: req.fileId });

      const initial = await engine.initialize();
      this.setStatus(managed, "ready");
      logger.info("session created", { sessionId, unitId: unit.unit.id, documentUri });
      return { info: this.info(managed), initial };
    } catch (err) {
      this.sessions.delete(sessionId);
      await this.releaseDocContext(documentUri);
      throw err;
    }
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    this.setStatus(s, "closed");
    await this.releaseDocContext(s.documentUri);
    this.deps.logger.info("session closed", { sessionId });
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
    this.stopReaper();
  }

  get(sessionId: string): SessionInfo | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.info(s) : undefined;
  }

  size(): number {
    return this.sessions.size;
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // -- operations -----------------------------------------------------------

  next(sessionId: string): Promise<{ info: SessionInfo; outcome: StepOutcome }> {
    return this.op(sessionId, (s) => s.engine.next());
  }

  nextCommand(sessionId: string): string | undefined {
    return this.require(sessionId).engine.nextCommand();
  }

  currentState(sessionId: string): Promise<ProofState> {
    return this.require(sessionId).engine.currentState();
  }

  async verifySuggestedTactic(sessionId: string, tactic: string): Promise<{ info: SessionInfo; outcome: StepOutcome }> {
    const s = this.require(sessionId);
    const candidate = tactic.trim();
    const expected = s.engine.nextCommand()?.trim();
    if (!candidate || !expected || candidate !== expected) {
      throw new AppError("TACTIC_REJECTED", `Suggested tactic does not match the next source tactic. Expected: ${expected ?? "no remaining tactic"}`);
    }
    return this.op(sessionId, (managed) => managed.engine.next());
  }


  previous(sessionId: string): Promise<{ info: SessionInfo; outcome: StepOutcome }> {
    return this.op(sessionId, (s) => s.engine.previous());
  }

  reset(sessionId: string): Promise<{ info: SessionInfo; outcome: StepOutcome }> {
    return this.op(sessionId, (s) => s.engine.reset());
  }

  jump(sessionId: string, step: number): Promise<{ info: SessionInfo; outcome: StepOutcome }> {
    return this.op(sessionId, (s) => s.engine.jump(step));
  }

  private async op(
    sessionId: string,
    action: (s: ManagedSession) => Promise<StepOutcome>,
  ): Promise<{ info: SessionInfo; outcome: StepOutcome }> {
    const s = this.require(sessionId);
    s.lastActiveAt = this.deps.clock.now();
    this.setStatus(s, "busy");
    try {
      const outcome = await this.serializedDocOp(s.documentUri, () => action(s));
      this.setStatus(s, "ready");
      return { info: this.info(s), outcome };
    } catch (err) {
      this.setStatus(s, "ready");
      throw err;
    }
  }

  // -- document-scoped process pooling & serialization ----------------------

  private async acquireDocContext(
    documentUri: string,
    fileId: string,
    content: string,
  ): Promise<DocContext> {
    const existing = this.docContexts.get(documentUri);
    if (existing) {
      existing.refCount++;
      return existing;
    }

    const { config, adapter } = this.deps;
    const lean = await adapter.createSession({
      projectRoot: config.leanProjectRoot,
      startupTimeoutMs: config.limits.leanStartupTimeoutMs,
    });

    await adapter.openDocument(lean, {
      uri: documentUri,
      fileId,
      text: content,
    });

    const ctx: DocContext = {
      documentUri,
      fileId,
      documentText: content,
      lean,
      refCount: 1,
      lock: Promise.resolve(),
    };
    this.docContexts.set(documentUri, ctx);

    adapter.onCrash(lean, () => void this.recoverDocument(documentUri));
    return ctx;
  }

  private async releaseDocContext(documentUri: string): Promise<void> {
    const ctx = this.docContexts.get(documentUri);
    if (!ctx) return;
    ctx.refCount--;
    if (ctx.refCount <= 0) {
      this.docContexts.delete(documentUri);
      await this.deps.adapter.disposeSession(ctx.lean);
    }
  }

  private serializedDocOp<T>(documentUri: string, fn: () => Promise<T>): Promise<T> {
    const ctx = this.docContexts.get(documentUri);
    if (!ctx) return fn();
    const run = ctx.lock.then(fn);
    ctx.lock = run.catch(() => undefined);
    return run;
  }

  // -- crash recovery -------------------------------------------------------

  private async recoverDocument(documentUri: string): Promise<void> {
    const ctx = this.docContexts.get(documentUri);
    if (!ctx) return;

    const affectedSessions = [...this.sessions.values()].filter(
      (s) => s.documentUri === documentUri,
    );
    for (const s of affectedSessions) {
      this.setStatus(s, "recovering");
    }

    const { config, adapter, logger } = this.deps;
    try {
      const newLean = await adapter.createSession({
        projectRoot: config.leanProjectRoot,
        startupTimeoutMs: config.limits.leanStartupTimeoutMs,
      });

      await adapter.openDocument(newLean, {
        uri: documentUri,
        fileId: ctx.fileId,
        text: ctx.documentText,
      });

      adapter.onCrash(newLean, () => void this.recoverDocument(documentUri));
      ctx.lean = newLean;

      for (const s of affectedSessions) {
        s.engine.rebind(newLean);
        this.setStatus(s, "ready");
      }
      logger.info("document context recovered across sessions", {
        documentUri,
        sessionCount: affectedSessions.length,
      });
    } catch (err) {
      logger.error("document recovery failed", { documentUri, error: String(err) });
      for (const s of affectedSessions) {
        this.setStatus(s, "failed");
      }
    }
  }

  // -- idle reaper ------------------------------------------------------------

  startReaper(intervalMs = 30_000): void {
    this.reaper = setInterval(() => {
      const cutoff = this.deps.clock.now() - this.deps.config.limits.sessionIdleMs;
      for (const s of this.sessions.values()) {
        if (s.lastActiveAt < cutoff) void this.close(s.id);
      }
    }, intervalMs);
    this.reaper.unref();
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
  }

  // -- helpers ----------------------------------------------------------------

  private require(sessionId: string): ManagedSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AppError("UNKNOWN_SESSION", `No such session ${sessionId}`);
    if (s.status === "closed" || s.status === "failed") {
      throw new AppError("SESSION_CLOSED", `Session is ${s.status}`);
    }
    return s;
  }

  private setStatus(s: ManagedSession, status: SessionStatus): void {
    s.status = status;
    const info = this.info(s);
    for (const l of this.statusListeners) l(info);
  }

  private info(s: ManagedSession): SessionInfo {
    const p = s.engine.progress();
    const doc = this.docContexts.get(s.documentUri);
    return {
      id: s.id,
      projectId: s.projectId,
      fileId: s.fileId,
      proofUnitId: s.unitId,
      status: s.status,
      leanVersion: doc?.lean.leanVersion ?? "unknown",
      frontierStep: p.frontier,
      cursorStep: p.cursor,
      totalSteps: p.total,
    };
  }
}
