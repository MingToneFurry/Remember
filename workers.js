const DEFAULT_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Remember - Bootstrap</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
        background: radial-gradient(circle at top, #f3f6fb, #e9eef8);
      }
      main {
        width: min(92vw, 720px);
        padding: 28px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 1.6rem;
      }
      p {
        margin: 0;
        line-height: 1.7;
      }
      code {
        background: rgba(0, 0, 0, 0.06);
        padding: 2px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Remember Worker is running</h1>
      <p>This is the T00 bootstrap. API, upload, generation, and admin features come next.</p>
    </main>
  </body>
</html>
`;

function htmlResponse(html, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, s-maxage=300");
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return new Response(html, { status, headers });
}

function notFoundResponse() {
  return htmlResponse("<h1>404 Not Found</h1>", 404, {
    "cache-control": "no-store",
  });
}

async function handleFetch(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/") {
    return htmlResponse(DEFAULT_HTML, 200, {
      "cache-control": "public, s-maxage=300",
    });
  }

  return notFoundResponse();
}

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    // Placeholder for T11 cleanup task.
    ctx.waitUntil(Promise.resolve());
  },
};
