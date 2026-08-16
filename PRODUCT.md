# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** VideoExpress AI creators / operators working inside `https://app.videoexpress.ai` Library who batch-convert images → videos. They manage library folders (libraryId 4), upload image sets, and generate dozens–hundreds of 10s videos (16:9) with per-image prompts.

**Situation & job:** Already authenticated in the VideoExpress web app. Job is to select a folder, prepare prompts (from filenames or curated lists), run an unattended queue that respects the service's parallel limit (5 concurrent AI videos), monitor status until `completed`, and bulk-download results — without clicking generation manually per image.

Secondary audiences: small teams/agencies repurposing the same workflow for client batches; no separate admin role.

## Product Purpose

Orchestrate the full image→video lifecycle inside VideoExpress AI from within the page: folder/media browsing, batch upload, prompt composition, queued generation, status polling, and bulk download. The userscript exists to turn a single-item UI into a reliable batch automation layer that preserves the host app's auth, rate limits, and data model.

Success means a user can start `runQueue` on a folder and return to a fully-pollable, recoverable history (localStorage) and downloaded files, even when the API returns `parallel_limit` or delayed `videoId` values.

## Positioning

The only in-page, session-native batch manager for VideoExpress AI. Instead of an external bot or separate backend, it monkey-patches `fetch`/`XHR` via `installAuthCapture` (`videoexpress-manager.user.js:310`) to capture `X-CSRF-TOKEN` / `Bearer` from the user's real session and replays the native `POST /ai/api/image2video` + `GET /ai/api/status/{uuid}` flow via `sessionFetch` (`videoexpress-manager.user.js:333`). Differentiation is the integrated pipeline: filename-derived prompt cleaning (`promptCleaner` / `cleanPrompt` / `composePrompt`), `{{image}}` master-prompt templating, indexed `promptList`, sequential queue with 1500ms gap + 60s `parallel_limit` backoff (retry Infinity), heuristic `videoId` extraction (`extractVideoIdFromStatus` + `fetchAiVideosMap` fallback), and jittered concurrent downloads (concurrency 3) — all persisted as `library:{id}:folder:{fid}:media:{mid}` records.

## Operating Context

- **Runtime:** Tampermonkey/Greasemonkey UserScript (`videoexpress-manager.user.js:1`), IIFE, `@run-at document-idle`, `@grant none`, `@match https://app.videoexpress.ai/*`. No build, no package manager, no CI. Verification via `node --check`.
- **Host dependencies:** Relies on `app.videoexpress.ai` DOM and authenticated APIs (`/library/*`, `/ai/api/image2video`, `/ai/api/status/*`, `/library/download/*`). Early bail if hostname != `videoexpress.ai` or `__videoExpressManagerLoaded` already set.
- **Core workflow:** `bootstrap` (`videoexpress-manager.user.js:2620`) → `installAuthCapture` + `refreshFolders` + `renderQueue` + `pollStatuses` interval (15s). User selects folder → `loadFolderImages`/`loadFolderVideos` (pageSize 100) → configures prompts → `buildQueue` → `runQueue` (sequential, `delayBetweenRequestsMs:1500`) → `pollStatuses` (`pollIntervalMs:15000`) → `downloadQueueCompleted`/`downloadVideos`/`fetchAndDownload` with `downloadMin/MaxDelayMs` jitter.
- **Persistence:** `localStorage` keys `videoexpress.manager.history.v1` (records map) and `videoexpress.manager.ui-state.v1` (aspect/videoLength/delays/prompts/filters/panel position/active tab `videoexpress-manager.user.js:54`-`59`).
- **Operational rituals:** Draggable floating panel (5 tabs), video filters (query/date/size), log console, manual retry on `parallel_limit`.

## Capabilities and Constraints

**Confirmed capabilities**

- Folder CRUD: `getFolders`/`createFolder`/`deleteFolder`; media listing: `getMedia`/`getAllImages`/`getAllVideos`; upload via `uploadFile` + `postMultipart`.
- Generation: `generateImageVideo` building `URLSearchParams {type,prompt,mediaId,uuid,aspect,videoLength,generatorName:create_from_prompt}` → `POST /ai/api/image2video`.
- Queue: `buildQueue` (`videoexpress-manager.user.js:743`) respects `masterPrompt`/`appendFilenamePrompt`/`promptListEnabled` and skips `submitted|running|completed|started` (with `skipStartedWithoutUuid`).
- Polling: `pollStatuses` with `normalizeStatus`/`isParallelLimitMessage` (`/multiple videos in progress|up to 5 ai videos|parallel/i`) and 16+ candidate `videoId` paths + regex fallback; backfill via `fetchAiVideosMap` paging AI Videos folder.
- Downloads: `fetchAndDownload` blob → object URL, `resolveVideoDownloadName`, sequential jitter (`downloadConcurrency:3`, retry 3×), progress UI.
- Prompt pipeline: `cleanPrompt` (stripExtension, replace underscores/dashes, collapse whitespace), `composePrompt` (`{{image}}`), `parsePromptList`.

**Constraints & limits**

- Service enforces ~5 concurrent AI videos; detection is string-heuristic (`isParallelLimitMessage`) — brittle to wording changes.
- `maxParallelLimitRetries: Infinity` + 60s delay can loop forever; no circuit breaker.
- `videoId` extraction remains heuristic; missing ids require extra `fetchAiVideosMap` paging (N+1 cost on each poll with gaps).
- Auth capture monkey-patches globals without restore — conflict risk if multiple userscripts patch `fetch`/`XHR`.
- Vendored `videoeditor.js` / `videoeditor.min.js` (744+ nodes) must be ignored in analysis; `.har`/`.log` are gitignored fixtures.
- Config defaults: `libraryId:4`, `pageSize:100`, `videoLength:10`, `aspect:16:9`, `pollIntervalMs:15000`, download delays 800–1200ms (current header values in `videoexpress-manager.user.js:20`).

**Explicitly undecided / not confirmed**

- Pricing, licensing, or hosted backend — none; userscript is client-only.
- Multi-workspace / multi-library support beyond `libraryId:4`.
- Server-side `uuid` query optimization flag (`_queryUuidSupported`) behavior across API versions.

## Brand Commitments

- Name: **VideoExpress Library Manager** (`@name` `videoexpress-manager.user.js:2`), namespace `https://app.videoexpress.ai/`.
- Update channel: `https://raw.githubusercontent.com/ayyfahim/vea_automator/main/videoexpress-manager.user.js` (`updateURL`/`downloadURL`).
- Voice: utilitarian, in-page manager — floating panel UX, status badges (`started|submitted|running|completed|failed|parallel_limit|skipped`), log lines prefixed `[VE]`.
- No logo, palette, or typography commitments declared in the brief; future visual work must not invent them.

## Evidence on Hand

- Source: `videoexpress-manager.user.js:1` (~3800 lines, v0.7.1), `videoeditor.js` (vendored, to be ignored), `AGENTS.md` entrypoints, `docs/videoexpress-manager-understanding.md` (graph-verified reference, 1177 nodes, 9 routes).
- API evidence: HAR fixtures `vea_download_*.har`, `vea_timlineWithExport.har`; logs `app.videoexpress.ai-*.log` — real status payloads inform `extractVideoIdFromStatus` heuristics.
- No testimonials, case studies, benchmarks, or marketing assets on hand — must not be fabricated.
- `get_architecture` routes: `ANY /library/get_categories/{}`, `ANY /library/add_category/{}`, `ANY /library/delete_category/{}`, `ANY /api/library/get_media/{}?{}`, `ANY /library/upload/{}`, `ANY /ai/api/image2video`, `ANY /ai/api/status/{}?_={}`, `- /library/download/{}`.

## Product Principles

1. **Session-native, not separate.** Reuse the user's authenticated session and native endpoints; never ask for separate credentials or bypass rate limits.
2. **Unattended reliability over speed.** Prefer sequential queue + backoff + persistence that survives reloads to raw throughput.
3. **Recoverability is the feature.** Every `uuid`/`videoId`/status transition must be persisted and reconcilable via fallback (`fetchAiVideosMap`) so a poll or refresh never loses work.
4. **Heuristics with fallbacks.** When the API shape is unstable (parallel-limit wording, videoId location), keep the broad matcher but always retain a paging/regex fallback rather than assuming a fixed payload.
5. **Zero-build operability.** Stay a single installable userscript; no build step, no external service, no new storage beyond `localStorage`.

## Accessibility & Inclusion

No product-specific accessibility standard was established in the brief. As a web in-page panel, future work should meet at minimum: keyboard operable panel (drag alternative, focus order), sufficient color contrast for status badges, and ARIA labels for queue/video tables. Revisit if a target WCAG level is set.
