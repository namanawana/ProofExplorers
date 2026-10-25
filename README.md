# Proof Explorer

Interactive proof IDE / debugger for large Lean 4 developments. Lean is the
source of truth; the app only ever shows transitions Lean has verified.

```
apps/backend   Node + TypeScript modular monolith (REST + WebSocket + engine)
apps/web       React + Vite + Zustand client (Phase-4 shell)
packages/protocol   shared types and wire protocol (single source of truth)
db/schema.sql  PostgreSQL schema
lean/          fixtures and test Lake project
docs/          ARCHITECTURE.md, TASKS.md
```

## Quick start

```bash
npm install
npm run typecheck        # tsc on backend + protocol
npm test                 # engine invariants + analyzers (no Lean needed)

# Run the backend (needs a Lean toolchain with `lake` on PATH for real stepping)
LEAN_PROJECT_ROOT=./lean/test-project npm run dev:backend
npm run dev:web
```

> `SANDBOX=local` runs Lean unconfined — development only. Use
> `SANDBOX=docker` (see `LeanProcessLauncher.ts`) for anything untrusted.

## Read next

1. `docs/ARCHITECTURE.md` — architecture, API, security, testing, deployment
2. `docs/TASKS.md` — phased task plan with acceptance criteria
3. `apps/backend/src/engine/ProofEngine.ts` — the transactional core

## Hackathon web upload

The web application now supports direct `.lean` uploads. Start the full stack with:

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` and click **Upload .lean**. A sample integration file is included at `test-files/ProofExplorerTest.lean`.

The upload flow creates a project, stores the source, analyzes the proof hierarchy, loads the dependency graph, starts a Lean session for the first executable proof unit, and exposes verified proof navigation in the browser.

### First-time Lean setup

The development Lean project is pinned to Lean 4.15.0 and Mathlib v4.15.0 so
uploaded files can use `import Mathlib`. On a fresh checkout, run:

```bash
npm run setup:lean
```

This runs `lake update` and `lake build` in `lean/test-project`. After that,
`npm run dev` starts the web app and backend normally.
