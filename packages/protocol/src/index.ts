/**
 * @proof-explorer/protocol
 * ---------------------------------------------------------------------------
 * Single source of truth for every type that crosses a process boundary:
 *   - the domain model (ProofUnit, ProofState, Goal, ProofTransition, ...)
 *   - the append-only event log vocabulary
 *   - the WebSocket wire protocol (versioned)
 *
 * The backend and the web client both import from here, so a protocol change
 * is a compile error on both sides instead of a runtime surprise.
 *
 * CONVENTION: all line/column values are ZERO-BASED and columns are UTF-16 code
 * units. This matches both the LSP specification and JavaScript string
 * indexing, so no off-by-one conversion is needed anywhere in the stack.
 */

export const PROTOCOL_VERSION = "1.0" as const;

// ===========================================================================
// 1. Source tracking
// ===========================================================================

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  fileId: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

// ===========================================================================
// 2. Hierarchical model (ProofUnit)
// ===========================================================================

export type ProofUnitType =
  | "project"
  | "file"
  | "namespace"
  | "definition"
  | "theorem"
  | "lemma"
  | "example"
  | "subproof"
  | "local_have" // `have h : Q := by ...`  (opens a sub-proof, new goal)
  | "intermediate_result" // `have h : Q := lemma_A` (term-mode, NO sub-proof)
  | "goal";

export type ProofUnitStatus = "pending" | "in_progress" | "verified" | "failed";

/**
 * A node in the hierarchy. Nesting depth is unbounded: `children` is just a
 * list of ids, so the tree is stored flat and loaded lazily (Invariant 7).
 */
export interface ProofUnit {
  id: string;
  type: ProofUnitType;
  name?: string;
  statement?: string;
  parentId?: string;
  sourceRange?: SourceRange;
  /** Ids of units this unit logically depends on (derived from the DAG). */
  dependencies: string[];
  children: string[];
  status: ProofUnitStatus;
  /** Ids of committed states. Loaded lazily; may be empty until executed. */
  states: string[];
  metadata?: Record<string, unknown>;
}

// ===========================================================================
// 3. Dependency DAG  (kept strictly separate from the timeline - Invariant 9)
// ===========================================================================

export type DependencyKind = "depends_on" | "proves" | "derives" | "used_by";

/**
 * How we know the edge exists. Invariant 4: an edge MUST carry evidence.
 *  - "syntactic": identifier occurrence in source (may over-approximate)
 *  - "elaborated": confirmed from Lean's environment / term (authoritative)
 */
export type DependencyEvidenceKind = "syntactic" | "elaborated";

export interface Dependency {
  id: string;
  fromUnitId: string; // the dependent (e.g. the theorem)
  toUnitId: string; // the dependency (e.g. the lemma)
  kind: DependencyKind;
  evidence: {
    kind: DependencyEvidenceKind;
    range: SourceRange; // where the reference occurs
  };
}

// ===========================================================================
// 4. Proof state / goals / transitions (the execution timeline)
// ===========================================================================

export interface LocalDeclaration {
  name: string;
  type: string;
  /** Present for `let`-style declarations (x : T := v). */
  value?: string;
}

export type GoalStatus = "open" | "focused" | "solved" | "abandoned";

export interface Goal {
  id: string;
  /** Authoritative metavariable identifier from Lean kernel/LSP when available. */
  mvarId?: string;
  parentGoalId?: string;
  createdAtStep: number;
  solvedAtStep?: number;
  status: GoalStatus;
  /** Lean `case` tag, if any (e.g. "left"). */
  caseName?: string;
  target: string;
  localContext: LocalDeclaration[];
  /** Explicitly marks whether lineage was determined authoritatively or state-local. */
  isAuthoritative?: boolean;
}

export interface ProofState {
  id: string;
  proofUnitId: string;
  stepNumber: number;
  /** Only OPEN goals; solved goals live in the transition that closed them. */
  goals: Goal[];
  focusedGoalId?: string;
  localContext: LocalDeclaration[];
  sourcePosition?: SourcePosition;
  sourceRange?: SourceRange;
  /** Hash of the canonical goal list; used for corruption detection on replay. */
  stateHash: string;
  parentStateId?: string;
  timestamp: number;
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  range: SourceRange;
}

export interface ProofTransition {
  id: string;
  fromStateId: string;
  toStateId: string;
  command: string;
  sourceRange?: SourceRange;
  /** Always true for committed transitions. Rejected ones are never stored. */
  verified: true;
  durationMs?: number;
  diagnostics?: Diagnostic[];
  generatedGoals?: string[];
  solvedGoals?: string[];
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  proofUnitId: string;
  step: number;
  stateId: string;
  stateHash: string;
  documentVersion: number;
  createdAt: number;
}

// ===========================================================================
// 5. Project / file / session metadata
// ===========================================================================

export interface Project {
  id: string;
  name: string;
  createdAt: number;
}

export interface ProjectFile {
  id: string;
  projectId: string;
  path: string;
  /** SHA-256 of contents; the contents live in file storage, not the DB row. */
  contentHash: string;
  lineCount: number;
}

export type SessionStatus =
  | "starting"
  | "ready"
  | "busy"
  | "recovering"
  | "failed"
  | "closed";

export interface SessionInfo {
  id: string;
  projectId: string;
  fileId: string;
  proofUnitId: string;
  status: SessionStatus;
  leanVersion: string;
  /** Furthest verified step. */
  frontierStep: number;
  /** Step currently displayed to the user. */
  cursorStep: number;
  totalSteps: number;
}

// ===========================================================================
// 6. Event log (append-only; powers debugging and replay)
// ===========================================================================

export type EventType =
  | "SESSION_CREATED"
  | "DOCUMENT_LOADED"
  | "DOCUMENT_CHANGED"
  | "PROOF_UNIT_DISCOVERED"
  | "PROOF_UNIT_ENTERED"
  | "PROOF_UNIT_EXITED"
  | "COMMAND_STARTED"
  | "COMMAND_COMPLETED"
  | "COMMAND_FAILED"
  | "GOAL_CREATED"
  | "GOAL_FOCUSED"
  | "GOAL_SOLVED"
  | "TACTIC_APPLIED"
  | "STATE_CREATED"
  | "STATE_COMMITTED"
  | "CHECKPOINT_CREATED"
  | "CHECKPOINT_RESTORED"
  | "DEPENDENCY_DISCOVERED"
  | "PROOF_COMPLETED";

export interface DomainEvent {
  /** Monotonic per-session sequence number assigned by the EventStore. */
  seq: number;
  sessionId: string;
  type: EventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

// ===========================================================================
// 7. WebSocket protocol
// ===========================================================================

export type ErrorCode =
  | "PROTOCOL_VERSION_MISMATCH"
  | "INVALID_MESSAGE"
  | "UNKNOWN_SESSION"
  | "SESSION_BUSY"
  | "SESSION_CLOSED"
  | "NO_MORE_STEPS"
  | "STEP_OUT_OF_RANGE"
  | "TACTIC_REJECTED"
  | "LEAN_TIMEOUT"
  | "LEAN_CRASHED"
  | "CHECKPOINT_CORRUPT"
  | "INTERNAL";

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  /** Lean diagnostics that justify a TACTIC_REJECTED, if any. */
  diagnostics?: Diagnostic[];
}

/** Every message, in both directions, carries this envelope. */
export interface Envelope<TType extends string, TPayload> {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: TType;
  /** Client-chosen correlation id; echoed on the matching response. */
  requestId: string;
  sessionId: string;
  payload: TPayload;
}

// ---- Client -> Server ------------------------------------------------------

export type ClientMessage =
  | Envelope<"ATTACH", Record<string, never>>
  | Envelope<"DETACH", Record<string, never>>
  | Envelope<"NEXT", Record<string, never>>
  | Envelope<"PREVIOUS", Record<string, never>>
  | Envelope<"RESET", Record<string, never>>
  | Envelope<"JUMP", { step: number }>
  | Envelope<"ENTER_UNIT", { proofUnitId: string }>
  | Envelope<"PING", Record<string, never>>;

export type ClientMessageType = ClientMessage["type"];

// ---- Server -> Client ------------------------------------------------------

/** Incremental graph change so the client never re-downloads the whole DAG. */
export interface GraphDelta {
  addedUnits: ProofUnit[];
  addedDependencies: Dependency[];
  removedUnitIds: string[];
}

export interface StateUpdatePayload {
  step: number;
  /** Always true: the server never emits unverified states (Invariant 1). */
  verified: true;
  state: ProofState;
  transition?: ProofTransition;
  session: SessionInfo;
  graphDelta?: GraphDelta;
}

export type ServerMessage =
  | Envelope<"STATE_UPDATE", StateUpdatePayload>
  | Envelope<"SESSION_STATUS", SessionInfo>
  | Envelope<"EVENT", DomainEvent>
  | Envelope<"ERROR", ErrorPayload>
  | Envelope<"PONG", Record<string, never>>;

export type ServerMessageType = ServerMessage["type"];

// ===========================================================================
// 8. REST payloads
// ===========================================================================

export interface CreateProjectRequest {
  name: string;
}

export interface UploadFileRequest {
  path: string;
  content: string;
}

export interface CreateSessionRequest {
  projectId: string;
  fileId: string;
  proofUnitId: string;
}

/** Lightweight structure node: enough to render the explorer tree lazily. */
export interface StructureNode {
  id: string;
  type: ProofUnitType;
  name?: string;
  status: ProofUnitStatus;
  childCount: number;
  sourceRange?: SourceRange;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface HttpError {
  error: { code: ErrorCode | "NOT_FOUND" | "BAD_REQUEST"; message: string };
}
