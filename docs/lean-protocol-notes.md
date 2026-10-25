# Lean 4 LSP Protocol Reference & Verification Notes

Toolchain pinned: `leanprover/lean4:v4.15.0`

## 1. Document Lifecycle & Sync

### `initialize` / `initialized`
- Standard LSP handshake.
- Lean returns `serverInfo.name` ("Lean 4 Server") and `serverInfo.version` ("4.15.0").
- Capabilities include textDocumentSync (Full=1 or Incremental=2), hoverProvider, completionProvider, and Lean-specific RPC capability.

### `textDocument/didOpen` & `textDocument/didChange`
- `didOpen` opens a file.
- `didChange` with full-text synchronization (`contentChanges: [{ text }]`).
- Positions are zero-based UTF-16 code units across all messages.

## 2. Elaboration Progress: `$/lean/fileProgress`

- Notification sent from server to client:
  ```json
  {
    "textDocument": { "uri": "file:///path/to/File.lean", "version": 1 },
    "processing": [
      {
        "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 10, "character": 0 } },
        "kind": 1
      }
    ]
  }
  ```
- **Semantics:**
  - `processing.length > 0`: Lean is actively elaborating one or more ranges.
  - `processing.length === 0`: Lean has completed elaboration for the document version.
  - **Already-cached files:** For files whose `.olean` is already built and fully up-to-date, Lean may emit an immediate `processing: []` or complete instantaneously. The adapter initializes `elaborating = true` on `didOpen`/`didChange`, but checks for `processing: []` and supports an elaboration quiet-check to avoid indefinite stalls.

## 3. Diagnostics: `textDocument/publishDiagnostics`

- Standard LSP notification:
  ```json
  {
    "uri": "file:///path/to/File.lean",
    "version": 1,
    "diagnostics": [
      {
        "range": { "start": { "line": 4, "character": 4 }, "end": { "line": 4, "character": 12 } },
        "severity": 1,
        "message": "type mismatch\n  hp\nhas type\n  p : Prop\nbut is expected to have type\n  q : Prop"
      }
    ]
  }
  ```
- **Cumulative publication:** Lean publishes the *complete* list of active diagnostics for the file on each notification. New diagnostic lists overwrite previous lists for that URI.
- Severities: 1 = Error, 2 = Warning, 3 = Information, 4 = Hint.
- Range overlap rule: ProofEngine checks if any error diagnostic overlaps the tactic range (or the whole declaration for the final step, since "unsolved goals" is reported at declaration scope).

## 4. Goal Queries: `$/lean/plainGoal` vs Interactive RPC

### 4.1 Plain Goal (`$/lean/plainGoal`)
- Request params:
  ```json
  {
    "textDocument": { "uri": "file:///path/to/File.lean" },
    "position": { "line": 5, "character": 10 }
  }
  ```
- Response:
  ```json
  {
    "rendered": "p q : Prop\nhp : p\nhq : q\n⊢ q",
    "goals": [
      "p q : Prop\nhp : p\nhq : q\n⊢ q"
    ]
  }
  ```
  Returns `null` if no tactic block is open at that position.
- Limitation: Plain goals do not contain metavariable identifiers (`mvarId`), so goal lineage cannot be determined authoritatively from plainGoal alone.

### 4.2 Interactive Goal RPC (`$/lean/rpc/call`)
- Session setup: Client sends `$/lean/rpc/connect` with `{ "uri": "file:///path/to/File.lean" }` to get `{ "sessionId": string }`.
- Method call:
  ```json
  {
    "textDocument": { "uri": "file:///path/to/File.lean" },
    "position": { "line": 5, "character": 10 },
    "sessionId": "<rpc-session-id>",
    "method": "Lean.Widget.getInteractiveGoals",
    "params": {
      "line": 5,
      "character": 10
    }
  }
  ```
- Response:
  ```json
  {
    "goals": [
      {
        "mvarId": { "name": "_uniq.1234" },
        "userName": "case left",
        "goalPrefix": "⊢ ",
        "type": { "tag": "expr", "val": "q" },
        "hyps": [
          {
            "names": ["hp"],
            "type": { "tag": "expr", "val": "p" }
          }
        ]
      }
    ]
  }
  ```
- Authoritative metavariable identifier (`mvarId`):
  Each open goal has an authoritative `mvarId` assigned by the Lean kernel and elaboration engine.
  Tracking goals by `mvarId` provides true goal lineage across tactic applications without heuristic guesswork.

## 5. Cancellation & Process Lifecycle

- Client can cancel in-flight requests using `$/cancelRequest` with `{ "id": requestId }`.
- Shutdown: Send `shutdown` request, await response, then send `exit` notification.
- Crash detection: Subscribing to process `exit` event allows immediate failover, event logging, and state recovery.
