import { UpstreamError } from "./upstreamClient.js";

function toSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function fetchAllVideosByUid(client, uid, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || 200);
  const pageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 50));
  const videos = [];
  let total = null;
  let page = 1;

  while (page <= maxPages) {
    const url = `https://uapis.cn/api/v1/social/bilibili/archives?mid=${encodeURIComponent(uid)}&ps=${pageSize}&pn=${page}`;
    const { data } = await client.requestJson(url, {
      schema: (payload) => payload && typeof payload === "object",
    });

    const currentVideos = toSafeArray(data.videos ?? data?.data?.videos);
    const currentTotal = Number(data.total ?? data?.data?.total ?? 0);
    if (Number.isFinite(currentTotal) && currentTotal >= 0) total = currentTotal;

    if (currentVideos.length === 0) break;
    videos.push(...currentVideos);

    if (total !== null && videos.length >= total) break;
    if (currentVideos.length < pageSize) break;
    page += 1;
  }

  if (videos.length === 0 && total === null) {
    throw new UpstreamError("投稿接口返回异常：无总数且无视频");
  }

  return {
    uid: String(uid),
    total: total ?? videos.length,
    fetchedPages: page,
    videos,
  };
}

async function fetchAicuByPage(client, source, uid, page, keyword = "") {
  if (source === "comment") {
    return client.requestJson(
      `https://api.aicu.cc/api/v3/search/getreply?uid=${encodeURIComponent(uid)}&pn=${page}&ps=100&mode=0`,
      { schema: (payload) => payload && typeof payload === "object" },
    );
  }
  if (source === "danmu") {
    return client.requestJson(
      `https://api.aicu.cc/api/v3/search/getvideodm?uid=${encodeURIComponent(uid)}&pn=${page}&ps=100&keyword=${encodeURIComponent(keyword)}`,
      { schema: (payload) => payload && typeof payload === "object" },
    );
  }
  if (source === "zhibodanmu") {
    return client.requestJson(
      `https://api.aicu.cc/api/v3/search/getlivedm?uid=${encodeURIComponent(uid)}&pn=${page}&ps=100&keyword=${encodeURIComponent(keyword)}`,
      { schema: (payload) => payload && typeof payload === "object" },
    );
  }
  throw new UpstreamError("未知的 AICU 数据源", { source });
}

function extractAicuPage(source, data) {
  if (source === "comment") return toSafeArray(data?.data?.replies);
  if (source === "danmu") return toSafeArray(data?.data?.videodmlist);
  if (source === "zhibodanmu") return toSafeArray(data?.data?.list);
  return [];
}

function extractAicuCursor(data) {
  return {
    isEnd: Boolean(data?.data?.cursor?.is_end),
    allCount: Number(data?.data?.cursor?.all_count ?? 0),
  };
}

export async function fetchPagedAicuData(client, source, uid, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || 1000);
  const maxItems = Math.max(1, Number(options.maxItems) || 5000);
  const keyword = String(options.keyword || "");
  const items = [];
  let page = 1;
  let total = 0;

  while (page <= maxPages) {
    const { data } = await fetchAicuByPage(client, source, uid, page, keyword);
    const pageItems = extractAicuPage(source, data);
    const cursor = extractAicuCursor(data);
    if (Number.isFinite(cursor.allCount) && cursor.allCount >= 0) total = cursor.allCount;
    if (pageItems.length > 0) items.push(...pageItems);

    if (cursor.isEnd) break;
    if (items.length >= maxItems) break;
    if (pageItems.length === 0) break;
    page += 1;
  }

  const truncated = items.length > maxItems;
  return {
    uid: String(uid),
    source,
    total,
    fetchedPages: page,
    truncated,
    items: items.slice(0, maxItems),
  };
}

export function estimateRegDateByUid(uidInput) {
  const uid = Number(uidInput);
  if (!Number.isFinite(uid) || uid <= 0) {
    return {
      uid: String(uidInput ?? ""),
      estimatedRange: "未知",
      confidence: "low",
      note: "UID 不合法，无法估算注册时间",
    };
  }
  if (uid <= 1_000_000) {
    return {
      uid: String(uid),
      estimatedRange: "2009-2012",
      confidence: "low",
      note: "基于 UID 段位估算，误差可能半年以上",
    };
  }
  if (uid <= 10_000_000) {
    return {
      uid: String(uid),
      estimatedRange: "2013-2016",
      confidence: "low",
      note: "基于 UID 段位估算，误差可能半年以上",
    };
  }
  if (uid <= 50_000_000) {
    return {
      uid: String(uid),
      estimatedRange: "2017-2019",
      confidence: "low",
      note: "基于 UID 段位估算，误差可能半年以上",
    };
  }
  if (uid <= 200_000_000) {
    return {
      uid: String(uid),
      estimatedRange: "2020-2022",
      confidence: "low",
      note: "基于 UID 段位估算，误差可能半年以上",
    };
  }
  return {
    uid: String(uid),
    estimatedRange: "2023+",
    confidence: "low",
    note: "基于 UID 段位估算，误差可能半年以上",
  };
}

async function runWithConcurrency(items, concurrency, handler) {
  const max = Math.max(1, Number(concurrency) || 1);
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      out[current] = await handler(items[current], current);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function fetchTopVideoInfosByPlayCount(client, videos, options = {}) {
  const topN = Math.max(1, Number(options.topN) || 10);
  const concurrency = Math.max(1, Number(options.concurrency) || 3);
  const sorted = toSafeArray(videos)
    .filter((item) => item && typeof item === "object")
    .sort((a, b) => toNumber(b.play_count ?? b.play ?? b?.stat?.view) - toNumber(a.play_count ?? a.play ?? a?.stat?.view))
    .slice(0, topN);

  const infos = await runWithConcurrency(sorted, concurrency, async (video) => {
    const bvid = String(video.bvid || "").trim();
    const aid = String(video.aid || "").trim();
    if (!bvid && !aid) return null;
    const query = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`;
    const { data } = await client.requestJson(`https://uapis.cn/api/v1/social/bilibili/view?${query}`, {
      schema: (payload) => payload && typeof payload === "object",
    });
    return {
      bvid: bvid || String(data?.bvid || ""),
      aid: aid || String(data?.aid || ""),
      playCount: toNumber(video.play_count ?? video.play ?? data?.stat?.view),
      data,
    };
  });

  return infos.filter(Boolean);
}
