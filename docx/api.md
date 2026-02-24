# API 范围与数据声明

## 统一声明
所有第三方聚合接口都应返回：
`dataNotice: "第三方API数据可能不准确，仅供纪念参考"`

该声明必须在：
- `GET /api/proxy/:source` 的响应中出现
- 纪念页渲染内容中出现
- 快照 `MemorialSnapshot` 中保留

## 代理接口
`GET /api/proxy/:source`

`source` 支持：
- `allVid` 投稿列表分页
- `vidInfo` 视频详情（按 bvid 或 aid）
- `comment` 评论分页聚合
- `danmu` 视频弹幕分页聚合
- `zhibodanmu` 直播弹幕分页聚合

### allVid
- Query: `uid`（必填）, `pn`（可选，默认 1）
- 上游：`uapis.cn` archives

### vidInfo
- Query: `bvid` 或 `aid`（二选一）
- 上游：`uapis.cn` view

### comment
- Query: `uid`（必填）, `pn/page`（可选）
- 上游：`api.aicu.cc` getreply

### danmu
- Query: `uid`（必填）, `pn/page`（可选）, `keyword`（可选，长度受限）
- 上游：`api.aicu.cc` getvideodm

### zhibodanmu
- Query: `uid`（必填）, `pn/page`（可选）, `keyword`（可选，长度受限）
- 上游：`api.aicu.cc` getlivedm

## 任务接口
### 创建任务
`POST /api/generate`

请求体：
```json
{
  "uid": "123456",
  "turnstileToken": "..."
}
```

响应体：
```json
{
  "ok": true,
  "jobId": "job_xxx",
  "queued": true,
  "stage": "queued",
  "estimatedWaitSec": 15
}
```

### 查询任务
`GET /api/job/:jobId`

响应体（示例）：
```json
{
  "jobId": "job_xxx",
  "uid": "123456",
  "status": "running",
  "stage": "analyzing",
  "progress": 60,
  "warnings": [],
  "gitSync": null,
  "updatedAt": 1730000000000
}
```

## 队列消息类型
`AnalysisQueueMessage`
```json
{
  "jobId": "job_xxx",
  "uid": "123456",
  "requestedAt": 1730000000000,
  "traceId": "trace_xxx"
}
```

## 聚合快照类型
`MemorialSnapshot`
```json
{
  "uid": "123456",
  "generatedAt": 1730000000000,
  "disclaimer": "第三方API数据可能不准确，仅供纪念参考",
  "sourceQuality": "third-party-unstable",
  "allVid": {},
  "topVideoInfos": [],
  "comments": {},
  "danmu": {},
  "liveDanmu": {},
  "regDateEstimate": {},
  "modelOutput": {}
}
```

## Git 同步结果类型
`GitSyncResult`
```json
{
  "branch": "generated-pages",
  "commitSha": "abc123",
  "files": ["generated/pages/123456.html"],
  "committedAt": "2026-02-24T00:00:00.000Z",
  "status": "succeeded"
}
```

## 阶段定义
- `queued`
- `fetching`
- `analyzing`
- `rendering`
- `syncing`
- `succeeded`
- `failed`

## 质量与风控要求
1. 参数严格校验（UID/jobId/source/分页参数）
2. 代理响应 schema 校验后再返回
3. 上游失败不透传内部错误细节
4. 全链路保留 `requestId` 用于排障
5. 所有返回统一附带不准确声明
