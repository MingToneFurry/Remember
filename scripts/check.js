import { accessSync, readFileSync } from "node:fs";

function assertReadable(path) {
  accessSync(path);
}

function assertContains(path, needle) {
  const content = readFileSync(path, "utf8");
  if (!content.includes(needle)) {
    throw new Error(`Expected "${needle}" in ${path}`);
  }
}

assertReadable("workers.js");
assertReadable("wrangler.toml");
assertReadable("Readme.md");
assertContains("workers.js", "export default");
assertContains("wrangler.toml", "main = \"workers.js\"");
console.log("check passed");
