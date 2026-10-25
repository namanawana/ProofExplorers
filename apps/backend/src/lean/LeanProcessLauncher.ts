/**
 * Process launching is separated from protocol handling so the SANDBOX is a
 * pluggable policy: development uses LocalProcessLauncher; production MUST use
 * DockerProcessLauncher (or an equivalent such as gVisor / Firecracker).
 *
 * Uploaded .lean files are untrusted code. Lean can run arbitrary
 * metaprograms at elaboration time (`run_cmd`, macros, `#eval`), so they must
 * never execute on the host unconfined.
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface LeanProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface LaunchOptions {
  projectRoot: string;
}

export interface LeanProcessLauncher {
  launch(options: LaunchOptions): LeanProcess;
}

function wrap(child: ReturnType<typeof spawn>): LeanProcess {
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    kill: () => child.kill("SIGKILL"),
    onExit: (listener) => child.on("exit", (code) => listener(code)),
  };
}

/** DEVELOPMENT ONLY - runs Lean directly on the host with no isolation. */
export class LocalProcessLauncher implements LeanProcessLauncher {
  launch({ projectRoot }: LaunchOptions): LeanProcess {
    // `lake serve` starts the Lean language server with the project's
    // dependency search paths configured. Verify against the pinned toolchain.
    const child = spawn("lake", ["serve", "--"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "inherit"],
    });
    return wrap(child);
  }
}

export interface DockerLimits {
  image: string;
  memory: string; // e.g. "2g"
  cpus: string; // e.g. "1.5"
  pidsLimit: number;
}

/**
 * Production launcher: one throw-away container per Lean session.
 *
 *  --network none   : uploaded code cannot exfiltrate or fetch anything
 *  --read-only      : immutable root filesystem
 *  --tmpfs /tmp     : the only writable scratch space, memory-backed
 *  --memory/--cpus/--pids-limit : hard resource ceilings (session quotas)
 *  --cap-drop ALL + no-new-privileges : no privilege escalation
 *  :ro project mount: the Lake project (with PRE-BUILT .olean files for
 *                     imports such as Mathlib) is mounted read-only
 *
 * Wall-clock limits are enforced by the adapter (LEAN_TIMEOUT) plus the
 * SessionManager idle reaper, which kills the container.
 */
export class DockerProcessLauncher implements LeanProcessLauncher {
  constructor(private readonly limits: DockerLimits) {}

  launch({ projectRoot }: LaunchOptions): LeanProcess {
    const l = this.limits;
    const child = spawn(
      "docker",
      [
        "run", "--rm", "-i",
        "--network", "none",
        "--read-only",
        "--tmpfs", "/tmp:rw,size=256m",
        "--memory", l.memory,
        "--cpus", l.cpus,
        "--pids-limit", String(l.pidsLimit),
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "-v", `${projectRoot}:/project:ro`,
        "-w", "/project",
        l.image,
        "lake", "serve", "--",
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    return wrap(child);
  }
}
