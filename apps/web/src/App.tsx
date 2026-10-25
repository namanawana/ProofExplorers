/** Proof Explorer IDE - browser entry point. */
import React, { useRef, useState } from "react";
import { useProofStore } from "./state/useProofStore";
import { LeanMonacoEditor } from "./components/LeanMonacoEditor";
import { GoalInspector } from "./components/GoalInspector";
import { TimelineViewer } from "./components/TimelineViewer";
import { HierarchicalProofExplorer } from "./components/HierarchicalProofExplorer";
import { DependencyGraphView } from "./components/DependencyGraphView";
import { AIProposalPanel } from "./components/AIProposalPanel";

export function App() {
  const {
    session, state, lastTransition, diagnostics, fileContent, fileName, units, dependencies,
    checkpoints, sessionStack, activeUnitId, selectedGoalId, error, busy, connected,
    uploadLeanFile, next, previous, reset, jump, enterUnit, exitUnit, selectUnit, selectGoal, verifyTactic,
  } = useProofStore();
  const [activeTab, setActiveTab] = useState<"goals" | "graph">("goals");
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", background: "#fff", color: "#1a202c", overflow: "hidden" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", background: "#2d3748", color: "#fff", minHeight: 48, boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <strong style={{ fontSize: 15 }}>Proof Explorer</strong>
          <span style={{ fontSize: 11, color: "#a0aec0" }}>Lean 4 Proof Debugger</span>
          <input ref={fileInput} type="file" accept=".lean,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLeanFile(f); e.currentTarget.value = ""; }} />
          <button onClick={() => fileInput.current?.click()} disabled={busy} style={{ marginLeft: 8, padding: "5px 10px", borderRadius: 4, border: "1px solid #718096", background: "#4a5568", color: "#fff", cursor: busy ? "wait" : "pointer", fontSize: 12 }}>📤 Upload .lean</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "#48bb78" : "#f56565" }} /><span style={{ color: connected ? "#c6f6d5" : "#fed7d7" }}>{connected ? "Live" : "Offline"}</span></div>
          {session && <div style={{ color: "#e2e8f0" }}>Status: <strong>{session.status}</strong> · Lean <strong>{session.leanVersion}</strong></div>}
        </div>
      </header>

      {error && <div role="alert" style={{ background: "#fff5f5", color: "#c53030", borderBottom: "1px solid #feb2b2", padding: "6px 16px", fontSize: 12 }}>⚠️ {error}</div>}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside style={{ width: 260, borderRight: "1px solid #e2e8f0", background: "#f7fafc", display: "flex", flexDirection: "column" }}>
          <HierarchicalProofExplorer units={units} activeUnitId={activeUnitId} onSelectUnit={selectUnit} onEnterUnit={enterUnit} onExitUnit={exitUnit} canExitUnit={sessionStack.length > 0} />
        </aside>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", borderRight: "1px solid #e2e8f0", minWidth: 0 }}>
          <div style={{ padding: "6px 12px", background: "#edf2f7", borderBottom: "1px solid #e2e8f0", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span>📄 {fileName ?? "No Lean file uploaded"}</span>
            {state?.sourceRange && <span style={{ color: "#718096" }}>Range: L{state.sourceRange.startLine + 1}:C{state.sourceRange.startColumn} - L{state.sourceRange.endLine + 1}:C{state.sourceRange.endColumn}</span>}
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {fileContent ? <LeanMonacoEditor value={fileContent} activeRange={state?.sourceRange} diagnostics={diagnostics} /> : <div style={{ height: "100%", display: "grid", placeItems: "center", color: "#a0aec0", fontSize: 14 }}><div style={{ textAlign: "center" }}><div style={{ fontSize: 38, marginBottom: 10 }}>📄</div><strong>Upload a Lean 4 file to begin</strong><div style={{ marginTop: 6 }}>The file will be analyzed and verified by Lean.</div></div></div>}
          </div>
          <div style={{ borderTop: "1px solid #e2e8f0", background: "#fff" }}><TimelineViewer session={session} checkpoints={checkpoints} lastTransition={lastTransition} busy={busy} onNext={next} onPrevious={previous} onReset={reset} onJump={jump} /></div>
        </main>

        <section style={{ width: 390, display: "flex", flexDirection: "column", background: "#fff" }}>
          <div style={{ display: "flex", borderBottom: "1px solid #e2e8f0", background: "#f7fafc" }}>
            <button onClick={() => setActiveTab("goals")} style={{ flex: 1, padding: "8px 12px", border: "none", background: activeTab === "goals" ? "#fff" : "transparent", borderBottom: activeTab === "goals" ? "2px solid #3182ce" : "none", fontWeight: activeTab === "goals" ? 600 : 400, color: activeTab === "goals" ? "#2b6cb0" : "#718096", cursor: "pointer", fontSize: 12 }}>🎯 Goals {state ? `(${state.goals.length})` : ""}</button>
            <button onClick={() => setActiveTab("graph")} style={{ flex: 1, padding: "8px 12px", border: "none", background: activeTab === "graph" ? "#fff" : "transparent", borderBottom: activeTab === "graph" ? "2px solid #3182ce" : "none", fontWeight: activeTab === "graph" ? 600 : 400, color: activeTab === "graph" ? "#2b6cb0" : "#718096", cursor: "pointer", fontSize: 12 }}>🕸 DAG</button>
          </div>
          <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>{activeTab === "goals" ? <GoalInspector state={state} selectedGoalId={selectedGoalId} onSelectGoal={selectGoal} /> : <DependencyGraphView units={units} dependencies={dependencies} selectedUnitId={activeUnitId} onSelectUnit={selectUnit} />}</div>
          <AIProposalPanel session={session} onApplyTactic={verifyTactic} />
        </section>
      </div>
    </div>
  );
}
