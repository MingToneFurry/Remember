function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isAbortError(err) {
  return err?.name === "AbortError";
}

export class UpstreamError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UpstreamError";
    this.details = details;
  }
}

export class UpstreamTimeoutError extends UpstreamError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = "UpstreamTimeoutError";
  }
}

export class UpstreamSchemaError extends UpstreamError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = "UpstreamSchemaError";
  }
}

export class UpstreamClient {
  constructor(options = {}) {
    this.allowedHosts = new Set(options.allowedHosts || []);
    this.timeoutMs = Math.max(100, Number(options.timeoutMs) || 6000);
    this.retries = Math.max(0, Number(options.retries) || 2);
    this.backoffBaseMs = Math.max(50, Number(options.backoffBaseMs) || 300);
    this.fetchImpl = options.fetchImpl || fetch;
    this.semaphore = new Semaphore(options.maxConcurrency || 4);
  }

  assertUrlAllowed(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch {
      throw new UpstreamError("上游URL不合法", { url });
    }
    if (parsed.protocol !== "https:") {
      throw new UpstreamError("仅允许 HTTPS 上游", { url: parsed.toString() });
    }
    if (!this.allowedHosts.has(parsed.hostname)) {
      throw new UpstreamError("上游域名不在白名单", { host: parsed.hostname });
    }
    return parsed;
  }

  async requestJson(url, options = {}) {
    const parsed = this.assertUrlAllowed(url);
    const maxRetries = options.retries ?? this.retries;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const schema = options.schema || null;

    await this.semaphore.acquire();
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await this.fetchImpl(parsed.toString(), {
            method: options.method || "GET",
            headers: options.headers || { accept: "application/json" },
            body: options.body,
            cf: options.cf,
            signal: controller.signal,
          });
          const text = await response.text();
          if (!response.ok) {
            if (attempt < maxRetries && isRetryableStatus(response.status)) {
              await sleep(this.backoffBaseMs * (attempt + 1));
              continue;
            }
            throw new UpstreamError("上游请求失败", {
              status: response.status,
              body: text.slice(0, 500),
              url: parsed.toString(),
            });
          }
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw new UpstreamError("上游响应不是合法 JSON", { url: parsed.toString() });
          }
          if (schema && !schema(data)) {
            throw new UpstreamSchemaError("上游响应未通过 schema 预校验", { url: parsed.toString() });
          }
          return { data, response };
        } catch (err) {
          if (isAbortError(err)) {
            if (attempt < maxRetries) {
              await sleep(this.backoffBaseMs * (attempt + 1));
              continue;
            }
            throw new UpstreamTimeoutError("上游请求超时", { timeoutMs, url: parsed.toString() });
          }
          if (attempt < maxRetries) {
            await sleep(this.backoffBaseMs * (attempt + 1));
            continue;
          }
          if (err instanceof UpstreamError) throw err;
          throw new UpstreamError("上游请求异常", { message: String(err?.message || err), url: parsed.toString() });
        } finally {
          clearTimeout(timer);
        }
      }
      throw new UpstreamError("上游请求失败");
    } finally {
      this.semaphore.release();
    }
  }
}

export function createDefaultUpstreamClient(fetchImpl = fetch) {
  return new UpstreamClient({
    fetchImpl,
    timeoutMs: 8000,
    retries: 2,
    backoffBaseMs: 250,
    maxConcurrency: 4,
    allowedHosts: ["uapis.cn", "api.aicu.cc", "grok.726748.xyz", "api.github.com"],
  });
}
