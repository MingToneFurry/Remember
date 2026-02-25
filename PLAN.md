# Claude 代码全量审查与修复执行计划（代码+配置+CI）

## 1. 目标与执行方式
1. 先完成全量审查结果落地：将问题清单、修复方案、验收标准写入本文件。
2. 再按严重级别分批修复：Critical -> High -> Medium。
3. 每个小步骤独立 commit，并即时汇报：`步骤编号 + commit hash + 关键变化 + 校验结果`。

## 2. 基线结论（只读审查）
- 代码范围：`src/`、`tests/`、`scripts/`、`workers.js`、`wrangler.toml`、`.github/workflows/`。
- 已验证基线命令：`npm run check`、`npm run test`、`npm run perf`。
- 当前主要问题集中在：任务排队健壮性、日志脱敏、重试策略、队列毒消息处理、前端警告渲染、限流与 CI 门禁。

## 3. 问题清单与修复方案

### 3.1 Critical
1. 入队失败后仍写入 UID 冷却，后续请求被误拦截。
- 证据：`src/routes/runtime.js` 的 `handleGenerate` 在写入 cooldown 后，如果 queue send 失败未回滚。
- 修复：queue send 异常时删除 `job:{jobId}` 和 `cooldown:uid:{uid}`，并返回 `503`。
- 验收：新增回归测试，验证首次失败后可立即重试同 UID。

2. 非 HttpError 原始异常消息直接打日志，存在密钥泄漏风险。
- 证据：`src/routes/runtime.js` 的统一错误分支直接输出 `err.message`。
- 修复：日志统一使用 `sanitizeFailureMessage` 脱敏后输出。
- 验收：回归测试验证泄漏样本不会出现在日志输出中。

### 3.2 High
3. UpstreamClient 对非可重试错误也重试（如 400）。
- 证据：`src/services/upstreamClient.js` catch 分支对大多数错误一律重试。
- 修复：仅对超时、网络异常、可重试状态码重试。
- 验收：新增 400 场景测试，确保只请求一次。

4. 队列消息解析异常时直接 retry，可能形成毒消息风暴。
- 证据：`src/routes/runtime.js` 的 queue handler 将解析异常落入统一 retry 分支。
- 修复：解析失败直接 ack 丢弃；业务失败采用有限重试，超过上限后 ack 并标记失败。
- 验收：新增队列测试，验证非法消息 ack 且不 retry。

5. 首页 warning 渲染使用 `innerHTML`，存在 XSS 面。
- 证据：`homepageHtml` 前端脚本中的 `warningList.innerHTML = ...`。
- 修复：改为 `createElement + textContent`。
- 验收：新增回归测试，确认不再使用 `innerHTML` 渲染 warning。

### 3.3 Medium
6. `running` 状态仍允许再次进入生成流程，存在重复处理风险。
- 证据：`processGenerateJob` 允许 `running` 状态再次执行。
- 修复：仅允许 `queued/pending` 进入生成；队列消费前再检查状态。
- 验收：新增测试，`running` 状态消息应直接 ack 且不重跑任务。

7. 上传分片与完成接口缺少独立限流。
- 证据：`/api/upload/part`、`/api/upload/complete` 未单独调用限流。
- 修复：新增 `upload-part`、`upload-complete` 的分钟/天级限流。
- 验收：新增测试触发 429。

8. 部署工作流缺少发布前 check/test 门禁。
- 证据：`.github/workflows/deploy-generated-pages.yml` 直接 deploy。
- 修复：deploy 前加入 `npm run check`、`npm run test`。
- 验收：workflow 静态检查 + 本地命令通过。

## 4. 实施步骤（分批提交）
1. 覆盖本 `PLAN.md`（当前步骤）。
2. 修复 Critical：入队回滚 + 日志脱敏 + 测试。
3. 修复 High：重试策略 + 队列毒消息处理 + 测试。
4. 修复 High：warning XSS 渲染 + 测试。
5. 修复 Medium：状态闸门 + 上传限流 + 测试。
6. 修复 Medium：CI check/test 门禁。
7. 全量回归：`npm run check`、`npm run test`、`npm run perf`、`npm run dryrun`。

## 5. 验收标准
1. `POST /api/generate` 在入队失败时返回 503，且不残留冷却。
2. 错误日志不输出密钥原文。
3. 非可重试状态码不重复请求上游。
4. 队列非法消息不进入无限重试。
5. warning 渲染路径无 `innerHTML` 注入面。
6. `running` 状态不会重复执行生成流程。
7. 上传分片/完成接口可触发 429 限流。
8. CI 在 deploy 前强制执行 check/test。

## 6. 执行期间汇报机制
1. 每完成 1 个小步骤立即汇报一次：`步骤编号 + commit hash + 关键变化 + 校验结果`。
2. 若单步思考/实现跨度较大，达到“约 5000 token 级别”前强制插入中途汇报。
3. 遇到阻塞（外部 API、权限、密钥、配额）立刻先汇报，再继续。
