import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const project = resolve(root, "lean", "test-project");
const lake = process.platform === "win32" ? "lake.exe" : "lake";

function run(args) {
  console.log(`\n> ${lake} ${args.join(" ")}`);
  const result = spawnSync(lake, args, { cwd: project, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`Could not start ${lake}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(project)) {
  console.error(`Lean project not found: ${project}`);
  process.exit(1);
}

// Resolve the pinned Mathlib dependency and build the local library once.
// Subsequent runs are incremental and normally very fast.
run(["update"]);
run(["build"]);
console.log("\nLean environment is ready. Start Proof Explorer with: npm run dev");
