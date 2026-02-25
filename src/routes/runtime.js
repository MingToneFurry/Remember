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
const JOB_ID_REGEX = /^job_[a-f0-9]{32}$/;
const PUBLIC_ERROR_DETAIL_LIMIT = 5;
const PUBLIC_ERROR_TEXT_LIMIT = 160;
const HOT_CACHE_TTL_MS = 15 * 1000;
const SITEMAP_CACHE_KEY = "cache:sitemap:xml";
const upstreamClient = createDefaultUpstreamClient(fetch);
const hotCache = {
  recent: { expiresAt: 0, items: [] },
  sitemap: { expiresAt: 0, xml: "" },
};

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
      "access-control-allow-headers": "content-type,x-upload-token,x-upload-session-token,x-request-id",
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
   h.set("cross-origin-opener-policy", "same-origin");
   h.set("cross-origin-resource-policy", "same-site");
   h.set("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  return h;
}

function jsonResponse(data, status = 200, headers = {}) {
  const h = securityHeaders(headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function htmlResponse(html, status = 200, headers = {}, options = {}) {
  const nonce = String(options.nonce || "").trim();
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}' https://challenges.cloudflare.com` : "'self' https://challenges.cloudflare.com";
  const h = securityHeaders(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set(
    "content-security-policy",
    `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';`,
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

function normalizeJobId(input) {
  const raw = String(input || "").trim();
  return JOB_ID_REGEX.test(raw) ? raw : null;
}

function sanitizePublicDetails(details) {
  if (!Array.isArray(details)) return [];
  return details
    .filter((item) => item !== null && item !== undefined)
    .slice(0, PUBLIC_ERROR_DETAIL_LIMIT)
    .map((item) => String(item).slice(0, PUBLIC_ERROR_TEXT_LIMIT));
}

function publicErrorPayload(err, requestId = "unknown") {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      return {
        status: err.status,
        body: {
          error: "服务暂时不可用",
          details: [],
          requestId,
        },
      };
    }
    return {
      status: err.status,
      body: {
        error: err.message,
        details: sanitizePublicDetails(err.details),
      },
    };
  }

  return {
    status: 500,
    body: {
      error: "Internal Error",
      details: [],
      requestId,
    },
  };
}

function sanitizeFailureMessage(input) {
  return String(input || "unknown")
    .replace(/(token|secret|authorization)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]")
    .slice(0, 220);
}

function randomId(prefix = "id") {
  const arr = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Array.from(arr, (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function generateCspNonce() {
  const arr = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function getHotRecentCache() {
  if (hotCache.recent.expiresAt > Date.now() && Array.isArray(hotCache.recent.items)) {
    return hotCache.recent.items;
  }
  return null;
}

function setHotRecentCache(items) {
  hotCache.recent = {
    expiresAt: Date.now() + HOT_CACHE_TTL_MS,
    items: Array.isArray(items) ? items.slice(0, MAX_RECENT) : [],
  };
}

function getHotSitemapCache() {
  if (hotCache.sitemap.expiresAt > Date.now() && hotCache.sitemap.xml) return hotCache.sitemap.xml;
  return null;
}

function setHotSitemapCache(xml) {
  hotCache.sitemap = {
    expiresAt: Date.now() + HOT_CACHE_TTL_MS,
    xml: String(xml || ""),
  };
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

async function enforceIpRateLimit(env, request, scope, maxPerDay, maxPerMinute = 0) {
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const now = new Date();
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:ip:${scope}:${ip}:${day}`;
  const current = Number((await env.REMEMBER_KV.get(key)) || "0") + 1;
  await env.REMEMBER_KV.put(key, String(current), { expirationTtl: 2 * 24 * 3600 });
  if (current > maxPerDay) throw new HttpError(429, "请求过于频繁，请明天再试");
  if (maxPerMinute > 0) {
    const minute = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const minuteKey = `rl:ipm:${scope}:${ip}:${minute}`;
    const minuteCount = Number((await env.REMEMBER_KV.get(minuteKey)) || "0") + 1;
    await env.REMEMBER_KV.put(minuteKey, String(minuteCount), { expirationTtl: 2 * 3600 });
    if (minuteCount > maxPerMinute) throw new HttpError(429, "请求过于频繁，请稍后重试");
  }
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

function homepageHtml(siteKey, scriptNonce = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Remember</title>
  <style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#f4f7fc;padding:20px;color:#1f2a3d}
  .box{max-width:980px;margin:0 auto;background:#fff;border:1px solid #dbe4f4;border-radius:12px;padding:18px}
  form{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start}
  input,button{padding:10px 12px;border-radius:8px;border:1px solid #c8d4eb}
  button{background:#1c57d7;color:#fff;cursor:pointer}
  button[disabled]{opacity:.65;cursor:not-allowed}
  .full{grid-column:1 / -1}
  .hint{font-size:12px;color:#4b5f87}
  .status{margin-top:14px;padding:12px;border:1px solid #dbe4f5;border-radius:10px;background:#f8fbff}
  .bar{height:8px;background:#e8eefb;border-radius:999px;overflow:hidden;margin-top:8px}
  .bar > span{display:block;height:100%;background:#2d63d8;width:0;transition:width .2s ease}
  .warn{color:#7a4e00;margin:10px 0 0;padding-left:18px}
  .error{color:#a22121}
  ul{padding-left:18px}
  .recent{margin-top:16px}
  </style>
  <script nonce="${safeText(scriptNonce)}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body><div class="box">
  <h1>Remember 纪念页生成</h1>
  <p>输入 UID 创建异步任务。前端会先直连上游接口重试 3 次，全部失败后再走 Worker 代理。</p>
  <form id="generate-form">
    <input id="uid" inputmode="numeric" maxlength="20" placeholder="请输入 UID" autocomplete="off"/>
    <button id="submit-btn" type="submit">创建任务</button>
    <div class="cf-turnstile full" data-sitekey="${safeText(siteKey)}"></div>
    <div id="source-hint" class="hint full"></div>
  </form>
  <div id="job-status" class="status">
    <div id="status-line">等待提交任务</div>
    <div id="stage-line" class="hint">阶段: -</div>
    <div class="bar"><span id="progress-bar"></span></div>
    <ul id="warning-list" class="warn"></ul>
    <div id="error-line" class="error"></div>
  </div>
  <div class="recent"><h2>最近生成</h2><ul id="recent-list"></ul></div>
  </div>
  <script nonce="${safeText(scriptNonce)}">
  const STAGE_LABELS={queued:'排队中',fetching:'抓取数据',analyzing:'模型分析',rendering:'渲染页面',syncing:'同步产物',succeeded:'已完成',failed:'已失败'};
  const statusLine=document.getElementById('status-line');
  const stageLine=document.getElementById('stage-line');
  const progressBar=document.getElementById('progress-bar');
  const warningList=document.getElementById('warning-list');
  const errorLine=document.getElementById('error-line');
  const sourceHint=document.getElementById('source-hint');
  const submitBtn=document.getElementById('submit-btn');
  const uidInput=document.getElementById('uid');

  function sleep(ms){return new Promise((r)=>setTimeout(r,ms));}
  function setStatus(text){statusLine.textContent=text;}
  function setStage(stage,progress){
    const label=STAGE_LABELS[stage]||stage||'-';
    stageLine.textContent='阶段: '+label;
    const safeProgress=Number.isFinite(Number(progress))?Math.max(0,Math.min(100,Number(progress))):0;
    progressBar.style.width=safeProgress+'%';
  }
  function renderWarnings(warnings){
    const list=Array.isArray(warnings)?warnings.filter(Boolean):[];
    warningList.replaceChildren();
    for(const warning of list){
      const li=document.createElement('li');
      li.textContent=String(warning);
      warningList.appendChild(li);
    }
  }

  async function loadRecent(){
    const ul=document.getElementById('recent-list');
    try{
      const resp=await fetch('/api/recent?limit=10',{headers:{accept:'application/json'}});
      const data=await resp.json();
      const items=Array.isArray(data.items)?data.items:[];
      ul.innerHTML=items.map((item)=>'<li><a href="/u/'+encodeURIComponent(item.uid)+'">UID '+String(item.uid)+'</a> · '+new Date(item.createdAt).toLocaleString()+'</li>').join('')||'<li>暂无数据</li>';
    }catch{
      ul.innerHTML='<li>加载失败，请稍后刷新</li>';
    }
  }

  async function fetchAllVidWithRetry(uid){
    const directUrl='https://uapis.cn/api/v1/social/bilibili/archives?mid='+encodeURIComponent(uid)+'&ps=1&pn=1';
    let lastError='未知错误';
    for(let attempt=1;attempt<=3;attempt++){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),4000);
      try{
        const resp=await fetch(directUrl,{signal:controller.signal,headers:{accept:'application/json'}});
        if(!resp.ok) throw new Error('HTTP '+resp.status);
        const data=await resp.json();
        if(!data||typeof data!=='object') throw new Error('payload invalid');
        return {via:'direct',attempt,data};
      }catch(err){
        lastError=String(err&&err.message?err.message:err);
        await sleep(200*attempt);
      }finally{
        clearTimeout(timer);
      }
    }
    const proxyResp=await fetch('/api/proxy/allVid?uid='+encodeURIComponent(uid)+'&pn=1',{headers:{accept:'application/json'}});
    if(!proxyResp.ok){
      throw new Error('代理请求失败 HTTP '+proxyResp.status+'; direct error: '+lastError);
    }
    return {via:'worker-proxy',attempt:4,data:await proxyResp.json(),fallback:lastError};
  }

  async function pollJob(jobId){
    for(let i=0;i<240;i++){
      await sleep(1500);
      const resp=await fetch('/api/job/'+encodeURIComponent(jobId),{headers:{accept:'application/json'}});
      const job=await resp.json();
      if(!resp.ok){
        errorLine.textContent=String(job.error||'任务状态查询失败');
        return;
      }
      setStage(job.stage,job.progress);
      renderWarnings(job.warnings);
      if(job.status==='succeeded'){
        setStatus('任务完成，正在跳转页面');
        if(job.url){
          location.href=job.url;
          return;
        }
        await loadRecent();
        return;
      }
      if(job.status==='failed'){
        setStatus('任务失败');
        errorLine.textContent=String(job.error||'未知错误');
        return;
      }
      const waitSec=Math.max(0,Math.round((240-i)*1.5));
      setStatus('任务进行中，预计剩余轮询 '+waitSec+' 秒');
    }
    setStatus('任务超时，请稍后重新查询');
  }

  async function onSubmit(event){
    event.preventDefault();
    errorLine.textContent='';
    renderWarnings([]);
    const uid=String(uidInput.value||'').trim();
    if(!/^\d{1,20}$/.test(uid)){
      errorLine.textContent='UID 格式错误';
      return;
    }
    submitBtn.disabled=true;
    try{
      setStatus('检查数据源连通性');
      setStage('queued',0);
      const source=await fetchAllVidWithRetry(uid);
      if(source.via==='direct'){
        sourceHint.textContent='上游直连成功（'+source.attempt+' 次尝试）';
      }else{
        sourceHint.textContent='上游直连失败 3 次，已切换 Worker 代理。';
      }
      const turnstileToken=window.turnstile&&typeof window.turnstile.getResponse==='function'?window.turnstile.getResponse():'';
      const resp=await fetch('/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uid,turnstileToken})});
      const data=await resp.json();
      if(!resp.ok){
        throw new Error(String(data.error||'任务创建失败'));
      }
      setStatus('任务已入队，预计等待 '+String(data.estimatedWaitSec||'-')+' 秒');
      setStage(data.stage||'queued',0);
      await pollJob(data.jobId);
      await loadRecent();
    }catch(err){
      errorLine.textContent=String(err&&err.message?err.message:err);
    }finally{
      submitBtn.disabled=false;
    }
  }

  document.getElementById('generate-form').addEventListener('submit',onSubmit);
  loadRecent();
  </script></body></html>`;
}

async function getRecent(env, limit = MAX_RECENT, options = {}) {
  const max = parseBoundedInt(limit, 1, MAX_RECENT, MAX_RECENT);
  if (!options.skipCache) {
    const cached = getHotRecentCache();
    if (cached) return cached.slice(0, max);
  }
  const items = (await env.REMEMBER_KV.get("recent:list", "json")) || [];
  const normalized = Array.isArray(items) ? items.slice(0, MAX_RECENT) : [];
  setHotRecentCache(normalized);
  return normalized.slice(0, max);
}

async function saveRecent(env, item) {
  const current = await getRecent(env, MAX_RECENT);
  const merged = [item, ...current.filter((v) => v.uid !== item.uid)].slice(0, MAX_RECENT);
  await env.REMEMBER_KV.put("recent:list", JSON.stringify(merged));
  setHotRecentCache(merged);
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
    const [uploadsRaw, allVid, comments, danmu, liveDanmu] = await Promise.all([
      env.REMEMBER_KV.get(`uploads:index:${uid}`, "json"),
      fetchAllVideosByUid(upstreamClient, uid, { maxPages: 200, pageSize: 50 }),
      fetchPagedAicuData(upstreamClient, "comment", uid, { maxPages: 200, maxItems: 1000 }),
      fetchPagedAicuData(upstreamClient, "danmu", uid, { maxPages: 200, maxItems: 1000 }),
      fetchPagedAicuData(upstreamClient, "zhibodanmu", uid, { maxPages: 200, maxItems: 500 }),
    ]);
    const uploads = Array.isArray(uploadsRaw) ? uploadsRaw : [];
    const topVideoInfos = await fetchTopVideoInfosByPlayCount(upstreamClient, allVid.videos || [], { topN: 10, concurrency: 3 });
    const regDateEstimate = estimateRegDateByUid(uid);
    const dataNotice = String(env.DATA_NOTICE || "第三方API数据可能不准确，仅供纪念参考");
    const generatedAt = Date.now();

    await patchJob({ stage: "analyzing", progress: 60 });
    const snapshotBase = {
      uid,
      uploads,
      createdAt: generatedAt,
      generatedAt,
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
    const item = { uid, createdAt: generatedAt, url: `/u/${uid}` };
    await Promise.all([
      env.REMEMBER_DATA.put(`pages/${uid}.html`, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
      env.REMEMBER_DATA.put(`snapshots/${uid}/${jobId}.json`, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" } }),
      env.REMEMBER_KV.put(`meta:uid:${uid}`, JSON.stringify(item)),
    ]);
    await saveRecent(env, item);
    const recentList = await getRecent(env, MAX_RECENT);
    const sitemap = (await appendUidToSitemapCache(env, uid)) || (await sitemapXml(env, { forceRebuild: true }));

    await patchJob({ stage: "syncing", progress: 95, warnings });
    const gitSync = await syncGeneratedPageToGitHub(env, { uid, html, snapshot, item, recentList, sitemapXml: sitemap });
    if (gitSync.status !== "succeeded" && gitSync.reason) {
      warnings.push(`Git 同步异常: ${gitSync.reason}`);
    }
    await patchJob({ status: "succeeded", stage: "succeeded", progress: 100, url: item.url, warnings, gitSync });
  } catch (err) {
    const safeMessage = sanitizeFailureMessage(err?.message || err);
    await patchJob({
      status: "failed",
      stage: "failed",
      error: safeMessage,
      warnings: [`任务失败: ${safeMessage}`],
    });
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSearchKeyword(input) {
  return String(input || "").trim().slice(0, 64);
}

function proxySchemaValidator(source, payload) {
  if (!isPlainObject(payload)) return false;
  if (source === "allVid") {
    return Array.isArray(payload.videos) || Array.isArray(payload?.data?.videos) || Number.isFinite(Number(payload.total || payload?.data?.total || 0));
  }
  if (source === "vidInfo") {
    return Boolean(payload.aid || payload.bvid || payload?.data?.aid || payload?.data?.bvid);
  }
  const list = payload?.data?.list || payload?.list || payload?.data?.reply || payload?.reply;
  return Array.isArray(list) || Number.isFinite(Number(payload.code ?? 0));
}

async function handleProxy(request, env, url) {
  await enforceIpRateLimit(env, request, "proxy", 120, 30);
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
    const keyword = sanitizeSearchKeyword(url.searchParams.get("keyword"));
    upstream = `https://api.aicu.cc/api/v3/search/getvideodm?uid=${encodeURIComponent(uid)}&pn=${pn}&ps=100&keyword=${encodeURIComponent(keyword)}`;
  } else if (source === "zhibodanmu") {
    if (!uid) throw new HttpError(400, "zhibodanmu 需要 uid");
    const pn = parseBoundedInt(url.searchParams.get("pn") || url.searchParams.get("page"), 1, 1000, 1);
    const keyword = sanitizeSearchKeyword(url.searchParams.get("keyword"));
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
      schema: (data) => proxySchemaValidator(source, data),
    });
    payload = data;
  } catch (err) {
    throw new HttpError(502, "上游接口请求失败");
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
  await enforceIpRateLimit(env, request, "upload-init", 20, 8);

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
  await enforceIpRateLimit(env, request, "generate", 10, 4);

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
  try {
    await env.ANALYSIS_QUEUE.send(
      JSON.stringify({
        jobId,
        uid,
        requestedAt: now,
        traceId,
      }),
    );
  } catch {
    await Promise.allSettled([env.REMEMBER_KV.delete(`job:${jobId}`), env.REMEMBER_KV.delete(cooldownKey)]);
    throw new HttpError(503, "排队服务暂时不可用，请稍后重试");
  }
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
  const normalizedJobId = normalizeJobId(jobId);
  if (!normalizedJobId) throw new HttpError(400, "jobId 不合法");
  const job = await env.REMEMBER_KV.get(`job:${normalizedJobId}`, "json");
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
  await enforceIpRateLimit(env, request, "removal-create", 8, 3);
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
  if (!/^rr_[a-f0-9]{32}$/.test(id) || !/^code_[a-f0-9]{32}$/.test(code)) {
    throw new HttpError(400, "参数不合法");
  }
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
    setHotRecentCache(filtered);
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
      await sitemapXml(env, { forceRebuild: true });
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
    await removeUidFromRecent(env, uid);
    await sitemapXml(env, { forceRebuild: true });
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

async function appendUidToSitemapCache(env, uid) {
  const normalizedUid = normalizeUid(uid);
  if (!normalizedUid) return null;
  let xml = getHotSitemapCache();
  if (!xml) {
    xml = await env.REMEMBER_KV.get(SITEMAP_CACHE_KEY);
  }
  if (!xml || typeof xml !== "string") return null;
  const targetLoc = `${DOMAIN}/u/${normalizedUid}`;
  const needle = `<loc>${targetLoc}</loc>`;
  if (xml.includes(needle)) return xml;
  const endTag = "</urlset>";
  const endIndex = xml.lastIndexOf(endTag);
  if (endIndex <= 0) return null;
  const appended = `${xml.slice(0, endIndex)}<url><loc>${targetLoc}</loc></url>${xml.slice(endIndex)}`;
  const urlCount = (appended.match(/<url>/g) || []).length;
  if (urlCount > MAX_SITEMAP_URLS) return null;
  setHotSitemapCache(appended);
  await env.REMEMBER_KV.put(SITEMAP_CACHE_KEY, appended, { expirationTtl: 12 * 3600 });
  return appended;
}

async function sitemapXml(env, options = {}) {
  const forceRebuild = Boolean(options.forceRebuild);
  if (!forceRebuild) {
    const hot = getHotSitemapCache();
    if (hot) return hot;
    const persisted = await env.REMEMBER_KV.get(SITEMAP_CACHE_KEY);
    if (persisted) {
      setHotSitemapCache(persisted);
      return persisted;
    }
  }

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
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`;
  setHotSitemapCache(xml);
  await env.REMEMBER_KV.put(SITEMAP_CACHE_KEY, xml, { expirationTtl: 12 * 3600 });
  return xml;
}

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const cors = corsHeaders(request.headers.get("origin"));
  const requestId = request.headers.get("cf-ray") || randomId("req");

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    if (request.method === "GET" && path === "/") {
      const nonce = generateCspNonce();
      return htmlResponse(homepageHtml(env.TURNSTILE_SITE_KEY || "", nonce), 200, { ...cors, "cache-control": "public, s-maxage=300", "x-request-id": requestId }, { nonce });
    }
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
      await enforceIpRateLimit(env, request, "recent", 1200, 120);
      const limit = parseBoundedInt(url.searchParams.get("limit"), 1, MAX_RECENT, MAX_RECENT);
      return jsonResponse({ items: await getRecent(env, limit) }, 200, { ...cors, "cache-control": "public, s-maxage=60" });
    }
    if (request.method === "GET" && path.startsWith("/api/proxy/")) return applyCorsToResponse(await handleProxy(request, env, url), cors);
    if (request.method === "POST" && path === "/api/upload/init") return applyCorsToResponse(await handleUploadInit(request, env), cors);
    if (request.method === "PUT" && path === "/api/upload/part") return applyCorsToResponse(await handleUploadPart(request, env, url), cors);
    if (request.method === "POST" && path === "/api/upload/complete") return applyCorsToResponse(await handleUploadComplete(request, env), cors);
    if (request.method === "POST" && path === "/api/generate") return applyCorsToResponse(await handleGenerate(request, env, ctx), cors);
    if (request.method === "GET" && path.startsWith("/api/job/")) {
      await enforceIpRateLimit(env, request, "job", 1500, 180);
      return applyCorsToResponse(await handleJob(env, path.split("/").pop()), cors);
    }
    if (request.method === "POST" && path === "/api/removal-requests") return applyCorsToResponse(await handleRemovalCreate(request, env), cors);
    if (request.method === "GET" && path.startsWith("/api/removal-requests/")) return applyCorsToResponse(await handleRemovalGet(env, url), cors);
    if (path === "/admin" || path.startsWith("/api/admin/")) return applyCorsToResponse(await handleAdmin(request, env, url, ctx), cors);

    throw new HttpError(404, "Not Found");
  } catch (err) {
    if (!(err instanceof HttpError)) {
      console.error("unhandled_error", { requestId, path, message: sanitizeFailureMessage(err?.message || err) });
    }
    const publicErr = publicErrorPayload(err, requestId);
    return jsonResponse(publicErr.body, publicErr.status, { ...cors, "cache-control": "no-store", "x-request-id": requestId });
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

function getQueueAttemptCount(message) {
  const raw = Number(message?.attempts ?? message?.deliveryCount ?? message?.retryCount ?? 0);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

async function markQueueJobFailed(env, jobId, error) {
  const key = `job:${jobId}`;
  const current = await env.REMEMBER_KV.get(key, "json").catch(() => null);
  if (!current) return;
  const safeMessage = sanitizeFailureMessage(error?.message || error);
  const warnings = Array.isArray(current.warnings) ? current.warnings.slice(0, 5) : [];
  warnings.push(`队列处理失败: ${safeMessage}`);
  await env.REMEMBER_KV.put(
    key,
    JSON.stringify({
      ...current,
      status: "failed",
      stage: "failed",
      error: safeMessage,
      warnings,
      updatedAt: Date.now(),
    }),
    { expirationTtl: 24 * 3600 },
  ).catch(() => {});
}

async function handleQueue(batch, env) {
  const maxRetries = parseBoundedInt(env.QUEUE_MAX_RETRIES, 0, 10, 3);
  for (const message of batch.messages || []) {
    let payload;
    try {
      payload = await parseQueueMessageBody(message.body);
    } catch {
      if (typeof message.ack === "function") message.ack();
      continue;
    }

    const jobId = normalizeJobId(payload?.jobId);
    const uid = normalizeUid(payload?.uid);
    if (!jobId || !uid) {
      if (typeof message.ack === "function") message.ack();
      continue;
    }

    try {
      await processGenerateJob(env, jobId);
      if (typeof message.ack === "function") message.ack();
    } catch (err) {
      const attempts = getQueueAttemptCount(message);
      if (attempts >= maxRetries) {
        await markQueueJobFailed(env, jobId, err);
        if (typeof message.ack === "function") message.ack();
        continue;
      }
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

