# Proof Explorer - Hackathon Quickstart

## 1. Requirements

- Node.js 20+
- Lean 4 / Lake available on PATH
- The bundled `lean/test-project` must have its dependencies built

## 2. Install

From the repository root:

```bash
npm install
```

## 3. Start the backend

```bash
npm run dev:backend
```

The backend listens on `http://localhost:8080`.

For local development the default is `SANDBOX=local`. Uploaded Lean files are still written into the isolated `.proof-explorer-uploads/<projectId>/` workspace under the Lean project root before Lean is started.

For a production/demo machine with Docker available, set:

```env
SANDBOX=docker
```

and use the supplied sandbox image.

## 4. Start the web app

In a second terminal:

```bash
npm run dev:web
```

Open the Vite URL, normally:

```text
http://localhost:5173/
```

## 5. Upload a Lean file

Click **Upload .lean** in the top-left of the web UI and select:

```text
test-files/ProofExplorerTest.lean
```

The application will:

1. create a project;
2. upload the source file through `POST /api/projects/:id/files`;
3. analyze its proof hierarchy;
4. populate the hierarchy tree and dependency DAG;
5. open the first executable theorem/lemma/example;
6. create a real Lean proof session;
7. show the initial goals;
8. allow verified Next / Previous / Reset / Jump navigation;
9. allow nested proof-unit entry and return;
10. show an AI-assisted tactic proposal; and
11. verify an accepted proposal against the next source tactic and commit the resulting Lean state.

## 6. Important

The web app is not useful by itself. Run **both** the backend and the web app.

If the UI says `Offline`, check that `npm run dev:backend` is running on port 8080.

If the UI says `No units loaded`, check the browser Network tab for `/api/structure/<fileId>` and `/api/proof-units/<unitId>` failures.

## Lean environment setup (required for Mathlib uploads)

The bundled test Lake project pins Lean 4.15.0 and Mathlib v4.15.0. Before using
an uploaded file containing `import Mathlib`, run once from the repository root:

```bash
npm run setup:lean
```

This resolves the Lake dependency and builds the test project. Then start the app
normally with `npm run dev`.
