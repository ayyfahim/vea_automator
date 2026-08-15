# Queue Download Sequential Prefix — Design

**Date:** 2026-08-16
**Author:** Muse Spark (brainstorming with user)
**Status:** Approved (user confirmed queue order, `1_` no pad, Queue tab only absolute position, Approach 1)
**Related Plan:** `docs/superpowers/plans/2026-08-16-retry-failed-and-failure-info.md` (prior feature)

## 1. Goal

When user clicks **Download Completed** or **Download Remaining** in the Queue tab, downloaded files should be prefixed with their absolute queue position `N_` (e.g., `1_117.mp4`, `7_BruceScene.mp4`) so file explorer order matches Queue preview order and cross-references row numbers.

Scope: Queue tab only. No change to Downloads tab (Selected/Visible). No user toggle.

## 2. Context

- UserScript `videoexpress-manager.user.js:1` (v0.6.1, IIFE, `@run-at document-idle` on `https://app.videoexpress.ai/*`)
- Queue derived via `buildQueue` `videoexpress-manager.user.js:743` mapping `state.items` (sorted by `compareMediaName` `videoexpress-manager.user.js:1671`) → `{media,prompt,record,status,skip}`
- Rendered in `renderQueue` `videoexpress-manager.user.js:1695` (5 cols, up to 150 rows)
- Downloads via `downloadQueueCompleted({onlyRemaining})` `videoexpress-manager.user.js:2144` filtering `state.history.records` where `status:"completed"` and `videoId` present, then `resolveVideoDownloadName` `videoexpress-manager.user.js:1789` (`sanitizeFileName` `videoexpress-manager.user.js:1681`) + `fetchAndDownloadWithRetry` `videoexpress-manager.user.js:1835`
- Recent feature: retry/info for failed items; this prefix is an additive follow-up

## 3. Decisions

- **Order:** Queue order (same sorted order as `buildQueue`/`renderQueue`), not generation `completedAt` nor separate alphabetical. Chosen per user Q1=A.
- **Format:** `N_` with no zero-padding, underscore separator (`1_foo.mp4`). Chosen per Q2=A. String `N` is decimal, 1-based.
- **Base:** Absolute queue position, not batch-relative. For `Download Remaining` with queue positions 7,8,9,10, files become `7_…`, `8_…`, etc., ensuring direct mapping to table row. Chosen per Q3.
- **Scope:** Only `downloadQueueCompleted` paths (Queue tab). Downloads tab unchanged. Chosen per Q3.

## 4. Architecture

Single-file change, same IIFE. No new storage keys, no `HISTORY_KEY` schema change.

**Components:**

- `getQueuePositionForMedia(mediaId: string|number) => number|null` (new, pure helper near `getQueueDownloadCounts` `videoexpress-manager.user.js:779`): scans `state.queue` first (preferred, already sorted and reflects current filters), else `state.items` sorted, returns 1-based index or null if not found.
- Modified `downloadQueueCompleted`: after building `entries` (already filtered by `completed`+`videoId` and `onlyRemaining`), map each to `pos = getQueuePositionForMedia(rec.imageId) || (fallback batch index)`, then `prefixedName = `${pos}_${resolveVideoDownloadName(fakeVideo)}``. Pass `prefixedName` to `fetchAndDownloadWithRetry`.
- Unchanged: `resolveVideoDownloadName`, `sanitizeFileName`, `fetchAndDownload`, `pollStatuses`, `buildQueue`.

**Data Flow:**

1. User has loaded folder → `state.items` sorted, `state.queue = buildQueue(folder, items)`.
2. User clicks Download Completed (all) or Download Remaining (undownloaded).
3. `downloadQueueCompleted` resolves missing `videoId`s (existing logic), filters `completed` records, builds `entries`.
4. For each `entry`, lookup `pos` via `getQueuePositionForMedia`; fallback to `idx+1` if queue empty.
5. `fakeVideo = {id: vid, uuid, name: rec.imageName}` → `base = resolveVideoDownloadName(fakeVideo)` → `fileName = `${pos}_${base}``.
6. `await fetchAndDownloadWithRetry(fakeVideo, fileName)` → set `downloadedAt`.

## 5. Error Handling / Edge Cases

- **Queue not loaded:** If `state.queue` empty and `state.items` empty, `loadFolderImages()` is already called at start of `runQueue`; for download path, call `loadFolderImages()` lazily or fallback to batch index and log `queuePos fallback`.
- **Media not in queue:** e.g., image deleted after completion. Return null → use `entries` loop index+1 as fallback so download still succeeds.
- **Name length:** `resolveVideoDownloadName` already caps via `sanitizeFileName` (180 chars). Prefix adds at most 4 chars (`150_`); final stays ≤184, well under OS limits. No truncation of prefix.
- **Special chars:** `sanitizeFileName` already strips `< > : " / \ | ? *`. Prefix is digits+`_`, safe.
- **Downloads tab:** Explicitly out of scope — no prefix applied, no regression.

## 6. Testing

- **Syntax:** `node --check videoexpress-manager.user.js`
- **Unit (throwaway `test_prefix.js`):** Mock `state.queue = [{media:{id:1}},{media:{id:2}},...]` and `history` entries; assert `getQueuePositionForMedia(7)===7`, `prefixForRemaining` at positions 7,8 yields `7_`, `8_`, not `1_`, `2_`; assert no zero-pad (`10_` not `010_`).
- **Manual (Tampermonkey on `app.videoexpress.ai`):** Create folder with 5 images sorted alphabetically, run queue to completion (or mock history), click Download Completed → verify downloads `1_…` through `5_…` sort correctly in OS; click Download Remaining on 2 items at end → verify `4_`, `5_`.

## 7. Out of Scope

- Zero-padding / configurable padding — deferred per Q2 choice; can add later if >99 items cause sort issues.
- Toggle checkbox in UI — deferred per Approach 3 rejection.
- Persisting prefix or renaming already-downloaded files — not required.
- Changing `Downloads` tab behavior.

## 8. Open Questions

None — all clarified via Q1-3 and Approach 1 approval.
