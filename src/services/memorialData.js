import { UpstreamError } from "./upstreamClient.js";

function toSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNonNegativeIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function pickArchivePayload(payload) {
  if (!isRecord(payload)) return null;
  if (Array.isArray(payload.videos)) return payload;
  if (isRecord(payload.data) && Array.isArray(payload.data.videos)) return payload.data;
  return null;
}

function isArchivePayload(payload) {
  const archive = pickArchivePayload(payload);
  if (!archive) return false;
  const total = toNonNegativeIntOrNull(archive.total);
  return total !== null;
}

const AICU_LIST_KEY_BY_SOURCE = {
  comment: "replies",
  danmu: "videodmlist",
  zhibodanmu: "list",
};

function isAicuPayload(source, payload) {
  if (!isRecord(payload) || Number(payload.code) !== 0) return false;
  const data = payload.data;
  if (!isRecord(data)) return false;
  const cursor = data.cursor;
  if (!isRecord(cursor) || typeof cursor.is_end !== "boolean") return false;
  if (toNonNegativeIntOrNull(cursor.all_count) === null) return false;
  const listKey = AICU_LIST_KEY_BY_SOURCE[source];
  return Array.isArray(data[listKey]);
}

const ARCHIVE_RETRY_OPTIONS = {
  retries: 4,
  timeoutMs: 10000,
  backoffBaseMs: 250,
  maxBackoffMs: 5000,
  backoffJitterRatio: 0.2,
};

const AICU_RETRY_OPTIONS = {
  retries: 5,
  timeoutMs: 12000,
  backoffBaseMs: 300,
  maxBackoffMs: 6000,
  backoffJitterRatio: 0.25,
};

const VIDEO_VIEW_RETRY_OPTIONS = {
  retries: 4,
  timeoutMs: 10000,
  backoffBaseMs: 250,
  maxBackoffMs: 5000,
  backoffJitterRatio: 0.2,
};

export async function fetchAllVideosByUid(client, uid, options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages) || 200);
  const pageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 50));
  const videos = [];
  let total = null;
  let page = 1;

  while (page <= maxPages) {
    const url = `https://uapis.cn/api/v1/social/bilibili/archives?mid=${encodeURIComponent(uid)}&ps=${pageSize}&pn=${page}`;
    const { data } = await client.requestJson(url, {
      ...ARCHIVE_RETRY_OPTIONS,
      schema: isArchivePayload,
      retryOnSchemaFailure: true,
    });

    const archive = pickArchivePayload(data);
    if (!archive) throw new UpstreamError("archive payload invalid");
    const currentVideos = toSafeArray(archive.videos);
    const currentTotal = toNonNegativeIntOrNull(archive.total);
    if (currentTotal !== null) total = currentTotal;

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
      {
        ...AICU_RETRY_OPTIONS,
        schema: (payload) => isAicuPayload("comment", payload),
        retryOnSchemaFailure: true,
      },
    );
  }
  if (source === "danmu") {
    return client.requestJson(
      `https://api.aicu.cc/api/v3/search/getvideodm?uid=${encodeURIComponent(uid)}&pn=${page}&ps=100&keyword=${encodeURIComponent(keyword)}`,
      {
        ...AICU_RETRY_OPTIONS,
        schema: (payload) => isAicuPayload("danmu", payload),
        retryOnSchemaFailure: true,
      },
    );
  }
  if (source === "zhibodanmu") {
    return client.requestJson(
      `https://api.aicu.cc/api/v3/search/getlivedm?uid=${encodeURIComponent(uid)}&pn=${page}&ps=100&keyword=${encodeURIComponent(keyword)}`,
      {
        ...AICU_RETRY_OPTIONS,
        schema: (payload) => isAicuPayload("zhibodanmu", payload),
        retryOnSchemaFailure: true,
      },
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
  const allCount = toNonNegativeIntOrNull(data?.data?.cursor?.all_count);
  return {
    isEnd: Boolean(data?.data?.cursor?.is_end),
    allCount: allCount ?? 0,
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
      ...VIDEO_VIEW_RETRY_OPTIONS,
      schema: (payload) => isRecord(payload) && Boolean(payload?.aid || payload?.bvid || payload?.data?.aid || payload?.data?.bvid),
      retryOnSchemaFailure: true,
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

function pickPayloadData(payload) {
  if (!isRecord(payload)) return {};
  if (isRecord(payload.data)) return payload.data;
  return payload;
}

function toBvid(value) {
  const bvid = String(value || "").trim();
  return /^BV[0-9A-Za-z]{10}$/.test(bvid) ? bvid : "";
}

function toAid(value) {
  const aid = String(value || "").trim();
  return /^\d+$/.test(aid) ? aid : "";
}

function normalizeAllVidArtifact(uid, payload) {
  const data = pickPayloadData(payload);
  const videos = toSafeArray(data.videos);
  const total = toNonNegativeIntOrNull(data.total) ?? toNonNegativeIntOrNull(payload?.total) ?? videos.length;
  const fetchedPages =
    toNonNegativeIntOrNull(data.fetchedPages) ??
    toNonNegativeIntOrNull(payload?.fetchedPages) ??
    toNonNegativeIntOrNull(data.page) ??
    toNonNegativeIntOrNull(payload?.page) ??
    (videos.length > 0 ? 1 : 0);
  return {
    uid: String(uid),
    total,
    fetchedPages,
    videos,
  };
}

function normalizeAicuArtifact(source, uid, payload) {
  const data = pickPayloadData(payload);
  const listKey = AICU_LIST_KEY_BY_SOURCE[source];
  const listFromSource = toSafeArray(data[listKey]);
  const items = listFromSource.length > 0 ? listFromSource : toSafeArray(payload?.items);
  const cursor = isRecord(data.cursor) ? data.cursor : isRecord(payload?.cursor) ? payload.cursor : {};
  const total =
    toNonNegativeIntOrNull(cursor.all_count) ??
    toNonNegativeIntOrNull(payload?.total) ??
    toNonNegativeIntOrNull(data.total) ??
    items.length;
  const fetchedPages =
    toNonNegativeIntOrNull(payload?.fetchedPages) ??
    toNonNegativeIntOrNull(data.fetchedPages) ??
    toNonNegativeIntOrNull(payload?.page) ??
    toNonNegativeIntOrNull(data.page) ??
    (items.length > 0 ? 1 : 0);
  return {
    uid: String(uid),
    source,
    total,
    fetchedPages,
    truncated: Boolean(payload?.truncated),
    items,
  };
}

function deriveTopVideoInfosFromAllVid(videos) {
  return toSafeArray(videos)
    .filter((item) => isRecord(item))
    .sort((a, b) => toNumber(b.play_count ?? b.play ?? b?.stat?.view) - toNumber(a.play_count ?? a.play ?? a?.stat?.view))
    .slice(0, 10)
    .map((item) => ({
      bvid: toBvid(item.bvid),
      aid: toAid(item.aid),
      playCount: toNumber(item.play_count ?? item.play ?? item?.stat?.view),
      data: item,
    }));
}

function normalizeTopVideoInfosArtifact(payload, allVidVideos) {
  let items = [];
  if (Array.isArray(payload)) {
    items = payload;
  } else if (Array.isArray(payload?.items)) {
    items = payload.items;
  } else if (Array.isArray(payload?.topVideoInfos)) {
    items = payload.topVideoInfos;
  }

  const normalized = toSafeArray(items)
    .filter((item) => isRecord(item))
    .map((item) => {
      const data = isRecord(item.data) ? item.data : item;
      const bvid = toBvid(item.bvid || data?.bvid);
      const aid = toAid(item.aid || data?.aid);
      return {
        ...item,
        bvid,
        aid,
        playCount: toNumber(item.playCount ?? item.play_count ?? data?.stat?.view),
        data,
      };
    })
    .filter((item) => item.bvid || item.aid || isRecord(item.data));
  if (normalized.length > 0) return normalized.slice(0, 20);
  return deriveTopVideoInfosFromAllVid(allVidVideos);
}

export function buildSnapshotFromArtifacts(uid, artifacts = {}) {
  const allVid = normalizeAllVidArtifact(uid, artifacts.allVid);
  const comments = normalizeAicuArtifact("comment", uid, artifacts.comment);
  const danmu = normalizeAicuArtifact("danmu", uid, artifacts.danmu);
  const liveDanmu = normalizeAicuArtifact("zhibodanmu", uid, artifacts.zhibodanmu);
  const topVideoInfos = normalizeTopVideoInfosArtifact(artifacts.topVideoInfos, allVid.videos);
  return { allVid, comments, danmu, liveDanmu, topVideoInfos };
}
