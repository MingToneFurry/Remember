# Remember 详细部署文档

最后更新：2026-02-24

## 1. 部署目标

将 `Remember` 以 Cloudflare Workers 的形式部署到生产域名 `rem.furry.ist`，并正确接入：

- Workers 路由
- R2（对象存储）
- KV（元数据/任务状态）
- Turnstile（人机验证）
- Cloudflare Access（管理接口鉴权）

## 2. 前置条件

执行部署前请确认：

- 已有 Cloudflare 账号，且站点 `furry.ist` 已接入 Cloudflare
- 本地已安装 Node.js（建议 20+）
- 本地可用 `npx wrangler`（建议 4.x）
- 具备以下 Cloudflare 权限：Workers、KV、R2、Zero Trust Access、Turnstile

快速检查：

```bash
node -v
npx wrangler --version
```

首次使用 Wrangler 需要登录：

```bash
npx wrangler login
```

## 3. 创建云端资源

### 3.1 创建 KV Namespace

```bash
npx wrangler kv namespace create REMEMBER_KV
```

记录命令输出里的 `id`，稍后填入 `wrangler.toml`。

### 3.2 创建 R2 Bucket

```bash
npx wrangler r2 bucket create remember-data
```

### 3.3 创建 Turnstile 站点

在 Cloudflare Dashboard 创建 Turnstile Site：

- Hostname 建议包含 `rem.furry.ist`
- 记录 `Site Key` 和 `Secret Key`

后续：

- `TURNSTILE_SITE_KEY` 写入 `wrangler.toml`（变量）
- `TURNSTILE_SECRET` 通过 `wrangler secret put` 注入（密钥）

### 3.4 创建 Cloudflare Access 应用

在 Zero Trust 中创建 Self-hosted 应用，保护：

- `/admin*`
- `/api/admin/*`

建议策略：

- 仅允许指定邮箱、邮箱域、或特定身份组
- 默认拒绝其他访问

从应用详情中复制 `AUD`（JWT aud claim），后续写入 `ACCESS_AUD`。

## 4. 配置 `wrangler.toml`

当前项目使用：

- 默认环境用于本地开发
- `env.production` 用于生产路由与生产绑定

你需要至少完成这些替换：

- `[[kv_namespaces]].id`
- `[[env.production.kv_namespaces]].id`
- `[vars].TURNSTILE_SITE_KEY`
- `[env.production.vars].TURNSTILE_SITE_KEY`
- `[vars].ACCESS_AUD`
- `[env.production.vars].ACCESS_AUD`

参考结构（以仓库文件为准）：

```toml
name = "remember-pages"
main = "workers.js"
compatibility_date = "2026-01-15"
workers_dev = true

[vars]
TURNSTILE_SITE_KEY = "<site-key>"
ACCESS_AUD = "<access-aud>"

[[r2_buckets]]
binding = "REMEMBER_DATA"
bucket_name = "remember-data"

[[kv_namespaces]]
binding = "REMEMBER_KV"
id = "<kv-id>"

[env.production]
routes = [{ pattern = "rem.furry.ist/*", zone_name = "furry.ist" }]

[env.production.vars]
TURNSTILE_SITE_KEY = "<site-key>"
ACCESS_AUD = "<access-aud>"

[[env.production.r2_buckets]]
binding = "REMEMBER_DATA"
bucket_name = "remember-data"

[[env.production.kv_namespaces]]
binding = "REMEMBER_KV"
id = "<kv-id>"
```

如果有多个 Access AUD，可用逗号拼接：

```toml
ACCESS_AUD = "aud1,aud2,aud3"
```

## 5. 注入密钥（Secrets）

### 5.1 生成上传签名密钥

可用 Node 生成 32 字节随机值：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5.2 写入生产 Secrets

```bash
npx wrangler secret put TURNSTILE_SECRET --env production
npx wrangler secret put TOKEN_SIGNING_SECRET --env production
```

注意：

- `TOKEN_SIGNING_SECRET` 需足够随机，且长度建议不低于 32 字节
- 不要把 secret 直接写入 `wrangler.toml`

## 6. 本地联调

```bash
npx wrangler dev
```

联调建议：

- 先验证 `GET /`、`GET /api/recent`
- 再验证 `POST /api/generate` 和任务轮询
- 管理接口在本地默认不会有 Access 头，返回 403 属于预期

## 7. 发布前检查

### 7.1 语法检查

```bash
node --check workers.js
```

### 7.2 生产 dry-run

```bash
npx wrangler deploy --dry-run --env production
```

重点确认输出里存在以下绑定：

- `env.REMEMBER_KV`
- `env.REMEMBER_DATA`
- `env.TURNSTILE_SITE_KEY`
- `env.ACCESS_AUD`

## 8. 正式发布

```bash
npx wrangler deploy --env production
```

发布后建议记录：

- git commit hash
- 发布时间
- wrangler 输出摘要

## 9. 上线验收清单

按顺序验证：

1. `GET /` 页面可访问，Turnstile 正常展示
2. `GET /api/recent?limit=5` 正常返回 JSON
3. 提交 UID 后 `POST /api/generate` 返回 `jobId`
4. 轮询 `GET /api/job/:jobId` 最终为 `succeeded`
5. `GET /u/:uid` 可访问
6. `GET /sitemap.xml` 和 `GET /robots.txt` 正常
7. 未通过 Access 访问 `/api/admin/requests` 返回 403
8. 上传链路 `init/part/complete` 成功

## 10. 定时清理任务（可选但建议）

项目已实现 `scheduled` 清理逻辑（R2 原始数据与过期上传会话），但需要触发器才能运行。

可在 `wrangler.toml` 增加：

```toml
[env.production.triggers]
crons = ["0 4 * * *"]
```

含义：每天 UTC 04:00 执行一次。

## 11. 回滚方案

推荐使用“回退代码 + 重新部署”：

```bash
git checkout <上一个稳定commit>
npx wrangler deploy --env production
```

回滚后做最小验收：

- `/`
- `/api/recent`
- `/u/:uid`
- `/api/admin/requests`（未授权应 403）

## 12. 常见问题与排查

### 12.1 `ACCESS_AUD not configured`

原因：

- `wrangler.toml` 的 `ACCESS_AUD` 为空或未配置

处理：

- 在 `[env.production.vars]` 填入 Access 应用的 AUD

### 12.2 管理接口一直 403

原因：

- Access 应用未覆盖 `/api/admin/*`
- Access 策略未放行当前用户
- `ACCESS_AUD` 与实际应用不匹配

处理：

- 检查 Access 应用路径和策略
- 重新确认 AUD 值

### 12.3 上传完成失败（403/400）

原因：

- 上传 token 过期
- `TOKEN_SIGNING_SECRET` 配置不一致
- `parts` 列表不合法（重复 partNumber、缺失 etag）

处理：

- 重新走 `upload/init` 获取新 token
- 检查生产 secret 是否被误改

### 12.4 跨域请求失败

原因：

- 请求来源不在允许的 Origin 白名单

处理：

- 确认前端域名为 `https://rem.furry.ist` 或已纳入 Worker CORS 规则

## 13. 运行维护建议

- 每次发布前固定执行：`node --check` + `wrangler deploy --dry-run`
- 对生产发布建立变更记录（时间、commit、发布人）
- 周期性检查 KV/R2 资源使用量与错误日志
- 对管理接口访问行为保留审计记录
