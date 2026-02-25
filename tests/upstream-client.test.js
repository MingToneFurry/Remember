import test from "node:test";
import assert from "node:assert/strict";
import { UpstreamClient, UpstreamError, UpstreamTimeoutError } from "../src/services/upstreamClient.js";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("should retry failed requests and finally succeed", async () => {
  let attempts = 0;
  const client = new UpstreamClient({
    allowedHosts: ["uapis.cn"],
    retries: 2,
    timeoutMs: 200,
    backoffBaseMs: 10,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse(500, { error: "busy" });
      if (attempts === 2) throw new Error("network down");
      return jsonResponse(200, { ok: true });
    },
  });
  const { data } = await client.requestJson("https://uapis.cn/api/test");
  assert.equal(data.ok, true);
  assert.equal(attempts, 3);
});

test("should fail with timeout error when all retries timed out", async () => {
  const client = new UpstreamClient({
    allowedHosts: ["uapis.cn"],
    retries: 0,
    timeoutMs: 20,
    backoffBaseMs: 5,
    fetchImpl: async (_url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  });

  await assert.rejects(() => client.requestJson("https://uapis.cn/api/test"), UpstreamTimeoutError);
});

test("should reject non-whitelisted hosts", async () => {
  const client = new UpstreamClient({
    allowedHosts: ["uapis.cn"],
    retries: 0,
    timeoutMs: 50,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  });
  await assert.rejects(() => client.requestJson("https://example.com/api/test"), /白名单/);
});

test("should not retry non-retryable upstream status", async () => {
  let attempts = 0;
  const client = new UpstreamClient({
    allowedHosts: ["uapis.cn"],
    retries: 3,
    timeoutMs: 100,
    backoffBaseMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse(400, { error: "bad request" });
    },
  });

  await assert.rejects(() => client.requestJson("https://uapis.cn/api/test"), UpstreamError);
  assert.equal(attempts, 1);
});

test("should retry schema failures when retryOnSchemaFailure is enabled", async () => {
  let attempts = 0;
  const client = new UpstreamClient({
    allowedHosts: ["uapis.cn"],
    retries: 3,
    timeoutMs: 100,
    backoffBaseMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) return jsonResponse(200, { code: -666, message: "busy" });
      return jsonResponse(200, { code: 0, data: { ok: true } });
    },
  });

  const { data } = await client.requestJson("https://uapis.cn/api/test", {
    schema: (payload) => Number(payload?.code) === 0,
    retryOnSchemaFailure: true,
  });
  assert.equal(data.code, 0);
  assert.equal(attempts, 3);
});
