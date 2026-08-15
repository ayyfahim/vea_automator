# Queue Download Completed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add “Download Completed / Download Remaining” to the Queue tab so a batch of 20 that yields 18 completed can be downloaded in one click with image-name filenames, while tracking the 2 remaining (failed or not-yet-downloaded) across reloads.

**Architecture:** Extend history records with `videoId`/`downloadedAt` captured during `pollStatuses()` status mapping, add Queue-tab summary + buttons + progress, and implement `downloadQueueCompleted()` reusing `fetchAndDownload`/`randomDelay` with delay honoring. All changes confined to `videoexpress-manager.user.js`.

**Tech Stack:** Vanilla JS userscript (no build), `fetch` + `FormData`, `localStorage` persistence, VideoExpress APIs `/ai/api/status/{uuid}` and `/library/download/{id}`.

## Global Constraints

- Single file change: `videoexpress-manager.user.js` only.
- No new dependencies, no server API contract changes.
- Reuse existing `fetchAndDownload`, `randomDelay`, `sanitizeFileName`, `resolveVideoDownloadName`, `logLine`, `saveHistory`, `updateButtonStates`.
- Backward compatible: missing `videoId`/`downloadedAt` defaults to `null`.
- Must not modify Downloads tab behavior.

---

## File Structure

- Modify: `videoexpress-manager.user.js`
  - `config` (20-45): no change.
  - `HISTORY_KEY` handling (157-191): record shape extension.
  - `pollStatuses` (2023-2076): videoId extraction + `completedAt`.
  - `renderQueue` (1495-1556): summary + badge for downloaded.
  - Root `innerHTML` (608-1191): Queue tab HTML add summary row + buttons + progress.
  - `els` mapping (1195-1259): add new element refs.
  - New function `downloadQueueCompleted` + helpers `getQueueCompletedRecords`, `getQueueDownloadCounts`.
  - `updateButtonStates` (2078-2121): enable/disable new buttons.
  - `attachEvents` (2134-2367): wire new buttons + Stop sharing.
  - `bootstrap` (2369-2471): ensure videoId capture log.

## Task 1: Extend history record + capture videoId in pollStatuses

**Files:**
- Modify: `videoexpress-manager.user.js:157-172` (history shape comment), `2023-2076` (pollStatuses)

**Interfaces:**
- Consumes: `api.getStatus(uuid)` → `statusPayload` (object with unknown videoId field)
- Produces: `record.videoId: string|null`, `record.completedAt: string|null`, `record.downloadedAt: string|null` (read by Tasks 2-3)

- [ ] **Step 1: Inspect current pollStatuses and document payload candidates**

Read `videoexpress-manager.user.js:2023-2076`. Confirm current `pollStatuses` only saves `statusPayload` without extracting id.

- [ ] **Step 2: Add helper to extract videoId from payload (minimal, testable via console)**

In `videoexpress-manager.user.js` after `isParallelLimitMessage`, add:

```js
function extractVideoIdFromStatus(payload) {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [
    payload.videoId,
    payload.mediaId,
    payload.video_id,
    payload.media_id,
    payload.id,
    payload.data && payload.data.id,
    payload.data && payload.data.videoId,
    payload.data && payload.data.mediaId,
    payload.result && payload.result.id,
    payload.video && payload.video.id,
  ];
  for (const v of candidates) if (v) return String(v);
  // fallback: scan one level for numeric id-like field
  for (const k of Object.keys(payload)) {
    if (/^(video|media)_?id$/i.test(k) && payload[k]) return String(payload[k]);
  }
  return null;
}
```

- [ ] **Step 3: Update pollStatuses to persist videoId + completedAt**

Modify `pollStatuses` loop body after `mapped` computed, before `nextRecord` creation:

```js
const videoId = mapped === "completed" ? extractVideoIdFromStatus(statusPayload) : record.videoId || null;
if (mapped === "completed" && videoId) console.log("[VE] videoId captured", record.uuid, videoId, statusPayload);
const nextRecord = {
  ...record,
  status: mapped,
  statusPayload,
  videoId: videoId || record.videoId || null,
  completedAt: mapped === "completed" ? (record.completedAt || new Date().toISOString()) : record.completedAt || null,
  downloadedAt: record.downloadedAt || null,
  updatedAt: new Date().toISOString(),
};
```

Ensure `runQueue`'s `baseRecord` initializes `videoId: null, downloadedAt: null, completedAt: null`.

- [ ] **Step 4: Manual verify in browser**

Load script via Tampermonkey, trigger one generation, open console, wait for `completed`, confirm log `[VE] videoId captured <uuid> <id>` appears and `localStorage[\"videoexpress.manager.history.v1\"]` record has `videoId`.

- [ ] **Step 5: Commit**

```bash
git add videoexpress-manager.user.js
git commit -m "feat: capture videoId in pollStatuses for queue downloads"
```

---

## Task 2: Queue tab UI — summary, buttons, progress

**Files:**
- Modify: `videoexpress-manager.user.js:608-1191` (innerHTML), `1195-1259` (els), `1495-1556` (renderQueue), `2078-2121` (updateButtonStates)

**Interfaces:**
- Consumes: `state.queue`, `state.history.records`, `getQueueDownloadCounts()` (produced in this task)
- Produces: DOM `#ve-queue-download-summary`, `#ve-queue-download-progress`, `#ve-download-completed-btn`, `#ve-download-remaining-btn` (used by Task 3)

- [ ] **Step 1: Add count helper**

Add after `buildQueue`:

```js
function getQueueDownloadCounts() {
  let completed = 0, downloaded = 0, remaining = 0;
  for (const item of state.queue) {
    const rec = getRecord(state.selectedFolderId, item.media.id);
    if (!rec || normalizeStatus(rec.status) !== "completed") continue;
    completed++;
    if (rec.downloadedAt) downloaded++;
    else remaining++;
  }
  return { completed, downloaded, remaining };
}
```

- [ ] **Step 2: Add HTML in Queue tab**

In root `innerHTML`, inside `data-panel="queue"` after the `.ve-stats` section and before `Queue preview` section, insert:

```html
<div class="ve-section" id="ve-queue-download-section">
  <div class="ve-section-title"><span><i class="bi bi-download"></i> Download generated</span></div>
  <div class="ve-muted" id="ve-queue-download-summary">No completed videos yet.</div>
  <div class="ve-progress" title="Queue download progress"><div class="ve-progress-bar" id="ve-queue-download-progress"></div></div>
  <div class="ve-row" style="margin-top:10px">
    <button class="ve-button primary" id="ve-download-completed-btn" type="button"><i class="bi bi-download"></i> Download Completed</button>
    <button class="ve-button success" id="ve-download-remaining-btn" type="button"><i class="bi bi-download"></i> Download Remaining</button>
  </div>
</div>
```

- [ ] **Step 3: Wire els refs**

Add to `els`:
```js
queueDownloadSummary: root.querySelector("#ve-queue-download-summary"),
queueDownloadProgress: root.querySelector("#ve-queue-download-progress"),
downloadCompletedBtn: root.querySelector("#ve-download-completed-btn"),
downloadRemainingBtn: root.querySelector("#ve-download-remaining-btn"),
```

- [ ] **Step 4: Update renderQueue to populate summary + downloaded badge**

At end of `renderQueue()`, after `els.queueBody.innerHTML = ...`:

```js
const counts = getQueueDownloadCounts();
els.queueDownloadSummary.textContent = counts.completed
  ? `Completed: ${counts.completed} | Downloaded: ${counts.downloaded} | Remaining: ${counts.remaining}`
  : "No completed videos yet. Run queue and wait for completion.";
els.queueDownloadProgress.style.width = counts.completed ? `${Math.round((counts.downloaded / counts.completed) * 100)}%` : "0%";
```

Modify row mapping to show downloaded badge: after `displayStatus` compute `isDownloaded = record && record.downloadedAt`:

```js
<td><span class="ve-badge ${getBadgeClass(displayStatus)}">${escapeHtml(displayStatus)}</span>${isDownloaded ? ` <span class="ve-badge completed">downloaded</span>` : ""}</td>
```

- [ ] **Step 5: Update updateButtonStates**

Add:
```js
const counts = getQueueDownloadCounts();
els.downloadCompletedBtn.disabled = state.running || state.uploadInProgress || state.downloadInProgress || counts.completed === 0;
els.downloadRemainingBtn.disabled = state.running || state.uploadInProgress || state.downloadInProgress || counts.remaining === 0;
```

- [ ] **Step 6: Visual verify**

Reload page, open Queue tab, confirm new section appears, buttons disabled when no completed, summary text updates after mocking a record in localStorage.

- [ ] **Step 7: Commit**

```bash
git add videoexpress-manager.user.js
git commit -m "feat: queue download UI with completed/remaining summary"
```

---

## Task 3: Download logic for queue completed

**Files:**
- Modify: `videoexpress-manager.user.js:1788-1847` (downloadVideos reference), add new `downloadQueueCompleted`, `attachEvents` wiring

**Interfaces:**
- Consumes: `state.history.records`, `extractVideoIdFromStatus`, `fetchAndDownload`, `randomDelay`, `resolveVideoDownloadName`, `getQueueDownloadCounts`, `state.downloadInProgress`, `config.downloadMinDelayMs/MaxDelayMs`
- Produces: `downloadQueueCompleted({onlyRemaining})` callable from button handlers

- [ ] **Step 1: Implement downloadQueueCompleted**

Add after `downloadVideos`:

```js
async function downloadQueueCompleted({ onlyRemaining }) {
  if (state.downloadInProgress) return;
  updateConfigFromInputs();
  const folder = getSelectedFolder();
  if (!folder) throw new Error("No folder selected.");
  const entries = state.queue
    .map(item => ({ item, rec: getRecord(folder.id, item.media.id) }))
    .filter(({ rec }) => rec && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt))
    .filter(({ rec }) => rec.videoId || rec.uuid); // must have resolvable target

  if (!entries.length) throw new Error(onlyRemaining ? "No remaining downloads." : "No completed videos to download.");

  // Fallback: if some rec lack videoId, fetch library once and correlate by newest datetime
  const missing = entries.filter(({ rec }) => !rec.videoId);
  let fallbackMap = new Map();
  if (missing.length) {
    logLine(`Resolving ${missing.length} missing videoIds via library fetch...`);
    const payload = await api.getAllVideos(folder.id);
    const vids = payload.results.filter(v => v.type === "video" || v.extension === "mp4").sort((a,b)=> new Date(b.datetime)-new Date(a.datetime));
    // naive: assign newest vids to missing entries in queue order
    missing.forEach(({ rec }, i) => { if (vids[i]) fallbackMap.set(rec.imageId, String(vids[i].id)); });
  }

  state.downloadInProgress = true;
  state.stopRequested = false;
  updateButtonStates();
  let completed = 0, failed = 0;
  const total = entries.length;
  els.queueDownloadProgress.style.width = "0%";

  try {
    for (const { item, rec } of entries) {
      if (state.stopRequested) break;
      const vid = rec.videoId || fallbackMap.get(rec.imageId);
      if (!vid) { failed++; logLine(`Skip ${rec.imageName}: no videoId resolvable`); continue; }
      const fakeVideo = { id: vid, uuid: rec.uuid, name: rec.imageName, fileName: rec.imageFileName };
      const fileName = resolveVideoDownloadName(fakeVideo);
      els.queueDownloadSummary.textContent = `${onlyRemaining ? "Remaining" : "Completed"}: downloading ${completed+1}/${total} | ${fileName}`;
      try {
        await fetchAndDownload(fakeVideo, fileName);
        const next = { ...rec, downloadedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        setRecord(folder.id, rec.imageId, next);
        completed++;
        logLine(`Queue download ${completed}/${total}: ${fileName}`);
      } catch (e) {
        failed++;
        logLine(`Queue download failed ${fileName}: ${e.message}`);
      }
      els.queueDownloadProgress.style.width = `${Math.round(((completed+failed)/total)*100)}%`;
      renderQueue(); updateButtonStates();
      if (completed+failed < total && !state.stopRequested) {
        const waitMs = randomDelay(config.downloadMinDelayMs, config.downloadMaxDelayMs);
        els.queueDownloadSummary.textContent = `${onlyRemaining ? "Remaining" : "Completed"}: waiting ${Math.round(waitMs/1000)}s (${completed+failed}/${total})`;
        await sleep(waitMs);
      }
    }
  } finally {
    state.downloadInProgress = false;
    updateButtonStates(); renderQueue();
    const ok = completed;
    els.queueDownloadSummary.textContent = state.stopRequested
      ? `${onlyRemaining ? "Remaining" : "Completed"}: stopped ${completed}/${total} downloaded`
      : `${onlyRemaining ? "Remaining" : "Completed"}: ${ok}/${total} downloaded, ${failed} failed | Remaining: ${getQueueDownloadCounts().remaining}`;
    logLine(state.stopRequested ? "Queue download stopped." : `Queue download finished ${ok}/${total}.`);
  }
}
```

Reuse `state.stopRequested` so existing Stop button can cancel (or add queue-specific stop sharing).

- [ ] **Step 2: Wire buttons in attachEvents**

```js
els.downloadCompletedBtn.addEventListener("click", () => handleAction(() => downloadQueueCompleted({ onlyRemaining: false })));
els.downloadRemainingBtn.addEventListener("click", () => handleAction(() => downloadQueueCompleted({ onlyRemaining: true })));
```

Extend `els.stopBtn` or `els.stopDownloadsBtn` to set `state.stopRequested = true` (already does) — ensure `downloadQueueCompleted` respects it. Optionally make `els.stopDownloadsBtn` also stop queue downloads (already shared flag).

- [ ] **Step 3: Functional verify**

With 2-3 completed records mocked (inject `videoId` + `completedAt`), click Download Remaining → confirm staggered downloads, filenames match image names, `downloadedAt` appears in localStorage, summary updates to `Remaining: 0`, reload confirms persistence. Click again → disabled.

- [ ] **Step 4: Commit**

```bash
git add videoexpress-manager.user.js
git commit -m "feat: implement queue download completed/remaining with tracking"
```

---

## Task 4: Final verification

**Files:**
- None (verification only)

- [ ] **Step 1: Syntax check**

Run: `node --check videoexpress-manager.user.js` (or `npx eslint` if available). Expected: no syntax errors.

- [ ] **Step 2: Manual E2E (requires live site)**

  1. Create test folder, upload 3 images.
  2. Run queue (videoLength 5s for speed).
  3. Wait for poll to mark completed (check console `[VE] videoId captured`).
  4. Click Download Remaining → 3 files download.
  5. Verify `localStorage` record has `downloadedAt`.
  6. Reload → counts show Downloaded 3, Remaining 0.
  7. Simulate 1 failure (invalid prompt) → counts show Failed 1, Remaining correct.

- [ ] **Step 3: Regression check**

Confirm Downloads tab still works: Load videos → select all → download still respects delays.
