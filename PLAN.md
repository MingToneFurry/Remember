# Remember 全量闭环实现计划（Worker + Queue + Grok + GitHub 双轨）

## 摘要
1. 已完成仓库全量读取（`workers.js`、`Readme.md`、`wrangler.toml`、`docx/*`、`example/*`、`.env`、`.gitignore`）。
2. 目标范围按你最新定义执行：以 `docx/api.md` 列表为准，落地投稿/评论/视频弹幕/直播弹幕/视频详情/注册时间估算，接入 Grok 分析，生成纪念页，自动更新 sitemap，自动清理变动页面缓存，并形成“Worker 实时服务 + 自动提交到 `generated-pages` + GitHub Actions 推送 Cloudflare”的双轨链路。
3. 已锁定实现决策：`先锁定现状基线`、`Cloudflare Queues`、`Worker 直推 GitHub`、`独立分支 generated-pages`、`异步任务分析`、`API 可能不准确声明必须落地`、`密钥暂不处理（按你的选择）`。

## 公开接口与类型变更
1. `GET /api/proxy/:source` 扩展 `source`：`allVid | vidInfo | comment | danmu | zhibodanmu`。
2. `POST /api/generate` 保持现有入参，返回新增字段：`queued`、`stage`、`estimatedWaitSec`。
3. `GET /api/job/:jobId` 扩展返回：`stage`、`progress`、`warnings`、`gitSync`、`updatedAt`。
4. 新增内部任务消息类型 `AnalysisQueueMessage`：`{ jobId, uid, requestedAt, traceId }`。
5. 新增聚合快照类型 `MemorialSnapshot`：`{ uid, generatedAt, disclaimer, sourceQuality, allVid, topVideoInfos, comments, danmu, liveDanmu, regDateEstimate, modelOutput }`。
6. 新增 Git 同步结果类型 `GitSyncResult`：`{ branch, commitSha, files, committedAt, status }`。
7. 所有外部 API 聚合结果新增统一声明字段：`dataNotice: "第三方API数据可能不准确，仅供纪念参考"`。

## 分步实施（每个小步骤一个 commit）
1. 步骤 1：提交当前工作区基线；commit：`chore: 锁定基线`；验收：`git status` 仅剩后续新增改动。
2. 步骤 2：初始化工程脚手架与命令；commit：`chore: 初始化工程`；改动：新增 `package.json`、`scripts/check`、`scripts/test`、`scripts/dryrun`；验收：`npm run check` 可执行。
3. 步骤 3：补齐配置契约；commit：`feat: 增加队列配置`；改动：`wrangler.toml` 增加 Queues 生产/消费绑定与新增 vars；验收：`npx wrangler deploy --dry-run --env production` 通过配置解析。
4. 步骤 4：拆分 Worker 模块；commit：`refactor: 拆分Worker模块`；改动：拆成 `src/config`、`src/http`、`src/routes`、`src/services`、`src/templates`，`workers.js` 仅做入口；验收：行为不变、`node --check` 通过。
5. 步骤 5：实现统一上游请求客户端；commit：`feat: 统一上游客户端`；改动：超时、重试、退避、并发限制、白名单域名、schema 预校验；验收：失败重试与超时单测通过。
6. 步骤 6：扩展代理源到 danmu/zhibodanmu 并对齐 docx；commit：`feat: 扩展代理源`；改动：新增 `danmu`、`zhibodanmu` 转发；`comment` 按 UID 聚合接口落地；验收：5 个 source 均可返回 JSON。
7. 步骤 7：实现投稿全量分页抓取；commit：`feat: 聚合投稿数据`；改动：按 `allVid` 分页直到游标结束/达到上限；验收：分页边界和空数据场景通过。
8. 步骤 8：实现评论与视频弹幕聚合；commit：`feat: 聚合互动数据`；改动：`comment` 与 `danmu` 全量分页抓取、限量截断策略；验收：all_count 与分页终止逻辑单测通过。
9. 步骤 9：实现直播弹幕与注册时间估算；commit：`feat: 聚合直播与注册`；改动：`zhibodanmu` 聚合 + `userRegDate` 区间估算器；验收：估算规则与空直播列表场景通过。
10. 步骤 10：实现 Top10 视频详情聚合；commit：`feat: 聚合视频详情`；改动：按播放量取 Top10，批量调用 `vidInfo`（受并发限制）；验收：Top10 排序与并发上限单测通过。
11. 步骤 11：接入 Grok 分析器；commit：`feat: 接入Grok分析`；改动：构建结构化 prompt、模型响应 schema 校验、失败降级文案；验收：模型成功/超时/非法响应三场景通过。
12. 步骤 12：升级纪念页模板；commit：`feat: 升级纪念页模板`；改动：新增章节（用户画像、代表视频、评论/弹幕片段、时间线摘要）和“数据不准确”声明；验收：XSS 转义测试通过。
13. 步骤 13：把生成流程改为入队；commit：`feat: 生成改为入队`；改动：`/api/generate` 仅鉴权+建 job+发 Queue 消息；验收：接口快速返回（不阻塞模型调用）。
14. 步骤 14：实现 Queue 消费者主流程；commit：`feat: 实现队列消费`；改动：抓数→分析→渲染→落盘→更新 job 阶段；验收：端到端生成成功，失败可落 `failed`。
15. 步骤 15：扩展任务状态可观测性；commit：`feat: 扩展任务状态`；改动：`stage/progress/warnings/gitSync` 持久化；验收：前端轮询能看到阶段变化。
16. 步骤 16：实现 Worker 直推 GitHub；commit：`feat: 打通自动提交`；改动：调用 GitHub API 将生成产物提交到 `generated-pages`；验收：能写入指定分支并返回 commitSha。
17. 步骤 17：生成分支索引与 sitemap 文件；commit：`feat: 生成索引文件`；改动：维护 `generated/recent.json`、`generated/sitemap.xml`、`generated/meta/*.json`；验收：提交后索引一致。
18. 步骤 18：新增 GitHub Actions 构建部署；commit：`ci: 新增部署流程`；改动：`push generated-pages` 触发同步到 Cloudflare + 清理变动 URL 缓存；验收：workflow dry-run 与语法校验通过。
19. 步骤 19：完善首页任务交互；commit：`feat: 完善首页交互`；改动：显示排队状态、阶段进度、错误原因与最近生成列表；验收：生成成功/失败/超时均有可读提示。
20. 步骤 20：强化安全控制；commit：`fix: 强化安全校验`；改动：严格参数验证、代理 schema 校验、速率限制细分、错误脱敏、CSP/CORS 收紧；验收：安全用例全部通过。
21. 步骤 21：性能优化；commit：`perf: 优化抓取性能`；改动：KV 缓存热点接口、并发池、批次写 KV/R2、减少重复计算；验收：基准脚本达标。
22. 步骤 22：补齐测试；commit：`test: 补齐核心测试`；改动：单测+集成测试覆盖关键链路；验收：`npm run test` 全绿。
23. 步骤 23：完善文档与声明；commit：`docs: 完善文档说明`；改动：更新 README 与 `docx/api.md`，新增“所有 API 可能不准确”统一说明与运维手册；验收：文档与实现一致。
24. 步骤 24：全量验收与发布前检查；commit：`chore: 完成全量验收`；改动：补验收记录与发布清单；验收：所有检查命令通过。

## 安全与性能检查清单（执行阶段每步按需运行）
1. 语法与类型：`node --check`、构建检查脚本。
2. 单元/集成：`npm run test`。
3. Worker 配置：`npx wrangler deploy --dry-run --env production`。
4. 安全回归：SSRF 白名单、XSS 转义、Turnstile 强制、Access 鉴权、路径注入、错误脱敏。
5. 性能回归：分页上限、并发上限、队列吞吐、单任务超时保护、KV/R2 写放大控制。
6. CI/CD 验证：workflow lint、分支触发、变更 URL 缓存清理生效。

## 关键验收场景
1. UID 提交后 1 秒内返回 `jobId` 与 `queued`。
2. `job` 从 `queued -> fetching -> analyzing -> rendering -> syncing -> succeeded` 完整流转。
3. 任一外部 API 失败时任务进入可解释失败状态，且不泄漏密钥。
4. 纪念页含 Top10 视频、评论摘要、视频弹幕摘要、直播弹幕摘要、注册时间估算、模型分析。
5. 纪念页与接口都包含“数据可能不准确”声明。
6. 自动提交到 `generated-pages` 成功并可追溯 commit SHA。
7. GitHub Actions 触发后完成 Cloudflare 同步与变动 URL 缓存清理。
8. `/sitemap.xml` 与首页最近列表在生成后自动更新。
9. 高并发下无队列雪崩，失败任务可重试且不重复提交 Git。

## 执行期间汇报机制
1. 每完成 1 个小步骤立即汇报一次：`步骤编号 + commit hash + 关键变化 + 校验结果`。
2. 若单步思考/实现跨度较大，达到你要求的“约 5000 token 级别”前强制插入中途汇报。
3. 若遇到阻塞（外部 API、权限、CI 密钥、Cloudflare 配额），立即中断并先汇报再继续。

## 假设与默认值
1. 默认分支策略：开发分支维持现状，自动生成分支固定为 `generated-pages`。
2. 默认异步基础：Cloudflare Queues，单条消息处理，失败重试受控。
3. 默认模型策略：Grok 异步调用，超时降级为“无模型分析但页面可生成”。
4. 默认密钥策略：按你选择“暂不处理存量密钥”，仅新增所需 secret 配置说明，不做轮换动作。
5. 默认数据质量策略：所有第三方 API 结果均标记为“可能不准确”，并在页面与接口统一展示。
