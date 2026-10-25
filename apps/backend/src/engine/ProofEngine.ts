/**
 * ProofEngine - the per-session state machine at the heart of the system.
 *
 *   S0 --T1--> S1 --T2--> S2 ...
 *
 * Responsibilities
 *   - turn "Next" into a VERIFIED transition via the LeanAdapter
 *   - commit transitions transactionally (compute -> persist -> advance)
 *   - serve Previous / Jump / Reset from history, checkpoint + replay
 *   - emit domain events
 *
 * Key invariants enforced here
 *   I1  a state is only ever shown after Lean verified the step
 *   I2  every committed transition is recoverable (persist BEFORE advancing)
 *   I3  a rejected command changes NOTHING (all work happens on locals; the
 *       only mutations are the final assignments after persistence succeeds)
 *
 * Two integers describe progress:
 *   frontier : furthest step Lean has verified and we have committed
 *   cursor   : the step the user is currently looking at (<= frontier)
 * Previous/Reset only move the cursor; they never ask Lean to "undo".
 */
import type {
  Checkpoint,
  Diagnostic,
  EventType,
  Goal,
  ProofState,
  ProofTransition,
  SourcePosition,
  SourceRange,
} from "@proof-explorer/protocol";
import type { LeanAdapter, LeanSessionHandle } from "../lean/LeanAdapter";
import {
  AppError,
  rangeEnd,
  rangesOverlap,
  type Clock,
  type Logger,
} from "../util/index";
import { CheckpointManager } from "./CheckpointManager";
import type { EventStore } from "./EventStore";
import { hashGoals, reconcileGoals } from "./GoalManager";
import type { CommitRecord, ProofRepository } from "./ProofRepository";
import { LruCache } from "./StateCache";

/** One executable unit of the proof script (a top-level tactic of the unit). */
export interface ScriptCommand {
  /** 1-based; equals the step number this command produces. */
  index: number;
  text: string;
  range: SourceRange;
}

/** Everything the engine needs to know about WHAT it is stepping through. */
export interface ProofTarget {
  unitId: string;
  /** Whole-unit range; errors anywhere inside it fail the FINAL step. */
  unitRange: SourceRange;
  documentUri: string;
  /** Position just after `by`, i.e. where the state before step 1 lives. */
  initialPosition: SourcePosition;
  script: ScriptCommand[];
}

export interface EngineConfig {
  checkpointInterval: number;
  elaborationTimeoutMs: number;
  stateCacheSize: number;
}

export interface EngineDeps {
  sessionId: string;
  adapter: LeanAdapter;
  leanSession: LeanSessionHandle;
  target: ProofTarget;
  repo: ProofRepository;
  events: EventStore;
  clock: Clock;
  logger: Logger;
  config: EngineConfig;
}

export interface StepOutcome {
  state: ProofState;
  /** The transition INTO `state` (undefined at step 0). */
  transition?: ProofTransition;
}

/** Result of computing a step. Pure data: nothing has been committed yet. */
interface Computed {
  state: ProofState;
  /** Absent only for step 0, which has no incoming transition. */
  transition?: ProofTransition;
  closed: Goal[];
  created: Goal[];
}

export class ProofEngine {
  private frontier = 0;
  private cursor = 0;
  private initialized = false;
  private leanSession: LeanSessionHandle;

  private readonly cache: LruCache<number, ProofState>;
  private readonly checkpoints: CheckpointManager;
  /** Serialises operations: Next/Jump/... never interleave on one session. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: EngineDeps) {
    this.leanSession = deps.leanSession;
    this.cache = new LruCache(deps.config.stateCacheSize);
    this.checkpoints = new CheckpointManager(deps.config.checkpointInterval);
  }

  // =========================================================================
  // Public operations (each runs exclusively, one at a time)
  // =========================================================================

  /** Load step 0 (the goals before the first tactic) and commit it. */
  initialize(): Promise<StepOutcome> {
    return this.exclusive(async () => {
      const { adapter, target, config } = this.deps;
      await adapter.awaitElaboration(
        this.leanSession,
        target.documentUri,
        config.elaborationTimeoutMs,
      );

      // The statement itself must elaborate, otherwise there is nothing to run.
      const diags = await adapter.getDiagnostics(this.leanSession, target.documentUri);
      const head: SourceRange = {
        ...target.unitRange,
        endLine: target.initialPosition.line,
        endColumn: target.initialPosition.column,
      };
      const headErrors = diags.filter(
        (d) => d.severity === "error" && rangesOverlap(d.range, head),
      );
      if (headErrors.length > 0) {
        throw new AppError(
          "TACTIC_REJECTED",
          "The statement does not elaborate in Lean",
          headErrors,
        );
      }

      const snap = await adapter.getGoalsAt(
        this.leanSession,
        target.documentUri,
        target.initialPosition,
      );
      const rec = reconcileGoals({
        unitId: target.unitId,
        step: 0,
        previousOpen: [],
        raw: snap.goals,
      });
      const state = this.buildState(0, undefined, rec.open, target.initialPosition);
      await this.commit({ state, closed: [], created: rec.created });
      this.initialized = true;
      return { state };
    });
  }

  /** Return the exact next source tactic without mutating proof state. */
  nextCommand(): string | undefined {
    if (this.cursor < this.frontier) return this.deps.target.script[this.cursor]?.text;
    return this.deps.target.script[this.frontier]?.text;
  }

  currentState(): Promise<ProofState> {
    return this.materialize(this.cursor);
  }

  next(): Promise<StepOutcome> {
    return this.exclusive(async () => {
      this.assertInitialized();

      // Already verified earlier (user went Previous): just move the cursor.
      if (this.cursor < this.frontier) {
        return this.moveCursor(this.cursor + 1);
      }
      if (this.frontier >= this.deps.target.script.length) {
        throw new AppError("NO_MORE_STEPS", "The proof is already complete");
      }
      await this.advanceFrontier();
      return this.moveCursor(this.frontier);
    });
  }

  previous(): Promise<StepOutcome> {
    return this.exclusive(async () => {
      this.assertInitialized();
      if (this.cursor === 0) {
        throw new AppError("STEP_OUT_OF_RANGE", "Already at the first step");
      }
      return this.moveCursor(this.cursor - 1);
    });
  }

  reset(): Promise<StepOutcome> {
    return this.exclusive(async () => {
      this.assertInitialized();
      return this.moveCursor(0);
    });
  }

  /** Jump to any step. Steps beyond the frontier are executed (and verified). */
  jump(step: number): Promise<StepOutcome> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const total = this.deps.target.script.length;
      if (!Number.isInteger(step) || step < 0 || step > total) {
        throw new AppError("STEP_OUT_OF_RANGE", `Step ${step} is outside 0..${total}`);
      }
      while (this.frontier < step) await this.advanceFrontier();
      return this.moveCursor(step);
    });
  }

  /** Point the engine at a fresh Lean process after a crash. History is kept. */
  rebind(leanSession: LeanSessionHandle): void {
    this.leanSession = leanSession;
    this.cache.clear(); // cached bodies are still valid, but force re-verify
  }

  progress(): { frontier: number; cursor: number; total: number } {
    return {
      frontier: this.frontier,
      cursor: this.cursor,
      total: this.deps.target.script.length,
    };
  }

  checkpointList(): readonly Checkpoint[] {
    return this.checkpoints.list();
  }

  // =========================================================================
  // Transactional step execution
  // =========================================================================

  /**
   * Execute exactly one new step beyond the frontier.
   *
   *   BEGIN     computeStep()   - talks to Lean, builds values, mutates nothing
   *   VALIDATE  inside computeStep (diagnostics + goal parse)
   *   COMMIT    commit()        - persist, THEN advance frontier
   *   ROLLBACK  on any throw: nothing was mutated, so there is nothing to undo
   */
  private async advanceFrontier(): Promise<void> {
    const cmd = this.deps.target.script[this.frontier]!;
    const prev = await this.materialize(this.frontier);
    await this.emit("COMMAND_STARTED", { step: cmd.index, command: cmd.text });
    try {
      const computed = await this.computeStep(prev, cmd);
      await this.commit(computed);
      await this.emit("COMMAND_COMPLETED", {
        step: cmd.index,
        durationMs: computed.transition?.durationMs,
      });
    } catch (err) {
      await this.emit("COMMAND_FAILED", {
        step: cmd.index,
        reason: (err as Error).message,
      });
      throw err; // frontier/cursor untouched => Invariant 3
    }
  }

  /** Ask Lean for the result of `cmd` applied to `prev`. No side effects. */
  private async computeStep(prev: ProofState, cmd: ScriptCommand): Promise<Computed> {
    const { adapter, target, clock, config } = this.deps;
    const startedAt = clock.now();

    await adapter.awaitElaboration(
      this.leanSession,
      target.documentUri,
      config.elaborationTimeoutMs,
    );
    const diagnostics = await adapter.getDiagnostics(
      this.leanSession,
      target.documentUri,
    );

    // Which errors count against THIS step? Lean reports "unsolved goals"
    // on the enclosing block rather than on the last tactic, so the FINAL step
    // is held responsible for every error inside the whole unit.
    const isFinal = cmd.index === target.script.length;
    const scope = isFinal ? target.unitRange : cmd.range;
    const errors = diagnostics.filter(
      (d) => d.severity === "error" && rangesOverlap(d.range, scope),
    );
    if (errors.length > 0) {
      throw new AppError(
        "TACTIC_REJECTED",
        `Lean rejected \`${cmd.text.trim()}\``,
        errors,
      );
    }

    const end = rangeEnd(cmd.range);
    const snap = await adapter.getGoalsAt(this.leanSession, target.documentUri, end);
    const rec = reconcileGoals({
      unitId: target.unitId,
      step: cmd.index,
      previousOpen: prev.goals,
      raw: snap.goals,
    });
    const state = this.buildState(cmd.index, prev, rec.open, end, cmd.range);

    const warnings: Diagnostic[] = diagnostics.filter(
      (d) => d.severity !== "error" && rangesOverlap(d.range, cmd.range),
    );
    const transition: ProofTransition = {
      id: `${state.id}<-${prev.id}`,
      fromStateId: prev.id,
      toStateId: state.id,
      command: cmd.text,
      sourceRange: cmd.range,
      verified: true,
      durationMs: clock.now() - startedAt,
      diagnostics: warnings.length ? warnings : undefined,
      generatedGoals: rec.created.map((g) => g.id),
      solvedGoals: rec.closed.map((g) => g.id),
    };
    return { state, transition, closed: rec.closed, created: rec.created };
  }

  /** Persist first, advance second. A failure in `saveCommit` aborts cleanly. */
  private async commit(c: Computed): Promise<void> {
    const step = c.state.stepNumber;
    const isCheckpoint = this.checkpoints.shouldCheckpoint(step);

    const record: CommitRecord = {
      state: c.state,
      transition: c.transition,
      closedGoals: c.closed,
      createdGoals: c.created,
      keepBody: isCheckpoint,
    };
    await this.deps.repo.saveCommit(this.deps.sessionId, record);

    // ---- COMMIT POINT: everything below only touches in-memory bookkeeping.
    this.frontier = step;
    this.cache.set(step, c.state);

    await this.emit("STATE_CREATED", { step, stateId: c.state.id });
    for (const g of c.created) await this.emit("GOAL_CREATED", { goalId: g.id, step });
    for (const g of c.closed) await this.emit("GOAL_SOLVED", { goalId: g.id, step });
    if (c.state.focusedGoalId) {
      await this.emit("GOAL_FOCUSED", { goalId: c.state.focusedGoalId, step });
    }
    await this.emit("STATE_COMMITTED", { step, stateHash: c.state.stateHash });

    if (isCheckpoint) {
      const cp: Checkpoint = {
        id: `${this.deps.sessionId}:cp${step}`,
        sessionId: this.deps.sessionId,
        proofUnitId: this.deps.target.unitId,
        step,
        stateId: c.state.id,
        stateHash: c.state.stateHash,
        documentVersion: 0,
        createdAt: this.deps.clock.now(),
      };
      this.checkpoints.record(cp);
      await this.deps.repo.saveCheckpoint(cp);
      await this.emit("CHECKPOINT_CREATED", { step });
    }
    if (step > 0 && step === this.deps.target.script.length && c.state.goals.length === 0) {
      await this.emit("PROOF_COMPLETED", { unitId: this.deps.target.unitId });
    }
  }

  // =========================================================================
  // History access: cache -> stored body -> checkpoint + deterministic replay
  // =========================================================================

  private async moveCursor(step: number): Promise<StepOutcome> {
    const state = await this.materialize(step);
    this.cursor = step;
    const transition =
      step === 0
        ? undefined
        : await this.deps.repo.getTransition(this.deps.sessionId, step);
    return { state, transition };
  }

  /**
   * Obtain the full state for any committed step <= frontier.
   * Replay re-queries Lean for each step after the checkpoint and compares the
   * result with the hash recorded at commit time; any difference means the
   * stored history and Lean disagree, and LEAN WINS: we fail loudly with
   * CHECKPOINT_CORRUPT instead of showing a state we cannot justify.
   */
  private async materialize(step: number): Promise<ProofState> {
    const hit = this.cache.get(step);
    if (hit) return hit;

    const stored = await this.deps.repo.getState(this.deps.sessionId, step);
    if (stored) {
      this.cache.set(step, stored);
      return stored;
    }

    const cp = this.checkpoints.nearestAtOrBefore(step);
    if (!cp) throw new AppError("CHECKPOINT_CORRUPT", `No checkpoint at or before step ${step}`);

    const base = await this.deps.repo.getState(this.deps.sessionId, cp.step);
    if (!base || base.stateHash !== cp.stateHash) {
      throw new AppError("CHECKPOINT_CORRUPT", `Checkpoint at step ${cp.step} failed its integrity check`);
    }
    await this.emit("CHECKPOINT_RESTORED", { fromStep: cp.step, toStep: step });

    let prev = base;
    for (let s = cp.step + 1; s <= step; s++) {
      const cmd = this.deps.target.script[s - 1]!;
      const replayed = await this.computeStep(prev, cmd);
      const expected = await this.deps.repo.getStateHash(this.deps.sessionId, s);
      if (expected !== replayed.state.stateHash) {
        throw new AppError("CHECKPOINT_CORRUPT", `Replay diverged from recorded history at step ${s}`);
      }
      prev = replayed.state;
      this.cache.set(s, prev);
    }
    return prev;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private buildState(
    step: number,
    prev: ProofState | undefined,
    goals: Goal[],
    position: SourcePosition,
    range?: SourceRange,
  ): ProofState {
    const hash = hashGoals(goals);
    const focused = goals[0];
    return {
      id: `${this.deps.sessionId}@${step}:${hash.slice(0, 12)}`,
      proofUnitId: this.deps.target.unitId,
      stepNumber: step,
      goals,
      focusedGoalId: focused?.id,
      localContext: focused?.localContext ?? [],
      sourcePosition: position,
      sourceRange: range,
      stateHash: hash,
      parentStateId: prev?.id,
      timestamp: this.deps.clock.now(),
    };
  }

  private emit(type: EventType, payload: Record<string, unknown>): Promise<unknown> {
    return this.deps.events.append(this.deps.sessionId, type, payload);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new AppError("INTERNAL", "Engine is not initialized");
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
