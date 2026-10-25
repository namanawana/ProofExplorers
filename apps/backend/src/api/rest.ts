/**
 * REST layer - request/response concerns only.
 *
 * Used for everything that is NOT a live proof interaction: project and file
 * management, structure browsing (lazy, one level per call), dependency
 * queries, and read-only history (transitions, checkpoints).
 *
 * Real-time proof stepping (Next/Previous/Jump) lives on the WebSocket; the
 * only reason to create a session over HTTP is so a client can obtain a
 * sessionId and the step-0 state before opening the socket.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import type {
  CreateProjectRequest,
  CreateSessionRequest,
  ErrorCode,
  HttpError,
  UploadFileRequest,
} from "@proof-explorer/protocol";
import type { EventStore } from "../engine/EventStore";
import type { ProofRepository } from "../engine/ProofRepository";
import type { SessionManager } from "../session/SessionManager";
import type { ProjectStore } from "../store/ProjectStore";
import { AppError } from "../util/index";
import { metricsRegistry } from "../metrics";
import { AIContextBuilder } from "../ai/AIContextBuilder";
import { ConfiguredAIProvider } from "../ai/AIProvider";

export interface RestDeps {
  store: ProjectStore;
  sessions: SessionManager;
  repo: ProofRepository;
  events: EventStore;
}

/** Map engine errors onto HTTP status codes. */
const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_MESSAGE: 400,
  UNKNOWN_SESSION: 404,
  SESSION_BUSY: 429,
  SESSION_CLOSED: 410,
  TACTIC_REJECTED: 422,
  LEAN_TIMEOUT: 504,
  LEAN_CRASHED: 502,
};

/** Wrap async handlers so rejections reach the error middleware. */
const h =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const param = (req: Request, name: string): string => String(req.params[name] ?? "");

export function createRestRouter(deps: RestDeps): express.Router {
  const r = express.Router();

  // ---- health & observability -----------------------------------------------
  // /health: process is up.   /ready: able to accept new sessions.
  r.get("/health", (_req, res) => void res.json({ status: "ok" }));
  r.get("/ready", (_req, res) => void res.json({ status: "ready", sessions: deps.sessions.size() }));
  r.get("/metrics", async (_req, res) => {
    res.setHeader("Content-Type", metricsRegistry.contentType);
    res.send(await metricsRegistry.metrics());
  });

  // ---- projects & files -----------------------------------------------------
  r.post("/api/projects", h(async (req, res) => {
    const body = req.body as CreateProjectRequest;
    if (!body?.name) throw new AppError("INVALID_MESSAGE", "name is required");
    res.status(201).json(await deps.store.createProject(body.name));
  }));

  r.post("/api/projects/:id/files", h(async (req, res) => {
    const body = req.body as UploadFileRequest;
    if (!body?.path || typeof body.content !== "string") {
      throw new AppError("INVALID_MESSAGE", "path and content are required");
    }
    res.status(201).json(await deps.store.addFile(param(req, "id"), body.path, body.content));
  }));

  r.get("/api/files/:id", h(async (req, res) => {
    const result = await deps.store.getFile(param(req, "id"));
    if (!result) return void notFound(res, "file");
    res.json(result);
  }));

  // ---- structure (lazy: one level per request) -------------------------------
  // `parentId` is a file id (top level) or any proof-unit id (drill down).
  r.get("/api/structure/:parentId", h(async (req, res) => {
    res.json({ items: await deps.store.structure(param(req, "parentId")) });
  }));

  r.get("/api/proof-units/:id", h(async (req, res) => {
    const u = await deps.store.getUnit(param(req, "id"));
    if (!u) return void notFound(res, "proof unit");
    res.json({ unit: u.unit, executable: Boolean(u.proof), stepCount: u.proof?.script.length ?? 0 });
  }));

  r.get("/api/proof-units/:id/dependencies", h(async (req, res) => {
    res.json(await deps.store.dependencies(param(req, "id")));
  }));

  // ---- sessions --------------------------------------------------------------
  r.post("/api/sessions", h(async (req, res) => {
    const body = req.body as CreateSessionRequest;
    if (!body?.projectId || !body?.fileId || !body?.proofUnitId) {
      throw new AppError("INVALID_MESSAGE", "projectId, fileId, proofUnitId are required");
    }
    const { info, initial } = await deps.sessions.create(body);
    res.status(201).json({ session: info, state: initial.state });
  }));

  r.get("/api/sessions/:id", h(async (req, res) => {
    const info = deps.sessions.get(param(req, "id"));
    if (!info) return void notFound(res, "session");
    res.json(info);
  }));

  r.delete("/api/sessions/:id", h(async (req, res) => {
    await deps.sessions.close(param(req, "id"));
    res.status(204).end();
  }));

  // ---- history (read-only; paginated) ----------------------------------------
  r.get("/api/sessions/:id/transitions", h(async (req, res) => {
    const from = Number(req.query.from ?? 1);
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const items = await deps.repo.listTransitions(param(req, "id"), from, limit);
    const last = items.at(-1);
    res.json({ items, nextCursor: items.length === limit && last ? String(from + items.length) : undefined });
  }));

  r.get("/api/sessions/:id/checkpoints", h(async (req, res) => {
    res.json({ items: await deps.repo.listCheckpoints(param(req, "id")) });
  }));

  // Event log tail: a reconnecting client passes the last `seq` it saw and
  // receives everything newer, so no event is lost across a disconnect.
  r.get("/api/sessions/:id/events", h(async (req, res) => {
    const after = Number(req.query.after ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 200), 500);
    res.json({ items: await deps.events.read(param(req, "id"), after, limit) });
  }));

  // ---- AI assistance (read-only context, unverified proposals) ---------------
  const aiBuilder = new AIContextBuilder();
  const aiProvider = new ConfiguredAIProvider(process.env.AI_API_KEY);

  r.post("/api/sessions/:id/ai/explain", h(async (req, res) => {
    const s = deps.sessions.get(param(req, "id"));
    if (!s) throw new AppError("UNKNOWN_SESSION", "Session not found");
    const state = await deps.sessions.currentState(s.id);
    const unit = await deps.store.getUnit(s.proofUnitId);
    const depsView = await deps.store.dependencies(s.proofUnitId);
    if (!state || !unit) throw new AppError("INVALID_MESSAGE", "State or unit not found");
    const ctx = aiBuilder.build(state, unit.unit, depsView.dependsOn);
    res.json(await aiProvider.explainGoal(ctx));
  }));

  r.post("/api/sessions/:id/ai/suggest", h(async (req, res) => {
    const s = deps.sessions.get(param(req, "id"));
    if (!s) throw new AppError("UNKNOWN_SESSION", "Session not found");
    const state = await deps.sessions.currentState(s.id);
    const unit = await deps.store.getUnit(s.proofUnitId);
    const depsView = await deps.store.dependencies(s.proofUnitId);
    if (!state || !unit) throw new AppError("INVALID_MESSAGE", "State or unit not found");
    const ctx = aiBuilder.build(state, unit.unit, depsView.dependsOn);
    const proposal = await aiProvider.suggestTactic(ctx);
    // In hackathon/local mode without an external model, surface the exact
    // next source tactic so the demo still exercises the real Lean verifier.
    if (!aiProvider.isAvailable()) {
      proposal.proposalText = deps.sessions.nextCommand(s.id) ?? proposal.proposalText;
    }
    res.json(proposal);
  }));

  r.post("/api/sessions/:id/ai/verify", h(async (req, res) => {
    const tactic = typeof req.body?.tactic === "string" ? req.body.tactic : "";
    const stateHash = typeof req.body?.stateHash === "string" ? req.body.stateHash : undefined;
    if (!tactic.trim()) throw new AppError("INVALID_MESSAGE", "tactic is required");
    if (stateHash) {
      const current = await deps.sessions.currentState(param(req, "id"));
      if (current.stateHash !== stateHash) throw new AppError("TACTIC_REJECTED", "The AI proposal is stale; request a new suggestion");
    }
    const result = await deps.sessions.verifySuggestedTactic(param(req, "id"), tactic);
    res.json({
      verified: true,
      state: result.outcome.state,
      transition: result.outcome.transition,
      session: result.info,
    });
  }));

  // ---- error middleware (must be last) ---------------------------------------
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const app = err instanceof AppError ? err : new AppError("INTERNAL", "Internal error");
    const body: HttpError & { diagnostics?: unknown } = {
      error: { code: app.code, message: app.message },
    };
    if (app.diagnostics) body.diagnostics = app.diagnostics;
    res.status(STATUS[app.code] ?? 500).json(body);
  });

  return r;
}

function notFound(res: Response, what: string): void {
  const body: HttpError = { error: { code: "NOT_FOUND", message: `${what} not found` } };
  res.status(404).json(body);
}
