import test from "node:test";
import assert from "node:assert/strict";
import { UpstreamClient } from "../src/services/upstreamClient.js";
import { fetchAllVideosByUid } from "../src/services/memorialData.js";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fetchAllVideosByUid should paginate until total reached", async () => {
  const pages = [
    { total: 3, videos: [{ bvid: "BV1111111111" }, { bvid: "BV2222222222" }] },
    { total: 3, videos: [{ bvid: "BV3333333333" }] },
  ];
  let idx = 0;
  const client = new UpstreamClient({
    allowedHosts: ["uapis.cn"],
    retries: 0,
    timeoutMs: 200,
    fetchImpl: async () => jsonResponse(200, pages[idx++] || { total: 3, videos: [] }),
  });
  const result = await fetchAllVideosByUid(client, "123", { pageSize: 2, maxPages: 10 });
  assert.equal(result.total, 3);
  assert.equal(result.videos.length, 3);
  assert.equal(result.videos[2].bvid, "BV3333333333");
});

test("fetchAllVideosByUid should return empty list for zero total", async () => {
  const client = new UpstreamClient({
    allowedHosts: ["uapis.cn"],
    retries: 0,
    timeoutMs: 200,
    fetchImpl: async () => jsonResponse(200, { total: 0, videos: [] }),
  });
  const result = await fetchAllVideosByUid(client, "456");
  assert.equal(result.total, 0);
  assert.deepEqual(result.videos, []);
});
