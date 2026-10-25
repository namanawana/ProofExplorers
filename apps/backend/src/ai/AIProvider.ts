/**
 * AIProvider - model provider abstraction for tactic suggestions and explanations.
 *
 * Implements P9-02:
 *   - Strictly returns unverified proposals (`verified: false`)
 *   - Proposals must pass through ProofEngine / Lean validation before acceptance
 *   - Gracefully disabled when no API provider is configured
 */
import type { VerifiedAIContext } from "./AIContextBuilder";

export interface AIProposal {
  type: "tactic_suggestion" | "explanation";
  proposalText: string;
  verified: false;
  stateHash: string;
}

export interface AIProvider {
  isAvailable(): boolean;
  explainGoal(ctx: VerifiedAIContext): Promise<AIProposal>;
  suggestTactic(ctx: VerifiedAIContext): Promise<AIProposal>;
}

export class ConfiguredAIProvider implements AIProvider {
  constructor(private readonly apiKey?: string) {}

  isAvailable(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async explainGoal(ctx: VerifiedAIContext): Promise<AIProposal> {
    if (!this.isAvailable()) {
      return {
        type: "explanation",
        proposalText: "AI provider is not configured. Set AI_API_KEY to enable.",
        verified: false,
        stateHash: ctx.stateHash,
      };
    }

    const explanation = `Focused goal target is \`${ctx.focusedGoal?.target ?? "complete"}\` with ${ctx.focusedGoal?.localContext.length ?? 0} hypotheses.`;
    return {
      type: "explanation",
      proposalText: explanation,
      verified: false,
      stateHash: ctx.stateHash,
    };
  }

  async suggestTactic(ctx: VerifiedAIContext): Promise<AIProposal> {
    if (!this.isAvailable()) {
      return {
        type: "tactic_suggestion",
        proposalText: "simp",
        verified: false,
        stateHash: ctx.stateHash,
      };
    }

    const target = ctx.focusedGoal?.target ?? "";
    let candidate = "simp";
    if (target.includes("∧")) {
      candidate = "constructor";
    } else if (target.includes("=")) {
      candidate = "rfl";
    }

    return {
      type: "tactic_suggestion",
      proposalText: candidate,
      verified: false,
      stateHash: ctx.stateHash,
    };
  }
}
