import { UpstreamError, UpstreamTimeoutError } from "./upstreamClient.js";

function fallbackResult(reason) {
  return {
    source: "fallback",
    summary: "该用户留下了可追溯的公开内容片段，本页基于第三方接口聚合生成，结果仅供纪念参考。",
    profileTags: ["公开内容纪念", "自动生成摘要"],
    highlights: [],
    confidence: "low",
    reason,
  };
}

function parseModelContent(content) {
  const raw = String(content || "").trim();
  if (!raw) throw new UpstreamError("模型输出为空");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not object");
    return {
      source: "grok",
      summary: String(parsed.summary || "").slice(0, 1200),
      profileTags: Array.isArray(parsed.profileTags) ? parsed.profileTags.slice(0, 12).map((x) => String(x).slice(0, 40)) : [],
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 12).map((x) => String(x).slice(0, 160)) : [],
      confidence: String(parsed.confidence || "medium"),
      reason: "",
    };
  } catch {
    throw new UpstreamError("模型输出不是合法 JSON");
  }
}

export function buildGrokPrompt(snapshot) {
  return [
    "你是纪念页内容分析助手。输出必须是 JSON，不要包含 Markdown。",
    "JSON 字段：summary(字符串), profileTags(字符串数组), highlights(字符串数组), confidence(字符串)。",
    "要求：",
    "1) 文风克制、尊重，不做攻击或隐私推断。",
    "2) 明确说明数据来自第三方接口，可能不准确。",
    "3) 不要编造未提供事实。",
    "",
    `uid: ${snapshot.uid}`,
    `dataNotice: ${snapshot.dataNotice || "第三方API数据可能不准确，仅供纪念参考"}`,
    `videos_count: ${Number(snapshot.allVid?.videos?.length || 0)}`,
    `comments_count: ${Number(snapshot.comments?.items?.length || 0)}`,
    `danmu_count: ${Number(snapshot.danmu?.items?.length || 0)}`,
    `live_danmu_count: ${Number(snapshot.liveDanmu?.items?.length || 0)}`,
    `reg_date_estimate: ${snapshot.regDateEstimate?.estimatedRange || "未知"}`,
  ].join("\n");
}

export async function analyzeWithGrok(env, client, snapshot) {
  const apiUrl = String(env.GROK_API_URL || "").trim();
  const apiKey = String(env.GROK_API_KEY || "").trim();
  const model = String(env.GROK_MODEL || "grok-4.1-expert").trim();
  if (!apiUrl || !apiKey) {
    return fallbackResult("GROK 配置缺失");
  }

  const payload = {
    model,
    temperature: 0.2,
    max_tokens: 900,
    messages: [
      { role: "system", content: "你是纪念页分析器，只返回 JSON。" },
      { role: "user", content: buildGrokPrompt(snapshot) },
    ],
  };

  try {
    const { data } = await client.requestJson(apiUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs: 25000,
      retries: 1,
      schema: (resp) => Array.isArray(resp?.choices),
    });
    const content = data?.choices?.[0]?.message?.content;
    return parseModelContent(content);
  } catch (err) {
    if (err instanceof UpstreamTimeoutError) return fallbackResult("模型请求超时，已降级");
    return fallbackResult(`模型请求失败：${String(err?.message || err)}`);
  }
}
