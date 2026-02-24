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
