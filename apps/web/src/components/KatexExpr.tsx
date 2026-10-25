import React, { useMemo } from "react";
import katex from "katex";

interface KatexExprProps {
  expr: string;
  className?: string;
  displayMode?: boolean;
}

export function KatexExpr({ expr, className, displayMode = false }: KatexExprProps) {
  const html = useMemo(() => {
    try {
      // Format lean expressions slightly for KaTeX (e.g. converting ∧ to \land, ∨ to \lor, → to \to)
      let tex = expr
        .replace(/∧/g, "\\land ")
        .replace(/∨/g, "\\lor ")
        .replace(/¬/g, "\\neg ")
        .replace(/→/g, "\\to ")
        .replace(/↔/g, "\\leftrightarrow ")
        .replace(/∀/g, "\\forall ")
        .replace(/∃/g, "\\exists ")
        .replace(/≤/g, "\\le ")
        .replace(/≥/g, "\\ge ")
        .replace(/≠/g, "\\ne ")
        .replace(/⊢\s*/g, "\\vdash ");

      return katex.renderToString(tex, {
        throwOnError: false,
        displayMode,
      });
    } catch {
      return null;
    }
  }, [expr, displayMode]);

  if (!html) {
    return <span className={className}>{expr}</span>;
  }

  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      aria-label={expr}
    />
  );
}
