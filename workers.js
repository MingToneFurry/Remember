const DOMAIN = "https://rem.furry.ist";
const MAX_UPLOAD_SIZE = 300 * 1024 * 1024;
const PART_SIZE_HINT = 8 * 1024 * 1024;
const MAX_PARTS = 10000;
const MAX_RECENT = 50;
const UID_COOLDOWN_SECONDS = 2 * 60 * 60;

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function corsHeaders(origin) {
  if (!origin) return {};
  if (origin === DOMAIN || origin === "https://www.rem.furry.ist") {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
      "access-control-allow-headers": "content-type,x-upload-token,x-upload-session-token",
      "access-control-max-age": "86400",
      vary: "Origin",
    };
  }
  return {};
}

function securityHeaders(base = {}) {
  const h = new Headers(base);
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", "geolocation=(), microphone=(), camera=()");
  return h;
}

function jsonResponse(data, status = 200, headers = {}) {
  const h = securityHeaders(headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function htmlResponse(html, status = 200, headers = {}) {
  const h = securityHeaders(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self';",
  );
  return new Response(html, { status, headers: h });
}

function normalizeUid(input) {
  const uid = String(input ?? "").trim();
  return /^\d{1,20}$/.test(uid) ? uid : null;
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
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Array.from(arr, (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

async function sha256Text(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function issueSignedToken(env, payload, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const fullPayload = { ...payload, exp };
  const body = btoa(JSON.stringify(fullPayload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const sig = await sha256Text(`${body}.${env.TOKEN_SIGNING_SECRET}`);
  return `${body}.${sig}`;
}

async function verifySignedToken(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".", 2);
  const expected = await sha256Text(`${body}.${env.TOKEN_SIGNING_SECRET}`);
  if (expected !== sig) return null;

  try {
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function verifyTurnstile(request, env, token) {
  if (!token) throw new HttpError(403, "缺少 Turnstile token");
  if (!env.TURNSTILE_SECRET) throw new HttpError(500, "服务端 Turnstile 密钥未配置");
  const fd = new FormData();
  fd.append("secret", env.TURNSTILE_SECRET);
  fd.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) fd.append("remoteip", ip);
  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: fd });
  if (!resp.ok) throw new HttpError(502, "Turnstile 校验服务异常");
  const data = await resp.json();
  if (!data.success) throw new HttpError(403, "Turnstile 校验失败", data["error-codes"] ?? []);
}

async function enforceIpRateLimit(env, request, scope, maxPerDay) {
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:ip:${scope}:${ip}:${day}`;
  const current = Number((await env.REMEMBER_KV.get(key)) || "0") + 1;
  await env.REMEMBER_KV.put(key, String(current), { expirationTtl: 2 * 24 * 3600 });
  if (current > maxPerDay) throw new HttpError(429, "请求过于频繁，请明天再试");
}

function requireAdminAccess(request) {
  const email = request.headers.get("cf-access-authenticated-user-email");
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!email || !jwt) throw new HttpError(403, "需要 Cloudflare Access");
}

function homepageHtml(siteKey) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Remember</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;background:#f5f7fb;padding:20px}.box{max-width:960px;margin:0 auto;background:#fff;border:1px solid #dfe6f3;border-radius:12px;padding:16px}input,button{padding:10px;border-radius:8px;border:1px solid #c8d3e5}button{background:#2056d8;color:#fff;cursor:pointer}ul{padding-left:18px}</style>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body><div class="box"><h1>rem.furry.ist 纪念页</h1><p>输入 UID 生成专属页面，上传数据后可增强页面内容。</p>
  <input id="uid" inputmode="numeric" maxlength="20" placeholder="UID"/><button id="gen">生成页面</button><div class="cf-turnstile" data-sitekey="${safeText(siteKey)}"></div><p id="status"></p>
  <h2>最近生成</h2><ul id="recent"></ul></div>
  <script>
  async function loadRecent(){const r=await fetch('/api/recent');const d=await r.json();const ul=document.getElementById('recent');ul.innerHTML=(d.items||[]).map(i=>'<li><a href="/u/'+encodeURIComponent(i.uid)+'">UID '+i.uid+'</a> · '+new Date(i.createdAt).toLocaleString()+'</li>').join('')||'<li>暂无</li>';}
  async function gen(){const uid=document.getElementById('uid').value.trim();const token=window.turnstile?.getResponse();const s=document.getElementById('status');s.textContent='处理中...';const r=await fetch('/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uid,turnstileToken:token})});const d=await r.json();if(!r.ok){s.textContent=d.error||'失败';return;}s.textContent='任务已提交';const jobId=d.jobId;for(let i=0;i<90;i++){await new Promise(x=>setTimeout(x,1500));const jr=await fetch('/api/job/'+encodeURIComponent(jobId));const jd=await jr.json();if(jd.status==='succeeded'){location.href=jd.url;return;}if(jd.status==='failed'){s.textContent='失败:'+jd.error;return;}}s.textContent='任务超时';}
  document.getElementById('gen').onclick=gen;loadRecent();
  </script></body></html>`;
}

async function getRecent(env) {
  return (await env.REMEMBER_KV.get("recent:list", "json")) || [];
}

async function saveRecent(env, item) {
  const current = await getRecent(env);
  const merged = [item, ...current.filter((v) => v.uid !== item.uid)].slice(0, MAX_RECENT);
  await env.REMEMBER_KV.put("recent:list", JSON.stringify(merged));
}

function buildPage(uid, snapshot) {
  const uploaded = Array.isArray(snapshot?.uploads) ? snapshot.uploads : [];
  const rows = uploaded.length
    ? uploaded.map((u) => `<tr><td>${safeText(u.fileName)}</td><td>${safeText(u.size)}</td><td>${safeText(u.mime)}</td></tr>`).join("")
    : '<tr><td colspan="3">暂无上传数据</td></tr>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>UID ${safeText(uid)} 纪念页</title><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{font-family:system-ui;background:#f4f6fb;padding:20px}.card{max-width:900px;margin:0 auto;background:#fff;border:1px solid #dce4f2;border-radius:12px;padding:16px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ecf1f8;padding:8px;text-align:left}</style></head><body><div class="card"><h1>UID ${safeText(uid)} 纪念页</h1><p>页面已生成于 ${new Date(snapshot.createdAt).toLocaleString()}</p><h2>上传数据</h2><table><thead><tr><th>文件名</th><th>大小</th><th>MIME</th></tr></thead><tbody>${rows}</tbody></table></div></body></html>`;
}

async function processGenerateJob(env, jobId) {
  const jobKey = `job:${jobId}`;
  const job = await env.REMEMBER_KV.get(jobKey, "json");
  if (!job || job.status !== "pending") return;
  job.status = "running";
  await env.REMEMBER_KV.put(jobKey, JSON.stringify(job), { expirationTtl: 3600 });
  try {
    const uploads = (await env.REMEMBER_KV.get(`uploads:index:${job.uid}`, "json")) || [];
    const snapshot = { uid: job.uid, uploads, createdAt: Date.now() };
    const html = buildPage(job.uid, snapshot);
    await env.REMEMBER_DATA.put(`pages/${job.uid}.html`, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    await env.REMEMBER_DATA.put(`snapshots/${job.uid}/${jobId}.json`, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" } });
    const item = { uid: job.uid, createdAt: Date.now(), url: `/u/${job.uid}` };
    await env.REMEMBER_KV.put(`meta:uid:${job.uid}`, JSON.stringify(item));
    await saveRecent(env, item);
    job.status = "succeeded";
    job.url = item.url;
    await env.REMEMBER_KV.put(jobKey, JSON.stringify(job), { expirationTtl: 86400 });
  } catch (err) {
    job.status = "failed";
    job.error = String(err?.message || err);
    await env.REMEMBER_KV.put(jobKey, JSON.stringify(job), { expirationTtl: 86400 });
  }
}

async function handleProxy(request, env, url) {
  await enforceIpRateLimit(env, request, "proxy", 60);
  const source = url.pathname.split("/").pop();
  const uid = normalizeUid(url.searchParams.get("uid"));
  const bvid = String(url.searchParams.get("bvid") || "").trim();
  if (!["allVid", "comment", "vidInfo"].includes(source)) throw new HttpError(400, "source 不合法");
  if (!uid && !bvid) throw new HttpError(400, "缺少 uid/bvid 参数");

  let upstream;
  if (source === "allVid") {
    if (!uid) throw new HttpError(400, "allVid 需要 uid");
    const pn = Math.max(1, Math.min(200, Number(url.searchParams.get("pn") || "1")));
    upstream = `https://uapis.cn/api/v1/social/bilibili/archives?mid=${uid}&ps=50&pn=${pn}`;
  } else if (source === "comment") {
    const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page") || "1")));
    if (!bvid || !/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new HttpError(400, "comment 需要合法 bvid");
    upstream = `https://uapis.cn/api/v1/social/bilibili/replies?bvid=${encodeURIComponent(bvid)}&pn=${page}`;
  } else {
    if (!bvid || !/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new HttpError(400, "vidInfo 需要合法 bvid");
    upstream = `https://uapis.cn/api/v1/social/bilibili/view?bvid=${encodeURIComponent(bvid)}`;
  }

  const r = await fetch(upstream, { cf: { cacheTtl: 0, cacheEverything: false } });
  const text = await r.text();

  // Merge existing security headers with CORS headers and Vary: Origin
  const baseHeaders = securityHeaders({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  const headers = new Headers(baseHeaders);

  const origin = request.headers.get("Origin");
  // Only allow configured domain to access this proxy
  if (origin && origin === DOMAIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    // If the proxy relies on cookies or auth, this allows them to be sent
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  // Ensure Vary includes Origin (without dropping any existing Vary values)
  const existingVary = headers.get("Vary");
  if (existingVary) {
    if (!existingVary.split(",").map(v => v.trim().toLowerCase()).includes("origin")) {
      headers.set("Vary", existingVary + ", Origin");
    }
  } else {
    headers.set("Vary", "Origin");
  }

  return new Response(text, { status: r.status, headers });
}

async function handleUploadInit(request, env) {
  const body = await request.json().catch(() => ({}));
  const uid = normalizeUid(body.uid);
  if (!uid) throw new HttpError(400, "uid 不合法");
  const size = Number(body.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_SIZE) throw new HttpError(400, "上传大小不合法");
  await verifyTurnstile(request, env, body.turnstileToken);
  await enforceIpRateLimit(env, request, "upload-init", 20);

  const fileName = String(body.fileName || "data.bin").slice(0, 200);
  const mime = String(body.mime || "application/octet-stream").slice(0, 120);
  const objectPath = `raw/${new Date().toISOString().slice(0, 10)}/${uid}/${randomId("upload")}-${fileName}`;
  const upload = await env.REMEMBER_DATA.createMultipartUpload(objectPath, { httpMetadata: { contentType: mime } });
  const token = await issueSignedToken(env, { uid, uploadId: upload.uploadId }, 24 * 3600);
  await env.REMEMBER_KV.put(`upload:${upload.uploadId}`, JSON.stringify({ uid, key: objectPath, fileName, mime, size, createdAt: Date.now() }), { expirationTtl: 24 * 3600 });
  return jsonResponse({ ok: true, uid, uploadId: upload.uploadId, uploadToken: token, maxPartSizeHint: PART_SIZE_HINT }, 200, { "cache-control": "no-store" });
}

async function handleUploadPart(request, env, url) {
  const uploadId = String(url.searchParams.get("uploadId") || "");
  const partNumber = Number(url.searchParams.get("partNumber") || "0");
  if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) throw new HttpError(400, "参数不合法");
  const token = request.headers.get("x-upload-token") || request.headers.get("x-upload-session-token") || "";
  const payload = await verifySignedToken(env, token);
  if (!payload || payload.uploadId !== uploadId) throw new HttpError(403, "上传令牌无效");
  const session = await env.REMEMBER_KV.get(`upload:${uploadId}`, "json");
  if (!session || session.uid !== payload.uid) throw new HttpError(403, "上传会话无效");
  const multipart = env.REMEMBER_DATA.resumeMultipartUpload(session.key, uploadId);
  const p = await multipart.uploadPart(partNumber, request.body);
  return jsonResponse({ ok: true, partNumber, etag: p.etag }, 200, { "cache-control": "no-store" });
}

async function handleUploadComplete(request, env) {
  const body = await request.json().catch(() => ({}));
  const uploadId = String(body.uploadId || "");
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (!uploadId || parts.length === 0) throw new HttpError(400, "参数不完整");
  await verifyTurnstile(request, env, body.turnstileToken);
  const payload = await verifySignedToken(env, body.uploadToken || body.sessionToken || "");
  if (!payload || payload.uploadId !== uploadId) throw new HttpError(403, "上传令牌无效");
  const session = await env.REMEMBER_KV.get(`upload:${uploadId}`, "json");
  if (!session) throw new HttpError(404, "上传会话不存在");

  const multipart = env.REMEMBER_DATA.resumeMultipartUpload(session.key, uploadId);
  await multipart.complete(parts.map((x) => ({ partNumber: Number(x.partNumber), etag: String(x.etag) })));
  const idxKey = `uploads:index:${session.uid}`;
  const list = (await env.REMEMBER_KV.get(idxKey, "json")) || [];
  list.push({ uploadId, key: session.key, fileName: session.fileName, mime: session.mime, size: session.size, createdAt: Date.now() });
  await env.REMEMBER_KV.put(idxKey, JSON.stringify(list.slice(-200)));
  await env.REMEMBER_KV.delete(`upload:${uploadId}`);
  return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
}

async function handleGenerate(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const uid = normalizeUid(body.uid);
  if (!uid) throw new HttpError(400, "uid 不合法");
  await verifyTurnstile(request, env, body.turnstileToken);
  await enforceIpRateLimit(env, request, "generate", 5);

  const cooldownKey = `cooldown:uid:${uid}`;
  const existingCooldown = await env.REMEMBER_KV.get(cooldownKey);
  if (existingCooldown) throw new HttpError(429, "该 UID 处于冷却期，请稍后重试");
  await env.REMEMBER_KV.put(cooldownKey, "1", { expirationTtl: UID_COOLDOWN_SECONDS });

  const jobId = randomId("job");
  await env.REMEMBER_KV.put(`job:${jobId}`, JSON.stringify({ jobId, uid, status: "pending", createdAt: Date.now() }), { expirationTtl: 3600 });
  ctx.waitUntil(processGenerateJob(env, jobId));
  return jsonResponse({ ok: true, jobId }, 202, { "cache-control": "no-store" });
}

async function handleJob(env, jobId) {
  const job = await env.REMEMBER_KV.get(`job:${jobId}`, "json");
  if (!job) throw new HttpError(404, "任务不存在");
  return jsonResponse(job, 200, { "cache-control": "no-store" });
}

async function handleRemovalCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  const uid = normalizeUid(body.uid);
  if (!uid) throw new HttpError(400, "uid 不合法");
  await verifyTurnstile(request, env, body.turnstileToken);
  const id = randomId("rr");
  const code = randomId("code");
  await env.REMEMBER_KV.put(`removal:req:${id}`, JSON.stringify({ id, uid, reason: String(body.reason || "").slice(0, 1000), status: "pending", code, createdAt: Date.now() }));
  return jsonResponse({ ok: true, id, queryCode: code }, 200, { "cache-control": "no-store" });
}

async function handleRemovalGet(env, url) {
  const parts = url.pathname.split("/");
  const id = parts[parts.length - 1];
  const code = String(url.searchParams.get("code") || "");
  const req = await env.REMEMBER_KV.get(`removal:req:${id}`, "json");
  if (!req || req.code !== code) throw new HttpError(403, "查询码错误");
  return jsonResponse({ id: req.id, uid: req.uid, status: req.status, createdAt: req.createdAt }, 200, { "cache-control": "no-store" });
}

async function handleAdmin(request, env, url, ctx) {
  requireAdminAccess(request);
  if (request.method === "GET" && url.pathname === "/admin") {
    return htmlResponse("<h1>Admin</h1><p>可通过 /api/admin/* 使用管理接口。</p>", 200, { "cache-control": "no-store" });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/requests") {
    const status = String(url.searchParams.get("status") || "pending");
    const list = await env.REMEMBER_KV.list({ prefix: "removal:req:" });
    const out = [];
    for (const k of list.keys) {
      const v = await env.REMEMBER_KV.get(k.name, "json");
      if (v && (!status || v.status === status)) out.push({ id: v.id, uid: v.uid, status: v.status, createdAt: v.createdAt });
    }
    return jsonResponse({ items: out }, 200, { "cache-control": "no-store" });
  }
  const reqMatch = url.pathname.match(/^\/api\/admin\/requests\/([^/]+)\/(approve|reject)$/);
  if (request.method === "POST" && reqMatch) {
    const id = reqMatch[1];
    const action = reqMatch[2];
    const key = `removal:req:${id}`;
    const reqObj = await env.REMEMBER_KV.get(key, "json");
    if (!reqObj) throw new HttpError(404, "申请不存在");
    reqObj.status = action === "approve" ? "approved" : "rejected";
    await env.REMEMBER_KV.put(key, JSON.stringify(reqObj));
    if (action === "approve") {
      await env.REMEMBER_DATA.delete(`pages/${reqObj.uid}.html`);
      await env.REMEMBER_KV.delete(`meta:uid:${reqObj.uid}`);
    }
    return jsonResponse({ ok: true, status: reqObj.status }, 200, { "cache-control": "no-store" });
  }
  const unpublishMatch = url.pathname.match(/^\/api\/admin\/pages\/([^/]+)\/unpublish$/);
  if (request.method === "POST" && unpublishMatch) {
    const uid = normalizeUid(unpublishMatch[1]);
    if (!uid) throw new HttpError(400, "uid 不合法");
    await env.REMEMBER_DATA.delete(`pages/${uid}.html`);
    await env.REMEMBER_KV.delete(`meta:uid:${uid}`);
    return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
  }
  const regenMatch = url.pathname.match(/^\/api\/admin\/pages\/([^/]+)\/regenerate$/);
  if (request.method === "POST" && regenMatch) {
    const uid = normalizeUid(regenMatch[1]);
    if (!uid) throw new HttpError(400, "uid 不合法");
    const jobId = randomId("job");
    await env.REMEMBER_KV.put(`job:${jobId}`, JSON.stringify({ jobId, uid, status: "pending", createdAt: Date.now() }), { expirationTtl: 3600 });
    ctx.waitUntil(processGenerateJob(env, jobId));
    return jsonResponse({ ok: true, jobId }, 202, { "cache-control": "no-store" });
  }
  throw new HttpError(404, "admin route not found");
}

async function sitemapXml(env) {
  const list = await env.REMEMBER_KV.list({ prefix: "meta:uid:" });
  const urls = [];
  for (const item of list.keys) {
    const uid = item.name.slice("meta:uid:".length);
    if (normalizeUid(uid)) urls.push(`<url><loc>${DOMAIN}/u/${uid}</loc></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${DOMAIN}/</loc></url>${urls.join("")}</urlset>`;
}

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const cors = corsHeaders(request.headers.get("origin"));

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    if (request.method === "GET" && path === "/") return htmlResponse(homepageHtml(env.TURNSTILE_SITE_KEY || ""), 200, { ...cors, "cache-control": "public, s-maxage=300" });
    if (request.method === "GET" && path === "/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: https://rem.furry.ist/sitemap.xml\n", { headers: { ...cors, "content-type": "text/plain; charset=utf-8", "cache-control": "public, s-maxage=86400" } });
    if (request.method === "GET" && path === "/sitemap.xml") return new Response(await sitemapXml(env), { headers: { ...cors, "content-type": "application/xml; charset=utf-8", "cache-control": "public, s-maxage=3600" } });

    if (request.method === "GET" && path.startsWith("/u/")) {
      const uid = normalizeUid(path.slice(3));
      if (!uid) throw new HttpError(404, "not found");
      const obj = await env.REMEMBER_DATA.get(`pages/${uid}.html`);
      if (!obj) throw new HttpError(404, "not found");
      return new Response(await obj.text(), { headers: { ...cors, "content-type": "text/html; charset=utf-8", "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800" } });
    }

    if (request.method === "GET" && path === "/api/recent") return jsonResponse({ items: await getRecent(env) }, 200, { ...cors, "cache-control": "public, s-maxage=60" });
    if (request.method === "GET" && path.startsWith("/api/proxy/")) return handleProxy(request, env, url);
    if (request.method === "POST" && path === "/api/upload/init") return handleUploadInit(request, env);
    if (request.method === "PUT" && path === "/api/upload/part") return handleUploadPart(request, env, url);
    if (request.method === "POST" && path === "/api/upload/complete") return handleUploadComplete(request, env);
    if (request.method === "POST" && path === "/api/generate") return handleGenerate(request, env, ctx);
    if (request.method === "GET" && path.startsWith("/api/job/")) return handleJob(env, path.split("/").pop());
    if (request.method === "POST" && path === "/api/removal-requests") return handleRemovalCreate(request, env);
    if (request.method === "GET" && path.startsWith("/api/removal-requests/")) return handleRemovalGet(env, url);
    if (path === "/admin" || path.startsWith("/api/admin/")) return handleAdmin(request, env, url, ctx);

    throw new HttpError(404, "Not Found");
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse({ error: err.message, details: err.details || [] }, err.status, { ...cors, "cache-control": "no-store" });
    return jsonResponse({ error: "Internal Error", details: [String(err?.message || err)] }, 500, { ...cors, "cache-control": "no-store" });
  }
}

async function handleScheduled(event, env) {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

  let r2Cursor = undefined;
  do {
    const list = await env.REMEMBER_DATA.list({ prefix: "raw/", cursor: r2Cursor });
    for (const obj of list.objects) {
      if (obj.uploaded.getTime() < sevenDaysAgo) {
        await env.REMEMBER_DATA.delete(obj.key);
      }
    }
    r2Cursor = list.truncated ? list.cursor : undefined;
  } while (r2Cursor);

  let kvCursor = undefined;
  do {
    const kvUploads = await env.REMEMBER_KV.list({ prefix: "upload:", cursor: kvCursor });
    for (const key of kvUploads.keys) {
      const v = await env.REMEMBER_KV.get(key.name, "json");
      if (v && v.createdAt && now - v.createdAt > 24 * 3600 * 1000) {
        await env.REMEMBER_KV.delete(key.name);
      }
    }
    kvCursor = kvUploads.list_complete ? undefined : kvUploads.cursor;
  } while (kvCursor);
}

export default {
  fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
