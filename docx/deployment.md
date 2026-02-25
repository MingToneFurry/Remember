# Remember 部署文档（Cloudflare + 自动部署）

最后更新：2026-02-25

## 1. 你要的两种自动部署方式

本项目支持两种自动部署路径：

1. `GitHub Actions`（仓库内执行 `wrangler deploy`）
2. `Cloudflare Workers Git 集成（Workers Builds）`（Cloudflare 直接连 GitHub/GitLab）

建议先确定主路径，再启用，避免双重部署互相覆盖。

### 1.1 方案选择建议

- 选 `GitHub Actions`：
  - 你希望部署逻辑和校验步骤全部在仓库可审计（YAML 可评审）。
  - 你需要在部署后执行额外动作（例如 purge cache、自定义脚本）。
- 选 `Workers Git 集成`：
  - 你希望 Cloudflare 原生托管构建和部署，不维护太多 CI 细节。
  - 你希望 PR/提交状态直接显示在 Git 提供商集成里。

### 1.2 不建议同时启用同一分支自动部署

如果两个系统都监听同一个代码分支，会出现重复部署。建议：

- 只保留一个“生产 Worker 部署入口”；
- 另一个仅用于辅助（例如只做测试，不做 deploy）。

---

## 2. Cloudflare 详细部署（通用基础）

不管你选哪条自动部署路径，先完成以下基础配置。

## 2.1 前置条件

- Cloudflare 账号已接入站点 `furry.ist`
- 本地 Node.js >= 20
- Wrangler 4.x 可用

```bash
node -v
npx wrangler --version
npx wrangler login
```

## 2.2 创建云端资源

### 2.2.1 KV

```bash
npx wrangler kv namespace create REMEMBER_KV
```

记录返回的 `id`，稍后填入 `wrangler.toml`。

### 2.2.2 R2

```bash
npx wrangler r2 bucket create remember-data
```

### 2.2.3 Queue

```bash
npx wrangler queues create remember-analysis
```

如果出现 `The specified queue settings are invalid`（错误码 100128），按账户上限显式指定保留时长：

```bash
npx wrangler queues create remember-analysis --message-retention-period-secs 86400
```

说明：部分账户当前 `message_retention_period` 上限是 `86400` 秒，而不是 `345600` 秒。

### 2.2.4 Turnstile

在 Cloudflare Dashboard 创建 Turnstile Site：

- Hostname 包含 `rem.furry.ist`
- 记录 `Site Key` 与 `Secret Key`

### 2.2.5 Cloudflare Access（保护管理接口）

在 Zero Trust 创建 Self-hosted 应用，覆盖路径：

- `/admin*`
- `/api/admin/*`

创建策略后复制 `AUD`（JWT aud claim），写入 `ACCESS_AUD`。

## 2.3 配置 `wrangler.toml`

必须确认以下内容与云端资源一致：

- `[[kv_namespaces]].id`
- `[[env.production.kv_namespaces]].id`
- `[[r2_buckets]].bucket_name`
- `[[queues.producers]].queue`
- `[[queues.consumers]].queue`
- `[env.production].routes`
- `[vars]/[env.production.vars]` 中 `TURNSTILE_SITE_KEY`、`ACCESS_AUD`

当前项目关键项示例（以仓库文件为准）：

```toml
name = "remember-pages"
main = "workers.js"
compatibility_date = "2026-01-15"

[[queues.producers]]
binding = "ANALYSIS_QUEUE"
queue = "remember-analysis"

[[queues.consumers]]
queue = "remember-analysis"
max_batch_size = 1
max_batch_timeout = 3

[env.production]
routes = [{ pattern = "rem.furry.ist/*", zone_name = "furry.ist" }]
```

## 2.4 注入生产 Secrets（Cloudflare）

```bash
npx wrangler secret put TURNSTILE_SECRET --env production
npx wrangler secret put TOKEN_SIGNING_SECRET --env production
npx wrangler secret put GROK_API_KEY --env production
npx wrangler secret put GITHUB_TOKEN --env production
```

可选（未设置则由代码走默认/回退逻辑）：

```bash
npx wrangler secret put GITHUB_OWNER --env production
npx wrangler secret put GITHUB_REPO --env production
```

## 2.5 发布前本地校验

```bash
npm run check
npm run test
npm run perf
npm run dryrun
```

---

## 3. 方案 A：GitHub Actions 自动部署（推荐当前仓库继续使用）

本仓库已有 workflow：

- 文件：`.github/workflows/deploy-generated-pages.yml`
- 触发：`generated-pages` 分支下 `generated/**` 变更
- 行为：`check -> test -> wrangler deploy -> purge changed URLs`

## 3.1 GitHub Secrets 配置

在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 添加：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`

## 3.2 API Token 最小权限建议

`CLOUDFLARE_API_TOKEN` 建议至少具备：

- Account 级：
  - `Workers Scripts: Edit`
  - `Workers KV Storage: Edit`
  - `Workers R2 Storage: Edit`
  - `Account Settings: Read`
  - 若涉及 Queue 绑定变更，建议补 `Queues: Edit`
- Zone 级：
  - `Workers Routes: Edit`
  - `Cache Purge`

并把 token 资源范围限制到生产账户与生产 zone。

## 3.3 触发与发布流

1. Worker 内将产物提交到 `generated-pages` 分支（`generated/**`）。
2. GitHub Action 被触发：
   - 安装依赖
   - `npm run check`
   - `npm run test`
   - `npx wrangler deploy --env production`
   - 计算变更 URL 并调用 Cloudflare Cache Purge API
3. 部署完成后访问线上域名验证。

## 3.4 手动触发

workflow 支持 `workflow_dispatch`，可在 GitHub Actions 页面手动触发一次部署。

## 3.5 失败排查要点

- `Authentication error`：检查 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
- `route permission denied`：补 `Workers Routes: Edit`
- purge 失败：确认 `CLOUDFLARE_ZONE_ID` 与 `Cache Purge` 权限

---

## 4. 方案 B：Workers Git 集成自动部署（Workers Builds）

适合希望 Cloudflare 直接托管部署流程的场景。

## 4.1 创建或绑定 Git 集成

1. 进入 `Cloudflare Dashboard -> Workers & Pages`
2. 选择：
   - 新建 Worker：`Create application -> Import a repository`
   - 已有 Worker：进入 Worker 后 `Settings -> Builds` 绑定仓库
3. 授权 `Cloudflare Workers and Pages` GitHub App（或 GitLab）
4. 选择目标仓库与分支（通常是 `main`）

## 4.2 构建与部署参数建议

在 Builds 配置中设置：

- Install command：`npm ci`（无 lockfile 可用 `npm install`）
- Build/Check command：`npm run check && npm run test`
- Deploy command：`npx wrangler deploy --env production`
- Root directory：仓库根目录（若 monorepo 则填写子目录）
- Watch paths（可选）：限制触发范围，避免无关改动触发部署

## 4.3 环境变量与密钥

在 Worker 的 `Settings -> Variables / Secrets` 中补齐与生产一致的配置：

- Vars：`TURNSTILE_SITE_KEY`、`ACCESS_AUD`、`DATA_NOTICE` 等
- Secrets：`TURNSTILE_SECRET`、`TOKEN_SIGNING_SECRET`、`GROK_API_KEY`、`GITHUB_TOKEN`

## 4.4 与 GitHub Actions 共存时的规则

若启用 Workers Git 集成部署 `main`，同时保留现有 `generated-pages` Action：

- 可以共存（监听分支不同）
- 但必须明确哪条链路负责“生产 Worker deploy”
- 建议避免两条链路都部署同一个 Worker 同一环境

---

## 5. 手动部署（兜底）

自动部署出现故障时，使用手动命令兜底：

```bash
npm run check
npm run test
npm run perf
npm run dryrun
npx wrangler deploy --env production
```

---

## 6. 上线后验收

1. `GET /` 可访问，Turnstile 正常
2. `POST /api/generate` 可返回 `jobId`
3. `GET /api/job/:jobId` 可看到阶段流转
4. `GET /u/:uid` 页面可访问
5. `GET /sitemap.xml` 与 `GET /robots.txt` 正常
6. `/api/admin/*` 未授权访问返回 403
7. GitHub Action 或 Workers Builds 有成功部署记录

---

## 7. 回滚策略

### 7.1 GitHub Actions 路径回滚

1. 回退到稳定 commit
2. 推送分支触发重新部署，或手动 `workflow_dispatch`

```bash
git checkout <stable-commit>
git push origin HEAD:<deploy-branch>
```

### 7.2 Workers Git 集成路径回滚

1. 在 Git 提供商回退分支到稳定 commit
2. 触发一次新的构建部署

### 7.3 紧急手动回滚

```bash
git checkout <stable-commit>
npx wrangler deploy --env production
```

---

## 8. 常见问题

### 8.1 `ACCESS_AUD not configured`

- 原因：生产 vars 未配置或值为空
- 处理：在 Cloudflare 生产环境 vars 补齐 `ACCESS_AUD`

### 8.2 管理接口始终 403

- 原因：Access 应用路径未覆盖 `/api/admin/*` 或策略未放行
- 处理：检查 Access 应用路径、策略、AUD 一致性

### 8.3 `wrangler deploy` 权限错误

- 原因：API token 权限不足
- 处理：补齐 `Workers Scripts Edit / Workers Routes Edit / KV / R2 / Cache Purge` 等必要权限

### 8.4 队列相关绑定报错

- 原因：Queue 名称或权限不匹配
- 处理：核对 `wrangler.toml` 队列名与 Cloudflare 账户下队列一致，必要时补 `Queues Edit`

### 8.5 `The specified queue settings are invalid`

- 常见报错：`message_retention_period must be between 60 and 86400 seconds`
- 原因：账户允许的消息保留上限低于 Wrangler 默认值
- 处理：创建队列时显式使用 `--message-retention-period-secs 86400`

---

## 9. 运维建议

- 生产部署统一走一条主链路（Action 或 Git 集成），减少冲突
- 所有 token 使用最小权限和最小资源范围
- 每次部署记录：时间、commit hash、执行人、结果
- 定期检查 KV/R2 用量、队列积压、5xx 错误趋势
