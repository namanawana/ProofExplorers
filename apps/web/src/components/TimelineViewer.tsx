import React from "react";
import type { SessionInfo, Checkpoint, ProofTransition } from "@proof-explorer/protocol";

interface TimelineViewerProps {
  session?: SessionInfo;
  checkpoints?: Checkpoint[];
  lastTransition?: ProofTransition;
  busy: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onReset: () => void;
  onJump: (step: number) => void;
}

export function TimelineViewer({
  session,
  checkpoints = [],
  lastTransition,
  busy,
  onNext,
  onPrevious,
  onReset,
  onJump,
}: TimelineViewerProps) {
  if (!session) {
    return (
      <div style={{ padding: 12, color: "#a0aec0", fontStyle: "italic", fontSize: 12 }}>
        No active session.
      </div>
    );
  }

  const { cursorStep, frontierStep, totalSteps } = session;
  const checkpointStepSet = new Set(checkpoints.map((c) => c.step));

  // Render a window of steps around cursor and frontier
  const steps = Array.from({ length: totalSteps + 1 }, (_, i) => i);

  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={onReset}
          disabled={busy || cursorStep === 0}
          style={{ padding: "4px 10px", fontSize: 12, borderRadius: 4, border: "1px solid #cbd5e0", cursor: "pointer" }}
        >
          ⏮ Reset
        </button>
        <button
          onClick={onPrevious}
          disabled={busy || cursorStep === 0}
          style={{ padding: "4px 10px", fontSize: 12, borderRadius: 4, border: "1px solid #cbd5e0", cursor: "pointer" }}
        >
          ◀ Prev
        </button>
        <button
          onClick={onNext}
          disabled={busy || cursorStep >= totalSteps}
          style={{ padding: "4px 12px", fontSize: 12, fontWeight: 600, backgroundColor: "#3182ce", color: "#fff", borderRadius: 4, border: "none", cursor: "pointer" }}
        >
          Next ▶
        </button>
        <span style={{ fontSize: 12, marginLeft: "auto", color: "#4a5568" }}>
          Step <strong>{cursorStep}</strong> / {totalSteps} (frontier: {frontierStep})
        </span>
      </div>

      {/* Visual Step Ribbon */}
      <div
        style={{
          display: "flex",
          gap: 4,
          overflowX: "auto",
          padding: "6px 0",
          alignItems: "center",
        }}
      >
        {steps.map((step) => {
          const isCursor = step === cursorStep;
          const isVerified = step <= frontierStep;
          const isCheckpoint = checkpointStepSet.has(step);

          let bg = "#edf2f7";
          let color = "#718096";
          if (isVerified) {
            bg = "#ebf8ff";
            color = "#2b6cb0";
          }
          if (isCursor) {
            bg = "#3182ce";
            color = "#fff";
          }

          return (
            <button
              key={step}
              onClick={() => onJump(step)}
              disabled={busy}
              title={`Step ${step}${isCheckpoint ? " (Checkpoint)" : ""}`}
              style={{
                minWidth: 28,
                height: 28,
                padding: "2px 4px",
                fontSize: 11,
                fontWeight: isCursor ? 700 : 500,
                backgroundColor: bg,
                color,
                border: isCheckpoint ? "2px solid #dd6b20" : "1px solid #cbd5e0",
                borderRadius: 4,
                cursor: "pointer",
                position: "relative",
              }}
            >
              {step}
              {isCheckpoint && (
                <span
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    width: 7,
                    height: 7,
                    backgroundColor: "#dd6b20",
                    borderRadius: "50%",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Last Executed Tactic Command */}
      {lastTransition && (
        <div style={{ backgroundColor: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 4, padding: "6px 10px", fontSize: 12 }}>
          <span style={{ color: "#718096", marginRight: 6 }}>Tactic:</span>
          <code style={{ color: "#2d3748", fontWeight: 600 }}>{lastTransition.command.trim()}</code>
          {lastTransition.durationMs !== undefined && (
            <span style={{ color: "#a0aec0", marginLeft: 8, fontSize: 11 }}>({lastTransition.durationMs}ms)</span>
          )}
        </div>
      )}
    </div>
  );
}
