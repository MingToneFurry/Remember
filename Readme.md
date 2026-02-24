# Remember（rem.furry.ist）

这是一个基于 **Cloudflare Workers + R2 + KV** 的纪念页系统：
- 首页输入 UID，触发生成专属页面。
- 首页展示最近生成页面。
- 用户可上传几十 KB 到 300MB 的原始数据，系统保存到 R2。
- 关键写接口全部受 Turnstile 保护。
- 公共页面尽可能缓存，写接口 `no-store`。

---

## 已实现功能总览

### 1. 页面路由
- `GET /`：首页（UID 输入、Turnstile、最近列表）
- `GET /u/:uid`：用户专属纪念页
- `GET /admin`：管理页占位（需 Cloudflare Access）
- `GET /sitemap.xml`
- `GET /robots.txt`

### 2. 公共 API
- `GET /api/recent?limit=`：最近生成列表（`limit` 1~50）
- `GET /api/proxy/:source`：白名单代理（`allVid/comment/vidInfo`）
- `POST /api/upload/init`：初始化分片上传
- `PUT /api/upload/part`：上传分片
- `POST /api/upload/complete`：完成分片上传
- `POST /api/generate`：创建生成任务
- `GET /api/job/:jobId`：查询任务状态
- `POST /api/removal-requests`：提交移除申请
- `GET /api/removal-requests/:id?code=`：查询移除申请状态

### 3. 管理 API（Cloudflare Access）
- `GET /api/admin/requests?status=&limit=&cursor=`
- `POST /api/admin/requests/:id/approve`
- `POST /api/admin/requests/:id/reject`
- `POST /api/admin/pages/:uid/unpublish`
- `POST /api/admin/pages/:uid/regenerate`

### 4. 存储结构
- 页面 HTML：`pages/{uid}.html`
- 原始数据：`raw/YYYY-MM-DD/{uid}/...`
- 生成快照：`snapshots/{uid}/{jobId}.json`
- 页面元数据：`meta:uid:{uid}`
- 最近列表：`recent:list`
- 上传会话：`upload:{uploadId}`
- 任务状态：`job:{jobId}`
- 限流：`rl:ip:{scope}:{ip}:{day}`
- UID 冷却：`cooldown:uid:{uid}`
- 申诉单：`removal:req:{id}`

---

## 安全设计（当前版本）

1. **Turnstile 强制校验**
   - `generate`、`upload/init`、`upload/complete`、`removal-requests` 都必须提交 token。

2. **上传令牌签名保护**
   - 上传分片与完成必须提交带签名且有过期时间的上传令牌。
   - 防止他人猜测 uploadId 后插入恶意分片。

3. **SSRF 防护**
   - 代理接口固定 source 白名单和固定上游域名。
   - 不支持任意 URL 透传。

4. **XSS 防护**
   - 所有页面动态内容输出时进行 HTML 转义。
   - CSP + 基础安全响应头。

5. **权限隔离**
   - admin 路由必须由 Cloudflare Access 在边缘强制保护，同时 Worker 会对 `cf-access-jwt-assertion` 做签名和 `aud` 校验。

6. **防刷限制**
   - 按 IP 的每日限流：代理/生成/上传初始化。
   - UID 生成冷却 2 小时。

7. **缓存策略**
   - 可读页面/列表缓存；写接口与任务状态全部 no-store。

---

## 部署步骤（完整）

## 1) 创建 Cloudflare 资源
1. Worker：绑定域名 `rem.furry.ist`
2. R2 bucket：`remember-data`
3. KV namespace：`REMEMBER_KV`
4. Turnstile：创建站点，记录 site key / secret
5. Access：为 `/admin*` 与 `/api/admin/*` 配置 Access 应用

## 2) 配置 `wrangler.toml`

```toml
name = "remember-pages"
main = "workers.js"
compatibility_date = "2026-01-15"
workers_dev = true

[vars]
TURNSTILE_SITE_KEY = "<site-key>"
ACCESS_AUD = "<cloudflare-access-aud>"

[[r2_buckets]]
binding = "REMEMBER_DATA"
bucket_name = "remember-data"

[[kv_namespaces]]
binding = "REMEMBER_KV"
id = "<your-kv-id>"

[env.production]
routes = [{ pattern = "rem.furry.ist/*", zone_name = "furry.ist" }]

[env.production.vars]
TURNSTILE_SITE_KEY = "<site-key>"
ACCESS_AUD = "<cloudflare-access-aud>"

[[env.production.r2_buckets]]
binding = "REMEMBER_DATA"
bucket_name = "remember-data"

[[env.production.kv_namespaces]]
binding = "REMEMBER_KV"
id = "<your-kv-id>"
```

## 3) 注入密钥

```bash
wrangler secret put TURNSTILE_SECRET --env production
wrangler secret put TOKEN_SIGNING_SECRET --env production
```

> `TOKEN_SIGNING_SECRET` 用于上传令牌签名，必须是高强度随机字符串。
> `ACCESS_AUD` 来自 Cloudflare Access Application 的 AUD（JWT aud claim），可配置多个值并用逗号分隔。

## 4) 本地联调

```bash
wrangler dev
```

## 5) 发布

```bash
wrangler deploy --env production
```

## 6) 上线核验清单

1. 访问 `/` 显示 Turnstile 与最近列表
2. 提交 UID 后 `/api/generate` 返回 jobId
3. 轮询 `/api/job/:jobId` 直到 succeeded
4. `/u/:uid` 可访问且可缓存
5. 上传链路 init/part/complete 成功
6. admin 接口无 Access 时 403
7. `/sitemap.xml`、`/robots.txt` 正常

---

## 二次安全 Review（上线前建议）

### 已覆盖高风险点
- SSRF：已通过 source 与固定域名白名单封死。
- XSS：模板输出 escape + CSP。
- 越权：admin 接口依赖 Access + Worker 内 JWT 验签。
- 重放：上传 token 有签名+过期。
- 缓存污染：写接口 `no-store`。

### 建议继续加强（可选）
1. 在 WAF 添加国家/ASN/IP 风险规则。
2. 对上传内容增加 hash 校验与反病毒扫描（异步）。
3. 管理接口加入审计日志（写入 R2 或 Logpush）。
4. 对 Turnstile 失败进行渐进式封禁策略。
5. 为代理返回做 schema 验证，避免上游异常字段影响前端。
