import { spawnSync } from "node:child_process";

const syntax = spawnSync("node", ["--check", "workers.js"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (syntax.status !== 0) {
  process.exit(syntax.status ?? 1);
}

const unit = spawnSync("node", ["--test", "tests/upstream-client.test.js", "tests/memorial-data.test.js"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (unit.status !== 0) {
  process.exit(unit.status ?? 1);
}

console.log("test passed");
