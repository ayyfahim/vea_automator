# Queue Download Completed — Design

Date: 2026-08-15
Status: Approved
Source: `videoexpress-manager.user.js` (2477 lines)

## Objective
Add “download what I just generated” in the Queue tab: after running 20 images where 18 complete, one-click download the 18 with image-name filenames, and durably track the 2 remaining (failed or not-yet-downloaded).

## Current State
- Queue: `buildQueue` → `runQueue` submits via `POST /ai/api/image2video` → history record `{imageId, uuid, status: submitted/started/parallel_limit/failed, prompt}` persisted in `HISTORY_KEY`. Polling `GET /ai/api/status/{uuid}` every 15s updates `status` to `completed/failed/running`. No `videoId` stored.
- Downloads tab: `api.getAllVideos` → `GET /api/library/get_media` → filter `type==video` → manual selection → `GET /library/download/{video.id}` → blob download with random delay.
- Gap: no link from queue completion to downloadable library video; user must manually identify new videos.

## Decision
Approach 2 + 3 light (recommended): capture `videoId` from status payload, persist `downloadedAt`, UI in Queue tab. Reuse existing download engine.

## Architecture

### Data Model (history record)
Extend record written in `setRecord` / `runQueue` / `pollStatuses`:

```js
{
  // existing
  libraryId, folderId, folderName, imageId, imageName, mediaPath, prompt, startedAt, updatedAt, status, uuid,
  // new
  videoId: string|null,      // resolved library video id from status payload
  videoName: string|null,    // optional, from payload
  downloadedAt: string|null, // ISO timestamp when fetchAndDownload succeeded
  completedAt: string|null,  // when status became completed
}
```

Storage: `HISTORY_KEY = videoexpress.manager.history.v1` via `saveHistory()`. Backward compatible — missing fields default to null.

### Status → videoId resolution
In `pollStatuses()` when `mapped === "completed"`:
1. Inspect raw `statusPayload` (one live capture needed). Try candidates in order: `payload.videoId || payload.mediaId || payload.data?.id || payload.data?.videoId || payload.result?.id || payload.video?.id`.
2. Log full payload on first completed for verification.
3. If found, write `record.videoId`; else leave null and fallback will attempt library correlation with warning.

### Queue UI
Location: `Queue` tab, below `.ve-stats` section and above `Queue preview`.

- Summary line: `Completed: 18 | Downloaded: 12 | Remaining: 6` (computed from `state.queue` + history).
- Buttons: `Download Completed` (all completed with resolvable videoId) and `Download Remaining` (completed && !downloadedAt). Disabled when zero, or when `state.running/uploadInProgress/downloadInProgress`.
- Table badge: when `record.downloadedAt` exists, show secondary badge `downloaded` (reuse `.ve-badge.completed` style or new `.ve-badge.downloaded`).
- Progress: reuse `#ve-download-progress` or add `#ve-queue-download-progress` + `#ve-queue-download-summary` muted line.

### Download Logic
New function `downloadQueueCompleted({ onlyRemaining })`:

1. Filter `state.queue` → history records where `status === "completed"` and `(onlyRemaining ? !downloadedAt : true)`.
2. Resolve each entry to `{ id: record.videoId || fallbackVideo.id, name: record.imageName }`. If `videoId` missing, one-time `api.getAllVideos(folder.id)` fallback correlates by newest `datetime` matching count (log warning).
3. For each video: `resolveVideoDownloadName({id, uuid, name})` → `fetchAndDownload(video, fileName)` → on success set `downloadedAt = new Date().toISOString()` via `setRecord`. Random delay `randomDelay(downloadMinDelayMs, downloadMaxDelayMs)` between items. Honor `state.stopRequested` + `state.downloadInProgress` (reuse same flags as Downloads tab, or introduce `state.queueDownloadInProgress` if isolation needed).
4. Update summary + progress bar + `renderQueue()` + `updateButtonStates()` after each item. Final log line mirrors `downloadVideos`.

Reuse: `fetchAndDownload`, `randomDelay`, `sanitizeFileName`, `resolveVideoDownloadName`, `logLine`.

### Button States
Extend `updateButtonStates()` to disable/enable new buttons based on `visibleCompletedCount` and `remainingCount` and `state.downloadInProgress`.

## File Changes
- `videoexpress-manager.user.js` only. No new files, no API contract changes.

## Verification
1. Manual live test: create folder with 3 small images, run queue, wait for `completed` (observe console log of `statusPayload`), click `Download Remaining` → 3 files download with image names, `downloadedAt` set.
2. Reload page → summary shows `Remaining: 0`, history persists (`localStorage` inspection).
3. Run batch where 1 fails (e.g., bad prompt) → `Completed: 2 | Failed: 1 | Remaining: 2` → download remaining downloads only 2, failure not offered.
4. Partial download + Stop → `stopRequested` honored, remaining count reflects undownloaded.

## Non-Goals
- ZIP bundling, auto-download on completion, Downloads tab changes, server-side changes.

## Risks
- Status payload shape unknown until live capture — mitigation: candidate list + fallback + console warning.
- Concurrent `downloadInProgress` shared between Queue and Downloads — mitigation: single flag blocks both, consistent UX.

## Alternatives Considered
- Library recency correlation only (fragile). Full folder-wide history download (out of scope per user A).
