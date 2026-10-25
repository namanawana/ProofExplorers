import React from "react";
import type { ProofState, Goal } from "@proof-explorer/protocol";
import { KatexExpr } from "./KatexExpr";

interface GoalInspectorProps {
  state?: ProofState;
  selectedGoalId?: string;
  onSelectGoal?: (goalId: string) => void;
}

export function GoalInspector({
  state,
  selectedGoalId,
  onSelectGoal,
}: GoalInspectorProps) {
  if (!state) {
    return (
      <div style={{ padding: 16, color: "#666", fontStyle: "italic" }}>
        No proof state available.
      </div>
    );
  }

  const { goals, focusedGoalId } = state;

  if (goals.length === 0) {
    return (
      <div style={{ padding: 16, backgroundColor: "#f0fff4", border: "1px solid #c6f6d5", borderRadius: 6, margin: 12 }}>
        <h4 style={{ margin: "0 0 6px 0", color: "#22543d" }}>🎉 No goals</h4>
        <p style={{ margin: 0, fontSize: 13, color: "#276749" }}>Proof completed and verified at this step.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 12, height: "100%", overflowY: "auto", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong style={{ fontSize: 13 }}>Goals ({goals.length})</strong>
        <span style={{ fontSize: 11, color: "#666" }}>
          Step {state.stepNumber} · hash: {state.stateHash.slice(0, 8)}
        </span>
      </div>

      {goals.map((g: Goal, idx: number) => {
        const isFocused = g.id === focusedGoalId;
        const isSelected = g.id === selectedGoalId;

        return (
          <div
            key={g.id}
            onClick={() => onSelectGoal?.(g.id)}
            style={{
              border: isFocused ? "2px solid #3182ce" : "1px solid #e2e8f0",
              borderRadius: 6,
              padding: 10,
              marginBottom: 10,
              backgroundColor: isSelected ? "#ebf8ff" : isFocused ? "#f7fafc" : "#fff",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "2px 6px",
                    borderRadius: 4,
                    backgroundColor: isFocused ? "#3182ce" : "#edf2f7",
                    color: isFocused ? "#fff" : "#4a5568",
                    marginRight: 6,
                  }}
                >
                  {isFocused ? "Focused" : `Goal ${idx + 1}`}
                </span>
                {g.caseName && (
                  <span style={{ fontSize: 11, color: "#718096" }}>
                    case <strong>{g.caseName}</strong>
                  </span>
                )}
              </div>
              {g.isAuthoritative && (
                <span style={{ fontSize: 10, color: "#38a169", backgroundColor: "#f0fff4", padding: "1px 4px", borderRadius: 3 }}>
                  mvar: {g.mvarId ?? g.id.slice(-6)}
                </span>
              )}
            </div>

            {/* Local Context */}
            {g.localContext.length > 0 && (
              <div style={{ margin: "6px 0", fontSize: 12, borderBottom: "1px solid #edf2f7", paddingBottom: 6 }}>
                {g.localContext.map((d) => (
                  <div key={d.name} style={{ display: "flex", gap: 6, fontFamily: "ui-monospace, monospace" }}>
                    <span style={{ color: "#d69e2e", fontWeight: 600 }}>{d.name}</span>
                    <span style={{ color: "#718096" }}>:</span>
                    <KatexExpr expr={d.type} />
                  </div>
                ))}
              </div>
            )}

            {/* Target */}
            <div style={{ fontSize: 13, fontWeight: 600, color: "#2b6cb0", display: "flex", alignItems: "baseline", gap: 6 }}>
              <span>⊢</span>
              <KatexExpr expr={g.target} displayMode={false} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
