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
    const createResp = await runtime.fetch(
      new Request("https://rem.furry.ist/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: "123456", turnstileToken: "ok-token" }),
      }),
      env,
      createCtx(),
    );
    assert.equal(createResp.status, 202);
    const created = await createResp.json();
    assert.equal(created.queued, true);
    assert.equal(created.stage, "queued");
    assert.equal(env.__queueMessages.length, 1);

    const jobResp = await runtime.fetch(new Request(`https://rem.furry.ist/api/job/${created.jobId}`, { method: "GET" }), env, createCtx());
    assert.equal(jobResp.status, 200);
    const job = await jobResp.json();
    assert.equal(job.stage, "queued");
    assert.equal(job.progress, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    const createRequest = () =>
      new Request("https://rem.furry.ist/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: "223344", turnstileToken: "ok-token" }),
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
