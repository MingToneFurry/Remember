import test from "node:test";
import assert from "node:assert/strict";
import runtime from "../src/routes/runtime.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class MemoryKV {
  constructor() {
    this.map = new Map();
  }

  async get(key, type) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    if (type === "json") {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return value;
  }

  async put(key, value) {
    this.map.set(key, String(value));
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list(options = {}) {
    const prefix = String(options.prefix || "");
    const limit = Number(options.limit || 1000);
    const cursor = Number(options.cursor || 0);
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const items = keys.slice(cursor, cursor + limit).map((name) => ({ name }));
    const next = cursor + items.length;
    const listComplete = next >= keys.length;
    return {
      keys: items,
      list_complete: listComplete,
      cursor: listComplete ? undefined : String(next),
      truncated: !listComplete,
    };
  }
}

function createEnv(overrides = {}) {
  const kv = new MemoryKV();
  const queueMessages = [];
  return {
    TURNSTILE_SECRET: "turnstile-secret-1234567890",
    TURNSTILE_SITE_KEY: "site-key",
    TOKEN_SIGNING_SECRET: "token-secret-1234567890",
    DATA_NOTICE: "第三方API数据可能不准确，仅供纪念参考",
    REMEMBER_KV: kv,
    REMEMBER_DATA: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
      async list() {
        return { objects: [], truncated: false, cursor: undefined };
      },
    },
    ANALYSIS_QUEUE: {
      async send(payload) {
        queueMessages.push(payload);
      },
    },
    __queueMessages: queueMessages,
    ...overrides,
  };
}

function createCtx() {
  return {
    waitUntil() {},
  };
}

function createAsyncCtx() {
  const tasks = [];
  return {
    waitUntil(task) {
      tasks.push(Promise.resolve(task));
    },
    async flush() {
      await Promise.all(tasks);
    },
  };
}

function createMemoryR2(initialObjects = {}) {
  const store = new Map();
  for (const [key, value] of Object.entries(initialObjects)) {
    store.set(key, {
      body: typeof value === "string" ? value : JSON.stringify(value),
      uploaded: new Date(),
    });
  }
  return {
    __store: store,
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        uploaded: item.uploaded,
        async text() {
          return item.body;
        },
      };
    },
    async put(key, value) {
      store.set(key, {
        body: typeof value === "string" ? value : String(value),
        uploaded: new Date(),
      });
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options = {}) {
      const prefix = String(options.prefix || "");
      const cursor = Number(options.cursor || 0);
      const limit = Number(options.limit || 1000);
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const slice = keys.slice(cursor, cursor + limit);
      const next = cursor + slice.length;
      const truncated = next < keys.length;
      return {
        objects: slice.map((key) => ({ key, uploaded: store.get(key)?.uploaded || new Date() })),
        truncated,
        cursor: truncated ? String(next) : undefined,
      };
    },
  };
}

async function createReadyCollectSession(env, uid, turnstileToken = "ok-token") {
  const collectResp = await runtime.fetch(
    new Request("https://rem.furry.ist/api/collect/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid, turnstileToken }),
    }),
    env,
    createCtx(),
  );
  assert.equal(collectResp.status, 200);
  const collectData = await collectResp.json();
  const sessionKey = `collect:${collectData.collectId}`;
  const session = await env.REMEMBER_KV.get(sessionKey, "json");
  const uploadedArtifacts = {};
  for (const artifact of collectData.requiredArtifacts || []) {
    uploadedArtifacts[artifact] = {
      artifact,
      key: `raw/mock/${uid}/${collectData.collectId}/${artifact}.json`,
      fileName: `${artifact}.json`,
      mime: "application/json",
      size: 1,
      uploadedAt: Date.now(),
    };
  }
  await env.REMEMBER_KV.put(
    sessionKey,
    JSON.stringify({
      ...session,
      status: "ready",
      uploadedArtifacts,
      updatedAt: Date.now(),
    }),
  );
  return collectData;
}

function buildMinuteRateLimitKey(scope, ip, date = new Date()) {
  const minute = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return `rl:ipm:${scope}:${ip}:${minute}`;
}

test("GET / should render nonce-based CSP and script nonce", async () => {
  const env = createEnv();
  const request = new Request("https://rem.furry.ist/", { method: "GET" });
  const response = await runtime.fetch(request, env, createCtx());
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src 'self' 'nonce-[^']+' https:\/\/challenges\.cloudflare\.com/);
  const html = await response.text();
  assert.match(html, /<script nonce="[^"]+" src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js"/);
});

test("GET / should render warning script without innerHTML injection", async () => {
  const env = createEnv();
  const response = await runtime.fetch(new Request("https://rem.furry.ist/", { method: "GET" }), env, createCtx());
  const html = await response.text();
  assert.equal(html.includes("warningList.innerHTML"), false);
  assert.equal(html.includes("warningList.replaceChildren()"), true);
  assert.equal(html.includes("li.textContent=String(warning)"), true);
  assert.equal(html.includes("/api/collect/init"), true);
  assert.equal(html.includes("/api/collect/aicu"), true);
  assert.equal(html.includes("/api/upload/init"), true);
  assert.equal(html.includes("aicu_verify_required"), true);
  assert.equal(html.includes("verify-continue-btn"), true);
  assert.equal(html.includes("createCaptchaError"), true);
  assert.equal(html.includes("status===468"), false);
  assert.equal(html.includes("输入 UID 创建异步任务。前端会先直连上游接口重试 3 次，全部失败后再走 Worker 代理。"), false);
  assert.equal(html.includes("remember-site-theme-v1"), true);
});

test("POST /api/collect/aicu should return payload for valid collect session", async () => {
  const env = createEnv();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/turnstile/v0/siteverify")) {
      return jsonResponse(200, { success: true });
    }
    if (target.startsWith("https://api.aicu.cc/api/v3/search/getreply")) {
      upstreamCalls += 1;
      return jsonResponse(200, {
        code: 0,
        data: {
          cursor: { is_end: true, all_count: 1 },
          replies: [{ rpid: "1", message: "ok" }],
        },
      });
    }
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    const collect = await createReadyCollectSession(env, "123456");
    const response = await runtime.fetch(
      new Request("https://rem.furry.ist/api/collect/aicu", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: "123456",
          collectId: collect.collectId,
          collectToken: collect.collectToken,
          source: "comment",
          page: 1,
        }),
      }),
      env,
      createCtx(),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.code, 0);
    assert.equal(Array.isArray(body?.data?.replies), true);
    assert.equal(upstreamCalls >= 1, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/collect/aicu should return verify_required when upstream stays challenged", async () => {
  const env = createEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/turnstile/v0/siteverify")) {
      return jsonResponse(200, { success: true });
    }
    if (target.startsWith("https://api.aicu.cc/api/v3/search/getreply")) {
      return new Response("<html>challenge</html>", {
        status: 468,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    const collect = await createReadyCollectSession(env, "123456");
    const response = await runtime.fetch(
      new Request("https://rem.furry.ist/api/collect/aicu", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: "123456",
          collectId: collect.collectId,
          collectToken: collect.collectToken,
          source: "comment",
          page: 1,
        }),
      }),
      env,
      createCtx(),
    );
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "aicu_verify_required");
    assert.equal(String(body.verifyUrl || "").includes("https://api.aicu.cc/api/v3/search/getreply"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/generate should enqueue job and job endpoint should return stage/progress", async () => {
  const env = createEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/turnstile/v0/siteverify")) {
      return jsonResponse(200, { success: true });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };
  try {
    const collect = await createReadyCollectSession(env, "123456");
    const createResp = await runtime.fetch(
      new Request("https://rem.furry.ist/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: "123456",
          turnstileToken: "ok-token",
          collectId: collect.collectId,
          collectToken: collect.collectToken,
        }),
      }),
      env,
      createCtx(),
    );
    assert.equal(createResp.status, 202);
    const created = await createResp.json();
    assert.equal(created.queued, true);
    assert.equal(created.stage, "queued");
    assert.equal(env.__queueMessages.length, 1);
    const queuePayload = JSON.parse(env.__queueMessages[0]);
    assert.equal(queuePayload.collectId, collect.collectId);

    const jobResp = await runtime.fetch(new Request(`https://rem.furry.ist/api/job/${created.jobId}`, { method: "GET" }), env, createCtx());
    assert.equal(jobResp.status, 200);
    const job = await jobResp.json();
    assert.equal(job.stage, "queued");
    assert.equal(job.progress, 0);
    assert.equal(job.collectId, collect.collectId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/generate should accept numeric UID samples", async () => {
  const env = createEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/turnstile/v0/siteverify")) {
      return jsonResponse(200, { success: true });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };

  try {
    for (const uid of ["1933865292", "15918883740"]) {
      const collect = await createReadyCollectSession(env, uid);
      const response = await runtime.fetch(
        new Request("https://rem.furry.ist/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            uid,
            turnstileToken: "ok-token",
            collectId: collect.collectId,
            collectToken: collect.collectToken,
          }),
        }),
        env,
        createCtx(),
      );
      assert.equal(response.status, 202);
    }
    assert.equal(env.__queueMessages.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/generate should normalize full-width uid input", async () => {
  const env = createEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/turnstile/v0/siteverify")) {
      return jsonResponse(200, { success: true });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };

  try {
    const collect = await createReadyCollectSession(env, "1933865292");
    const response = await runtime.fetch(
      new Request("https://rem.furry.ist/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: "\uFF11\uFF19\uFF13\uFF13\uFF18\uFF16\uFF15\uFF12\uFF19\uFF12",
          turnstileToken: "ok-token",
          collectId: collect.collectId,
          collectToken: collect.collectToken,
        }),
      }),
      env,
      createCtx(),
    );
    assert.equal(response.status, 202);
    assert.equal(env.__queueMessages.length, 1);
    const payload = JSON.parse(env.__queueMessages[0]);
    assert.equal(payload.uid, "1933865292");
    assert.equal(payload.collectId, collect.collectId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/generate should reject multi uid input", async () => {
  const env = createEnv();
  const response = await runtime.fetch(
    new Request("https://rem.furry.ist/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uid: "1933865292 15918883740",
        turnstileToken: "unused",
        collectId: "collect_1234567890abcdef1234567890abcdef",
        collectToken: "unused",
      }),
    }),
    env,
    createCtx(),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(String(body.error || ""), /仅支持单 UID/);
});

test("POST /api/generate should rollback cooldown and return 503 when queue send fails", async () => {
  let attempts = 0;
  const env = createEnv({
    ANALYSIS_QUEUE: {
      async send() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("queue down");
        }
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/turnstile/v0/siteverify")) {
      return jsonResponse(200, { success: true });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };

  try {
    const collect = await createReadyCollectSession(env, "223344");
    const createRequest = () =>
      new Request("https://rem.furry.ist/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: "223344",
          turnstileToken: "ok-token",
          collectId: collect.collectId,
          collectToken: collect.collectToken,
        }),
      });

    const firstResp = await runtime.fetch(createRequest(), env, createCtx());
    assert.equal(firstResp.status, 503);
    const firstBody = await firstResp.json();
    assert.equal(firstBody.error, "服务暂时不可用");

    const secondResp = await runtime.fetch(createRequest(), env, createCtx());
    assert.equal(secondResp.status, 202);
    const secondBody = await secondResp.json();
    assert.equal(secondBody.queued, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed generate job should clear uid cooldown so retry can continue", async () => {
  const env = createEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/turnstile/v0/siteverify")) {
      return jsonResponse(200, { success: true });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };

  try {
    const uid = "445566";
    const collect = await createReadyCollectSession(env, uid);
    const createRequest = () =>
      new Request("https://rem.furry.ist/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid,
          turnstileToken: "ok-token",
          collectId: collect.collectId,
          collectToken: collect.collectToken,
        }),
      });

    const firstResp = await runtime.fetch(createRequest(), env, createCtx());
    assert.equal(firstResp.status, 202);
    const firstBody = await firstResp.json();

    let ackCount = 0;
    let retryCount = 0;
    const msg = {
      body: JSON.stringify({
        jobId: firstBody.jobId,
        uid,
        collectId: collect.collectId,
      }),
      ack() {
        ackCount += 1;
      },
      retry() {
        retryCount += 1;
      },
    };
    const queueCtx = createAsyncCtx();
    runtime.queue({ messages: [msg] }, env, queueCtx);
    await queueCtx.flush();

    assert.equal(ackCount, 1);
    assert.equal(retryCount, 0);
    const failedJob = await env.REMEMBER_KV.get(`job:${firstBody.jobId}`, "json");
    assert.equal(failedJob.status, "failed");
    assert.equal(await env.REMEMBER_KV.get(`cooldown:uid:${uid}`), null);

    const secondResp = await runtime.fetch(createRequest(), env, createCtx());
    assert.equal(secondResp.status, 202);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/generate should return 409 when collect session not ready", async () => {
  const env = createEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/turnstile/v0/siteverify")) {
      return jsonResponse(200, { success: true });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };
  try {
    const collectResp = await runtime.fetch(
      new Request("https://rem.furry.ist/api/collect/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: "998877", turnstileToken: "ok-token" }),
      }),
      env,
      createCtx(),
    );
    assert.equal(collectResp.status, 200);
    const collect = await collectResp.json();

    const response = await runtime.fetch(
      new Request("https://rem.furry.ist/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: "998877",
          turnstileToken: "ok-token",
          collectId: collect.collectId,
          collectToken: collect.collectToken,
        }),
      }),
      env,
      createCtx(),
    );
    assert.equal(response.status, 409);
    assert.equal(env.__queueMessages.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/job/:jobId should reject invalid id", async () => {
  const env = createEnv();
  const response = await runtime.fetch(new Request("https://rem.furry.ist/api/job/not-valid", { method: "GET" }), env, createCtx());
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "jobId 不合法");
});

test("unexpected server error should be redacted", async () => {
  const env = createEnv({
    REMEMBER_KV: {
      async get() {
        throw new Error("TOKEN_SIGNING_SECRET=leaked-value");
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true };
      },
    },
  });

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => {
    logged.push(args);
  };
  try {
    const response = await runtime.fetch(
      new Request("https://rem.furry.ist/api/job/job_1234567890abcdef1234567890abcdef", {
        method: "GET",
        headers: { "cf-ray": "ray-test-123" },
      }),
      env,
      createCtx(),
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, "Internal Error");
    assert.deepEqual(body.details, []);
    assert.equal(body.requestId, "ray-test-123");
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.some((line) => JSON.stringify(line).includes("leaked-value")), false);
  assert.equal(logged.some((line) => JSON.stringify(line).includes("[REDACTED]")), true);
});

test("queue should ack invalid payload and never retry", async () => {
  const env = createEnv();
  let ackCount = 0;
  let retryCount = 0;
  const message = {
    body: "{",
    ack() {
      ackCount += 1;
    },
    retry() {
      retryCount += 1;
    },
  };

  const ctx = createAsyncCtx();
  runtime.queue({ messages: [message] }, env, ctx);
  await ctx.flush();

  assert.equal(ackCount, 1);
  assert.equal(retryCount, 0);
});

test("queue should stop retrying after max attempts", async () => {
  const env = createEnv({
    QUEUE_MAX_RETRIES: "2",
    REMEMBER_KV: {
      async get() {
        throw new Error("temporary queue processing failure");
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true };
      },
    },
  });

  let ackCount = 0;
  let retryCount = 0;
  const message = {
    body: JSON.stringify({ jobId: "job_1234567890abcdef1234567890abcdef", uid: "123456" }),
    attempts: 2,
    ack() {
      ackCount += 1;
    },
    retry() {
      retryCount += 1;
    },
  };

  const ctx = createAsyncCtx();
  runtime.queue({ messages: [message] }, env, ctx);
  await ctx.flush();

  assert.equal(ackCount, 1);
  assert.equal(retryCount, 0);
});

test("queue should retry when attempts are below max", async () => {
  const env = createEnv({
    QUEUE_MAX_RETRIES: "3",
    REMEMBER_KV: {
      async get() {
        throw new Error("temporary queue processing failure");
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true };
      },
    },
  });

  let ackCount = 0;
  let retryCount = 0;
  const message = {
    body: JSON.stringify({ jobId: "job_1234567890abcdef1234567890abcdef", uid: "123456" }),
    attempts: 1,
    ack() {
      ackCount += 1;
    },
    retry() {
      retryCount += 1;
    },
  };

  const ctx = createAsyncCtx();
  runtime.queue({ messages: [message] }, env, ctx);
  await ctx.flush();

  assert.equal(ackCount, 0);
  assert.equal(retryCount, 1);
});

test("queue should fail job when required artifact is missing", async () => {
  const uid = "123456";
  const collectId = "collect_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const jobId = "job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const env = createEnv({
    REMEMBER_DATA: createMemoryR2(),
  });
  await env.REMEMBER_KV.put(
    `job:${jobId}`,
    JSON.stringify({
      jobId,
      uid,
      collectId,
      status: "queued",
      stage: "queued",
      warnings: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await env.REMEMBER_KV.put(
    `collect:${collectId}`,
    JSON.stringify({
      uid,
      collectId,
      status: "ready",
      requiredArtifacts: ["allVid", "comment", "danmu", "zhibodanmu", "topVideoInfos"],
      uploadedArtifacts: {
        allVid: { artifact: "allVid", key: "raw/mock/123456/allVid.json", size: 100 },
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
    }),
  );

  let ackCount = 0;
  let retryCount = 0;
  const message = {
    body: JSON.stringify({ jobId, uid, collectId }),
    ack() {
      ackCount += 1;
    },
    retry() {
      retryCount += 1;
    },
  };
  const ctx = createAsyncCtx();
  runtime.queue({ messages: [message] }, env, ctx);
  await ctx.flush();

  const job = await env.REMEMBER_KV.get(`job:${jobId}`, "json");
  assert.equal(job.status, "failed");
  assert.match(String(job.error || ""), /采集产物不完整/);
  assert.equal(ackCount, 1);
  assert.equal(retryCount, 0);
});

test("queue should build page from uploaded artifacts when collect data is complete", async () => {
  const uid = "654321";
  const collectId = "collect_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const jobId = "job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const requiredArtifacts = ["allVid", "comment", "danmu", "zhibodanmu", "topVideoInfos"];
  const uploadedArtifacts = {
    allVid: {
      artifact: "allVid",
      key: "raw/mock/654321/allVid.json",
      fileName: "allVid.json",
      mime: "application/json",
      size: 120,
      uploadedAt: Date.now(),
    },
    comment: {
      artifact: "comment",
      key: "raw/mock/654321/comment.json",
      fileName: "comment.json",
      mime: "application/json",
      size: 120,
      uploadedAt: Date.now(),
    },
    danmu: {
      artifact: "danmu",
      key: "raw/mock/654321/danmu.json",
      fileName: "danmu.json",
      mime: "application/json",
      size: 120,
      uploadedAt: Date.now(),
    },
    zhibodanmu: {
      artifact: "zhibodanmu",
      key: "raw/mock/654321/zhibodanmu.json",
      fileName: "zhibodanmu.json",
      mime: "application/json",
      size: 120,
      uploadedAt: Date.now(),
    },
    topVideoInfos: {
      artifact: "topVideoInfos",
      key: "raw/mock/654321/topVideoInfos.json",
      fileName: "topVideoInfos.json",
      mime: "application/json",
      size: 120,
      uploadedAt: Date.now(),
    },
  };
  const memoryR2 = createMemoryR2({
    [uploadedArtifacts.allVid.key]: {
      uid,
      total: 1,
      fetchedPages: 1,
      videos: [{ bvid: "BV1xx411c7Q1", aid: "111", title: "video-title", play_count: 99 }],
    },
    [uploadedArtifacts.comment.key]: {
      uid,
      source: "comment",
      total: 1,
      fetchedPages: 1,
      items: [{ message: "comment-text" }],
    },
    [uploadedArtifacts.danmu.key]: {
      uid,
      source: "danmu",
      total: 1,
      fetchedPages: 1,
      items: [{ content: "danmu-text" }],
    },
    [uploadedArtifacts.zhibodanmu.key]: {
      uid,
      source: "zhibodanmu",
      total: 1,
      fetchedPages: 1,
      items: [{ danmu: [{ uname: "live-user", text: "live-danmu" }] }],
    },
    [uploadedArtifacts.topVideoInfos.key]: [
      {
        bvid: "BV1xx411c7Q1",
        aid: "111",
        playCount: 99,
        data: {
          title: "video-title",
          bvid: "BV1xx411c7Q1",
          aid: "111",
          stat: { view: 99 },
        },
      },
    ],
  });
  const env = createEnv({
    REMEMBER_DATA: memoryR2,
  });
  await env.REMEMBER_KV.put(
    `job:${jobId}`,
    JSON.stringify({
      jobId,
      uid,
      collectId,
      status: "queued",
      stage: "queued",
      warnings: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await env.REMEMBER_KV.put(
    `collect:${collectId}`,
    JSON.stringify({
      uid,
      collectId,
      status: "ready",
      requiredArtifacts,
      uploadedArtifacts,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
    }),
  );

  let ackCount = 0;
  let retryCount = 0;
  const message = {
    body: JSON.stringify({ jobId, uid, collectId }),
    ack() {
      ackCount += 1;
    },
    retry() {
      retryCount += 1;
    },
  };
  const ctx = createAsyncCtx();
  runtime.queue({ messages: [message] }, env, ctx);
  await ctx.flush();

  const job = await env.REMEMBER_KV.get(`job:${jobId}`, "json");
  assert.equal(job.status, "succeeded");
  assert.equal(job.url, `/u/${uid}`);
  assert.equal(memoryR2.__store.has(`pages/${uid}.html`), true);
  assert.equal(memoryR2.__store.has(`snapshots/${uid}/${jobId}.json`), true);
  assert.equal(ackCount, 1);
  assert.equal(retryCount, 0);
});

test("queue should ack running jobs without reprocessing", async () => {
  const env = createEnv();
  const jobId = "job_1234567890abcdef1234567890abcdef";
  await env.REMEMBER_KV.put(
    `job:${jobId}`,
    JSON.stringify({
      jobId,
      uid: "123456",
      status: "running",
      stage: "fetching",
      warnings: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  let ackCount = 0;
  let retryCount = 0;
  const message = {
    body: JSON.stringify({ jobId, uid: "123456" }),
    ack() {
      ackCount += 1;
    },
    retry() {
      retryCount += 1;
    },
  };

  const ctx = createAsyncCtx();
  runtime.queue({ messages: [message] }, env, ctx);
  await ctx.flush();

  const stored = await env.REMEMBER_KV.get(`job:${jobId}`, "json");
  assert.equal(stored.status, "running");
  assert.equal(ackCount, 1);
  assert.equal(retryCount, 0);
});

test("scheduled cleanup should remove expired raw objects and stale collect/upload sessions", async () => {
  const memoryR2 = createMemoryR2();
  const now = Date.now();
  const oldTs = now - 25 * 3600 * 1000;
  memoryR2.__store.set("raw/old/object.json", { body: "{}", uploaded: new Date(oldTs) });
  memoryR2.__store.set("raw/new/object.json", { body: "{}", uploaded: new Date(now) });

  const collectLive = "collect_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const collectExpired = "collect_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const collectOrphan = "collect_cccccccccccccccccccccccccccccccc";
  const env = createEnv({ REMEMBER_DATA: memoryR2 });

  await env.REMEMBER_KV.put(
    `collect:${collectLive}`,
    JSON.stringify({
      collectId: collectLive,
      uid: "10001",
      status: "collecting",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 3600 * 1000,
    }),
  );
  await env.REMEMBER_KV.put(
    `collect:${collectExpired}`,
    JSON.stringify({
      collectId: collectExpired,
      uid: "10002",
      status: "collecting",
      createdAt: oldTs,
      updatedAt: oldTs,
      expiresAt: oldTs + 1000,
    }),
  );

  await env.REMEMBER_KV.put(
    "upload:upload-old",
    JSON.stringify({
      uid: "10001",
      collectId: collectLive,
      key: "raw/old/upload-part.json",
      createdAt: oldTs,
    }),
  );
  await env.REMEMBER_KV.put(
    "upload:upload-orphan",
    JSON.stringify({
      uid: "10003",
      collectId: collectOrphan,
      key: "raw/new/orphan-upload-part.json",
      createdAt: now,
    }),
  );
  await env.REMEMBER_KV.put(
    "upload:upload-live",
    JSON.stringify({
      uid: "10001",
      collectId: collectLive,
      key: "raw/new/live-upload-part.json",
      createdAt: now,
    }),
  );

  await env.REMEMBER_KV.put(
    "uploads:index:10001",
    JSON.stringify([
      { uploadId: "upload-old", collectId: collectLive, createdAt: oldTs },
      { uploadId: "upload-live", collectId: collectLive, createdAt: now },
      { uploadId: "upload-orphan", collectId: collectOrphan, createdAt: now },
    ]),
  );

  const ctx = createAsyncCtx();
  runtime.scheduled({ cron: "15 * * * *" }, env, ctx);
  await ctx.flush();

  assert.equal(memoryR2.__store.has("raw/old/object.json"), false);
  assert.equal(memoryR2.__store.has("raw/new/object.json"), true);
  assert.equal(await env.REMEMBER_KV.get(`collect:${collectExpired}`), null);
  assert.notEqual(await env.REMEMBER_KV.get(`collect:${collectLive}`), null);
  assert.equal(await env.REMEMBER_KV.get("upload:upload-old"), null);
  assert.equal(await env.REMEMBER_KV.get("upload:upload-orphan"), null);
  assert.notEqual(await env.REMEMBER_KV.get("upload:upload-live"), null);
  const index = await env.REMEMBER_KV.get("uploads:index:10001", "json");
  assert.equal(Array.isArray(index), true);
  assert.equal(index.length, 1);
  assert.equal(index[0].uploadId, "upload-live");
});

test("PUT /api/upload/part should be rate-limited", async () => {
  const env = createEnv();
  const ip = "1.2.3.4";
  await env.REMEMBER_KV.put(buildMinuteRateLimitKey("upload-part", ip), "120");

  const response = await runtime.fetch(
    new Request("https://rem.furry.ist/api/upload/part?uploadId=upload-x&partNumber=1", {
      method: "PUT",
      headers: { "cf-connecting-ip": ip },
      body: "part-body",
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 429);
});

test("POST /api/upload/complete should be rate-limited", async () => {
  const env = createEnv();
  const ip = "5.6.7.8";
  await env.REMEMBER_KV.put(buildMinuteRateLimitKey("upload-complete", ip), "20");

  const response = await runtime.fetch(
    new Request("https://rem.furry.ist/api/upload/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ uploadId: "upload-y", parts: [{ partNumber: 1, etag: "etag-1" }] }),
    }),
    env,
    createCtx(),
  );

  assert.equal(response.status, 429);
});
