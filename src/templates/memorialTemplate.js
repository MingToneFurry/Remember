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
    "<li>暂无高亮摘要</li>",
  );

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>UID ${esc(uid)} 纪念页</title><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
  body{font-family:system-ui;background:#f4f6fb;padding:20px;color:#1f2735}
  .card{max-width:980px;margin:0 auto;background:#fff;border:1px solid #dce4f2;border-radius:12px;padding:16px}
  .notice{padding:10px 12px;background:#fff8e8;border:1px solid #f1dc9a;border-radius:8px;color:#6b4d00;margin:12px 0}
  section{margin-top:18px}
  h1,h2,h3{margin:0 0 10px}
  table{width:100%;border-collapse:collapse}
  td,th{border-bottom:1px solid #ecf1f8;padding:8px;text-align:left}
  ul{padding-left:18px;margin:8px 0}
  code{background:#f5f7fb;padding:2px 4px;border-radius:4px}
  .tags{display:flex;gap:8px;flex-wrap:wrap}
  .tag{display:inline-block;padding:4px 8px;border-radius:999px;background:#eef3ff;border:1px solid #ccd7ff;color:#2d3f85;font-size:12px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width: 800px){.grid{grid-template-columns:1fr}}
  </style></head>
  <body><div class="card">
    <h1>UID ${esc(uid)} 纪念页</h1>
    <p>页面生成时间：${esc(generatedAt)}</p>
    <div class="notice">数据声明：${esc(dataNotice)}</div>

    <section>
      <h2>用户画像摘要</h2>
      <p>${esc(model.summary || "模型未返回结构化摘要，已使用降级文案。")}</p>
      <div class="tags">${tagRows}</div>
      <h3>高亮片段</h3>
      <ul>${highlightRows}</ul>
    </section>

    <section class="grid">
      <div>
        <h2>时间线摘要</h2>
        <ul>
          <li>注册时间估算：${esc(regRange)}</li>
          <li>投稿总数：${Number(snapshot?.allVid?.total || 0)}</li>
          <li>评论总数：${Number(snapshot?.comments?.total || 0)}</li>
          <li>视频弹幕总数：${Number(snapshot?.danmu?.total || 0)}</li>
          <li>直播弹幕总数：${Number(snapshot?.liveDanmu?.total || 0)}</li>
        </ul>
      </div>
      <div>
        <h2>上传数据</h2>
        <table><thead><tr><th>文件名</th><th>大小</th><th>MIME</th></tr></thead><tbody>${uploadRows}</tbody></table>
      </div>
    </section>

    <section>
      <h2>代表视频（Top 10）</h2>
      <ul>${videoRows}</ul>
    </section>

    <section class="grid">
      <div><h2>评论片段</h2><ul>${commentRows}</ul></div>
      <div><h2>视频弹幕片段</h2><ul>${danmuRows}</ul></div>
    </section>

    <section>
      <h2>直播弹幕片段</h2>
      <ul>${liveDanmuRows}</ul>
    </section>
  </div></body></html>`;
}
