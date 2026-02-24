import test from "node:test";
import assert from "node:assert/strict";
import { UpstreamClient } from "../src/services/upstreamClient.js";
import { estimateRegDateByUid, fetchAllVideosByUid, fetchPagedAicuData } from "../src/services/memorialData.js";

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

test("fetchPagedAicuData should stop by is_end and keep all_count", async () => {
  const pages = [
    {
      code: 0,
      data: { cursor: { is_end: false, all_count: 3 }, replies: [{ id: 1 }, { id: 2 }] },
    },
    {
      code: 0,
      data: { cursor: { is_end: true, all_count: 3 }, replies: [{ id: 3 }] },
    },
  ];
  let idx = 0;
  const client = new UpstreamClient({
    allowedHosts: ["api.aicu.cc"],
    retries: 0,
    timeoutMs: 200,
    fetchImpl: async () => jsonResponse(200, pages[idx++] || pages[1]),
  });
  const result = await fetchPagedAicuData(client, "comment", "123", { maxPages: 10, maxItems: 100 });
  assert.equal(result.total, 3);
  assert.equal(result.items.length, 3);
  assert.equal(result.truncated, false);
});

test("fetchPagedAicuData should truncate when hitting maxItems", async () => {
  const page = {
    code: 0,
    data: {
      cursor: { is_end: false, all_count: 300 },
      videodmlist: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })),
    },
  };
  const client = new UpstreamClient({
    allowedHosts: ["api.aicu.cc"],
    retries: 0,
    timeoutMs: 200,
    fetchImpl: async () => jsonResponse(200, page),
  });
  const result = await fetchPagedAicuData(client, "danmu", "789", { maxPages: 10, maxItems: 150 });
  assert.equal(result.items.length, 150);
  assert.equal(result.truncated, true);
});

test("fetchPagedAicuData should support empty zhibodanmu list", async () => {
  const client = new UpstreamClient({
    allowedHosts: ["api.aicu.cc"],
    retries: 0,
    timeoutMs: 200,
    fetchImpl: async () =>
      jsonResponse(200, {
        code: 0,
        data: { cursor: { is_end: true, all_count: 0 }, list: [] },
      }),
  });
  const result = await fetchPagedAicuData(client, "zhibodanmu", "900", { maxPages: 10, maxItems: 100 });
  assert.equal(result.items.length, 0);
  assert.equal(result.total, 0);
});

test("estimateRegDateByUid should map uid to expected range", () => {
  assert.equal(estimateRegDateByUid(999999).estimatedRange, "2009-2012");
  assert.equal(estimateRegDateByUid(5_000_000).estimatedRange, "2013-2016");
  assert.equal(estimateRegDateByUid(30_000_000).estimatedRange, "2017-2019");
  assert.equal(estimateRegDateByUid(80_000_000).estimatedRange, "2020-2022");
  assert.equal(estimateRegDateByUid(300_000_000).estimatedRange, "2023+");
});
