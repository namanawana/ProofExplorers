# Proof Explorer — Core Architecture

> Lean is the source of truth. The application does not invent the proof; it
> exposes the proof Lean has actually verified.

## 1. System overview

```
 Browser (React)                      REST (browse)      WebSocket (step)
 ┌───────────────┐   HTTPS ─────────────────┐   ┌──────── WSS ─────────┐
 │ Explorer tree │                          ▼   ▼                      │
 │ State viewer  │◄─────────────────  ┌───────────────────────────────────┐
 │ Timeline      │                    │ API layer  (api/rest.ts, ws.ts)    │  validate, map errors
 │ Dep. graph    │                    ├───────────────────────────────────┤
 └───────────────┘                    │ SessionManager                    │  quotas, status, recovery, reaper
                                      ├──────────────┬────────────────────┤
                       read side      │ ProofEngine  │  (one per session) │  state machine, transactions
   ┌──────────────────────────┐       │  ├ GoalManager        (pure)      │
   │ ProjectStore             │       │  ├ CheckpointManager  (index)     │
   │  ├ StructureAnalyzer     │       │  ├ StateCache (LRU)               │
   │  └ DependencyAnalyzer    │       │  ├ EventStore  (append-only)      │
   └──────────────────────────┘       │  └ ProofRepository (persistence)  │
                                      ├───────────────────────────────────┤
                                      │ LeanAdapter  (interface)           │  ← only place that knows LSP
                                      │  └ LspLeanAdapter + JsonRpc        │
                                      ├───────────────────────────────────┤
                                      │ LeanProcessLauncher (sandbox)      │  Local (dev) | Docker (prod)
                                      └───────────────┬───────────────────┘
                                                      ▼
                                         Lean 4 server → Lean kernel
```

A **modular monolith**: one deployable, strict internal boundaries expressed as
TypeScript interfaces (ports). A module is split into a service only when there
is a real scaling or isolation reason (the first candidate is the Lean worker
pool — see §8).

### Dependency rule

Arrows point inward to interfaces: `api → session → engine → LeanAdapter`.
`engine/` imports no Express, no `ws`, no LSP types. `lean/` imports nothing
from `engine/`. Only `server.ts` constructs concrete classes.

## 2. The three models (kept separate)

| Model | Question it answers | Where |
|---|---|---|
| Hierarchy (`ProofUnit` tree) | *Where am I?* | `analysis/StructureAnalyzer`, `ProjectStore` |
| Timeline (`S0 –T1→ S1 …`) | *What happened?* | `engine/ProofEngine`, `ProofRepository` |
| Dependency DAG (`Dependency` edges) | *Why does this exist?* | `analysis/DependencyAnalyzer` |

The DAG never reads the timeline and the timeline never reads the DAG
(Invariant 9). They are only joined by ids in the UI.

## 3. How a verified step is produced

Lean's language server cannot "run one tactic". It elaborates a whole document
and answers *"what are the goals at position P?"*. So a transition
`S(k-1) –T_k→ S(k)` is:

1. Lean has finished elaborating (`$/lean/fileProgress` reports no work left).
2. **No error diagnostic overlaps tactic T_k.** For the *final* tactic, no
   error anywhere in the unit (Lean reports "unsolved goals" on the block, not
   on the last tactic).
3. `$/lean/plainGoal` at the *end* of T_k returns the resulting goals.

Consequences that shape the design:

- **Previous / Jump never ask Lean to undo.** They move a cursor over committed
  history; steps whose body was not retained are rebuilt by *checkpoint +
  deterministic replay*, and each replayed hash is compared with the recorded
  one (`CHECKPOINT_CORRUPT` on mismatch — Lean wins).
- **Checkpoints are descriptors, not Lean snapshots.** Restoring is a position
  query, which makes crash recovery trivial (new process, reopen document).
- **`1 source line ≠ 1 step`**: a step is one top-level tactic *command* with a
  source range; it may add or remove any number of goals.

### Transaction

```
BEGIN     computeStep()   Lean queries, builds values, mutates nothing
VALIDATE  diagnostics + goal parse (throws AppError → nothing to roll back)
PERSIST   repo.saveCommit()  (one DB transaction in the Postgres impl)
COMMIT    frontier = step; cache; emit events; maybe checkpoint
```

The UI advances only on the `STATE_UPDATE` the server sends after COMMIT.

## 4. Data model

All types are in `packages/protocol/src/index.ts` (single source of truth for
backend and web). Persistent form: `db/schema.sql`.

| Entity | Notes |
|---|---|
| `Project`, `ProjectFile` | file contents live outside the row (hash stored) |
| `ProofUnit` | flat adjacency list ⇒ unbounded nesting; `local_have` (sub-proof) ≠ `intermediate_result` (term-mode) |
| `Goal` | first-class; `parentGoalId`, `createdAtStep`, `solvedAtStep` |
| `ProofState` | open goals only + `stateHash` |
| `ProofTransition` | only *committed, verified* transitions exist; rejections are events |
| `Checkpoint` | step, stateId, stateHash — the only steps with stored bodies |
| `Dependency` | **must carry evidence** (`syntactic` / `elaborated` + source range) |
| `DomainEvent` | append-only, per-session monotonic `seq` |
| `SessionInfo` | status, frontier/cursor/total steps, Lean version |

Source positions are zero-based lines and UTF-16 columns everywhere (matches
LSP and JS strings; no conversions to get wrong).

**Storage efficiency:** every step stores a transition + hash (small); full
state bodies only at checkpoints (`CHECKPOINT_INTERVAL`, default 100). A
10,000-step proof ≈ 100 bodies plus 10,000 compact rows.

## 5. API layers

### 5.1 REST (`api/rest.ts`) — browsing, setup, read-only history

| Method & path | Purpose |
|---|---|
| `GET /health`, `GET /ready` | liveness / readiness |
| `POST /api/projects` `{name}` | create project |
| `POST /api/projects/:id/files` `{path, content}` | upload + analyse a file |
| `GET /api/structure/:parentId` | **one level** of children (file id or unit id) |
| `GET /api/proof-units/:id` | unit detail, `executable`, `stepCount` |
| `GET /api/proof-units/:id/dependencies` | `{dependsOn[], usedBy[]}` with evidence |
| `POST /api/sessions` `{projectId,fileId,proofUnitId}` | start session → `{session, state(step 0)}` |
| `GET/DELETE /api/sessions/:id` | status / close |
| `GET /api/sessions/:id/transitions?from&limit` | paginated history (≤500) |
| `GET /api/sessions/:id/checkpoints` | checkpoint index |
| `GET /api/sessions/:id/events?after=&limit=` | event-log tail (reconnect replay; `seq` is gap-free) |

Errors: `{ "error": { "code", "message" }, "diagnostics"? }` with HTTP status
mapped from the protocol `ErrorCode` (400/404/410/422/429/502/504/500).

> Deviation from the spec sketch: `GET /proof-units/:id/states` is
> **session-scoped** (`/sessions/:id/transitions`) because states exist only
> relative to an execution.

### 5.2 WebSocket (`api/ws.ts`) — live proof protocol, `protocolVersion: "1.0"`

Envelope (both directions): `{ protocolVersion, type, requestId, sessionId, payload }`.

| Client → Server | Payload | Reply |
|---|---|---|
| `ATTACH` | – | `SESSION_STATUS`; then pushes `EVENT`/`SESSION_STATUS` |
| `NEXT` `PREVIOUS` `RESET` | – | `STATE_UPDATE` or `ERROR` |
| `JUMP` | `{step}` | `STATE_UPDATE` or `ERROR` |
| `ENTER_UNIT` | `{proofUnitId}` | `SESSION_STATUS` of the new child session |
| `PING` | – | `PONG` |

`STATE_UPDATE` payload: `{ step, verified: true, state, transition?, session, graphDelta? }`.
`ERROR` payload: `{ code, message, diagnostics? }` — `TACTIC_REJECTED` carries
Lean's diagnostics. Versioning: a mismatching `protocolVersion` is rejected with
`PROTOCOL_VERSION_MISMATCH`; breaking changes bump the major version.

## 6. Frontend architecture

- **State**: Zustand store = *projection of committed server state*. Actions
  send a command and apply the reply; nothing is optimistic (Invariant 5).
- **Transport**: `ProofSocket` correlates `requestId`s, rejects on `ERROR`,
  forwards pushes. Structure/graph data comes over REST, lazily.
- **Planned components**: `Workspace` (resizable panes) → `ProofExplorer`
  (virtualised tree, loads one level per expand) · `SourcePane` (Monaco,
  highlights `state.sourceRange`) · `StateViewer` (goals + context, KaTeX) ·
  `Timeline` (virtualised, checkpoint markers) · `DependencyGraph` (React Flow,
  semantic zoom L1–L4, expand-on-demand, graph deltas).
- **Scale**: never hold all states; fetch transition pages; render windows only.

## 7. Backend module responsibilities

| Module | Responsibility | Pure? |
|---|---|---|
| `lean/LspLeanAdapter` | LSP/JSON-RPC, diagnostics, goal queries | I/O |
| `lean/GoalTextParser` | `plainGoal` text → `RawGoal` (isolated for version drift) | pure |
| `engine/GoalManager` | goal identity & lineage (deterministic) | pure |
| `engine/ProofEngine` | transactions, cursor/frontier, replay | stateful |
| `engine/CheckpointManager` | when/where to checkpoint | pure index |
| `engine/EventStore` | append-only log + live tail | I/O port |
| `engine/ProofRepository` | durable commit port | I/O port |
| `session/SessionManager` | lifecycle, quotas, recovery, idle reaper | stateful |
| `analysis/*` | structure + dependencies from source | pure |
| `store/ProjectStore` | read model for REST | I/O port |

## 8. Language decision

**TypeScript (Node) for the backend**, not Haskell/OCaml:

| Concern | TypeScript | Haskell / OCaml |
|---|---|---|
| Lean integration | JSON-RPC over stdio is ~100 lines; same as any LSP client | needs hand-rolled LSP types or thin libs |
| Shared protocol with React UI | one `protocol` package, compile-time checked on both sides | codegen / duplication, drift risk |
| WebSocket / async | mature (`ws`, event loop fits I/O-bound proxying) | good, smaller ecosystems |
| Team productivity / hiring | highest | lower |
| Formal-methods fit | adequate: discriminated unions, strict mode, pure core | stronger types |

The engine is I/O-bound (waiting on Lean), not CPU-bound. The only genuinely
language-sensitive piece is **syntax-accurate structure extraction**, and that
belongs in *Lean itself* (a small Lean metaprogram emitting declaration/tactic
ranges as JSON) — a thin process boundary, language-independent. If heavy graph
analytics later justify it, that analyzer can be a separate OCaml/Haskell
service behind the existing `StructureAnalyzer`/`DependencyAnalyzer` interfaces.

## 9. Security architecture

Uploaded `.lean` is untrusted code (elaboration can run arbitrary
metaprograms). Controls, implemented in `DockerProcessLauncher` + config:

- one throw-away container per Lean session; `--network none`
- `--read-only` root, `--tmpfs /tmp`, project mounted `:ro` (pre-built imports)
- `--memory`, `--cpus`, `--pids-limit`, `--cap-drop ALL`, `no-new-privileges`
- wall-clock: `ELABORATION_TIMEOUT_MS` → `LEAN_TIMEOUT`; idle reaper kills containers
- quotas: `MAX_SESSIONS`; WebSocket `maxPayload`; 20 MB upload cap
- `SANDBOX=local` logs a loud warning and is for development only

Hardening backlog (P8): gVisor/Firecracker runtime, per-tenant quotas, seccomp
profile, signed file storage.

## 10. Testing architecture

| Layer | Tooling | What |
|---|---|---|
| Unit | Vitest | goal parser, analyzers (+ fixtures from disk), engine invariants (I1–I3, I7, I8, replay, corruption), seeded determinism property test — all against `FakeLeanAdapter` |
| Protocol | Vitest + real HTTP server + `ws` client | REST + WS round trips, malformed frames, version mismatch, concurrency, event replay, heartbeat, Lean-crash recovery (fake Lean) |
| Integration | Vitest + real Lean in container | **not yet written** (needs a toolchain; P1-03): `LspLeanAdapter` against the pinned version |
| E2E | Playwright | browser → WS → backend → Lean |
| Benchmarks | scripts | load, discovery, transition, checkpoint restore, graph expansion |

Fixtures (12 required by the spec) live in `lean/test-project/`; 7 exist today.
Current status: 40 unit/protocol tests passing, `tsc --noEmit` clean on backend,
protocol and web. Run `npm --workspace apps/backend run bench` for the benchmark
baseline (see TASKS.md P7-01).

## 11. Deployment architecture

```
Browser ─▶ Reverse proxy (TLS, WS upgrade, rate limit)
              ─▶ Backend (stateless API + SessionManager)
                    ─▶ Session workers  ─▶ Sandboxed Lean containers
              ─▶ PostgreSQL (truth)    ─▶ Redis (cache / locks only)
              ─▶ Object storage (uploaded files)
```

Sessions are sticky to a backend instance (Lean process affinity); on restart a
session is restorable because history is in Postgres and Lean can recompute.

## 12. Known limitations of this skeleton (honest list)

1. `HeuristicStructureAnalyzer` is not a Lean parser (see its header comment).
2. Goal lineage is content-based until metavariable ids are read from Lean.
3. `LspLeanAdapter` has been **type-checked but not run against a real Lean**;
   LSP method/field names must be verified against the pinned toolchain (P1-02).
4. Repository/EventStore/ProjectStore are in-memory; Postgres impls are P8.
5. `ENTER_UNIT` spawns a second Lean process; sharing one process per document
   is planned (P5-03).
6. A bullet (`·`) or `case` block is one step; inner tactics are not yet steppable.
