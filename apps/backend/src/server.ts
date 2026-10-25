/**
 * Composition root. This is the ONLY place concrete classes are wired
 * together; every other module receives its collaborators as parameters.
 *
 *   config -> launcher(sandbox) -> adapter -> engine deps -> SessionManager
 *                                                         -> REST + WebSocket
 */
import { createServer } from "node:http";
import express from "express";
import { createRestRouter } from "./api/rest";
import { attachWebSocket } from "./api/ws";
import { HeuristicStructureAnalyzer } from "./analysis/StructureAnalyzer";
import { loadConfig } from "./config";
import { InMemoryEventStore } from "./engine/EventStore";
import { InMemoryProofRepository } from "./engine/ProofRepository";
import { LspLeanAdapter } from "./lean/LspLeanAdapter";
import {
  DockerProcessLauncher,
  LocalProcessLauncher,
} from "./lean/LeanProcessLauncher";
import { SessionManager } from "./session/SessionManager";
import { InMemoryProjectStore } from "./store/ProjectStore";
import { createLogger, systemClock } from "./util/index";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ service: "proof-explorer-backend" });

  // Unsandboxed execution of uploaded Lean is a remote-code-execution hole.
  if (config.sandbox === "local") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing to start in production with SANDBOX=local. Use SANDBOX=docker.");
    }
    logger.warn("SANDBOX=local: Lean runs UNCONFINED on this host. Development only.");
  }
  const launcher =
    config.sandbox === "docker"
      ? new DockerProcessLauncher({ ...config.docker })
      : new LocalProcessLauncher();

  const adapter = new LspLeanAdapter(launcher, logger, config.pinnedLeanVersion);
  const events = new InMemoryEventStore(systemClock);
  const repo = new InMemoryProofRepository();
  const store = new InMemoryProjectStore(new HeuristicStructureAnalyzer(), systemClock);
  const sessions = new SessionManager({ adapter, repo, events, store, config, clock: systemClock, logger });
  sessions.startReaper();

  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(createRestRouter({ store, sessions, repo, events }));

  const http = createServer(app);
  attachWebSocket(http, { sessions, events, logger });
  http.listen(config.port, () => logger.info("listening", { port: config.port }));

  // Graceful shutdown: kill Lean processes so no containers are orphaned.
  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    http.close();
    await sessions.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
