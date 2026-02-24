import { spawnSync } from "node:child_process";

const syntax = spawnSync("node", ["--check", "workers.js"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (syntax.status !== 0) {
  process.exit(syntax.status ?? 1);
}

console.log("test passed");
