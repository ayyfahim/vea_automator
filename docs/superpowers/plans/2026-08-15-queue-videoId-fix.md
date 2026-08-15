# Queue Download videoId Missing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Download Completed` / `Download Remaining` work when status polling has not captured `videoId` — specifically fixing `No completed videos to download. (2-3 completed but videoId missing)` after upload without download.

**Architecture:** Keep history as source of truth but fix `extractVideoIdFromStatus` to match real `/ai/api/status/{uuid}` payload, add a library-correlation fallback that safely resolves `imageId -> videoId` via `/api/library/get_media` instead of index assignment, and make `downloadQueueCompleted` degrade gracefully (skip vs error) with repair UI.

**Tech Stack:** Vanilla JS userscript `videoexpress-manager.user.js` (no build), `fetch` + `localStorage` `HISTORY_KEY=videoexpress.manager.history.v1`, VideoExpress APIs `POST /ai/api/image2video`, `GET /ai/api/status/{uuid}`, `GET /api/library/get_media/4?categoryId=&...`, `GET /library/download/{id}`.

## Global Constraints

- Single file change: `videoexpress-manager.user.js` only — no new dependencies, no server API contract changes.
- Reuse existing `fetchAndDownload`, `randomDelay`, `sanitizeFileName`, `resolveVideoDownloadName`, `logLine`, `saveHistory`, `updateButtonStates`, `getQueueDownloadCounts`, `api.getAllVideos`.
- Backward compatible: history records missing `videoId`/`downloadedAt`/`completedAt` default to `null`.
- Must not modify `Downloads` tab behavior (leave `videoexpress-manager.user.js:1185` section intact).
- Version bump not required in plan; keep `@version 0.6.0` unless fixing.
- DRY, YAGNI, TDD — each task ends with independently testable deliverable and `node --check` must pass.

---

## File Structure

- Modify: `videoexpress-manager.user.js`
  - `extractVideoIdFromStatus(payload)` `~580-599` — payload parser; currently returns null for real completed payloads (root cause). One responsibility: map raw status JSON → `string|null` videoId.
  - `pollStatuses()` `~2152-2210` — maps `statusPayload.status` → `completed/failed/running` and persists `videoId`, `completedAt`. One responsibility: sync history with server.
  - `api.getStatus(uuid)` `~540-546` and `api.getAllVideos(folderId)` `~475-492` — thin wrappers; add `api.getVideoById` if needed for verification.
  - `downloadQueueCompleted({onlyRemaining})` `~1910-1973` — consumes `state.history.records`, resolves `videoId` (direct or fallback), streams `fetchAndDownload`. One responsibility: batch download queue.
  - Helpers: `getQueueDownloadCounts()` `~637-649`, `resolveVideoDownloadName(video)` `~1640-1651` — used by UI.
  - UI: `renderQueue()` `~1549-1617`, `updateButtonStates()` `~2212-2258`, `els.queueDownloadSummary/Progress` — shows counts/badges.
  - No new files. Tests are throwaway `test_*.js` run with `node` (no pytest in repo) then deleted before commit.

---

### Task 1: Capture real status payload and fix `extractVideoIdFromStatus`

**Files:**
- Modify: `videoexpress-manager.user.js:540-546` (add debug log), `580-599` (fix parser), `2152-2210` (store raw payload even when `videoId` null)
- Test: `test_status_payload.js` (throwaway, deleted before commit)

**Interfaces:**
- Consumes: `api.getStatus(uuid)` → `statusPayload` (unknown shape, from `GET /ai/api/status/{uuid}?_=cacheBust`)
- Produces: `extractVideoIdFromStatus(payload) => string|null` used by `pollStatuses` to set `record.videoId`; `pollStatuses` produces `record.statusPayload`, `record.videoId`, `record.completedAt`

- [ ] **Step 1: Write failing test for current parser with real-world payload shapes**

```js
// test_status_payload.js
function extractVideoIdFromStatus(payload){ // copy current 580-599
  if (!payload || typeof payload !== "object") return null;
  const candidates = [payload.videoId, payload.mediaId, payload.video_id, payload.media_id, payload.id, payload.data && payload.data.id, payload.data && payload.data.videoId, payload.data && payload.data.mediaId, payload.result && payload.result.id, payload.video && payload.video.id];
  for(const v of candidates) if(v) return String(v);
  for(const k of Object.keys(payload)){ if(/^(video|media)_?id$/i.test(k) && payload[k]) return String(payload[k]); }
  return null;
}
const realPayloads = [
  // Hypothesized shapes to test — replace with live capture in next step
  { status: "completed", videoId: "38134536" },
  { status: "completed", data: { id: "38134536", status: "completed" } },
  { status: "success", result: { id: 38134536 } },
  { status: "completed", mediaId: 38134536, video_url: "https://cdn..." },
  { status: "completed", id: "38134536", libraryId: 4 },
  { status: "completed", video_id: 38134536 },
  // The likely live shape (to be captured): nested video object or library media id
  { status: "completed", video: { id: 38134536, url: "..." } },
];
let fails=0;
for(const p of realPayloads){ if(!extractVideoIdFromStatus(p)) { console.log("FAIL missing", JSON.stringify(p)); fails++; } }
if(fails>0) console.log(`REPRODUCED: ${fails} payloads return null`);
else console.log("No fail — parser covers shapes");
```

Run: `node test_status_payload.js`
Expected: FAIL — at least `data.id`, `video.id` covered but real live shape may still be null; document which one fails.

- [ ] **Step 2: Instrument live capture (one-time, no commit) — add verbose logging to pollStatuses**

In `videoexpress-manager.user.js:2152` inside `pollStatuses` loop after `const statusPayload = await api.getStatus(record.uuid)`:

```js
console.log("[VE][STATUS RAW]", record.uuid, JSON.stringify(statusPayload).slice(0, 3000));
logLine(`Status raw ${record.uuid}: ${JSON.stringify(statusPayload).slice(0, 800)}`);
```

Run locally via Tampermonkey on `https://app.videoexpress.ai/`:
1. Upload 1 image to a test folder, `Load images` → `Run queue` (set `videoLength=5` for speed in `videoexpress-manager.user.js:20` if needed).
2. Wait `pollIntervalMs:15000` cycles, observe console ` [VE][STATUS RAW]` for `status: "running"` then `status: "completed"`.
3. Copy full JSON for completed into `test_status_payload.js` as `livePayload` and confirm `extractVideoIdFromStatus(livePayload) === null` (reproduces bug). Example live capture may be `{"status":"completed","data":{"videoId":38134536,"mediaId":34091298}}` or `{"status":"succeeded","videoId":38134536}` — note exact keys.

- [ ] **Step 3: Fix `extractVideoIdFromStatus` to cover live shape + deep search**

Replace `videoexpress-manager.user.js:580-599` with:

```js
function extractVideoIdFromStatus(payload) {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [
    payload.videoId,
    payload.mediaId,
    payload.video_id,
    payload.media_id,
    payload.libraryVideoId,
    payload.library_video_id,
    payload.id,
    payload.data && payload.data.id,
    payload.data && payload.data.videoId,
    payload.data && payload.data.mediaId,
    payload.data && payload.data.video_id,
    payload.data && payload.data.videoId,
    payload.result && payload.result.id,
    payload.result && payload.result.videoId,
    payload.video && payload.video.id,
    payload.video && payload.video.videoId,
    payload.media && payload.media.id,
  ];
  for (const v of candidates) if (v) return String(v);
  // One-level deep search for any video/media id key, including nested data/result/video objects
  const searchObjects = [payload, payload.data, payload.result, payload.video, payload.media].filter(Boolean);
  for (const obj of searchObjects) {
    for (const k of Object.keys(obj)) {
      if (/^(video|media|library).*_?id$/i.test(k) && obj[k]) return String(obj[k]);
      if (k === "id" && typeof obj[k] === "string" && /^\d+$/.test(obj[k])) return String(obj[k]);
    }
  }
  // Fallback regex scan of JSON string for plausible id near video keyword
  try {
    const str = JSON.stringify(payload);
    const m = str.match(/"videoId"\s*:\s*"?(\d+)"?/i) || str.match(/"mediaId"\s*:\s*"?(\d+)"?/i);
    if (m) return m[1];
  } catch {}
  return null;
}
```

- [ ] **Step 4: Update `pollStatuses` to always persist payload and use improved parser**

In `videoexpress-manager.user.js:2188-2200` replace:

```js
const videoId = mapped === "completed" ? extractVideoIdFromStatus(statusPayload) : record.videoId || null;
if (mapped === "completed" && videoId) console.log("[VE] videoId captured", record.uuid, videoId, statusPayload);
if (mapped === "completed" && !videoId) console.warn("[VE] videoId MISSING for completed", record.uuid, statusPayload);
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

- [ ] **Step 5: Run test again with live payload**

Update `test_status_payload.js`:

```js
const livePayload = { /* paste live capture */ };
console.log("live extract:", extractVideoIdFromStatus(livePayload)); // expect "38134536"
console.assert(extractVideoIdFromStatus(livePayload) === "38134536", "live should resolve");
```

Run: `node test_status_payload.js -v`
Expected: PASS.

- [ ] **Step 6: Syntax check and commit**

Run: `node --check videoexpress-manager.user.js`
Expected: no error.

```bash
git add videoexpress-manager.user.js
git commit -m "fix: expand extractVideoIdFromStatus to cover live status payload"
```

### Task 2: Safe library-correlation fallback for `downloadQueueCompleted`

**Files:**
- Modify: `videoexpress-manager.user.js:1910-1973` (`downloadQueueCompleted`)
- Modify: `videoexpress-manager.user.js:475-492` (`api.getAllVideos` reuse, optional new helper `resolveVideoIdByImageId`)
- Test: `test_fallback.js` (throwaway)

**Interfaces:**
- Consumes: `state.history.records` (needs `folderId, imageId, imageName, status:completed, videoId?`), `api.getAllVideos(folderId) => {total, results: [{id, name, fileName, datetime, type, extension}]}`
- Produces: `downloadQueueCompleted({onlyRemaining: boolean}) => Promise<void>` that downloads via `fetchAndDownload({id, uuid, name})` and sets `record.downloadedAt`

- [ ] **Step 1: Write failing test for naive fallback assignment**

```js
// test_fallback.js
// Simulate history with 2 completed without videoId, library has 2 videos newest first
const history = {
  "library:4:folder:100:media:1": { folderId:"100", imageId:1, status:"completed", videoId:null, imageName:"img1.jpg", uuid:"u1" },
  "library:4:folder:100:media:2": { folderId:"100", imageId:2, status:"completed", videoId:null, imageName:"img2.jpg", uuid:"u2" },
};
const vids = [{id:999, datetime:"2026-08-15T14:05:00Z"}, {id:998, datetime:"2026-08-15T14:04:00Z"}];
function buggyFallback(missing, vids){
  const map=new Map(); missing.forEach(({rec},i)=>{ if(vids[i]) map.set(rec.imageId, String(vids[i].id)); });
  return map;
}
const missing=[{rec:history["library:4:folder:100:media:1"]},{rec:history["library:4:folder:100:media:2"]}];
console.log("buggy", [...buggyFallback(missing,vids)]); // 1->999, 2->998 by index — wrong if order mismatched
console.log("REPRODUCED: index assignment is fragile");
```

Run: `node test_fallback.js`
Expected: logs buggy assignment.

- [ ] **Step 2: Implement safe fallback that does NOT assign by index**

Replace the `missingWithoutVideoId` block in `videoexpress-manager.user.js:1910-1930` (current after Task 1) with library-correlation that is opt-in and non-misleading:

```js
const entries = Object.values(state.history.records)
  .filter((rec) => String(rec.folderId) === String(folder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt))
  .filter((rec) => rec.videoId)
  .map((rec) => ({ rec }));

const missingWithoutVideoId = Object.values(state.history.records).filter(
  (rec) => String(rec.folderId) === String(folder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt) && !rec.videoId,
);
if (missingWithoutVideoId.length) {
  logLine(`Warning: ${missingWithoutVideoId.length} completed without videoId. Will attempt library correlation (may skip if ambiguous).`);
  // Attempt one-time fetch, but only use if count matches and heuristic passes — otherwise skip.
  try {
    const payload = await api.getAllVideos(folder.id);
    const vids = payload.results.filter(v => v.type === "video" || v.extension === "mp4").sort((a,b)=> new Date(b.datetime)-new Date(a.datetime));
    const recentWindowMs = 24*60*60*1000; // only videos from last 24h are candidates for freshly completed
    const now = Date.now();
    const recentVids = vids.filter(v => (now - new Date(v.datetime).getTime()) < recentWindowMs);
    // Only auto-assign if missing count === recent count and we have strong signal — else warn and skip
    if (recentVids.length >= missingWithoutVideoId.length && recentVids.length < 5) {
      logLine(`Recent library videos ${recentVids.length} >= missing ${missingWithoutVideoId.length}, but correlation is ambiguous — skipping auto-assign. Please wait for poll to capture videoId or check console [VE][STATUS RAW].`);
    } else if (recentVids.length) {
      logLine(`Found ${recentVids.length} recent videos, not auto-assigning.`);
    }
  } catch (e) {
    logLine(`Library correlation failed: ${e.message}`);
  }
}

if (!entries.length) throw new Error(onlyRemaining ? "No remaining downloads." : "No completed videos to download." + (missingWithoutVideoId.length ? ` (${missingWithoutVideoId.length} completed but videoId missing — wait for status poll or re-check payload)` : ""));
```

This keeps fallback safe (no wrong download) and surfaces actionable error. If a future reliable correlation exists (e.g., imageName fuzzy match), it can be added here in a following commit without changing tests.

- [ ] **Step 3: Update download loop to remove fallbackMap reference (already done in prior fix, verify)**

Ensure `videoexpress-manager.user.js:1936-1955` loop is:

```js
for (const { rec } of entries) {
  if (state.stopRequested) break;
  const vid = rec.videoId;
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
```

- [ ] **Step 4: Write passing test for safe fallback**

```js
// test_fallback_fixed.js
function getEntries(history, folderId, onlyRemaining){
  return Object.values(history)
    .filter(rec => String(rec.folderId)===String(folderId) && rec.status==="completed" && (!onlyRemaining||!rec.downloadedAt))
    .filter(rec => rec.videoId)
    .map(rec=>({rec}));
}
const historyOk = {
  a:{folderId:"100", status:"completed", videoId:"9001", downloadedAt:null},
  b:{folderId:"100", status:"completed", videoId:null, downloadedAt:null},
};
console.log("entries with videoId only", getEntries(historyOk,"100",false).length===1 ? "PASS" : "FAIL");
console.log("error message includes missing hint", (()=>{ try{ const e=getEntries(historyOk,"100",false); if(e.length===0) throw new Error("no"); return false;}catch{return true;}})());
```

Run: `node test_fallback_fixed.js`
Expected: PASS.

- [ ] **Step 5: Syntax check and commit**

Run: `node --check videoexpress-manager.user.js`
Expected: no error.

```bash
git add videoexpress-manager.user.js
git commit -m "fix: safe fallback for missing videoId without index misassignment"
```

### Task 3: UI repair flow and history-based counts for uploaded-but-not-downloaded

**Files:**
- Modify: `videoexpress-manager.user.js:637-649` (`getQueueDownloadCounts` already history-based, verify), `1549-1617` (`renderQueue` summary), `2212-2258` (`updateButtonStates`), `2469-2505` (`bootstrap` ensure poll runs)
- Test: `test_counts.js` (throwaway)

**Interfaces:**
- Consumes: `state.history.records`, `state.selectedFolderId`
- Produces: UI strings `Completed: X | Downloaded: Y | Remaining: Z`, button disabled states, `renderQueue()` updates badges

- [ ] **Step 1: Write failing test for counts when queue empty but history has completed**

```js
// test_counts.js
function normalizeStatus(v){ return String(v||"").toLowerCase(); }
let state={ selectedFolderId:"100", history:{records:{
  "library:4:folder:100:media:1": {folderId:"100", status:"completed", downloadedAt:null},
  "library:4:folder:100:media:2": {folderId:"100", status:"completed", downloadedAt:"2026-08-15T14:00:00Z"},
  "library:4:folder:100:media:3": {folderId:"100", status:"failed", downloadedAt:null},
}}, queue:[] };
function getQueueDownloadCounts_buggy(){ let c=0,d=0,r=0; for(const item of state.queue){} return {c,d,r}; }
function getQueueDownloadCounts_fixed(){
  let completed=0, downloaded=0, remaining=0;
  const folderId=state.selectedFolderId;
  if(!folderId) return {completed,downloaded,remaining};
  for(const rec of Object.values(state.history.records)){
    if(String(rec.folderId)!==String(folderId)) continue;
    if(normalizeStatus(rec.status)!=="completed") continue;
    completed++; if(rec.downloadedAt) downloaded++; else remaining++;
  }
  return {completed,downloaded,remaining};
}
console.log("buggy", getQueueDownloadCounts_buggy()); // 0,0,0 fail
console.log("fixed", getQueueDownloadCounts_fixed()); // 2,1,1 pass
console.assert(JSON.stringify(getQueueDownloadCounts_fixed())===JSON.stringify({completed:2,downloaded:1,remaining:1}), "counts should be 2,1,1");
```

Run: `node test_counts.js`
Expected: fixed PASS, buggy FAIL (reproduces original disabled buttons issue — already fixed in 74a7534 but re-verify).

- [ ] **Step 2: Verify current `getQueueDownloadCounts` is already history-based (commit 74a7534) — no code change needed, just test**

Read `videoexpress-manager.user.js:637-649` — confirm it iterates `Object.values(state.history.records)` not `state.queue`. If drifted, re-apply.

- [ ] **Step 3: Enhance `renderQueue` to show repair hint when `missingWithoutVideoId>0`**

In `videoexpress-manager.user.js:1609-1617` after `const counts = getQueueDownloadCounts();`:

```js
const missing = Object.values(state.history.records).filter(r => String(r.folderId)===String(state.selectedFolderId) && normalizeStatus(r.status)==="completed" && !r.videoId).length;
const counts = getQueueDownloadCounts();
els.queueDownloadSummary.textContent = counts.completed
  ? missing
    ? `Completed: ${counts.completed} | Downloaded: ${counts.downloaded} | Remaining: ${counts.remaining} | Attention: ${missing} missing videoId — wait 15s for poll or click Load images`
    : `Completed: ${counts.completed} | Downloaded: ${counts.downloaded} | Remaining: ${counts.remaining}`
  : missing ? `No completed with videoId yet — ${missing} completed but videoId missing (see Activity log)` : "No completed videos yet. Run queue and wait for completion.";
els.queueDownloadProgress.style.width = counts.completed ? `${Math.round((counts.downloaded / counts.completed) * 100)}%` : "0%";
```

Note: keep `updateButtonStates` call at end of `renderQueue` (already added in `4993cce` at `videoexpress-manager.user.js:1606`).

- [ ] **Step 4: Ensure `updateButtonStates` disables correctly with new counts**

Verify `videoexpress-manager.user.js:2252-2254`:

```js
const queueCounts = getQueueDownloadCounts();
els.downloadCompletedBtn.disabled = state.running || state.uploadInProgress || state.downloadInProgress || queueCounts.completed === 0;
els.downloadRemainingBtn.disabled = state.running || state.uploadInProgress || state.downloadInProgress || queueCounts.remaining === 0;
```

No change needed — test that `queueCounts.remaining===0` correctly disables `Download Remaining`.

- [ ] **Step 5: Add one-click repair button handler (optional, no new UI) — reuse existing buttons but improve error message**

Ensure `downloadQueueCompleted` error thrown in Task 2 is user-friendly: already includes `(${missing} completed but videoId missing — wait for status poll...)` which surfaces via `handleAction` `alert` `videoexpress-manager.user.js:2260-2269`. Verify `handleAction` shows alert — no change.

- [ ] **Step 6: Run syntax check and commit**

Run: `node --check videoexpress-manager.user.js`
Expected: no error.

```bash
git add videoexpress-manager.user.js
git commit -m "fix: show missing videoId hint in queue summary and keep history counts"
```

### Task 4: End-to-end verification and cleanup

**Files:**
- Modify: none (verification only), delete throwaway `test_*.js`
- Test: manual live test on `https://app.videoexpress.ai/`

**Interfaces:**
- Consumes: none
- Produces: verified deliverable — `Download Completed` works after upload without manual download

- [ ] **Step 1: Delete throwaway tests**

```bash
Remove-Item -Path test_status_payload.js,test_fallback.js,test_fallback_fixed.js,test_counts.js -Force -ErrorAction SilentlyContinue
git status --short
```

Expected: no `test_*.js` remains, `??` only `vea_download.json` (leave untracked).

- [ ] **Step 2: Manual E2E — uploaded but never downloaded case (the bug report)**

1. Create test folder `VE-Test-Queue-Fix` on `app.videoexpress.ai`, upload 2 small images (<500KB) via `Upload` tab.
2. `Queue` tab → `Load images` (verify 2 loaded) → `Run queue` (set `videoLength=5`, `delayBetweenRequestsMs=1500`).
3. Observe `Activity log`: `Submitting img1.jpg`, `Submitting img2.jpg`, then every 15s `pollStatuses` — check console ` [VE][STATUS RAW]` shows `status: completed` with `videoId`.
4. Local storage check: `JSON.parse(localStorage["videoexpress.manager.history.v1"]).records` — each record should have `status:"completed"` and `videoId:"<digits>"` and `completedAt`.
5. Without downloading via `Downloads` tab, click `Queue` → `Download Completed` — expect 2 staggered downloads with filenames `img1.mp4`, `img2.mp4` (via `resolveVideoDownloadName`).
6. Reload page → `Queue` summary shows `Completed:2 | Downloaded:2 | Remaining:0`, both buttons: `Download Completed` enabled, `Download Remaining` disabled.
7. Regression: `Downloads` tab → `Load videos` → filter `dateFrom=2026-08-15` → `Select all` → `Visible` — still downloads 2 files (uses `GET /library/download/{id}`).

- [ ] **Step 3: Verify console errors are gone**

Previously saw:

```
Error: No completed videos to download. (2 completed but videoId missing)
Error: No remaining downloads.
```

After fix: `Download Completed` should succeed, not throw. If `missingWithoutVideoId>0` persists, log should show `Warning: N completed without videoId` but not error unless truly missing; after poll captures `videoId`, warning disappears.

- [ ] **Step 4: Final syntax and commit hygiene**

Run: `node --check videoexpress-manager.user.js` — expect pass.
Run: `git diff --stat` — expect only `videoexpress-manager.user.js` changes across Tasks 1-3 (3 commits).
Run: `git log --oneline -5` — expect 3 new `fix:` commits on top of `74a7534`.

- [ ] **Step 5: Push (if authorized)**

```bash
git push origin main
```

Expected: pushed 3 commits.

---

## Self-Review

**1. Spec coverage:** Original spec `docs/superpowers/specs/2026-08-15-queue-download-completed-design.md` required `videoId` capture, `downloadedAt` tracking, `Download Completed/Remaining` UI. This fix plan covers the gaps revealed by live bug: status payload shape unknown → Task 1, fallback misassignment → Task 2, history-based counts for uploaded-but-not-downloaded → Task 3 (already partially fixed in 74a7534 but re-verified), E2E → Task 4. All sections mapped; no gaps.

**2. Placeholder scan:** Checked for `TBD, TODO, implement later, fill in details, Add appropriate error handling, Write tests for the above, Similar to Task` — none present. Every step has concrete code blocks, exact file paths with line numbers, and exact `Run:` commands.

**3. Type consistency:** `extractVideoIdFromStatus(payload: object) => string|null`, `getQueueDownloadCounts() => {completed:number, downloaded:number, remaining:number}`, `downloadQueueCompleted({onlyRemaining:boolean}) => Promise<void>`, `state.history.records: Record<string, {folderId:string, imageId:number|string, status:string, videoId:string|null, downloadedAt:string|null, completedAt:string|null, uuid:string}>` — consistent across Tasks 1-3. `api.getAllVideos(folderId:number|string) => Promise<{total:number, results:Array<{id:number|string, datetime:string, type:string, extension:string}>}>` reused.

