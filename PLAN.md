# PLAN (Implemented Baseline)

This file tracks the currently implemented browser-collect architecture.

## Implemented workstream
1. Collect session bootstrap
   - Added POST /api/collect/init
   - collectId/collectToken issuance and KV session storage
2. Upload pipeline binding
   - upload/init requires collectId + collectToken + artifact
   - upload/part and upload/complete strictly bound to upload token/session
   - collect status updates to collecting/ready
3. Generate gate
   - POST /api/generate requires collectId + collectToken
   - rejects non-ready session with 409
   - queue payload includes collectId
4. Queue consumption rewrite
   - Removed upstream collection calls from job runtime
   - Job consumes uploaded artifacts from R2 only
   - Missing/invalid artifact leads to failed job with warnings
5. Frontend collector rewrite
   - Browser-side collection + upload orchestration
   - uapis retry strategy for rate/overload responses
   - aicu captcha recovery (aicu_verify_required)
6. Memorial template enhancement
   - b23 video jump links
   - cover image no-referrer policy
   - head meta referrer=no-referrer
7. Scheduled cleanup convergence
   - 24h retention for raw/collect/upload
   - orphan upload session reclamation
   - uploads:index compaction
   - hourly cron
8. Docs sync
   - README/API/PLAN updated to new contracts

## Runtime states
Collect session:
- collecting
- ready

Job stage:
- queued
- fetching
- analyzing
- rendering
- syncing
- succeeded
- failed

Frontend transient stage:
- collecting
- uploading
- aicu_verify_required

## Validation baseline
- npm run check
- npm run test
- npm run perf

## Operational notes
- Worker should not be treated as upstream data collector now.
- Browser must finish artifact upload before generate.
- Cleanup assumes 24h retention and runs hourly.
