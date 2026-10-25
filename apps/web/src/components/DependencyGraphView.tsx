import React, { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Dependency, ProofUnit } from "@proof-explorer/protocol";

interface DependencyGraphViewProps {
  units?: ProofUnit[];
  dependencies?: Dependency[];
  selectedUnitId?: string;
  onSelectUnit?: (unitId: string) => void;
}

export function DependencyGraphView({
  units = [],
  dependencies = [],
  selectedUnitId,
  onSelectUnit,
}: DependencyGraphViewProps) {
  // Build React Flow nodes
  const nodes: Node[] = useMemo(() => {
    const declUnits = units.filter(
      (u) => ["theorem", "lemma", "definition", "subproof"].includes(u.type) || u.metadata?.external,
    );

    const cols = 3;
    const xSpacing = 220;
    const ySpacing = 100;

    return declUnits.map((u, idx) => {
      const isSelected = u.id === selectedUnitId;
      const isExternal = Boolean(u.metadata?.external);

      const col = idx % cols;
      const row = Math.floor(idx / cols);

      return {
        id: u.id,
        position: { x: 50 + col * xSpacing, y: 50 + row * ySpacing },
        data: {
          label: (
            <div style={{ padding: "4px 8px", textAlign: "left" }}>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span
                  style={{
                    fontSize: 9,
                    textTransform: "uppercase",
                    backgroundColor: isExternal ? "#e2e8f0" : "#3182ce",
                    color: isExternal ? "#4a5568" : "#fff",
                    padding: "1px 4px",
                    borderRadius: 2,
                    fontWeight: 700,
                  }}
                >
                  {isExternal ? "ext" : u.type}
                </span>
                <span style={{ fontSize: 11, fontWeight: 600 }}>{u.name ?? u.id.slice(-6)}</span>
              </div>
            </div>
          ),
        },
        style: {
          background: isSelected ? "#ebf8ff" : isExternal ? "#f7fafc" : "#fff",
          border: isSelected ? "2px solid #3182ce" : "1px solid #cbd5e0",
          borderRadius: 6,
          boxShadow: isSelected ? "0 0 0 2px #90cdf4" : "0 1px 3px rgba(0,0,0,0.08)",
          width: 180,
        },
      };
    });
  }, [units, selectedUnitId]);

  // Build React Flow edges
  const edges: Edge[] = useMemo(() => {
    return dependencies.map((d) => {
      const isElab = d.evidence.kind === "elaborated";
      const isConnectedToSelected =
        selectedUnitId && (d.fromUnitId === selectedUnitId || d.toUnitId === selectedUnitId);

      return {
        id: d.id,
        source: d.fromUnitId,
        target: d.toUnitId,
        label: isElab ? "elab" : "syn",
        animated: isElab,
        style: {
          stroke: isConnectedToSelected ? "#3182ce" : isElab ? "#38a169" : "#a0aec0",
          strokeWidth: isConnectedToSelected ? 2.5 : 1.5,
        },
        labelStyle: {
          fontSize: 9,
          fill: isElab ? "#22543d" : "#718096",
          fontWeight: 600,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isConnectedToSelected ? "#3182ce" : isElab ? "#38a169" : "#a0aec0",
        },
      };
    });
  }, [dependencies, selectedUnitId]);

  return (
    <div style={{ width: "100%", height: "100%", backgroundColor: "#fafbfc" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, node) => onSelectUnit?.(node.id)}
        fitView
      >
        <Background color="#e2e8f0" gap={16} />
        <Controls />
        <MiniMap nodeStrokeWidth={3} zoomable pannable />
      </ReactFlow>
    </div>
  );
}
