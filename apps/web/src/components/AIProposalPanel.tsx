import React, { useState } from "react";
import type { SessionInfo } from "@proof-explorer/protocol";

interface AIProposalPanelProps {
  session?: SessionInfo;
  onApplyTactic?: (tacticText: string, stateHash: string) => Promise<void>;
}

export function AIProposalPanel({ session, onApplyTactic }: AIProposalPanelProps) {
  const [loading, setLoading] = useState(false);
  const [proposal, setProposal] = useState<{
    type: string;
    text: string;
    stateHash: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!session) return null;

  const requestAI = async (endpoint: "explain" | "suggest") => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}/ai/${endpoint}`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error((await res.json()).error?.message ?? "AI request failed");
      }
      const data = await res.json();
      setProposal({
        type: data.type,
        text: data.proposalText,
        stateHash: data.stateHash,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async () => {
    if (!proposal || proposal.type !== "tactic_suggestion") return;
    setLoading(true);
    try {
      await onApplyTactic?.(proposal.text, proposal.stateHash);
      setProposal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 12, borderTop: "1px solid #e2e8f0", backgroundColor: "#fbfcfe" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <strong style={{ fontSize: 12 }}>🤖 AI Assistance</strong>
          <span
            style={{
              fontSize: 10,
              backgroundColor: "#feebc8",
              color: "#7b341e",
              padding: "1px 6px",
              borderRadius: 3,
              fontWeight: 600,
            }}
          >
            Proposal Only · Unverified
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => void requestAI("explain")}
            disabled={loading}
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 4,
              border: "1px solid #cbd5e0",
              cursor: "pointer",
            }}
          >
            Explain Goal
          </button>
          <button
            onClick={() => void requestAI("suggest")}
            disabled={loading}
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 4,
              backgroundColor: "#ebf8ff",
              border: "1px solid #bee3f8",
              color: "#2b6cb0",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Suggest Tactic
          </button>
        </div>
      </div>

      {loading && <div style={{ fontSize: 11, color: "#718096" }}>Generating proposal...</div>}
      {error && <div style={{ fontSize: 11, color: "#e53e3e" }}>{error}</div>}

      {proposal && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            backgroundColor: "#fff",
            border: "1px solid #cbd5e0",
            borderRadius: 4,
          }}
        >
          <div style={{ fontSize: 11, color: "#718096", marginBottom: 4 }}>
            {proposal.type === "explanation" ? "Goal Explanation:" : "Proposed Candidate Tactic:"}
          </div>
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              fontFamily: "ui-monospace, monospace",
              whiteSpace: "pre-wrap",
            }}
          >
            {proposal.text}
          </pre>

          {proposal.type === "tactic_suggestion" && (
            <div style={{ marginTop: 8, display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button
                onClick={() => setProposal(null)}
                style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, border: "1px solid #cbd5e0" }}
              >
                Reject
              </button>
              <button
                onClick={() => void handleAccept()}
                style={{
                  fontSize: 11,
                  padding: "2px 10px",
                  borderRadius: 3,
                  backgroundColor: "#38a169",
                  color: "#fff",
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Accept & Verify via Lean
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
