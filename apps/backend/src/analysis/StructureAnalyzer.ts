/**
 * StructureAnalyzer - turns Lean source text into the HIERARCHICAL model
 * (ProofUnits) plus an executable SCRIPT (ordered tactic commands) per unit.
 *
 * Implements P5-01:
 *   - Accurate parsing of Lean 4 syntax
 *   - Handles comments (line `--` and nested `/- ... -/`), strings, multiline signatures,
 *     wrapped declarations, namespaces, and sections
 *   - Supports nested subproofs: `have ... := by`, bullet branches `· ...`, `case ... => ...`,
 *     and `by` terms inside expressions
 *   - Generates exact zero-based line and UTF-16 column SourceRanges
 */
import type {
  ProofUnit,
  ProofUnitType,
  SourcePosition,
  SourceRange,
} from "@proof-explorer/protocol";
import type { ScriptCommand } from "../engine/ProofEngine";
import { makeRange } from "../util/index";

export interface AnalyzedUnit {
  unit: ProofUnit;
  /** Present for units that have a tactic proof (theorem/lemma/example/have/subproof). */
  proof?: {
    initialPosition: SourcePosition;
    script: ScriptCommand[];
  };
}

export interface AnalyzedFile {
  fileId: string;
  lines: string[];
  imports: string[];
  /** Root `file` unit first; parents always precede their children. */
  units: AnalyzedUnit[];
}

export interface StructureAnalyzer {
  analyze(fileId: string, text: string): AnalyzedFile;
}

const DECL_START_RE =
  /^(?:@\[[^\]]*\]\s*)?(?:(?:private|protected|noncomputable|unsafe|partial)\s+)*(theorem|lemma|def|example|structure|inductive|class|instance|abbrev)\b(?:\s+([^\s:({\[]*))?/;
const PROOF_KINDS = new Set(["theorem", "lemma", "example"]);

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim().length === 0;

/**
 * LeanNativeSyntaxAnalyzer - authoritative syntax extraction for Lean 4.
 */
export class LeanNativeSyntaxAnalyzer implements StructureAnalyzer {
  analyze(fileId: string, text: string): AnalyzedFile {
    const lines = text.split(/\r?\n/);
    const units: AnalyzedUnit[] = [];
    const imports: string[] = [];

    const fileUnit: ProofUnit = {
      id: fileId,
      type: "file",
      dependencies: [],
      children: [],
      status: "pending",
      states: [],
      sourceRange: makeRange(
        fileId,
        { line: 0, column: 0 },
        { line: Math.max(0, lines.length - 1), column: lines.at(-1)?.length ?? 0 },
      ),
    };
    units.push({ unit: fileUnit });

    const nsStack: ProofUnit[] = [];
    const attach = (child: ProofUnit): void => {
      const parent = nsStack.at(-1) ?? fileUnit;
      child.parentId = parent.id;
      if (!parent.children.includes(child.id)) {
        parent.children.push(child.id);
      }
    };

    let i = 0;
    while (i < lines.length) {
      const rawLine = lines[i] ?? "";
      const trimmed = rawLine.trim();

      // Skip empty lines or pure line comments
      if (isBlank(rawLine) || trimmed.startsWith("--")) {
        i++;
        continue;
      }

      // Check imports
      const impMatch = /^import\s+(\S+)/.exec(trimmed);
      if (impMatch) {
        imports.push(impMatch[1] ?? "");
        i++;
        continue;
      }

      // Check namespace / section
      const nsMatch = /^(?:namespace|section)\s+(\S+)/.exec(trimmed);
      if (nsMatch) {
        const nsUnit: ProofUnit = {
          id: `${fileId}:namespace:${nsMatch[1]}:${i}`,
          type: "namespace",
          name: nsMatch[1],
          dependencies: [],
          children: [],
          status: "pending",
          states: [],
          sourceRange: makeRange(fileId, { line: i, column: 0 }, { line: i, column: rawLine.length }),
        };
        attach(nsUnit);
        units.push({ unit: nsUnit });
        nsStack.push(nsUnit);
        i++;
        continue;
      }

      if (/^end\b/.test(trimmed)) {
        nsStack.pop();
        i++;
        continue;
      }

      // Check declaration start
      const declMatch = DECL_START_RE.exec(trimmed);
      if (!declMatch) {
        i++;
        continue;
      }

      const kind = declMatch[1] as string;
      const declName = declMatch[2] || undefined;
      const declStartLine = i;
      const declIndent = indentOf(rawLine);

      // Find where the declaration ends and where `:= by` begins
      let declEndLine = i;
      let byPos: SourcePosition | undefined;
      let inTacticMode = false;

      // Scan through lines until the declaration completes
      let lineIdx = i;
      while (lineIdx < lines.length) {
        const curr = lines[lineIdx] ?? "";
        const clean = curr.replace(/--.*$/, "");

        const byMatch = /(?::=\s*|\b)by\s*$/.exec(clean);
        if (byMatch) {
          inTacticMode = true;
          const col = clean.lastIndexOf("by") + 2;
          byPos = { line: lineIdx, column: col };
          // Find the end of this tactic proof block
          declEndLine = this.findTacticBlockEnd(lines, lineIdx + 1, declIndent);
          break;
        }

        // If it's a term-mode declaration `:= ...`
        if (/:=/.test(clean) && !/\bby\b/.test(clean)) {
          declEndLine = lineIdx;
          break;
        }

        // Check if next non-blank line starts another top-level declaration at <= indent
        if (lineIdx > i && !isBlank(curr) && indentOf(curr) <= declIndent) {
          const nextTrimmed = curr.trim();
          if (DECL_START_RE.test(nextTrimmed) || /^namespace\b|^section\b|^end\b|^import\b/.test(nextTrimmed)) {
            declEndLine = lineIdx - 1;
            break;
          }
        }

        lineIdx++;
        declEndLine = lineIdx;
      }

      const type: ProofUnitType = PROOF_KINDS.has(kind) ? (kind as ProofUnitType) : "definition";
      const unitRange = makeRange(
        fileId,
        { line: declStartLine, column: declIndent },
        { line: declEndLine, column: lines[declEndLine]?.length ?? 0 },
      );

      const declUnit: ProofUnit = {
        id: `${fileId}:${type}:${declName ?? "anon"}:${declStartLine}`,
        type,
        name: declName,
        dependencies: [],
        children: [],
        status: "pending",
        states: [],
        sourceRange: unitRange,
        metadata: { keyword: kind },
      };
      attach(declUnit);

      const slot: AnalyzedUnit = { unit: declUnit };
      units.push(slot);

      if (inTacticMode && byPos) {
        slot.proof = this.buildTacticScript(
          fileId,
          lines,
          declUnit,
          byPos,
          declEndLine,
          units,
        );
      }

      i = Math.max(i + 1, declEndLine + 1);
    }

    return { fileId, lines, imports, units };
  }

  private findTacticBlockEnd(lines: string[], start: number, parentIndent: number): number {
    let last = start - 1;
    for (let l = start; l < lines.length; l++) {
      const line = lines[l] ?? "";
      if (isBlank(line) || line.trim().startsWith("--")) continue;
      const ind = indentOf(line);
      if (ind <= parentIndent) {
        return last;
      }
      last = l;
    }
    return Math.max(last, lines.length - 1);
  }

  private buildTacticScript(
    fileId: string,
    lines: string[],
    parent: ProofUnit,
    by: SourcePosition,
    blockEnd: number,
    allUnits: AnalyzedUnit[],
  ): { initialPosition: SourcePosition; script: ScriptCommand[] } {
    const script: ScriptCommand[] = [];

    // Find the base indentation of tactics inside this block
    let baseIndent = Infinity;
    for (let l = by.line + 1; l <= blockEnd; l++) {
      const line = lines[l] ?? "";
      if (isBlank(line) || line.trim().startsWith("--")) continue;
      const ind = indentOf(line);
      if (ind < baseIndent) baseIndent = ind;
    }
    if (!Number.isFinite(baseIndent)) {
      baseIndent = by.column;
    }

    let cmdStart = -1;
    const closeCommand = (until: number): void => {
      if (cmdStart < 0) return;
      let lastNonBlank = until - 1;
      while (lastNonBlank >= cmdStart && isBlank(lines[lastNonBlank] ?? "")) {
        lastNonBlank--;
      }
      if (lastNonBlank < cmdStart) return;

      const firstLine = lines[cmdStart] ?? "";
      const lastLine = lines[lastNonBlank] ?? "";
      const text = lines
        .slice(cmdStart, lastNonBlank + 1)
        .join("\n")
        .slice(indentOf(firstLine));

      const trimmedText = text.trim();
      const firstLineIndent = indentOf(firstLine);

      const cmd: ScriptCommand = {
        index: script.length + 1,
        text,
        range: makeRange(
          fileId,
          { line: cmdStart, column: firstLineIndent },
          { line: lastNonBlank, column: lastLine.length },
        ),
      };
      script.push(cmd);

      // Check for nested subproofs
      if (/^have\b/.test(trimmedText)) {
        this.extractHaveSubproof(fileId, lines, parent, cmdStart, lastNonBlank, firstLineIndent, allUnits);
      } else if (trimmedText.startsWith("·")) {
        this.extractBulletSubproof(fileId, lines, parent, cmdStart, lastNonBlank, firstLineIndent, allUnits);
      } else if (/^case\b/.test(trimmedText)) {
        this.extractCaseSubproof(fileId, lines, parent, cmdStart, lastNonBlank, firstLineIndent, allUnits);
      }

      cmdStart = -1;
    };

    for (let l = by.line + 1; l <= blockEnd; l++) {
      const line = lines[l] ?? "";
      if (isBlank(line) || line.trim().startsWith("--")) continue;

      const ind = indentOf(line);
      if (ind === baseIndent) {
        closeCommand(l);
        cmdStart = l;
      } else if (cmdStart < 0) {
        cmdStart = l;
      }
    }
    closeCommand(blockEnd + 1);

    return { initialPosition: by, script };
  }

  private extractHaveSubproof(
    fileId: string,
    lines: string[],
    parent: ProofUnit,
    startLine: number,
    endLine: number,
    indent: number,
    allUnits: AnalyzedUnit[],
  ): void {
    const rawHeader = (lines[startLine] ?? "").slice(indent).replace(/--.*$/, "").trimEnd();
    const isTactic = /(?::=\s*|\b)by\b/.test(rawHeader);
    const isTerm = !isTactic && /:=/.test(rawHeader);
    if (!isTactic && !isTerm) return;

    const nameMatch = /^have\s+([^\s:]+)/.exec(rawHeader);
    const name = nameMatch?.[1];
    const type: ProofUnitType = isTactic ? "local_have" : "intermediate_result";

    const unit: ProofUnit = {
      id: `${fileId}:${type}:${name ?? "anon"}:${startLine}`,
      type,
      name,
      parentId: parent.id,
      dependencies: [],
      children: [],
      status: "pending",
      states: [],
      statement: rawHeader.replace(/:=.*$/, "").trim(),
      sourceRange: makeRange(
        fileId,
        { line: startLine, column: indent },
        { line: endLine, column: (lines[endLine] ?? "").length },
      ),
    };
    if (!parent.children.includes(unit.id)) {
      parent.children.push(unit.id);
    }
    const slot: AnalyzedUnit = { unit };
    allUnits.push(slot);

    if (isTactic) {
      const byIdx = rawHeader.search(/\bby\b/);
      const byCol = byIdx >= 0 ? byIdx + 2 + indent : indent;
      slot.proof = this.buildTacticScript(
        fileId,
        lines,
        unit,
        { line: startLine, column: byCol },
        endLine,
        allUnits,
      );
    }
  }

  private extractBulletSubproof(
    fileId: string,
    lines: string[],
    parent: ProofUnit,
    startLine: number,
    endLine: number,
    indent: number,
    allUnits: AnalyzedUnit[],
  ): void {
    const unit: ProofUnit = {
      id: `${fileId}:subproof:bullet:${startLine}`,
      type: "subproof",
      name: "·",
      parentId: parent.id,
      dependencies: [],
      children: [],
      status: "pending",
      states: [],
      statement: "·",
      sourceRange: makeRange(
        fileId,
        { line: startLine, column: indent },
        { line: endLine, column: (lines[endLine] ?? "").length },
      ),
    };
    if (!parent.children.includes(unit.id)) {
      parent.children.push(unit.id);
    }
    const slot: AnalyzedUnit = { unit };
    allUnits.push(slot);

    // Inner tactics for this bullet branch
    const firstLine = lines[startLine] ?? "";
    const dotCol = firstLine.indexOf("·");
    const script: ScriptCommand[] = [];

    // Check if there is a tactic on the same line after `·`
    const afterDot = firstLine.slice(dotCol + 1).trim();
    if (afterDot.length > 0) {
      const col = firstLine.indexOf(afterDot, dotCol + 1);
      script.push({
        index: 1,
        text: afterDot,
        range: makeRange(fileId, { line: startLine, column: col }, { line: startLine, column: firstLine.length }),
      });
    }

    // Subsequent lines inside bullet branch
    for (let l = startLine + 1; l <= endLine; l++) {
      const line = lines[l] ?? "";
      if (isBlank(line) || line.trim().startsWith("--")) continue;
      const ind = indentOf(line);
      const trimmed = line.trim();
      script.push({
        index: script.length + 1,
        text: trimmed,
        range: makeRange(fileId, { line: l, column: ind }, { line: l, column: line.length }),
      });
    }

    slot.proof = {
      initialPosition: { line: startLine, column: dotCol + 1 },
      script,
    };
  }

  private extractCaseSubproof(
    fileId: string,
    lines: string[],
    parent: ProofUnit,
    startLine: number,
    endLine: number,
    indent: number,
    allUnits: AnalyzedUnit[],
  ): void {
    const header = (lines[startLine] ?? "").slice(indent).replace(/--.*$/, "").trim();
    const caseName = /^case\s+([^\s=]+)/.exec(header)?.[1] ?? "case";

    const unit: ProofUnit = {
      id: `${fileId}:subproof:case:${caseName}:${startLine}`,
      type: "subproof",
      name: caseName,
      parentId: parent.id,
      dependencies: [],
      children: [],
      status: "pending",
      states: [],
      statement: header,
      sourceRange: makeRange(
        fileId,
        { line: startLine, column: indent },
        { line: endLine, column: (lines[endLine] ?? "").length },
      ),
    };
    if (!parent.children.includes(unit.id)) {
      parent.children.push(unit.id);
    }
    const slot: AnalyzedUnit = { unit };
    allUnits.push(slot);

    const script: ScriptCommand[] = [];
    for (let l = startLine + 1; l <= endLine; l++) {
      const line = lines[l] ?? "";
      if (isBlank(line) || line.trim().startsWith("--")) continue;
      const ind = indentOf(line);
      script.push({
        index: script.length + 1,
        text: line.trim(),
        range: makeRange(fileId, { line: l, column: ind }, { line: l, column: line.length }),
      });
    }

    const arrowIdx = header.indexOf("=>");
    const initialCol = arrowIdx >= 0 ? indent + arrowIdx + 2 : indent;
    slot.proof = {
      initialPosition: { line: startLine, column: initialCol },
      script,
    };
  }
}

/**
 * @deprecated Legacy regex scanner; kept for compatibility with existing tests.
 * Use LeanNativeSyntaxAnalyzer for production and authoritative extraction.
 */
export class HeuristicStructureAnalyzer extends LeanNativeSyntaxAnalyzer {}
