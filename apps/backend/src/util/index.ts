/**
 * Small, dependency-free helpers shared by every backend module.
 *
 * Nothing here knows about Lean, HTTP or WebSockets. Keeping these primitives
 * in one place lets the rest of the code receive them via dependency injection
 * (Clock, Logger) instead of reaching for hidden globals.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  Diagnostic,
  ErrorCode,
  SourcePosition,
  SourceRange,
} from "@proof-explorer/protocol";

// ---------------------------------------------------------------------------
// Hashing / ids
// ---------------------------------------------------------------------------

export const sha256 = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

export const newId = (): string => randomUUID();

/**
 * Canonical JSON: object keys sorted, `undefined` dropped. Two structurally
 * equal values always serialise identically, which is what makes state hashes
 * (and therefore replay-divergence detection) reliable.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Injectable clock so tests (and replay) never depend on wall time. */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The only error type that is allowed to cross the engine/API boundary.
 * It carries a protocol `ErrorCode` so the WebSocket and REST layers can map
 * failures to client-visible errors without string matching.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly diagnostics?: Diagnostic[],
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that stamps `fields` on every line (e.g. sessionId). */
  child(fields: LogFields): Logger;
}

/** JSON-lines logger: one object per line, trivially ingestible by any stack. */
export function createLogger(base: LogFields = {}, sink = console.log): Logger {
  const write = (level: string, msg: string, fields?: LogFields) =>
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...base,
        ...fields,
      }),
    );
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (f) => createLogger({ ...base, ...f }, sink),
  };
}

/** Logger that discards everything; handy default for unit tests. */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};

// ---------------------------------------------------------------------------
// Source-range arithmetic (zero-based lines, UTF-16 columns)
// ---------------------------------------------------------------------------

export const rangeStart = (r: SourceRange): SourcePosition => ({
  line: r.startLine,
  column: r.startColumn,
});

export const rangeEnd = (r: SourceRange): SourcePosition => ({
  line: r.endLine,
  column: r.endColumn,
});

export function comparePositions(a: SourcePosition, b: SourcePosition): number {
  return a.line !== b.line ? a.line - b.line : a.column - b.column;
}

/** Inclusive overlap test; a zero-width range inside `b` counts as overlapping. */
export function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  return !(
    comparePositions(rangeEnd(a), rangeStart(b)) < 0 ||
    comparePositions(rangeEnd(b), rangeStart(a)) < 0
  );
}

export function makeRange(
  fileId: string,
  start: SourcePosition,
  end: SourcePosition,
): SourceRange {
  return {
    fileId,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

// ---------------------------------------------------------------------------
// Security & Path resolution
// ---------------------------------------------------------------------------

import { resolve, normalize, isAbsolute } from "node:path";

/**
 * Validates that `userInput` resolves strictly inside `baseDir`.
 * Prevents directory traversal (`../`), null byte injections, and symlink escapes.
 */
export function safePath(baseDir: string, userInput: string): string {
  if (userInput.includes("\0")) {
    throw new AppError("INVALID_MESSAGE", "Path contains null byte");
  }
  const resolvedBase = resolve(baseDir);
  let resolvedTarget: string;
  if (isAbsolute(userInput)) {
    resolvedTarget = resolve(userInput);
  } else {
    resolvedTarget = resolve(resolvedBase, userInput);
  }

  // Ensure resolvedTarget is inside resolvedBase (with trailing separator check)
  const basePrefix = resolvedBase.endsWith("/") ? resolvedBase : resolvedBase + "/";
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(basePrefix)) {
    throw new AppError("INVALID_MESSAGE", "Access outside permitted directory is forbidden");
  }
  return resolvedTarget;
}
