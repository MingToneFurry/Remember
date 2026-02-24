import { UpstreamError } from "./upstreamClient.js";

function toSafeArray(value) {
  return Array.isArray(value) ? value : [];
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
  throw new UpstreamError("未知的 AICU 数据源", { source });
}

function extractAicuPage(source, data) {
  if (source === "comment") return toSafeArray(data?.data?.replies);
  if (source === "danmu") return toSafeArray(data?.data?.videodmlist);
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
