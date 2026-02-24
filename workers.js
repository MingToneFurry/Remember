const MAX_UPLOAD_SIZE = 512 * 1024 * 1024; // 512MB
const MAX_RECENT = 50;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "DENY");
  return new Response(JSON.stringify(data), { status, headers });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self';",
  );
  return new Response(html, { status, headers });
}

function normalizeUid(input) {
  const uid = String(input ?? "").trim();
  if (!/^\d{1,20}$/.test(uid)) return null;
  return uid;
}

function safeText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function randomId(prefix = "id") {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return `${prefix}_${Array.from(arr, (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET) {
    return { ok: false, reason: "TURNSTILE_SECRET 未配置" };
  }
  if (!token) {
    return { ok: false, reason: "缺少 Turnstile token" };
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const formData = new FormData();
  formData.append("secret", env.TURNSTILE_SECRET);
  formData.append("response", token);
  if (ip) formData.append("remoteip", ip);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: formData,
  });
  if (!resp.ok) {
    return { ok: false, reason: `Turnstile 上游失败(${resp.status})` };
  }
  const data = await resp.json();
  if (!data.success) {
    return { ok: false, reason: "Turnstile 校验失败", details: data["error-codes"] ?? [] };
  }
  return { ok: true };
}

function homepageHtml(siteKey) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Remember · 记忆存档</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: "Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
      background: linear-gradient(180deg,#f7f9fc,#eef2f7);
      color: #1e2430;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 28px 16px 64px; }
    .hero, .card { background: rgba(255,255,255,.9); border: 1px solid #dfe5ef; border-radius: 16px; padding: 20px; }
    .hero h1 { margin: 0 0 8px; font-size: 1.8rem; }
    .muted { color: #5f6d83; }
    .grid { display: grid; gap: 16px; margin-top: 16px; }
    .input-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; }
    input, button { border-radius: 10px; border: 1px solid #ccd5e3; font-size: 1rem; padding: 10px 12px; }
    button { background: #2f5bda; color: #fff; border-color: #2f5bda; cursor: pointer; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    ul { margin: 0; padding-left: 18px; }
    .recent-item { margin: 10px 0; }
    .error { color: #b42318; }
    .ok { color: #067647; }
  </style>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
  <main class="container">
    <section class="hero">
      <h1>记忆存档</h1>
      <p class="muted">输入 UID，生成专属纪念页。写接口受 Cloudflare Turnstile 保护；公共页面可缓存加速。</p>
      <div class="grid">
        <div>
          <label for="uid">UID</label>
          <div class="input-row">
            <input id="uid" type="text" inputmode="numeric" placeholder="例如：123456" maxlength="20" />
            <button id="generate-btn" type="button">生成专属页</button>
          </div>
        </div>
        <div class="cf-turnstile" data-sitekey="${safeText(siteKey)}"></div>
        <p id="status" class="muted">等待提交…</p>
      </div>
    </section>

    <section class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">最近生成</h2>
      <p class="muted">按时间倒序展示最近生成的页面。</p>
      <ul id="recent-list"><li class="muted">加载中…</li></ul>
    </section>
  </main>

  <script>
    async function loadRecent() {
      const list = document.getElementById('recent-list');
      try {
        const resp = await fetch('/api/recent', { headers: { 'accept': 'application/json' } });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'recent failed');
        if (!Array.isArray(data.items) || data.items.length === 0) {
          list.innerHTML = '<li class="muted">暂无记录</li>';
          return;
        }
        list.innerHTML = data.items.map(item => {
          const uid = String(item.uid || '');
          const created = new Date(item.createdAt || Date.now()).toLocaleString();
          return '<li class="recent-item"><a href="/u/' + encodeURIComponent(uid) + '">UID ' + uid + '</a> · <span class="muted">' + created + '</span></li>';
        }).join('');
      } catch (err) {
        list.innerHTML = '<li class="error">最近列表加载失败</li>';
      }
    }

    async function generatePage() {
      const uid = document.getElementById('uid').value.trim();
      const statusEl = document.getElementById('status');
      const btn = document.getElementById('generate-btn');
      const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
      const turnstileToken = tokenInput ? tokenInput.value : '';
      btn.disabled = true;
      statusEl.className = 'muted';
      statusEl.textContent = '正在提交…';
      try {
        const resp = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uid, turnstileToken })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '生成失败');
        statusEl.className = 'ok';
        statusEl.textContent = '生成完成，即将跳转…';
        await loadRecent();
        location.href = data.url;
      } catch (err) {
        statusEl.className = 'error';
        statusEl.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    }

    document.getElementById('generate-btn').addEventListener('click', generatePage);
    loadRecent();
  </script>
</body>
</html>`;
}

async function getRecent(env) {
  const raw = await env.REMEMBER_KV.get("recent:index");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function saveRecent(env, item) {
  const existing = await getRecent(env);
  const withoutUid = existing.filter((v) => v.uid !== item.uid);
  const merged = [item, ...withoutUid].slice(0, MAX_RECENT);
  await env.REMEMBER_KV.put("recent:index", JSON.stringify(merged));
}

async function buildMemorialPage(uid, uploadedItems = []) {
  const rows = uploadedItems.length
    ? uploadedItems
        .map(
          (it) => `<tr><td>${safeText(it.fileName)}</td><td>${safeText(it.size)}</td><td>${safeText(it.mime || "application/octet-stream")}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="3">暂无用户上传数据，后续可通过上传接口补充。</td></tr>';

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>UID ${safeText(uid)} · 纪念页</title>
<style>
body{margin:0;padding:24px;background:#f4f6fb;color:#1f2735;font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;}
.card{max-width:900px;margin:0 auto;background:#fff;border:1px solid #dee4ef;border-radius:16px;padding:22px;}
h1{margin:0 0 8px;} .muted{color:#5f6d83;} table{width:100%;border-collapse:collapse;margin-top:14px;} th,td{padding:10px;border-bottom:1px solid #e6ebf3;text-align:left;}
</style></head>
<body><article class="card">
<h1>UID ${safeText(uid)} 的纪念页</h1>
<p class="muted">此页面由用户提交请求生成。若涉及权益，请联系管理员申请移除。</p>
<h2>已上传的数据摘要</h2>
<table><thead><tr><th>文件名</th><th>大小(字节)</th><th>MIME</th></tr></thead><tbody>${rows}</tbody></table>
</article></body></html>`;
}

async function handleGenerate(request, env) {
  const payload = await request.json().catch(() => ({}));
  const uid = normalizeUid(payload.uid);
  if (!uid) {
    return jsonResponse({ error: "uid 不合法" }, 400, { "cache-control": "no-store" });
  }

  const turn = await verifyTurnstile(request, env, payload.turnstileToken);
  if (!turn.ok) {
    return jsonResponse({ error: turn.reason, details: turn.details ?? [] }, 403, { "cache-control": "no-store" });
  }

  const uploads = await env.REMEMBER_KV.get(`uploads:index:${uid}`, "json").catch(() => []);
  const html = await buildMemorialPage(uid, Array.isArray(uploads) ? uploads : []);
  await env.REMEMBER_DATA.put(`pages/${uid}.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  const item = { uid, createdAt: Date.now() };
  await env.REMEMBER_KV.put(`page:meta:${uid}`, JSON.stringify(item));
  await saveRecent(env, item);

  return jsonResponse({ ok: true, url: `/u/${uid}` }, 200, { "cache-control": "no-store" });
}

async function handleUploadInit(request, env) {
  const payload = await request.json().catch(() => ({}));
  const uid = normalizeUid(payload.uid);
  if (!uid) return jsonResponse({ error: "uid 不合法" }, 400, { "cache-control": "no-store" });

  const size = Number(payload.size ?? 0);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_SIZE) {
    return jsonResponse({ error: `文件大小超限，最大 ${MAX_UPLOAD_SIZE} 字节` }, 400, { "cache-control": "no-store" });
  }

  const turn = await verifyTurnstile(request, env, payload.turnstileToken);
  if (!turn.ok) {
    return jsonResponse({ error: turn.reason, details: turn.details ?? [] }, 403, { "cache-control": "no-store" });
  }

  const uploadId = randomId("upload");
  const sessionToken = randomId("sess");
  const fileName = String(payload.fileName ?? "data.bin").slice(0, 200);
  const mime = String(payload.mime ?? "application/octet-stream").slice(0, 120);

  const key = `uploads/${uid}/${uploadId}/${fileName}`;
  const upload = await env.REMEMBER_DATA.createMultipartUpload(key, {
    httpMetadata: { contentType: mime },
    customMetadata: { uid, fileName, size: String(size) },
  });

  await env.REMEMBER_KV.put(
    `upload:session:${uid}:${upload.uploadId}`,
    JSON.stringify({ uid, uploadId, key, fileName, mime, size, createdAt: Date.now(), sessionToken }),
    { expirationTtl: 60 * 60 * 24 },
  );

  return jsonResponse(
    {
      ok: true,
      uid,
      uploadId: upload.uploadId,
      clientUploadId: uploadId,
      sessionToken,
      maxPartSizeHint: 8 * 1024 * 1024,
    },
    200,
    { "cache-control": "no-store" },
  );
}

async function getUploadSession(env, uid, uploadId) {
  return env.REMEMBER_KV.get(`upload:session:${uid}:${uploadId}`, "json");
}

async function handleUploadPart(request, env, url) {
  const uid = normalizeUid(url.searchParams.get("uid"));
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const partNumber = Number(url.searchParams.get("partNumber") ?? 0);
  const sessionToken = request.headers.get("x-upload-session-token") ?? "";

  if (!uid || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return jsonResponse({ error: "参数不合法" }, 400, { "cache-control": "no-store" });
  }

  const session = await getUploadSession(env, uid, uploadId);
  if (!session || session.sessionToken !== sessionToken) {
    return jsonResponse({ error: "上传会话无效" }, 403, { "cache-control": "no-store" });
  }

  const multipart = env.REMEMBER_DATA.resumeMultipartUpload(session.key, uploadId);
  const part = await multipart.uploadPart(partNumber, request.body);
  return jsonResponse({ ok: true, partNumber, etag: part.etag }, 200, { "cache-control": "no-store" });
}

async function handleUploadComplete(request, env) {
  const payload = await request.json().catch(() => ({}));
  const uid = normalizeUid(payload.uid);
  const uploadId = String(payload.uploadId ?? "");
  const sessionToken = String(payload.sessionToken ?? "");
  const parts = Array.isArray(payload.parts) ? payload.parts : [];

  if (!uid || !uploadId || !sessionToken || parts.length === 0) {
    return jsonResponse({ error: "参数不完整" }, 400, { "cache-control": "no-store" });
  }

  const turn = await verifyTurnstile(request, env, payload.turnstileToken);
  if (!turn.ok) {
    return jsonResponse({ error: turn.reason, details: turn.details ?? [] }, 403, { "cache-control": "no-store" });
  }

  const session = await getUploadSession(env, uid, uploadId);
  if (!session || session.sessionToken !== sessionToken) {
    return jsonResponse({ error: "上传会话无效" }, 403, { "cache-control": "no-store" });
  }

  const multipart = env.REMEMBER_DATA.resumeMultipartUpload(session.key, uploadId);
  await multipart.complete(
    parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })),
  );

  const item = {
    uploadId,
    key: session.key,
    fileName: session.fileName,
    mime: session.mime,
    size: session.size,
    createdAt: Date.now(),
  };
  const indexKey = `uploads:index:${uid}`;
  const current = (await env.REMEMBER_KV.get(indexKey, "json").catch(() => [])) || [];
  const merged = [...current, item].slice(-100);
  await env.REMEMBER_KV.put(indexKey, JSON.stringify(merged));
  await env.REMEMBER_KV.delete(`upload:session:${uid}:${uploadId}`);

  return jsonResponse({ ok: true, item }, 200, { "cache-control": "no-store" });
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/") {
    return htmlResponse(homepageHtml(env.TURNSTILE_SITE_KEY ?? ""), 200, {
      "cache-control": "public, s-maxage=1800, stale-while-revalidate=86400",
    });
  }

  if (request.method === "GET" && path.startsWith("/u/")) {
    const uid = normalizeUid(path.slice(3));
    if (!uid) return htmlResponse("<h1>404</h1>", 404, { "cache-control": "no-store" });

    const obj = await env.REMEMBER_DATA.get(`pages/${uid}.html`);
    if (!obj) return htmlResponse("<h1>404</h1><p>页面不存在</p>", 404, { "cache-control": "no-store" });

    return new Response(await obj.text(), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (request.method === "GET" && path === "/api/recent") {
    const items = await getRecent(env);
    return jsonResponse({ items }, 200, {
      "cache-control": "public, s-maxage=60, stale-while-revalidate=120",
    });
  }

  if (request.method === "POST" && path === "/api/generate") {
    return handleGenerate(request, env);
  }

  if (request.method === "POST" && path === "/api/upload/init") {
    return handleUploadInit(request, env);
  }

  if (request.method === "PUT" && path === "/api/upload/part") {
    return handleUploadPart(request, env, url);
  }

  if (request.method === "POST" && path === "/api/upload/complete") {
    return handleUploadComplete(request, env);
  }

  return jsonResponse({ error: "Not Found" }, 404, { "cache-control": "no-store" });
}

export default {
  async fetch(request, env) {
    return handleFetch(request, env);
  },
};
