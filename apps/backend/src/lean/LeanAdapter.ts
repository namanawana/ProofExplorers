/**
 * LeanAdapter - the ONLY abstraction through which the backend talks to Lean.
 *
 * Why this differs slightly from the "execute(command)" sketch in the spec
 * --------------------------------------------------------------------------
 * Lean's language server does not expose a "run one tactic and give me the
 * new state" call. It elaborates a whole document and lets clients ask
 * "what are the goals at position P?" (`$/lean/plainGoal`). So the verified
 * transition  S(k-1) --T_k--> S(k)  is obtained as:
 *
 *   1. Lean has elaborated the document (awaitElaboration).
 *   2. No error diagnostic overlaps the source range of tactic T_k.
 *   3. getGoalsAt(end of T_k) returns the resulting goals.
 *
 * Consequently "checkpoint/restore" is NOT an adapter concern: a checkpoint is
 * a (documentVersion, position, hash) descriptor held by the engine, and
 * restoring it is just another position query. This keeps the adapter small
 * and makes crash recovery trivial (re-open the document, query again).
 *
 * Nothing outside src/lean/ may import LSP types or know about JSON-RPC.
 */
import type {
  Diagnostic,
  LocalDeclaration,
  SourcePosition,
} from "@proof-explorer/protocol";

/** Opaque handle to one live Lean process / server connection. */
export interface LeanSessionHandle {
  readonly id: string;
  /** Version string reported by the Lean server at startup. */
  readonly leanVersion: string;
}

export interface LeanSessionOptions {
  /** Directory containing the Lake project the document belongs to. */
  projectRoot: string;
  startupTimeoutMs: number;
}

export interface LeanDocument {
  /** file:// URI Lean uses to identify the document. */
  uri: string;
  /** Our own file id; stamped onto every SourceRange the adapter returns. */
  fileId: string;
  text: string;
}

/** A goal reported by Lean, parsed into target/context with optional metavariable id. */
export interface RawGoal {
  mvarId?: string;
  caseName?: string;
  target: string;
  context: LocalDeclaration[];
}

export interface GoalSnapshot {
  goals: RawGoal[];
  /** Lean's own rendering, kept for display/debugging. */
  rendered: string;
  documentVersion: number;
}

export interface LeanAdapter {
  createSession(options: LeanSessionOptions): Promise<LeanSessionHandle>;

  openDocument(session: LeanSessionHandle, doc: LeanDocument): Promise<void>;

  /** Replace the full text of an already-open document (DOCUMENT_CHANGED). */
  replaceDocument(
    session: LeanSessionHandle,
    uri: string,
    text: string,
  ): Promise<void>;

  /**
   * Resolve once Lean has finished elaborating the current document version.
   * Rejects with AppError("LEAN_TIMEOUT") if it takes longer than `timeoutMs`.
   */
  awaitElaboration(
    session: LeanSessionHandle,
    uri: string,
    timeoutMs: number,
  ): Promise<void>;

  /** All diagnostics Lean has published for the current document version. */
  getDiagnostics(
    session: LeanSessionHandle,
    uri: string,
  ): Promise<Diagnostic[]>;

  /** Goals Lean reports at `position`. An empty list means "no goals". */
  getGoalsAt(
    session: LeanSessionHandle,
    uri: string,
    position: SourcePosition,
  ): Promise<GoalSnapshot>;

  /** Register a callback fired if the Lean process dies unexpectedly. */
  onCrash(session: LeanSessionHandle, listener: () => void): void;

  disposeSession(session: LeanSessionHandle): Promise<void>;
}
