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

test("buildMemorialPage should render b23 links and no-referrer policies", () => {
  const html = buildMemorialPage(
    "456",
    {
      createdAt: Date.now(),
      topVideoInfos: [
        {
          bvid: "BV1xx411c7Q1",
          data: { title: "video-1", cover: "https://i0.hdslb.com/bfs/archive/cover.jpg", stat: { view: 100 } },
          playCount: 100,
        },
        {
          aid: "12345",
          data: { title: "video-2", stat: { view: 50 } },
          playCount: 50,
        },
      ],
    },
    esc,
  );

  assert.equal(html.includes("https://b23.tv/BV1xx411c7Q1"), true);
  assert.equal(html.includes("https://b23.tv/av12345"), true);
  assert.equal(html.includes('<meta name="referrer" content="no-referrer"/>'), true);
  assert.equal(html.includes('referrerpolicy="no-referrer"'), true);
});
