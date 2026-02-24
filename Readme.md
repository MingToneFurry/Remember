# Remember（rem.furry.ist）

Remember 是一个基于 Cloudflare 的异步纪念页生成系统，当前实现为：
- Worker 实时 API 与页面服务
- Cloudflare Queues 异步任务队列
- Grok 分析（失败自动降级）
- 生成产物自动提交到 GitHub `generated-pages` 分支
- GitHub Actions 触发 Cloudflare 部署与缓存清理

## 统一数据声明
所有第三方 API 聚合结果均会附带：
`dataNotice: "第三方API数据可能不准确，仅供纪念参考"`

页面与接口都展示该声明。

## 架构总览
1. 前端提交 UID 到 `POST /api/generate`
2. Worker 创建 job 并发送 Queue 消息
3. Queue 消费器执行：抓数 -> 分析 -> 渲染 -> 落盘 -> 同步 GitHub
4. 用户通过 `GET /api/job/:jobId` 轮询状态
5. 页面生成后可通过 `/u/:uid` 访问，`/sitemap.xml` 与最近列表自动更新

## 已实现接口
### 页面
- `GET /` 首页（任务创建、阶段进度、最近列表）
- `GET /u/:uid` 纪念页
- `GET /sitemap.xml`
- `GET /robots.txt`
- `GET /admin`（需 Access）

### 公共 API
- `GET /api/recent?limit=1..50`
- `GET /api/proxy/:source`，`source` 支持：`allVid | vidInfo | comment | danmu | zhibodanmu`
- `POST /api/upload/init`
- `PUT /api/upload/part`
- `POST /api/upload/complete`
- `POST /api/generate`
  - 返回：`{ ok, jobId, queued, stage, estimatedWaitSec }`
- `GET /api/job/:jobId`
  - 返回扩展字段：`stage`, `progress`, `warnings`, `gitSync`, `updatedAt`
- `POST /api/removal-requests`
- `GET /api/removal-requests/:id?code=`

### 管理 API（Cloudflare Access 保护）
- `GET /api/admin/requests?status=&limit=&cursor=`
- `POST /api/admin/requests/:id/approve`
- `POST /api/admin/requests/:id/reject`
- `POST /api/admin/pages/:uid/unpublish`
- `POST /api/admin/pages/:uid/regenerate`

## 存储结构
- R2
  - `pages/{uid}.html`
  - `snapshots/{uid}/{jobId}.json`
  - `raw/YYYY-MM-DD/{uid}/...`
- KV
  - `job:{jobId}` 任务状态
  - `meta:uid:{uid}` 页面元数据
  - `recent:list` 最近列表
  - `uploads:index:{uid}` 上传索引
  - `upload:{uploadId}` 上传会话
  - `removal:req:{id}` 申诉单
  - `cache:sitemap:xml` sitemap 缓存
  - 限流键：`rl:*`

## 安全基线
- Turnstile 强制校验（generate/upload/removal）
- Cloudflare Access JWT 校验（admin）
- 代理 SSRF 白名单（固定 host + 固定 source）
- 输入参数严格校验（UID/jobId/code 等）
- 双层限流（分钟 + 天）
- CSP nonce + 安全响应头（HSTS/COOP/CORP 等）
- 错误脱敏（5xx 不回传内部细节，回传 requestId）

## 性能策略
- 抓数并行化（投稿/评论/弹幕/直播弹幕）
- R2/KV 批量写入
- 最近列表与 sitemap 热缓存
- sitemap 增量更新优先，必要时全量重建

## 本地命令
```bash
npm run check
npm run test
npm run perf
npm run dryrun
```

## 部署与运维手册
### 1. Cloudflare 资源
- Worker
- KV namespace：`REMEMBER_KV`
- R2 bucket：`REMEMBER_DATA`
- Queue：`remember-analysis`（producer + consumer）
- Turnstile 站点
- Access 应用（保护 `/admin` 和 `/api/admin/*`）

### 2. 关键配置（`wrangler.toml`）
- `ANALYSIS_QUEUE` 生产/消费绑定
- `DATA_NOTICE` 统一声明
- `GITHUB_BRANCH=generated-pages`
- `GITHUB_PAGES_PREFIX=generated`

### 3. 必要 Secrets
```bash
wrangler secret put TURNSTILE_SECRET --env production
wrangler secret put TOKEN_SIGNING_SECRET --env production
wrangler secret put GROK_API_KEY --env production
wrangler secret put GITHUB_TOKEN --env production
```

可选：
```bash
wrangler secret put GITHUB_OWNER --env production
wrangler secret put GITHUB_REPO --env production
```

### 4. 发布流程
```bash
npm run check
npm run test
npm run perf
npm run dryrun
wrangler deploy --env production
```

### 5. 运行观察点
- job 流转：`queued -> fetching -> analyzing -> rendering -> syncing -> succeeded`
- 失败任务应包含可读 `error/warnings`，且不泄露密钥
- Git 同步结果应包含 `commitSha`

### 6. GitHub Actions 双轨
- 监听 `generated-pages` 分支的 `generated/**` 变更
- 自动执行 Worker 发布
- 按变更 UID 生成 purge URL，清理 Cloudflare 缓存

## 验收清单
1. 提交 UID 后 1 秒内返回 `jobId + queued`
2. job 阶段与进度可轮询观察
3. 纪念页包含 Top10 视频、评论/弹幕片段、注册时间估算、模型分析（或降级说明）
4. 页面与接口都包含统一数据声明
5. 生成后 `recent` 与 `sitemap` 自动更新
6. 自动提交到 `generated-pages` 成功并记录 commit SHA
