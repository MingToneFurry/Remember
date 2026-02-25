import { buildSiteThemeCss } from "./siteTheme.js";

function listOrEmpty(items, emptyHtml) {
  return items.length > 0 ? items.join("") : emptyHtml;
}

export function buildMemorialPage(uid, snapshot = {}, escapeHtml) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (x) => String(x ?? "");
  const uploads = Array.isArray(snapshot?.uploads) ? snapshot.uploads : [];
  const topVideoInfos = Array.isArray(snapshot?.topVideoInfos) ? snapshot.topVideoInfos : [];
  const commentItems = Array.isArray(snapshot?.comments?.items) ? snapshot.comments.items : [];
  const danmuItems = Array.isArray(snapshot?.danmu?.items) ? snapshot.danmu.items : [];
  const liveDanmuItems = Array.isArray(snapshot?.liveDanmu?.items) ? snapshot.liveDanmu.items : [];
  const model = snapshot?.modelOutput || {};
  const profileTags = Array.isArray(model.profileTags) ? model.profileTags : [];
  const highlights = Array.isArray(model.highlights) ? model.highlights : [];
  const regRange = String(snapshot?.regDateEstimate?.estimatedRange || "未知");
  const generatedAt = new Date(snapshot?.createdAt || Date.now()).toLocaleString();
  const dataNotice = String(snapshot?.dataNotice || "第三方API数据可能不准确，仅供纪念参考");
  const memorialLine = String(model?.signature || "此账号已注销。这里保留其公开留下的片段。");

  const uploadRows = uploads.length
    ? uploads
        .map((u) => `<tr><td>${esc(u.fileName)}</td><td>${esc(u.size)}</td><td>${esc(u.mime)}</td></tr>`)
        .join("")
    : '<tr><td colspan="3">暂无上传数据</td></tr>';

  const videoRows = listOrEmpty(
    topVideoInfos.slice(0, 10).map((v) => {
      const title = esc(v?.data?.title || v?.bvid || "未命名视频");
      const bvid = esc(v?.bvid || v?.data?.bvid || "");
      const playCount = Number(v?.playCount || v?.data?.stat?.view || 0).toLocaleString();
      return `<li><strong>${title}</strong>${bvid ? ` <code>${bvid}</code>` : ""} · 播放 ${playCount}</li>`;
    }),
    "<li>暂无视频信息</li>",
  );

  const commentRows = listOrEmpty(
    commentItems.slice(0, 8).map((c) => `<li>${esc(c?.message || "")}</li>`),
    "<li>暂无评论数据</li>",
  );
  const danmuRows = listOrEmpty(
    danmuItems.slice(0, 8).map((d) => `<li>${esc(d?.content || "")}</li>`),
    "<li>暂无视频弹幕数据</li>",
  );
  const liveDanmuRows = listOrEmpty(
    liveDanmuItems
      .slice(0, 8)
      .map((item) =>
        Array.isArray(item?.danmu)
          ? item.danmu
              .slice(0, 2)
              .map((x) => `<li>${esc(x?.uname || "匿名")}：${esc(x?.text || "")}</li>`)
              .join("")
          : "",
      ),
    "<li>暂无直播弹幕数据</li>",
  );

  const tagRows = listOrEmpty(
    profileTags.slice(0, 10).map((tag) => `<span class="tag">${esc(tag)}</span>`),
    '<span class="tag">自动生成</span>',
  );

  const highlightRows = listOrEmpty(
    highlights.slice(0, 10).map((item) => `<li>${esc(item)}</li>`),
    "<li>暂无可展示片段</li>",
  );

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>UID ${esc(uid)} 纪念页</title><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>${buildSiteThemeCss()}
  .memorial-metrics{list-style:none;padding:0;margin:10px 0 0}
  .memorial-metrics li{padding:6px 0;border-bottom:1px solid var(--theme-line)}
  .memorial-metrics li:last-child{border-bottom:none}
  .memorial-list li{padding:6px 0;border-bottom:1px solid var(--theme-line)}
  .memorial-list li:last-child{border-bottom:none}
  .notice-card{border:1px solid var(--theme-line);border-radius:10px;padding:10px 12px;background:var(--theme-card)}
  .fold{margin-top:12px}
  </style></head>
  <body><main class="site-shell">
    <header class="hero">
      <h1>UID ${esc(uid)} 纪念页</h1>
      <p class="lead">${esc(memorialLine)}</p>
      <div class="meta-row">
        <span class="meta-chip">加入时间估算：${esc(regRange)}</span>
        <span class="meta-chip">最后存档生成：${esc(generatedAt)}</span>
      </div>
    </header>

    <section class="panel">
      <h2>留下的话</h2>
      <p class="quote">${esc(model.summary || "这里保存的是公开可用的贡献片段。")}</p>
      <div class="tag-list">${tagRows}</div>
      <div class="notice-card fold muted">数据声明：${esc(dataNotice)}</div>
    </section>

    <section class="panel">
      <h2>代表性贡献</h2>
      <ul class="memorial-list">${videoRows}</ul>
    </section>

    <section class="panel">
      <h2>片段记录</h2>
      <div class="grid-two">
        <div>
          <h3>评论片段</h3>
          <ul class="memorial-list">${commentRows}</ul>
        </div>
        <div>
          <h3>视频弹幕片段</h3>
          <ul class="memorial-list">${danmuRows}</ul>
        </div>
      </div>
      <div class="fold">
        <h3>直播弹幕片段</h3>
        <ul class="memorial-list">${liveDanmuRows}</ul>
      </div>
    </section>

    <section class="panel">
      <h2>档案信息</h2>
      <div class="grid-two">
        <div>
          <ul class="memorial-metrics">
            <li>投稿总数：${Number(snapshot?.allVid?.total || 0)}</li>
            <li>评论总数：${Number(snapshot?.comments?.total || 0)}</li>
            <li>视频弹幕总数：${Number(snapshot?.danmu?.total || 0)}</li>
            <li>直播弹幕总数：${Number(snapshot?.liveDanmu?.total || 0)}</li>
          </ul>
          <h3>高亮片段</h3>
          <ul class="memorial-list">${highlightRows}</ul>
        </div>
        <div>
          <h3>上传数据</h3>
          <table class="table"><thead><tr><th>文件名</th><th>大小</th><th>MIME</th></tr></thead><tbody>${uploadRows}</tbody></table>
        </div>
      </div>
    </section>
  </main></body></html>`;
}
