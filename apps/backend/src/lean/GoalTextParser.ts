/**
 * Parser for the plain-text goal rendering returned by Lean's
 * `$/lean/plainGoal` request. Each element of its `goals` array looks like:
 *
 *     case left
 *     x y : ℕ
 *     h : x ≤ y
 *     ⊢ x < y + 1
 *
 * i.e. an optional `case <tag>` header, zero or more hypotheses
 * (`names : type`, with continuation lines indented), and a `⊢ target`.
 *
 * This is deliberately isolated: if a future Lean version changes the
 * rendering, only this file (and its tests) should need to change. When we
 * move to the structured `Lean.Widget.getInteractiveGoals` RPC, this parser
 * becomes a fallback.
 */
import type { LocalDeclaration } from "@proof-explorer/protocol";
import type { RawGoal } from "./LeanAdapter";

interface PendingHypothesis {
  names: string[];
  typeLines: string[];
}

export function parseGoalText(text: string): RawGoal {
  const lines = text.split("\n");
  let i = 0;
  let caseName: string | undefined;

  if (lines[0]?.startsWith("case ")) {
    caseName = lines[0].slice("case ".length).trim();
    i = 1;
  }

  const context: LocalDeclaration[] = [];
  const targetLines: string[] = [];
  let pending: PendingHypothesis | undefined;
  let inTarget = false;

  const flush = () => {
    if (!pending) return;
    const { type, value } = splitValue(pending.typeLines.join("\n").trim());
    // `a b : T` declares two hypotheses sharing one type.
    for (const name of pending.names) context.push({ name, type, value });
    pending = undefined;
  };

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (inTarget) {
      targetLines.push(line);
      continue;
    }
    if (line.startsWith("⊢ ")) {
      flush();
      inTarget = true;
      targetLines.push(line.slice(2));
      continue;
    }
    // Indented line => continuation of the previous hypothesis' type.
    if (/^\s/.test(line) && pending) {
      pending.typeLines.push(line.trim());
      continue;
    }
    const m = /^(.+?) : (.*)$/.exec(line);
    if (m) {
      flush();
      pending = {
        names: (m[1] ?? "").trim().split(/\s+/).filter(Boolean),
        typeLines: [m[2] ?? ""],
      };
    }
  }
  flush();

  return { caseName, target: targetLines.join("\n").trim(), context };
}

/**
 * `x : ℕ := 5` (a `let`-bound variable) is printed with its value after the
 * type. We split on the first top-level ` := `. Types that themselves contain
 * ` := ` are vanishingly rare; if one appears we merely keep it unsplit.
 */
function splitValue(typeText: string): { type: string; value?: string } {
  const idx = typeText.indexOf(" := ");
  if (idx < 0) return { type: typeText };
  return { type: typeText.slice(0, idx), value: typeText.slice(idx + 4) };
}
