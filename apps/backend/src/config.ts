/**
 * Central, typed configuration. Everything is read from the environment ONCE
 * at startup and passed down explicitly (no module reads process.env itself).
 */
export interface AppConfig {
  port: number;
  /** Lake project the Lean server runs in (must contain pre-built imports). */
  leanProjectRoot: string;
  /** Expected Lean version; a mismatch is logged, not fatal. */
  pinnedLeanVersion?: string;
  sandbox: "local" | "docker";
  docker: { image: string; memory: string; cpus: string; pidsLimit: number };
  limits: {
    maxSessions: number;
    sessionIdleMs: number;
    leanStartupTimeoutMs: number;
  };
  engine: {
    checkpointInterval: number;
    elaborationTimeoutMs: number;
    stateCacheSize: number;
  };
}

const int = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: int(env.PORT, 8080),
    leanProjectRoot: env.LEAN_PROJECT_ROOT ?? "./lean/test-project",
    pinnedLeanVersion: env.LEAN_VERSION,
    sandbox: env.SANDBOX === "docker" ? "docker" : "local",
    docker: {
      image: env.LEAN_DOCKER_IMAGE ?? "proof-explorer/lean-sandbox:latest",
      memory: env.LEAN_MEMORY ?? "2g",
      cpus: env.LEAN_CPUS ?? "1.5",
      pidsLimit: int(env.LEAN_PIDS_LIMIT, 256),
    },
    limits: {
      maxSessions: int(env.MAX_SESSIONS, 20),
      sessionIdleMs: int(env.SESSION_IDLE_MS, 15 * 60_000),
      leanStartupTimeoutMs: int(env.LEAN_STARTUP_TIMEOUT_MS, 60_000),
    },
    engine: {
      checkpointInterval: int(env.CHECKPOINT_INTERVAL, 100),
      elaborationTimeoutMs: int(env.ELABORATION_TIMEOUT_MS, 120_000),
      stateCacheSize: int(env.STATE_CACHE_SIZE, 256),
    },
  };
}
