# 发布前验收清单（2026-02-24）

## 命令检查
1. `npm run check`：通过
2. `npm run test`：通过（21/21）
3. `npm run perf`：通过（top10 基准 < 220ms）
4. `npm run dryrun`：通过（Wrangler 配置解析与绑定检查通过）
5. `npx yaml-lint .github/workflows/deploy-generated-pages.yml`：通过

## 安全回归
1. 代理源白名单与参数校验：通过
2. XSS 转义与 CSP nonce：通过
3. Turnstile 强制校验（生成/上传/申诉）：通过
4. Access 管理路由 JWT 校验：通过
5. 错误脱敏与 requestId 回传：通过

## 性能回归
1. 抓取并行化：通过
2. R2/KV 批量写入：通过
3. `recent/sitemap` 热缓存：通过
4. 任务流程阶段可观测：通过

## CI/CD 回归
1. `generated-pages` 分支 workflow 存在并可通过 YAML lint
2. 工作流包含变更 URL 缓存清理逻辑（首页、UID 页面、sitemap）

## 阻塞与处理
- 阻塞：`wrangler.toml` UTF-8 BOM 导致 dry-run 报 `Unknown character 65279`
- 处理：移除 BOM 并重跑，dry-run 已通过

