import React, { useEffect, useRef } from "react";
import Editor, { type OnMount, type Monaco } from "@monaco-editor/react";
import type { Diagnostic, SourceRange } from "@proof-explorer/protocol";

interface LeanMonacoEditorProps {
  value: string;
  activeRange?: SourceRange;
  diagnostics?: Diagnostic[];
  onSelectPosition?: (line: number, column: number) => void;
}

export function LeanMonacoEditor({
  value,
  activeRange,
  diagnostics = [],
  onSelectPosition,
}: LeanMonacoEditorProps) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Register Lean 4 language
    if (!monaco.languages.getLanguages().some((l) => l.id === "lean4")) {
      monaco.languages.register({ id: "lean4" });
      monaco.languages.setMonarchTokensProvider("lean4", {
        keywords: [
          "theorem", "lemma", "def", "example", "structure", "inductive", "class",
          "instance", "abbrev", "have", "show", "suffices", "by", "intro", "intros",
          "exact", "constructor", "rfl", "simp", "rw", "rewrite", "apply", "cases",
          "induction", "obtain", "ext", "fun", "let", "in", "match", "with",
          "namespace", "section", "end", "import", "open", "variable", "universe",
        ],
        symbols: /[=><!~?:&|+\-*\/\^%]+/,
        tokenizer: {
          root: [
            [/--.*$/, "comment"],
            [/\/-/, "comment", "@comment"],
            [/"([^"\\]|\\.)*"/, "string"],
            [/[a-zA-Z_][a-zA-Z0-9_']*/, {
              cases: {
                "@keywords": "keyword",
                "@default": "identifier",
              },
            }],
            [/[0-9]+/, "number"],
            [/·/, "keyword.bullet"],
            [/⊢/, "keyword.turnstile"],
            [/@symbols/, "delimiter"],
          ],
          comment: [
            [/[^/-]+/, "comment"],
            [/\/-/, "comment", "@push"],
            [/-\//, "comment", "@pop"],
            [/[\/-]/, "comment"],
          ],
        },
      });

      monaco.editor.defineTheme("lean-theme", {
        base: "vs",
        inherit: true,
        rules: [
          { token: "keyword", foreground: "0000ff", fontStyle: "bold" },
          { token: "keyword.bullet", foreground: "d73a49", fontStyle: "bold" },
          { token: "keyword.turnstile", foreground: "6f42c1", fontStyle: "bold" },
          { token: "comment", foreground: "6a737d", fontStyle: "italic" },
          { token: "string", foreground: "032f62" },
        ],
        colors: {
          "editor.lineHighlightBackground": "#f6f8fa",
        },
      });
    }

    monaco.editor.setTheme("lean-theme");

    editor.onDidChangeCursorPosition((e) => {
      onSelectPosition?.(e.position.lineNumber - 1, e.position.column - 1);
    });
  };

  // Update step highlighting
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    if (activeRange) {
      const startLine = activeRange.startLine + 1;
      const startCol = activeRange.startColumn + 1;
      const endLine = activeRange.endLine + 1;
      const endCol = activeRange.endColumn + 1;

      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
        {
          range: new monaco.Range(startLine, startCol, endLine, endCol),
          options: {
            isWholeLine: false,
            className: "lean-active-range-highlight",
            overviewRuler: {
              color: "#ffdf5d",
              position: monaco.editor.OverviewRulerLane.Full,
            },
            inlineClassName: "lean-active-inline",
          },
        },
      ]);
      editor.revealRangeInCenterIfOutsideViewport(
        new monaco.Range(startLine, startCol, endLine, endCol),
      );
    } else {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }
  }, [activeRange]);

  // Update diagnostics markers
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const markers = diagnostics.map((d) => {
      const severity =
        d.severity === "error"
          ? monaco.MarkerSeverity.Error
          : d.severity === "warning"
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info;

      return {
        startLineNumber: d.range.startLine + 1,
        startColumn: d.range.startColumn + 1,
        endLineNumber: d.range.endLine + 1,
        endColumn: d.range.endColumn + 1,
        message: d.message,
        severity,
      };
    });

    monaco.editor.setModelMarkers(model, "lean", markers);
  }, [diagnostics]);

  return (
    <div style={{ height: "100%", width: "100%", position: "relative" }}>
      <style>{`
        .lean-active-range-highlight {
          background-color: rgba(255, 230, 0, 0.25);
          border-bottom: 2px solid #e3a600;
        }
        .lean-active-inline {
          font-weight: 600;
        }
      `}</style>
      <Editor
        height="100%"
        language="lean4"
        value={value}
        theme="lean-theme"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          fontSize: 13,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        }}
        onMount={handleEditorMount}
      />
    </div>
  );
}
