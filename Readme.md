# Remember（rem.furry.ist）

此项目用于生成「已注销用户纪念页」：
- 首页输入 UID 后可创建专属页面。
- 首页展示最近生成页面。
- 写接口（生成、上传）启用 Cloudflare Turnstile 防护。
- 除必要接口外尽可能缓存。
- 支持几十 KB 到几百 MB的数据上传（R2 Multipart）。

## 当前已实现能力

### 1) 首页与专属页
- `GET /`：纪念站首页（UID 输入 + Turnstile + 最近生成列表）。
- `POST /api/generate`：创建/覆盖生成 `UID` 专属页。
- `GET /u/{uid}`：访问专属页。
- `GET /api/recent`：最近生成列表（短缓存）。

### 2) 大文件上传链路（R2 Multipart）
- `POST /api/upload/init`
  - 入参：`uid`, `fileName`, `size`, `mime`, `turnstileToken`
  - 返回：`uploadId`, `sessionToken`
- `PUT /api/upload/part?uid=...&uploadId=...&partNumber=...`
  - Header 需携带：`x-upload-session-token`
  - Body 为该分片二进制数据
  - 返回：`etag`
- `POST /api/upload/complete`
  - 入参：`uid`, `uploadId`, `sessionToken`, `parts[]`, `turnstileToken`
  - 完成合并并写入索引

> 上传设计说明：
> - 采用 R2 multipart，可覆盖几十 KB 到几百 MB 的波动场景。
> - 上传会话信息存 KV，并设置 TTL。
> - 通过 sessionToken 防止他人复用 uploadId 注入分片。

### 3) 缓存策略
- 首页 `/`：`public, s-maxage=1800`。
- 用户页 `/u/{uid}`：`public, s-maxage=86400, stale-while-revalidate=604800`。
- 最近列表 `/api/recent`：短缓存 `s-maxage=60`。
- 写接口：全部 `no-store`。

### 4) 安全策略（已落地）
- Turnstile：所有写接口关键步骤校验。
- 输入校验：UID 仅允许数字（1~20 位）。
- XSS 防护：页面输出统一 escape。
- 安全响应头：`CSP`, `X-Frame-Options`, `X-Content-Type-Options` 等。
- 上传保护：分片上传要求会话 token。

---

## 与文档接口结合建议

项目目前已打通“用户上传数据 -> R2 存储 -> 生成页展示摘要”链路。
后续可在 `POST /api/generate` 内增加：
1. 调用 `docx/api.md` 及相关接口抓取公开信息；
2. 对抓取结果与用户上传数据合并；
3. 调用分析模型生成文案；
4. 渲染完整纪念页并写入 `pages/{uid}.html`。

---

## 部署方法（完整）

## 前置资源
1. Cloudflare Worker（绑定域名 `rem.furry.ist`）
2. R2 Bucket：`remember-data`
3. KV Namespace：`REMEMBER_KV`
4. Turnstile Site Key + Secret

## 配置 `wrangler.toml`
- 已包含：
  - `REMEMBER_DATA`（R2）
  - `REMEMBER_KV`（KV）
  - `TURNSTILE_SITE_KEY`（公开 key）

将注释路由启用并改为你自己的 zone：
```toml
routes = [{ pattern = "rem.furry.ist/*", zone_name = "furry.ist" }]
```

## 配置密钥
```bash
wrangler secret put TURNSTILE_SECRET
```

## 本地调试
```bash
wrangler dev
```

## 部署
```bash
wrangler deploy
```

---

## API 示例

### 生成页面
```bash
curl -X POST https://rem.furry.ist/api/generate \
  -H 'content-type: application/json' \
  -d '{"uid":"123456","turnstileToken":"<token>"}'
```

### 初始化上传
```bash
curl -X POST https://rem.furry.ist/api/upload/init \
  -H 'content-type: application/json' \
  -d '{"uid":"123456","fileName":"data.json","size":1048576,"mime":"application/json","turnstileToken":"<token>"}'
```

### 上传分片
```bash
curl -X PUT 'https://rem.furry.ist/api/upload/part?uid=123456&uploadId=<uploadId>&partNumber=1' \
  -H 'x-upload-session-token: <sessionToken>' \
  --data-binary @part-1.bin
```

### 完成上传
```bash
curl -X POST https://rem.furry.ist/api/upload/complete \
  -H 'content-type: application/json' \
  -d '{"uid":"123456","uploadId":"<uploadId>","sessionToken":"<sessionToken>","turnstileToken":"<token>","parts":[{"partNumber":1,"etag":"<etag>"}]}'
```

---

## 最终安全 Review（本版本）

### 已检查并规避
- **XSS 注入**：模板插值统一转义。
- **未授权写操作**：关键写接口均需 Turnstile；分片接口需会话 token。
- **缓存污染**：写接口禁缓存，动态读接口短缓存，页面长缓存。
- **参数滥用**：UID/大小/partNumber 均有边界校验。

### 仍建议后续增强
1. 增加速率限制（如基于 IP + UID 的限频，建议用 DO 或 WAF 规则）。
2. 为上传补充 SHA-256 校验与重复文件去重。
3. 引入异步任务队列（生成任务状态机）避免高并发时重复生成。
4. 增加内容合规扫描（如恶意脚本片段、违规文本）。
5. 增加管理员审计日志与移除流程页面。

