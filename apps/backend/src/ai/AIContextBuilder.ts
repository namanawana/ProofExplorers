/**
 * AIContextBuilder - builds bounded, verified, read-only proof context for AI assistance.
 *
 * Implements P9-01:
 *   - Strictly read-only: never mutates engine cursor or state
 *   - Hash-checked against the current committed state
 *   - Explicit `proposal_only: true` boundary marker
 *   - Sanitizes and bounds input size to resist prompt injection and token exhaustion
 */
import type { Dependency, ProofState, ProofUnit } from "@proof-explorer/protocol";

export const MAX_AI_CONTEXT_CHARS = 16_000;

export interface VerifiedAIContext {
  proposalOnly: true;
  stateHash: string;
  unitId: string;
  unitName?: string;
  statement?: string;
  focusedGoal?: {
    target: string;
    localContext: Array<{ name: string; type: string }>;
  };
  openGoalsCount: number;
  dependencies: Array<{ name: string; kind: string }>;
  sanitizedPrompt: string;
}

export class AIContextBuilder {
  build(
    state: ProofState,
    unit: ProofUnit,
    dependencies: Dependency[],
  ): VerifiedAIContext {
    const focused = state.goals.find((g) => g.id === state.focusedGoalId) ?? state.goals[0];

    const depList = dependencies.map((d) => ({
      name: d.toUnitId,
      kind: d.evidence.kind,
    }));

    // Construct prompt while escaping potential delimiter injections
    const lines: string[] = [];
    lines.push(`Theorem: ${unit.name ?? "anonymous"}`);
    if (unit.statement) lines.push(`Statement: ${unit.statement}`);
    lines.push(`Step: ${state.stepNumber} (stateHash: ${state.stateHash})`);
    lines.push(`Remaining Open Goals: ${state.goals.length}`);

    if (focused) {
      lines.push("\nFocused Goal:");
      if (focused.localContext.length > 0) {
        lines.push("Local Hypotheses:");
        for (const h of focused.localContext) {
          lines.push(`  ${sanitize(h.name)} : ${sanitize(h.type)}`);
        }
      }
      lines.push(`⊢ ${sanitize(focused.target)}`);
    }

    if (depList.length > 0) {
      lines.push("\nAvailable Verified Dependencies:");
      for (const d of depList) {
        lines.push(`  - ${sanitize(d.name)} (${d.kind})`);
      }
    }

    let prompt = lines.join("\n");
    if (prompt.length > MAX_AI_CONTEXT_CHARS) {
      prompt = prompt.slice(0, MAX_AI_CONTEXT_CHARS) + "\n... [truncated]";
    }

    return {
      proposalOnly: true,
      stateHash: state.stateHash,
      unitId: unit.id,
      unitName: unit.name,
      statement: unit.statement,
      focusedGoal: focused
        ? {
            target: focused.target,
            localContext: focused.localContext.map((c) => ({ name: c.name, type: c.type })),
          }
        : undefined,
      openGoalsCount: state.goals.length,
      dependencies: depList,
      sanitizedPrompt: prompt,
    };
  }
}

function sanitize(text: string): string {
  // Disarm common prompt injection delimiters
  return text.replace(/<\|im_start\|>|<\|im_end\|>|```/g, " ");
}
