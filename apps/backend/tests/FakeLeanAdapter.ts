/**
 * FakeLeanAdapter - a scripted stand-in for Lean used by unit tests.
 *
 * It answers `getGoalsAt` from a table keyed by "line:column", and returns
 * whatever diagnostics the test installs. This lets us test the engine's
 * invariants (I1-I3, checkpoint replay, corruption detection) and the API
 * layers deterministically and without a Lean toolchain. Integration tests
 * against real Lean live in a separate suite (docs/TASKS.md, P1-03).
 */
import type { Diagnostic, SourcePosition } from "@proof-explorer/protocol";
import { parseGoalText } from "../src/lean/GoalTextParser";
import type {
  GoalSnapshot,
  LeanAdapter,
  LeanDocument,
  LeanSessionHandle,
  LeanSessionOptions,
} from "../src/lean/LeanAdapter";

export class FakeLeanAdapter implements LeanAdapter {
  /** "line:column" -> rendered goal texts at that position. */
  goalsByPosition = new Map<string, string[]>();
  diagnostics: Diagnostic[] = [];
  goalQueries = 0;
  sessionsCreated = 0;

  /** Crash listeners per Lean session handle id, like a real process table. */
  private crashListeners = new Map<string, Array<() => void>>();

  async createSession(_o: LeanSessionOptions): Promise<LeanSessionHandle> {
    this.sessionsCreated++;
    return { id: `fake${this.sessionsCreated}`, leanVersion: "fake-1.0" };
  }
  async openDocument(_s: LeanSessionHandle, _d: LeanDocument) {}
  async replaceDocument() {}
  async awaitElaboration() {}
  async getDiagnostics() {
    return this.diagnostics;
  }
  async getGoalsAt(
    _s: LeanSessionHandle,
    _uri: string,
    p: SourcePosition,
  ): Promise<GoalSnapshot> {
    this.goalQueries++;
    const texts = this.goalsByPosition.get(`${p.line}:${p.column}`) ?? [];
    return { goals: texts.map(parseGoalText), rendered: texts.join("\n\n"), documentVersion: 1 };
  }
  onCrash(s: LeanSessionHandle, listener: () => void) {
    this.crashListeners.set(s.id, [...(this.crashListeners.get(s.id) ?? []), listener]);
  }
  async disposeSession() {}

  /** TEST HOOK: simulate ONE Lean process (by handle id) dying unexpectedly. */
  crash(handleId: string): void {
    const listeners = this.crashListeners.get(handleId) ?? [];
    this.crashListeners.delete(handleId);
    for (const l of listeners) l();
  }
}
