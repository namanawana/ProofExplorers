/**
 * Zustand projection of the verified Proof Explorer server state.
 * The browser never invents proof state; it only displays server responses.
 */
import { create } from "zustand";
import type {
  Checkpoint,
  Dependency,
  Diagnostic,
  ProofState,
  ProofTransition,
  ProofUnit,
  SessionInfo,
} from "@proof-explorer/protocol";
import { ProofSocket } from "../net/ProofSocket";

interface NavSessionSnapshot {
  session: SessionInfo;
  state: ProofState;
  unitId: string;
}

interface ProofStore {
  session?: SessionInfo;
  state?: ProofState;
  lastTransition?: ProofTransition;
  diagnostics: Diagnostic[];
  fileContent: string;
  fileName?: string;
  projectId?: string;
  fileId?: string;
  units: ProofUnit[];
  dependencies: Dependency[];
  checkpoints: Checkpoint[];
  sessionStack: NavSessionSnapshot[];
  activeUnitId?: string;
  selectedGoalId?: string;
  error?: string;
  busy: boolean;
  connected: boolean;

  uploadLeanFile(file: File): Promise<void>;
  open(args: { projectId: string; fileId: string; proofUnitId: string }): Promise<void>;
  loadFile(fileId: string): Promise<void>;
  loadUnitsAndDeps(fileId: string): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  reset(): Promise<void>;
  jump(step: number): Promise<void>;
  verifyTactic(tactic: string, stateHash?: string): Promise<void>;
  enterUnit(proofUnitId: string): Promise<void>;
  exitUnit(): Promise<void>;
  selectUnit(unitId: string): Promise<void>;
  selectGoal(goalId: string): void;
  clearProject(): Promise<void>;
}

let socket: ProofSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;

const apiError = async (res: Response, fallback: string): Promise<string> => {
  try {
    const body = await res.json();
    return body?.error?.message ?? fallback;
  } catch {
    return fallback;
  }
};

const toUnit = (u: any): ProofUnit => ({
  id: u.id,
  type: u.type,
  name: u.name,
  statement: u.statement,
  parentId: u.parentId,
  status: u.status,
  children: [...(u.children ?? [])],
  dependencies: [...(u.dependencies ?? [])],
  states: [...(u.states ?? [])],
  sourceRange: u.sourceRange,
  metadata: u.metadata,
});

export const useProofStore = create<ProofStore>((set, get) => {
  const navigate = async (type: "NEXT" | "PREVIOUS" | "RESET" | "JUMP", step?: number) => {
    const { session } = get();
    if (!socket || !session) return;
    set({ busy: true, error: undefined });
    try {
      const reply = type === "JUMP"
        ? await socket.request({ type, sessionId: session.id, payload: { step: step ?? 0 } })
        : await socket.request({ type, sessionId: session.id, payload: {} });
      if (reply.type === "STATE_UPDATE") {
        set({
          state: reply.payload.state,
          lastTransition: reply.payload.transition,
          session: reply.payload.session,
          diagnostics: reply.payload.transition?.diagnostics ?? [],
        });
      }
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  };

  const connectCurrentSession = async (session: SessionInfo): Promise<void> => {
    socket?.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${location.host}/ws`;
    socket = new ProofSocket(
      wsUrl,
      (m) => {
        if (m.type === "SESSION_STATUS") set({ session: m.payload });
      },
      () => {
        set({ connected: false });
        const current = get().session;
        if (!current || current.id !== session.id) return;
        reconnectAttempt += 1;
        const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempt, 5), 10_000);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          void (async () => {
            try {
              await connectCurrentSession(current);
              reconnectAttempt = 0;
              set({ error: undefined });
              // Re-request the currently displayed verified state after reconnect.
              const cursor = get().state?.stepNumber ?? current.cursorStep;
              if (socket) {
                const reply = await socket.request({
                  type: "JUMP",
                  sessionId: current.id,
                  payload: { step: cursor },
                });
                if (reply.type === "STATE_UPDATE") {
                  set({ session: reply.payload.session, state: reply.payload.state, lastTransition: reply.payload.transition });
                }
              }
            } catch {
              // The close handler schedules the next attempt.
            }
          })();
        }, delay);
      },
    );
    await socket.connect();
    await socket.request({ type: "ATTACH", sessionId: session.id, payload: {} });
    set({ connected: true });
  };

  return {
    diagnostics: [],
    fileContent: "",
    units: [],
    dependencies: [],
    checkpoints: [],
    sessionStack: [],
    busy: false,
    connected: false,

    async uploadLeanFile(file) {
      set({ busy: true, error: undefined });
      try {
        if (!file.name.toLowerCase().endsWith(".lean")) throw new Error("Please select a .lean file");
        if (file.size > 20 * 1024 * 1024) throw new Error("Lean file exceeds the 20 MB limit");
        const content = await file.text();

        await get().clearProject();

        const projectRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: file.name.replace(/\.lean$/i, "") || "Lean Project" }),
        });
        if (!projectRes.ok) throw new Error(await apiError(projectRes, "Could not create project"));
        const project = await projectRes.json();

        const fileRes = await fetch(`/api/projects/${project.id}/files`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: file.name, content }),
        });
        if (!fileRes.ok) throw new Error(await apiError(fileRes, "Could not upload Lean file"));
        const uploaded = await fileRes.json();

        set({ projectId: project.id, fileId: uploaded.id, fileName: file.name, fileContent: content });
        await get().loadUnitsAndDeps(uploaded.id);

        const executable = get().units.find((u) => ["theorem", "lemma", "example", "local_have", "subproof"].includes(u.type) && u.metadata?.hasProof !== false);
        if (!executable) {
          throw new Error("The file was uploaded, but no executable theorem/lemma/example was found.");
        }
        await get().open({ projectId: project.id, fileId: uploaded.id, proofUnitId: executable.id });
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        set({ busy: false });
      }
    },

    async open(args) {
      set({ busy: true, error: undefined });
      try {
        const oldSession = get().session;
        if (oldSession && oldSession.proofUnitId !== args.proofUnitId) {
          try { await fetch(`/api/sessions/${oldSession.id}`, { method: "DELETE" }); } catch { /* best effort */ }
          socket?.close();
          socket = undefined;
        }
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        });
        if (!res.ok) throw new Error(await apiError(res, "Failed to create proof session"));
        const { session, state } = await res.json() as { session: SessionInfo; state: ProofState };
        await connectCurrentSession(session);
        set({
          session,
          state,
          activeUnitId: args.proofUnitId,
          projectId: args.projectId,
          fileId: args.fileId,
          error: undefined,
        });
        await get().loadFile(args.fileId);
        await get().loadUnitsAndDeps(args.fileId);
        const cp = await fetch(`/api/sessions/${session.id}/checkpoints`);
        if (cp.ok) set({ checkpoints: (await cp.json()).items ?? [] });
      } catch (e) {
        set({ error: (e as Error).message, connected: false });
      } finally {
        set({ busy: false });
      }
    },

    async loadFile(fileId) {
      const res = await fetch(`/api/files/${fileId}`);
      if (!res.ok) throw new Error(await apiError(res, "Could not load Lean file"));
      const data = await res.json();
      set({ fileContent: data.content ?? "", fileName: data.file?.path });
    },

    async loadUnitsAndDeps(fileId) {
      const byId = new Map<string, ProofUnit>();
      const queue: string[] = [];
      const rootRes = await fetch(`/api/structure/${fileId}`);
      if (!rootRes.ok) throw new Error(await apiError(rootRes, "Could not analyze Lean file"));
      const rootData = await rootRes.json();
      for (const node of rootData.items ?? []) queue.push(node.id);

      const seen = new Set<string>();
      while (queue.length && seen.size < 5000) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const res = await fetch(`/api/proof-units/${id}`);
        if (!res.ok) continue;
        const data = await res.json();
        const unit = toUnit(data.unit);
        unit.metadata = { ...(unit.metadata ?? {}), hasProof: Boolean(data.executable), stepCount: data.stepCount };
        byId.set(unit.id, unit);
        for (const child of unit.children) queue.push(child);
      }

      const all = [...byId.values()];
      const dependencyLists = await Promise.all(all.map(async (u) => {
        try {
          const res = await fetch(`/api/proof-units/${u.id}/dependencies`);
          if (!res.ok) return [] as Dependency[];
          const data = await res.json();
          return [...(data.dependsOn ?? []), ...(data.usedBy ?? [])] as Dependency[];
        } catch {
          return [] as Dependency[];
        }
      }));
      const depMap = new Map<string, Dependency>();
      for (const list of dependencyLists) for (const d of list) depMap.set(d.id, d);
      set({ units: all, dependencies: [...depMap.values()] });
    },

    async next() { await navigate("NEXT"); },
    async previous() { await navigate("PREVIOUS"); },
    async reset() { await navigate("RESET"); },
    async jump(step) { await navigate("JUMP", step); },

    async verifyTactic(tactic, stateHash) {
      const { session } = get();
      if (!session) return;
      set({ busy: true, error: undefined });
      try {
        const res = await fetch(`/api/sessions/${session.id}/ai/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tactic, stateHash }),
        });
        if (!res.ok) throw new Error(await apiError(res, "Lean rejected the suggested tactic"));
        const data = await res.json();
        set({ state: data.state, session: data.session, lastTransition: data.transition, diagnostics: data.transition?.diagnostics ?? [] });
      } catch (e) {
        set({ error: (e as Error).message });
        throw e;
      } finally {
        set({ busy: false });
      }
    },

    async enterUnit(proofUnitId) {
      const { session, state, sessionStack, activeUnitId } = get();
      if (!socket || !session || !state) return;
      set({ busy: true, error: undefined });
      try {
        const reply = await socket.request({ type: "ENTER_UNIT", sessionId: session.id, payload: { proofUnitId } });
        if (reply.type !== "STATE_UPDATE") throw new Error("Failed to enter proof unit");
        const childSession = reply.payload.session;
        set({ session: childSession, sessionStack: [...sessionStack, { session, state, unitId: activeUnitId ?? session.proofUnitId }], activeUnitId: proofUnitId, state: reply.payload.state, lastTransition: reply.payload.transition });
        await socket.request({ type: "ATTACH", sessionId: childSession.id, payload: {} });
        const cp = await fetch(`/api/sessions/${childSession.id}/checkpoints`);
        if (cp.ok) set({ checkpoints: (await cp.json()).items ?? [] });
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        set({ busy: false });
      }
    },

    async exitUnit() {
      const { session, sessionStack } = get();
      if (!session || sessionStack.length === 0 || !socket) return;
      const parentSnapshot = sessionStack[sessionStack.length - 1]!;
      try { await socket.request({ type: "DETACH", sessionId: session.id, payload: {} }); } catch { /* best effort */ }
      try { await fetch(`/api/sessions/${session.id}`, { method: "DELETE" }); } catch { /* best effort */ }
      const newStack = sessionStack.slice(0, -1);
      set({ session: parentSnapshot.session, state: parentSnapshot.state, activeUnitId: parentSnapshot.unitId, sessionStack: newStack, error: undefined });
      await socket.request({ type: "ATTACH", sessionId: parentSnapshot.session.id, payload: {} });
    },

    async selectUnit(unitId) {
      const unit = get().units.find((u) => u.id === unitId);
      if (!unit) return;
      set({ activeUnitId: unitId });
      if (["theorem", "lemma", "example", "local_have", "subproof"].includes(unit.type) && get().projectId && get().fileId && unit.metadata?.hasProof) {
        await get().open({ projectId: get().projectId!, fileId: get().fileId!, proofUnitId: unitId });
      }
    },

    selectGoal: (goalId) => set({ selectedGoalId: goalId }),

    async clearProject() {
      const { session } = get();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (session) {
        try { await fetch(`/api/sessions/${session.id}`, { method: "DELETE" }); } catch { /* best effort */ }
      }
      socket?.close();
      socket = undefined;
      set({ session: undefined, state: undefined, lastTransition: undefined, diagnostics: [], fileContent: "", fileName: undefined, projectId: undefined, fileId: undefined, units: [], dependencies: [], checkpoints: [], sessionStack: [], activeUnitId: undefined, selectedGoalId: undefined, connected: false, error: undefined });
    },
  };
});
