# API Contract (browser collect + upload + generate)

## Required artifacts
- allVid
- comment
- danmu
- zhibodanmu
- topVideoInfos

## POST /api/collect/init
Request body:
- uid: string
- turnstileToken: string

Response 200:
- ok: true
- uid
- collectId
- collectToken
- requiredArtifacts: string[]
- expiresAt: epoch ms
- partSizeHint: bytes

## POST /api/upload/init
Request body:
- uid: string
- collectId: string (collect_xxx)
- collectToken: string
- artifact: one of required artifacts
- size: number
- fileName: string
- mime: string

Response 200:
- ok: true
- uid
- collectId
- artifact
- uploadId
- uploadToken
- maxPartSizeHint

Notes:
- collectId + collectToken + artifact are mandatory
- session binding is enforced

## PUT /api/upload/part?uploadId=&partNumber=
Headers:
- x-upload-token
Body:
- binary part bytes

Response 200:
- ok
- partNumber
- etag
- collectId
- artifact

## POST /api/upload/complete
Request body:
- uploadId
- uploadToken
- parts: [{ partNumber, etag }]

Response 200:
- ok
- collectId
- artifact
- collectStatus: collecting | ready
- uploadedCount
- requiredCount

## POST /api/generate
Request body:
- uid
- collectId
- collectToken
- turnstileToken

Behavior:
- returns 409 if collect session is not ready
- returns 202 with jobId when accepted

Response 202:
- ok
- jobId
- queued
- stage
- estimatedWaitSec

## GET /api/job/:jobId
Response fields:
- jobId
- uid
- collectId
- status
- stage
- progress
- warnings
- gitSync
- updatedAt

## Queue message schema
- jobId
- uid
- collectId
- requestedAt
- traceId

## Snapshot schema (core)
- uid
- collectId
- generatedAt
- dataNotice
- sourceQuality: browser-uploaded
- allVid
- topVideoInfos
- comments
- danmu
- liveDanmu
- regDateEstimate
- modelOutput

## Frontend recovery state
- aicu_verify_required

Trigger condition:
- aicu response is non-JSON (captcha/challenge page)

Recovery:
1. Open failed URL in browser
2. Pass verification
3. Click "I have verified, continue"
4. Resume from checkpoint page, no reset of completed pages

## Retry matrix
- uapis retry on: 429, 499, 5xx, schema mismatch
- aicu retry on: retryable status + transient business codes (e.g. -666)
- aicu non-JSON: no blind retry loop, switch to aicu_verify_required

## Data notice
All rendered pages and snapshots keep:
- dataNotice: Data is sourced from public APIs and may contain delay or incompleteness
