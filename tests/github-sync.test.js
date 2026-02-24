import test from "node:test";
import assert from "node:assert/strict";
import { syncGeneratedPageToGitHub } from "../src/services/githubSync.js";

test("syncGeneratedPageToGitHub should skip when config missing", async () => {
  const result = await syncGeneratedPageToGitHub({}, { uid: "1", html: "<html/>" }, async () => {
    throw new Error("should not call fetch");
  });
  assert.equal(result.status, "skipped");
});

test("syncGeneratedPageToGitHub should commit file and return sha", async () => {
  let calls = 0;
  const mockFetch = async (_url, init = {}) => {
    calls += 1;
    if (!init.method || init.method === "GET") {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify({ commit: { sha: "abc123" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await syncGeneratedPageToGitHub(
    {
      GITHUB_OWNER: "owner",
      GITHUB_REPO: "repo",
      GITHUB_TOKEN: "token",
      GITHUB_BRANCH: "generated-pages",
      GITHUB_PAGES_PREFIX: "generated",
    },
    { uid: "100", html: "<html>ok</html>" },
    mockFetch,
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.commitSha, "abc123");
  assert.equal(calls, 2);
});
