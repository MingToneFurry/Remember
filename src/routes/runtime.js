import { createDefaultUpstreamClient } from "../services/upstreamClient.js";
import { analyzeWithGrok } from "../services/grokAnalyzer.js";
import { syncGeneratedPageToGitHub } from "../services/githubSync.js";
import { estimateRegDateByUid, fetchAllVideosByUid, fetchPagedAicuData, fetchTopVideoInfosByPlayCount } from "../services/memorialData.js";
import { buildMemorialPage } from "../templates/memorialTemplate.js";

const DOMAIN = "https://rem.furry.ist";
const MAX_UPLOAD_SIZE = 300 * 1024 * 1024;
const PART_SIZE_HINT = 8 * 1024 * 1024;
const MAX_PARTS = 10000;
const MAX_RECENT = 50;
const MAX_ADMIN_REQUESTS_PAGE_SIZE = 200;
const MAX_SITEMAP_URLS = 50000;
const UID_COOLDOWN_SECONDS = 2 * 60 * 60;
const ACCESS_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const upstreamClient = createDefaultUpstreamClient(fetch);

function ensureSecret(value, name) {
  if (!value || typeof value !== "string" || value.length < 16) {
    throw new HttpError(500, `${name} 未配置`);
  }
}

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
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self';",
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

function parseBoundedInt(input, min, max, fallback) {
  const raw = String(input ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function decodeBase64UrlToBytes(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? "=".repeat(4 - pad) : "");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeBase64UrlToString(input) {
  return new TextDecoder().decode(decodeBase64UrlToBytes(input));
}

async function issueSignedToken(env, payload, ttlSeconds) {
  ensureSecret(env.TOKEN_SIGNING_SECRET, "TOKEN_SIGNING_SECRET");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const fullPayload = { ...payload, exp };
  const body = btoa(JSON.stringify(fullPayload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const sig = await sha256Text(`${body}.${env.TOKEN_SIGNING_SECRET}`);
  return `${body}.${sig}`;
}

async function verifySignedToken(env, token) {
  ensureSecret(env.TOKEN_SIGNING_SECRET, "TOKEN_SIGNING_SECRET");
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".", 2);
  const expected = await sha256Text(`${body}.${env.TOKEN_SIGNING_SECRET}`);
  if (!timingSafeEqual(expected, sig)) return null;

  try {
    const payload = JSON.parse(decodeBase64UrlToString(body));
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
  // 管理接口的真正鉴权应由 Cloudflare Access 在边缘强制拦截。
  // 这里仅做最小兜底检查，避免明显未保护情况下直接放行。
  const email = request.headers.get("cf-access-authenticated-user-email");
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!email || !jwt) throw new HttpError(403, "需要 Cloudflare Access");
}

const accessJwksCache = new Map();
const accessKeyCache = new Map();

function parseAccessAudienceConfig(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function accessAudMatchesClaim(claim, accepted) {
  if (!claim) return false;
  if (Array.isArray(claim)) return claim.some((v) => accepted.includes(String(v)));
  return accepted.includes(String(claim));
}

function normalizeAccessIssuer(issuer) {
  try {
    const parsed = new URL(String(issuer || ""));
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:") return null;
    if (host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com")) {
      return parsed.origin;
    }
    return null;
  } catch {
    return null;
  }
}

async function getAccessJwks(issuer) {
  const now = Date.now();
  const cached = accessJwksCache.get(issuer);
  if (cached && cached.expiresAt > now) return cached.keys;
  const certsUrl = new URL("/cdn-cgi/access/certs", `${issuer}/`);
  const resp = await fetch(certsUrl.toString(), { headers: { accept: "application/json" } });
  if (!resp.ok) throw new HttpError(403, "Cloudflare Access validation failed");
  const data = await resp.json();
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  if (keys.length === 0) throw new HttpError(403, "Cloudflare Access validation failed");
  accessJwksCache.set(issuer, { keys, expiresAt: now + ACCESS_JWKS_CACHE_TTL_MS });
  return keys;
}

async function importAccessPublicKey(jwk) {
  const cacheKey = JSON.stringify({ kid: jwk.kid, n: jwk.n, e: jwk.e, kty: jwk.kty });
  const cached = accessKeyCache.get(cacheKey);
  if (cached) return cached;
  if (jwk.kty !== "RSA") throw new HttpError(403, "Cloudflare Access validation failed");
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, key_ops: ["verify"], ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  accessKeyCache.set(cacheKey, key);
  return key;
}

async function verifyAccessJwt(env, jwt) {
  const acceptedAudiences = parseAccessAudienceConfig(env.ACCESS_AUD);
  if (acceptedAudiences.length === 0) {
    throw new HttpError(500, "ACCESS_AUD not configured");
  }
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw new HttpError(403, "Cloudflare Access required");
  const [headerPart, payloadPart, signaturePart] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64UrlToString(headerPart));
    payload = JSON.parse(decodeBase64UrlToString(payloadPart));
  } catch {
    throw new HttpError(403, "Cloudflare Access required");
  }
  if (header?.alg !== "RS256") throw new HttpError(403, "Cloudflare Access required");
  const issuer = normalizeAccessIssuer(payload?.iss);
  if (!issuer) throw new HttpError(403, "Cloudflare Access required");
  if (!accessAudMatchesClaim(payload?.aud, acceptedAudiences)) throw new HttpError(403, "Cloudflare Access required");
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload?.exp) || payload.exp <= now) throw new HttpError(403, "Cloudflare Access required");
  if (Number.isFinite(payload?.nbf) && payload.nbf > now + 60) throw new HttpError(403, "Cloudflare Access required");
  const jwks = await getAccessJwks(issuer);
  const jwk = jwks.find((k) => k.kid === header.kid) || jwks[0];
  const key = await importAccessPublicKey(jwk);
  const verified = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    decodeBase64UrlToBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!verified) throw new HttpError(403, "Cloudflare Access required");
  return payload;
}

async function requireAdminAccessVerified(request, env) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) throw new HttpError(403, "Cloudflare Access required");
  const payload = await verifyAccessJwt(env, jwt);
  const email = request.headers.get("cf-access-authenticated-user-email");
  if (email && payload?.email && email !== payload.email) {
    throw new HttpError(403, "Cloudflare Access identity mismatch");
  }
}

async function requireAdminAccessStrict(request, env) {
  await requireAdminAccessVerified(request, env);
}

function sanitizeFileName(input) {
  const raw = String(input || "data.bin").slice(0, 200);
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]+/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/\.\.+/g, ".")
    .trim();
  return cleaned || "data.bin";
}

function applyCorsToResponse(response, cors) {
  if (!cors || Object.keys(cors).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

async function getRecent(env, limit = MAX_RECENT) {
  const items = (await env.REMEMBER_KV.get("recent:list", "json")) || [];
  const max = parseBoundedInt(limit, 1, MAX_RECENT, MAX_RECENT);
  return Array.isArray(items) ? items.slice(0, max) : [];
}

async function saveRecent(env, item) {
  const current = await getRecent(env);
  const merged = [item, ...current.filter((v) => v.uid !== item.uid)].slice(0, MAX_RECENT);
  await env.REMEMBER_KV.put("recent:list", JSON.stringify(merged));
}

function buildPage(uid, snapshot) {
  return buildMemorialPage(uid, snapshot, safeText);
}

async function processGenerateJob(env, jobId) {
  const jobKey = `job:${jobId}`;
  const current = await env.REMEMBER_KV.get(jobKey, "json");
  if (!current) return;
  if (!["queued", "pending", "running"].includes(String(current.status || ""))) return;
  const uid = normalizeUid(current.uid);
  if (!uid) {
    await env.REMEMBER_KV.put(jobKey, JSON.stringify({ ...current, status: "failed", stage: "failed", error: "uid 不合法", updatedAt: Date.now() }), {
      expirationTtl: 24 * 3600,
    });
    return;
  }

  const patchJob = async (patch) => {
    const latest = (await env.REMEMBER_KV.get(jobKey, "json")) || {};
    const merged = { ...latest, ...patch, updatedAt: Date.now() };
    await env.REMEMBER_KV.put(jobKey, JSON.stringify(merged), { expirationTtl: 24 * 3600 });
    return merged;
  };

  await patchJob({ status: "running", stage: "fetching", progress: 10 });
  try {
    const uploads = (await env.REMEMBER_KV.get(`uploads:index:${uid}`, "json")) || [];
    const allVid = await fetchAllVideosByUid(upstreamClient, uid, { maxPages: 200, pageSize: 50 });
    const comments = await fetchPagedAicuData(upstreamClient, "comment", uid, { maxPages: 200, maxItems: 1000 });
    const danmu = await fetchPagedAicuData(upstreamClient, "danmu", uid, { maxPages: 200, maxItems: 1000 });
    const liveDanmu = await fetchPagedAicuData(upstreamClient, "zhibodanmu", uid, { maxPages: 200, maxItems: 500 });
    const topVideoInfos = await fetchTopVideoInfosByPlayCount(upstreamClient, allVid.videos || [], { topN: 10, concurrency: 3 });
    const regDateEstimate = estimateRegDateByUid(uid);
    const dataNotice = String(env.DATA_NOTICE || "第三方API数据可能不准确，仅供纪念参考");

    await patchJob({ stage: "analyzing", progress: 60 });
    const snapshotBase = {
      uid,
      uploads,
      createdAt: Date.now(),
      generatedAt: Date.now(),
      dataNotice,
      sourceQuality: "third-party-unstable",
      allVid,
      topVideoInfos,
      comments,
      danmu,
      liveDanmu,
      regDateEstimate,
    };
    const modelOutput = await analyzeWithGrok(env, upstreamClient, snapshotBase);
    const warnings = [];
    if (modelOutput?.source === "fallback" && modelOutput?.reason) {
      warnings.push(String(modelOutput.reason));
    }
    const snapshot = { ...snapshotBase, modelOutput };

    await patchJob({ stage: "rendering", progress: 85, warnings });
    const html = buildPage(uid, snapshot);
    await env.REMEMBER_DATA.put(`pages/${uid}.html`, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    await env.REMEMBER_DATA.put(`snapshots/${uid}/${jobId}.json`, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" } });
    const item = { uid, createdAt: Date.now(), url: `/u/${uid}` };
    await env.REMEMBER_KV.put(`meta:uid:${uid}`, JSON.stringify(item));
    await saveRecent(env, item);

    await patchJob({ stage: "syncing", progress: 95, warnings });
    const gitSync = await syncGeneratedPageToGitHub(env, { uid, html, snapshot, item });
    if (gitSync.status !== "succeeded" && gitSync.reason) {
      warnings.push(`Git 同步异常: ${gitSync.reason}`);
    }
    await patchJob({ status: "succeeded", stage: "succeeded", progress: 100, url: item.url, warnings, gitSync });
  } catch (err) {
    await patchJob({
      status: "failed",
      stage: "failed",
      error: String(err?.message || err),
      warnings: [`任务失败: ${String(err?.message || err)}`],
    });
  }
}

async function handleProxy(request, env, url) {
  await enforceIpRateLimit(env, request, "proxy", 60);
  const source = url.pathname.split("/").pop();
  const uid = normalizeUid(url.searchParams.get("uid"));
  const bvid = String(url.searchParams.get("bvid") || "").trim();
  const aid = String(url.searchParams.get("aid") || "").trim();
  if (!["allVid", "comment", "vidInfo", "danmu", "zhibodanmu"].includes(source)) throw new HttpError(400, "source 不合法");

  let upstream;
  if (source === "allVid") {
    if (!uid) throw new HttpError(400, "allVid 需要 uid");
    const pn = parseBoundedInt(url.searchParams.get("pn"), 1, 200, 1);
    upstream = `https://uapis.cn/api/v1/social/bilibili/archives?mid=${encodeURIComponent(uid)}&ps=50&pn=${pn}`;
  } else if (source === "comment") {
    if (!uid) throw new HttpError(400, "comment 需要 uid");
    const pn = parseBoundedInt(url.searchParams.get("pn") || url.searchParams.get("page"), 1, 1000, 1);
    upstream = `https://api.aicu.cc/api/v3/search/getreply?uid=${encodeURIComponent(uid)}&pn=${pn}&ps=100&mode=0`;
  } else if (source === "danmu") {
    if (!uid) throw new HttpError(400, "danmu 需要 uid");
    const pn = parseBoundedInt(url.searchParams.get("pn") || url.searchParams.get("page"), 1, 1000, 1);
    const keyword = String(url.searchParams.get("keyword") || "");
    upstream = `https://api.aicu.cc/api/v3/search/getvideodm?uid=${encodeURIComponent(uid)}&pn=${pn}&ps=100&keyword=${encodeURIComponent(keyword)}`;
  } else if (source === "zhibodanmu") {
    if (!uid) throw new HttpError(400, "zhibodanmu 需要 uid");
    const pn = parseBoundedInt(url.searchParams.get("pn") || url.searchParams.get("page"), 1, 1000, 1);
    const keyword = String(url.searchParams.get("keyword") || "");
    upstream = `https://api.aicu.cc/api/v3/search/getlivedm?uid=${encodeURIComponent(uid)}&pn=${pn}&ps=100&keyword=${encodeURIComponent(keyword)}`;
  } else {
    if (bvid && /^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      upstream = `https://uapis.cn/api/v1/social/bilibili/view?bvid=${encodeURIComponent(bvid)}`;
    } else if (/^\d+$/.test(aid)) {
      upstream = `https://uapis.cn/api/v1/social/bilibili/view?aid=${encodeURIComponent(aid)}`;
    } else {
      throw new HttpError(400, "vidInfo 需要合法 bvid 或 aid");
    }
  }

  let payload;
  try {
    const { data } = await upstreamClient.requestJson(upstream, {
      schema: (data) => {
        if (!data || typeof data !== "object") return false;
        if (source === "allVid") return Array.isArray(data.videos) || Array.isArray(data?.data?.videos) || Number.isInteger(Number(data.total || data?.data?.total || 0));
        if (source === "vidInfo") return Boolean(data.aid || data.bvid || data?.data?.aid || data?.data?.bvid);
        return Number.isFinite(Number(data.code ?? 0)) || Array.isArray(data?.data?.list);
      },
    });
    payload = data;
  } catch (err) {
    throw new HttpError(502, "上游接口请求失败", [String(err?.message || err)]);
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    payload.dataNotice = String(env.DATA_NOTICE || "第三方API数据可能不准确，仅供纪念参考");
  }
  return jsonResponse(payload, 200, { "cache-control": "no-store" });
}

async function handleUploadInit(request, env) {
  const body = await request.json().catch(() => ({}));
  const uid = normalizeUid(body.uid);
  if (!uid) throw new HttpError(400, "uid 不合法");
  const size = Number(body.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_SIZE) throw new HttpError(400, "上传大小不合法");
  await verifyTurnstile(request, env, body.turnstileToken);
  await enforceIpRateLimit(env, request, "upload-init", 20);

  const fileName = sanitizeFileName(body.fileName);
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

  const normalizedParts = parts.map((x) => ({
    partNumber: Number(x.partNumber),
    etag: String(x.etag || "").trim(),
  }));
  const seen = new Set();
  for (const part of normalizedParts) {
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > MAX_PARTS) {
      throw new HttpError(400, "分片编号不合法");
    }
    if (!part.etag) throw new HttpError(400, "分片 etag 不合法");
    if (seen.has(part.partNumber)) throw new HttpError(400, "分片编号重复");
    seen.add(part.partNumber);
  }
  normalizedParts.sort((a, b) => a.partNumber - b.partNumber);

  const multipart = env.REMEMBER_DATA.resumeMultipartUpload(session.key, uploadId);
  await multipart.complete(normalizedParts);
  const idxKey = `uploads:index:${session.uid}`;
  // NOTE: KV does not provide atomic read-modify-write. This list is best-effort.
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

  if (!env.ANALYSIS_QUEUE || typeof env.ANALYSIS_QUEUE.send !== "function") {
    throw new HttpError(500, "队列未配置");
  }

  const now = Date.now();
  const jobId = randomId("job");
  const traceId = randomId("trace");
  const job = {
    jobId,
    uid,
    status: "queued",
    stage: "queued",
    progress: 0,
    warnings: [],
    gitSync: null,
    createdAt: now,
    updatedAt: now,
  };
  await env.REMEMBER_KV.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: 24 * 3600 });
  await env.ANALYSIS_QUEUE.send(
    JSON.stringify({
      jobId,
      uid,
      requestedAt: now,
      traceId,
    }),
  );
  return jsonResponse(
    {
      ok: true,
      jobId,
      queued: true,
      stage: "queued",
      estimatedWaitSec: 15,
    },
    202,
    { "cache-control": "no-store" },
  );
}

async function handleJob(env, jobId) {
  const job = await env.REMEMBER_KV.get(`job:${jobId}`, "json");
  if (!job) throw new HttpError(404, "任务不存在");
  const normalized = {
    ...job,
    stage: String(job.stage || job.status || "unknown"),
    progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : 0,
    warnings: Array.isArray(job.warnings) ? job.warnings : [],
    gitSync: job.gitSync ?? null,
    updatedAt: Number(job.updatedAt || job.createdAt || Date.now()),
  };
  return jsonResponse(normalized, 200, { "cache-control": "no-store" });
}

async function handleRemovalCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  const uid = normalizeUid(body.uid);
  if (!uid) throw new HttpError(400, "uid 不合法");
  await verifyTurnstile(request, env, body.turnstileToken);
  const id = randomId("rr");
  const code = randomId("code");
  const reason = String(body.reason || "").slice(0, 1000).trim();
  await env.REMEMBER_KV.put(`removal:req:${id}`, JSON.stringify({ id, uid, reason, status: "pending", code, createdAt: Date.now() }));
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

async function deleteR2ByPrefix(env, prefix) {
  let cursor;
  do {
    const list = await env.REMEMBER_DATA.list({ prefix, cursor });
    await Promise.all(list.objects.map((obj) => env.REMEMBER_DATA.delete(obj.key)));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

async function deleteRawByUid(env, uid) {
  const uidPrefix = `/${uid}/`;
  let cursor;
  do {
    const list = await env.REMEMBER_DATA.list({ prefix: "raw/", cursor });
    const matches = list.objects.filter((obj) => obj.key.includes(uidPrefix)).map((obj) => obj.key);
    await Promise.all(matches.map((key) => env.REMEMBER_DATA.delete(key)));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

async function deleteUploadSessionsByUid(env, uid) {
  let cursor;
  do {
    const list = await env.REMEMBER_KV.list({ prefix: "upload:", cursor });
    const values = await Promise.all(list.keys.map((k) => env.REMEMBER_KV.get(k.name, "json")));
    const doomed = [];
    for (let i = 0; i < list.keys.length; i += 1) {
      if (values[i]?.uid === uid) doomed.push(list.keys[i].name);
    }
    await Promise.all(doomed.map((key) => env.REMEMBER_KV.delete(key)));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

async function removeUidFromRecent(env, uid) {
  const current = await getRecent(env, MAX_RECENT);
  const filtered = current.filter((item) => item.uid !== uid);
  if (filtered.length !== current.length) {
    await env.REMEMBER_KV.put("recent:list", JSON.stringify(filtered));
  }
}

async function cleanupRemovedUidData(env, uid) {
  await Promise.all([
    deleteR2ByPrefix(env, `snapshots/${uid}/`),
    deleteRawByUid(env, uid),
    deleteUploadSessionsByUid(env, uid),
  ]);
}

async function handleAdmin(request, env, url, ctx) {
  await requireAdminAccessStrict(request, env);
  if (request.method === "GET" && url.pathname === "/admin") {
    return htmlResponse("<h1>Admin</h1><p>可通过 /api/admin/* 使用管理接口。</p>", 200, { "cache-control": "no-store" });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/requests") {
    const statusParam = String(url.searchParams.get("status") || "pending").trim();
    const status = statusParam === "all" ? "" : statusParam;
    if (status && !["pending", "approved", "rejected"].includes(status)) {
      throw new HttpError(400, "invalid status");
    }
    const limit = parseBoundedInt(url.searchParams.get("limit"), 1, MAX_ADMIN_REQUESTS_PAGE_SIZE, 50);
    const cursor = String(url.searchParams.get("cursor") || "").trim() || undefined;
    const list = await env.REMEMBER_KV.list({ prefix: "removal:req:", cursor, limit });
    const values = await Promise.all(list.keys.map((k) => env.REMEMBER_KV.get(k.name, "json")));
    const out = [];
    for (const v of values) {
      if (v && (!status || v.status === status)) {
        out.push({ id: v.id, uid: v.uid, status: v.status, createdAt: v.createdAt });
      }
    }
    const nextCursor = list.list_complete ? null : list.cursor;
    return jsonResponse({ items: out, cursor: nextCursor }, 200, { "cache-control": "no-store" });
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
      const uid = normalizeUid(reqObj.uid);
      if (!uid) throw new HttpError(500, "request data invalid");
      await Promise.all([
        env.REMEMBER_DATA.delete(`pages/${uid}.html`),
        env.REMEMBER_KV.delete(`meta:uid:${uid}`),
        env.REMEMBER_KV.delete(`uploads:index:${uid}`),
        removeUidFromRecent(env, uid),
      ]);
      ctx.waitUntil(cleanupRemovedUidData(env, uid));
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
  const prefix = "meta:uid:";
  const urls = [`<url><loc>${DOMAIN}/</loc></url>`];
  let cursor;
  do {
    const list = await env.REMEMBER_KV.list({ prefix, cursor, limit: 1000 });
    for (const item of list.keys) {
      if (urls.length >= MAX_SITEMAP_URLS) break;
      const uid = item.name.slice(prefix.length);
      if (normalizeUid(uid)) urls.push(`<url><loc>${DOMAIN}/u/${uid}</loc></url>`);
    }
    if (urls.length >= MAX_SITEMAP_URLS) break;
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`;
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
      return htmlResponse(await obj.text(), 200, { ...cors, "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800" });
    }

    if (request.method === "GET" && path === "/api/recent") {
      const limit = parseBoundedInt(url.searchParams.get("limit"), 1, MAX_RECENT, MAX_RECENT);
      return jsonResponse({ items: await getRecent(env, limit) }, 200, { ...cors, "cache-control": "public, s-maxage=60" });
    }
    if (request.method === "GET" && path.startsWith("/api/proxy/")) return applyCorsToResponse(await handleProxy(request, env, url), cors);
    if (request.method === "POST" && path === "/api/upload/init") return applyCorsToResponse(await handleUploadInit(request, env), cors);
    if (request.method === "PUT" && path === "/api/upload/part") return applyCorsToResponse(await handleUploadPart(request, env, url), cors);
    if (request.method === "POST" && path === "/api/upload/complete") return applyCorsToResponse(await handleUploadComplete(request, env), cors);
    if (request.method === "POST" && path === "/api/generate") return applyCorsToResponse(await handleGenerate(request, env, ctx), cors);
    if (request.method === "GET" && path.startsWith("/api/job/")) return applyCorsToResponse(await handleJob(env, path.split("/").pop()), cors);
    if (request.method === "POST" && path === "/api/removal-requests") return applyCorsToResponse(await handleRemovalCreate(request, env), cors);
    if (request.method === "GET" && path.startsWith("/api/removal-requests/")) return applyCorsToResponse(await handleRemovalGet(env, url), cors);
    if (path === "/admin" || path.startsWith("/api/admin/")) return applyCorsToResponse(await handleAdmin(request, env, url, ctx), cors);

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

function parseQueueMessageBody(body) {
  if (typeof body === "string") return JSON.parse(body);
  if (body && typeof body.text === "function") return body.text().then((t) => JSON.parse(t));
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body));
  return JSON.parse(String(body || "{}"));
}

async function handleQueue(batch, env) {
  for (const message of batch.messages || []) {
    try {
      const payload = await parseQueueMessageBody(message.body);
      const jobId = String(payload?.jobId || "").trim();
      const uid = normalizeUid(payload?.uid);
      if (!jobId || !uid) {
        if (typeof message.ack === "function") message.ack();
        continue;
      }
      await processGenerateJob(env, jobId);
      if (typeof message.ack === "function") message.ack();
    } catch (err) {
      if (typeof message.retry === "function") {
        message.retry();
      } else if (typeof message.ack === "function") {
        message.ack();
      }
    }
  }
}

export default {
  fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
  queue(batch, env, ctx) {
    ctx.waitUntil(handleQueue(batch, env));
  },
};
