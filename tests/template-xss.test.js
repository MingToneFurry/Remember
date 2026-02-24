import test from "node:test";
import assert from "node:assert/strict";
import { buildMemorialPage } from "../src/templates/memorialTemplate.js";

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

test("buildMemorialPage should escape user-controlled fields", () => {
  const html = buildMemorialPage(
    "123",
    {
      createdAt: Date.now(),
      dataNotice: "<script>alert(1)</script>",
      modelOutput: { summary: "<img src=x onerror=alert(2)>" },
      comments: { items: [{ message: "<svg onload=alert(3)>" }] },
      danmu: { items: [{ content: "<script>alert(4)</script>" }] },
      liveDanmu: { items: [{ danmu: [{ uname: "<u>", text: "<b>" }] }] },
      topVideoInfos: [{ bvid: "BV1", data: { title: "<script>alert(5)</script>" }, playCount: 1 }],
    },
    esc,
  );

  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("<img src=x onerror=alert(2)>"), false);
  assert.equal(html.includes("<svg onload=alert(3)>"), false);
  assert.equal(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
});
