import React, { useState } from "react";
import type { ProofUnit, StructureNode } from "@proof-explorer/protocol";

interface HierarchicalProofExplorerProps {
  units?: ProofUnit[];
  activeUnitId?: string;
  onSelectUnit?: (unitId: string) => void;
  onEnterUnit?: (unitId: string) => void;
  onExitUnit?: () => void;
  canExitUnit?: boolean;
}

export function HierarchicalProofExplorer({
  units = [],
  activeUnitId,
  onSelectUnit,
  onEnterUnit,
  onExitUnit,
  canExitUnit = false,
}: HierarchicalProofExplorerProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const unitMap = new Map(units.map((u) => [u.id, u]));

  // Find root units (file or units with no parent in this list)
  const rootUnits = units.filter((u) => !u.parentId || !unitMap.has(u.parentId));

  const renderTree = (u: ProofUnit, depth = 0) => {
    const isExpanded = expanded[u.id] ?? depth < 2;
    const isSelected = u.id === activeUnitId;
    const children = u.children
      .map((cid) => unitMap.get(cid))
      .filter((c): c is ProofUnit => Boolean(c));
    const hasChildren = children.length > 0;

    let badgeColor = "#718096";
    if (u.type === "theorem" || u.type === "lemma") badgeColor = "#3182ce";
    if (u.type === "local_have") badgeColor = "#805ad5";
    if (u.type === "subproof") badgeColor = "#dd6b20";

    return (
      <div key={u.id} style={{ marginLeft: depth * 14 }}>
        <div
          onClick={() => onSelectUnit?.(u.id)}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "4px 8px",
            borderRadius: 4,
            backgroundColor: isSelected ? "#ebf8ff" : "transparent",
            cursor: "pointer",
            fontSize: 12,
            gap: 6,
          }}
        >
          {hasChildren ? (
            <span
              onClick={(e) => toggleExpand(u.id, e)}
              style={{ width: 14, cursor: "pointer", color: "#a0aec0", userSelect: "none" }}
            >
              {isExpanded ? "▼" : "▶"}
            </span>
          ) : (
            <span style={{ width: 14 }} />
          )}

          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: "1px 4px",
              borderRadius: 3,
              backgroundColor: badgeColor,
              color: "#fff",
            }}
          >
            {u.type === "local_have" ? "have" : u.type}
          </span>

          <span style={{ fontWeight: isSelected ? 700 : 400, color: isSelected ? "#2b6cb0" : "#2d3748" }}>
            {u.name ?? (u.type === "subproof" ? "subproof" : "anon")}
          </span>

          {(u.type === "local_have" || u.type === "subproof") && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEnterUnit?.(u.id);
              }}
              title="Step into this sub-proof unit"
              style={{
                marginLeft: "auto",
                fontSize: 10,
                padding: "2px 6px",
                backgroundColor: "#edf2f7",
                border: "1px solid #cbd5e0",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              Step in ⤵
            </button>
          )}
        </div>

        {hasChildren && isExpanded && (
          <div>{children.map((c) => renderTree(c, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: 10, height: "100%", overflowY: "auto", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Hierarchy</strong>
        {canExitUnit && (
          <button
            onClick={onExitUnit}
            style={{
              fontSize: 11,
              padding: "2px 8px",
              backgroundColor: "#feebc8",
              border: "1px solid #fbd38d",
              borderRadius: 4,
              color: "#7b341e",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ◀ Back to parent
          </button>
        )}
      </div>

      {rootUnits.length === 0 ? (
        <div style={{ color: "#a0aec0", fontStyle: "italic", fontSize: 12 }}>
          No units loaded.
        </div>
      ) : (
        rootUnits.map((u) => renderTree(u, 0))
      )}
    </div>
  );
}
