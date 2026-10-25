import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(npm, ["run", "dev:backend"], { stdio: "inherit", shell: false }),
  spawn(npm, ["run", "dev:web"], { stdio: "inherit", shell: false }),
];

const shutdown = () => {
  for (const child of children) child.kill("SIGINT");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
}
