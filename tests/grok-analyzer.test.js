import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithGrok } from "../src/services/grokAnalyzer.js";
import { UpstreamClient, UpstreamTimeoutError } from "../src/services/upstreamClient.js";

function makeClient(fetchImpl) {
  return new UpstreamClient({
    allowedHosts: ["grok.726748.xyz"],
    retries: 0,
    timeoutMs: 200,
    fetchImpl,
  });
}

test("analyzeWithGrok should parse structured JSON response", async () => {
  const client = makeClient(async () => {
    const content = JSON.stringify({
      summary: "这是测试摘要",
      profileTags: ["A", "B"],
      highlights: ["H1"],
      confidence: "medium",
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const result = await analyzeWithGrok(
    { GROK_API_URL: "https://grok.726748.xyz/v1/chat/completions", GROK_API_KEY: "k", GROK_MODEL: "grok-x" },
    client,
    { uid: "1", allVid: { videos: [] }, comments: { items: [] }, danmu: { items: [] }, liveDanmu: { items: [] } },
  );
  assert.equal(result.source, "grok");
  assert.equal(result.summary, "这是测试摘要");
  assert.equal(result.profileTags.length, 2);
});

test("analyzeWithGrok should fallback on timeout", async () => {
  const client = makeClient(async () => {
    throw new UpstreamTimeoutError("timeout");
  });
  const result = await analyzeWithGrok(
    { GROK_API_URL: "https://grok.726748.xyz/v1/chat/completions", GROK_API_KEY: "k", GROK_MODEL: "grok-x" },
    client,
    { uid: "2" },
  );
  assert.equal(result.source, "fallback");
  assert.match(result.reason, /超时|失败/);
});

test("analyzeWithGrok should fallback on invalid response", async () => {
  const client = makeClient(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const result = await analyzeWithGrok(
    { GROK_API_URL: "https://grok.726748.xyz/v1/chat/completions", GROK_API_KEY: "k", GROK_MODEL: "grok-x" },
    client,
    { uid: "3" },
  );
  assert.equal(result.source, "fallback");
  assert.match(result.reason, /失败|JSON/);
});
