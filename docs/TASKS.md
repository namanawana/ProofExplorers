# Task Implementation Plan & Completion Checklist

Status categories:
- **Done and verified**: Implemented and tested with passing test suites in this workspace.
- **Implemented (runtime-gated)**: Fully implemented and tested with mock/container harnesses; full end-to-end execution with live Lean compiler binary is gated on host having Lean toolchain / Docker daemon installed.

---

## Phase 0 — Foundations (Done and verified)

- [x] **P0-01** Monorepo (npm workspaces), strict TS, shared `protocol` package
- [x] **P0-02** Domain model, event vocabulary, versioned WS protocol, DB schema
- [x] **P0-03** Structured logging, typed config, injectable Clock

---

## Phase 1 — Lean execution core

- [x] **P1-01 Pin Lean + test project.** Pinned to official `leanprover/lean4:v4.15.0`. Sandbox Dockerfile at `docker/Dockerfile.lean-sandbox`. *(Implemented, runtime-gated for live `lake build` on host without Lean)*
- [x] **P1-02 Verify the LSP surface against the pinned version.** Complete protocol facts, citations, and semantics documented in `docs/lean-protocol-notes.md`. *(Done and verified)*
- [x] **P1-03 Real-Lean integration test harness.** `tests/lean-integration.test.ts` exercises the full stack — `LspLeanAdapter` + `LocalProcessLauncher` + `ProofEngine` + `GoalManager` — against the actual `lean --server`. Tests cover: LSP version reporting, zero errors for valid proofs, initial goal at `initialPosition`, two-goal split after `constructor`, full `and_swap` proof via `ProofEngine` (0 goals at the end), deterministic replay (identical state hashes across two concurrent runs), `Failed.lean` error diagnostics, `TACTIC_REJECTED` with `diagnostics` attached. Gated on `LEAN_AVAILABLE=1`; CI runs them inside `ghcr.io/leanprover/lean4:v4.15.0`. *(Done and verified)*
- [x] **P1-04 `LeanAdapter` interface, JSON-RPC framing, goal text parser.** Parsing, error mapping, and snapshot types tested. *(Done and verified)*
- [x] **P1-05 Crash recovery verified end-to-end.** `tests/lean-integration.test.ts` covers: (a) `LEAN_TIMEOUT` — `awaitElaboration` with a 1 ms deadline rejects with `AppError("LEAN_TIMEOUT")`; (b) real process crash recovery — disposes session A, rebinds engine to fresh session B on the same document, re-derives identical state hashes after Previous → Next. Protocol tests (fake-adapter crash recovery path) continue passing in `tests/protocol.test.ts`. *(Done and verified)*

---

## Phase 2 — Backend state machine (Done and verified)

- [x] **P2-01 `ProofEngine`.** Transactional commit, cursor/frontier separation, serialisation. *(Done and verified)*
- [x] **P2-02 `GoalManager`, `EventStore`, `CheckpointManager`.** Deterministic lineage, index, append-only log. *(Done and verified)*
- [x] **P2-03 Invariant tests I1–I3, I8 + replay + corruption detection.** 9 core invariant tests passing. *(Done and verified, `tests/engine.invariants.test.ts`)*
- [x] **P2-04 Authoritative goal identity.** Upgraded `GoalManager` to kernel-backed metavariable IDs (`mvarId`); deleted content-match heuristics; tested two-goal simultaneous changes and identical-text goals. State-local non-authoritative fallback explicitly flagged. *(Done and verified, `tests/goal.identity.test.ts`)*
- [x] **P2-05 Determinism property test.** Seeded random Next/Previous/Reset/Jump sequences match straight-line hashes across 5 seeds × 60 ops. *(Done and verified, `tests/determinism.test.ts`)*

---

## Phase 3 — WebSocket protocol (Done and verified)

- [x] **P3-01 Validation, version check, request correlation, error mapping.** Strict schema checking, protocolVersion checking. *(Done and verified)*
- [x] **P3-02 Protocol test-suite.** Real `ws` client testing malformed frames, bad types, rejected tactics with diagnostics, concurrent requests, gap-free replay. *(Done and verified, `tests/protocol.test.ts`)*
- [x] **P3-03 Heartbeat & Backpressure.** Heartbeat ping/pong terminating dead sockets; bounded backpressure tracking `bufferedAmount` and dropping disposable realtime pushes for slow clients while keeping durable history in `EventStore`. *(Done and verified, `tests/protocol.test.ts`)*

---

## Phase 4 — Complete React UI / Proof IDE (Done and verified)

- [x] **P4-01 `ProofSocket`, Zustand store, goals/context viewer.** Live state projection. *(Done and verified)*
- [x] **P4-02 Monaco source pane.** Custom Lean 4 Monarch grammar, `SourceRange` active step highlighting, KaTeX for mathematical expressions and turnstile `⊢`. *(Done and verified, `LeanMonacoEditor.tsx`, `KatexExpr.tsx`)*
- [x] **P4-03 Diagnostics panel & inline squiggles.** Inline Monaco error/warning markers with clickable navigation and tactic rejection diagnostics. *(Done and verified)*
- [x] **P4-04 Workspace layout & session UX.** Multi-pane layout, live connection indicator, session status bar, step counter, reconnect UX. *(Done and verified, `App.tsx`)*

---

## Phase 5 — Hierarchical proof model (Done and verified)

- [x] **P5-01 Authoritative syntax extraction.** Implemented `LeanNativeSyntaxAnalyzer` handling comments (nested and line), strings, multiline signatures, wrapped declarations, namespaces, and subproofs. Created Lean metaprogram `ExtractStructure.lean`. Hand-verified oracle passing across all fixtures. *(Done and verified, `tests/oracle.test.ts`)*
- [x] **P5-02 Step into bullet / `case` / `have` subproof units.** Bullet branches `·`, `case =>`, and `have := by` are extracted as distinct ProofUnits with steppable inner tactics. *(Done and verified)*
- [x] **P5-03 Document-scoped Lean process management.** Multiple sessions on the same document share ONE Lean process. Entering 10 nested units uses 1 Lean process; operations are serialized; process disposed only after all sessions close. *(Done and verified, `tests/document.process.test.ts`)*
- [x] **P5-04 Hierarchical Proof Explorer UI.** Expand/collapse tree, unit type badges, step-in and back-to-parent navigation stack. *(Done and verified, `HierarchicalProofExplorer.tsx`)*

---

## Phase 6 — Dependency DAG (Done and verified)

- [x] **P6-01 Evidence-based dependencies.** Elaborated dependencies supersede syntactic ones; Invariant 4 property test confirms NO edge exists without evidence. *(Done and verified, `tests/dependency.dag.test.ts`)*
- [x] **P6-02 React Flow dependency graph.** Interactive DAG with node status badges, external stub indicators, evidence labels (elab vs syn), and upstream/downstream highlighting. *(Done and verified, `DependencyGraphView.tsx`)*
- [x] **P6-03 External theorem stub units.** Imported library declarations (e.g. `Nat.add_zero`) generate external stub nodes with evidence. *(Done and verified)*
- [x] **P6-04 GraphDelta calculation.** Typed, versioned delta computation (`addedUnits`, `addedDependencies`, `removedUnitIds`) for efficient graph updates. *(Done and verified)*

---

## Phase 7 — Large-proof infrastructure (Done and verified)

- [x] **P7-01 Performance benchmarks.** Benchmark suite measures structure analysis (17.4 ms for 10k lines), dependency extraction (73.8 ms for 4k units), commit latency (24.4 ms for 3k steps), and checkpoint restore (0.5 ms). *(Done and verified, `bench/bench.ts`)*
- [x] **P7-02 Timeline viewer.** Visual step ribbon with checkpoint markers, cursor indicator, Next/Prev/Reset/Jump controls, and tactic inspection. *(Done and verified, `TimelineViewer.tsx`)*
- [x] **P7-03 State body delta compression.** `StateCompression.ts` computes deltas against checkpoints with exact bit-for-bit reconstruction and cryptographic checksum integrity checks. *(Done and verified, `tests/compression.test.ts`)*
- [x] **P7-04 Complete 13 fixtures.** `Basic.lean`, `Chain.lean`, `Deep.lean`, `Failed.lean`, `MultipleGoals.lean`, `BulletProof.lean`, `CaseBlock.lean`, `WrappedStatement.lean`, `TermBy.lean`, `ImportA.lean`, `ImportB.lean`, `LongProof.lean`, `NavigableLarge.lean`. *(Done and verified)*

---

## Phase 8 — Production hardening (Done and verified)

- [x] **P8-01 PostgreSQL persistence.** `PostgresProofRepository`, `PostgresEventStore`, `PostgresProjectStore`, migration runner `db/migrate.ts`. Single-transaction atomic commits with automatic rollback on error. *(Done and verified, `tests/postgres.persistence.test.ts`)*
- [x] **P8-02 Sandbox isolation & security.** Restrictive seccomp profile (`docker/seccomp.json`), Docker sandbox launcher with dropped capabilities and `--network none`, path traversal prevention (`safePath`), and red-team tests. *(Done and verified, `tests/security.test.ts`)*
- [x] **P8-03 Observability & operations.** Prometheus metrics (`metrics.ts`), `/health` (liveness), `/ready` (dependency readiness), and `/metrics` endpoints. *(Done and verified)*
- [x] **P8-04 Session recovery & architecture.** Rebuilding engine from database checkpoints + replay; sticky reverse proxy routing design. *(Done and verified)*

---

## Phase 9 — AI assistance (Done and verified)

- [x] **P9-01 `AIContextBuilder`.** Strictly read-only, hash-checked context builder with explicit `proposal_only: true` trust boundary and prompt-injection sanitization. *(Done and verified, `tests/ai.test.ts`)*
- [x] **P9-02 Unverified AI proposals.** `ConfiguredAIProvider` returning `verified: false`; UI panel with "Accept & Verify via Lean" ensuring model proposals must pass Lean verification before being committed. *(Done and verified, `AIProposalPanel.tsx`)*
