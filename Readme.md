# Remember (rem.furry.ist)

Remember now uses a browser-first data collection pipeline.
Workers no longer call upstream collection APIs during job execution.

## Architecture (current)
1. Browser calls POST /api/collect/init to create a collect session.
2. Browser collects required artifacts directly from upstream APIs:
   - allVid
   - comment
   - danmu
   - zhibodanmu
   - topVideoInfos
3. Browser uploads each artifact via:
   - POST /api/upload/init
   - PUT /api/upload/part
   - POST /api/upload/complete
4. Browser calls POST /api/generate with uid + collectId + collectToken.
5. Queue consumer reads uploaded artifacts from R2, builds snapshot, renders page, stores outputs, syncs GitHub.

## Why this change
- Some upstream APIs are blocked from Worker runtime.
- Browser direct access has better compatibility.
- Worker side is now deterministic and only consumes uploaded data.

## Public APIs
- GET /
- GET /u/:uid
- GET /api/recent
- GET /api/job/:jobId
- GET /api/proxy/:source (debug/probe)
- POST /api/collect/init
- POST /api/upload/init
- PUT /api/upload/part
- POST /api/upload/complete
- POST /api/generate
- POST /api/removal-requests
- GET /api/removal-requests/:id

## Collect session state
- collecting
- ready

Generate gate:
- POST /api/generate returns 409 until collect session is ready and all required artifacts exist.

## Source retry policy
- uapis:
  - Retry on 429/499/5xx and schema mismatch
  - No captcha handling branch (rate-limit oriented)
- aicu:
  - Retry on transient business/load codes (e.g. -666) and retryable status
  - If non-JSON response is detected, frontend enters aicu_verify_required
  - User opens failed URL, passes verification, clicks "I have verified, continue" to resume from checkpoint

## Security controls
- Turnstile required on collect/init and generate
- Signed collect/upload tokens and scope validation
- Upload session bound to collectId + artifact
- Generate only accepts ready collect session
- API rate limits (minute/day)
- Admin APIs protected by Cloudflare Access

## Storage layout
R2:
- pages/{uid}.html
- snapshots/{uid}/{jobId}.json
- raw/YYYY-MM-DD/{uid}/{collectId}/{artifact}.json

KV:
- collect:{collectId}
- upload:{uploadId}
- uploads:index:{uid}
- job:{jobId}
- recent:list
- meta:uid:{uid}
- removal:req:{id}
- cache:sitemap:xml
- rl:* keys

## Retention and cleanup
- Retention target: 24 hours for raw collection artifacts and collect/upload sessions
- Scheduled cleanup covers:
  - raw/*
  - collect:*
  - upload:*
  - uploads:index:* compaction
- Orphan upload sessions are reclaimed
- Cron: 15 * * * * (hourly)

## Local commands
- npm run check
- npm run test
- npm run perf
- npm run dryrun
