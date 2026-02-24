import { fetchTopVideoInfosByPlayCount } from "../src/services/memorialData.js";

function buildMockVideos(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      bvid: `BV1xx411c7${String(i).padStart(2, "0").slice(-2)}`,
      play_count: count - i,
    });
  }
  return out;
}

function createMockClient(delayMs = 8) {
  return {
    async requestJson(url) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const parsed = new URL(url);
      return {
        data: {
          bvid: parsed.searchParams.get("bvid") || "",
          aid: parsed.searchParams.get("aid") || "",
          stat: { view: 1000 },
        },
      };
    },
  };
}

async function runBenchmark() {
  const videos = buildMockVideos(500);
  const mockClient = createMockClient(8);
  const startedAt = Date.now();
  const topInfos = await fetchTopVideoInfosByPlayCount(mockClient, videos, {
    topN: 10,
    concurrency: 4,
  });
  const elapsedMs = Date.now() - startedAt;
  const thresholdMs = 220;
  if (topInfos.length !== 10) {
    throw new Error(`benchmark failed: expected 10 records, got ${topInfos.length}`);
  }
  if (elapsedMs > thresholdMs) {
    throw new Error(`benchmark failed: ${elapsedMs}ms > ${thresholdMs}ms`);
  }
  console.log(`perf passed: top10 fetched in ${elapsedMs}ms (threshold ${thresholdMs}ms)`);
}

runBenchmark().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

