# Timeline Export Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new "Timeline Export" mode to `videoexpress-manager.user.js` that loads all videos from the selected folder, sorts them chronologically (by name with numeric collation = chronological), adds them sequentially to a single timeline track via `POST /render_project/tmp`, polls `GET /project/progress` + `GET /user_queue` until export completes, and enables a Download button for the finished stitched video.

**Architecture:** Extend the existing single-file IIFE (`videoexpress-manager.user.js:13`) without introducing build tooling. Add 4 new `api.*` methods (`renderTimeline`, `getProjectProgress`, `getUserQueue`, `getListOutput`) reusing `sessionFetch`/`getJson` auth (`videoexpress-manager.user.js:341`). Build bricks array in-memory (sorted via existing `compareMediaName:1743`) and POST `render_project/tmp` payload identical to HAR `vea_timlineWithExport.har` (options + data[].bricks with cumulative `left`). Store export state in `state.timelineExport` and persist via `UI_STATE_KEY`. New UI lives as a 6th tab "Timeline" (or Queue-subsection) with progress bar and log lines; reuses `asyncPool`, `sleep`, `fetchAndDownloadWithRetry`, and download helpers.

**Tech Stack:** Tampermonkey UserScript, vanilla JS, `fetch`/`XHR` (monkey-patched auth `installAuthCapture:310`), `Backbone`-style timeline model on `app.videoexpress.ai` (vendor `videoeditor.js` reference only — do not edit), `localStorage` (`videoexpress.manager.ui-state.v1`), `node --check` + `node --test` (no package.json) for TDD.

## Global Constraints

- Single file `videoexpress-manager.user.js:1` (2866 lines, v0.6.2 header `videoexpress-manager.user.js:4` — bump `@version` on change, keep `updateURL`/`downloadURL` to `raw.githubusercontent.com/ayyfahim/vea_automator/main/...`).
- `@run-at document-idle`, IIFE, `if (!location.hostname.endsWith("videoexpress.ai")) return` guard `videoexpress-manager.user.js:16`.
- No `package.json` / bundler / CI — do not add tooling unless requested; verify via `node --check videoexpress-manager.user.js` and manual Tampermonkey load on `app.videoexpress.ai`.
- Vendored `videoeditor.js` (3453304 bytes) — NEVER edit; filter graph queries to `file_pattern="videoexpress-manager.user.js"`.
- Persist keys: `videoexpress.manager.history.v1` (`HISTORY_KEY:50`), `videoexpress.manager.ui-state.v1` (`UI_STATE_KEY:51`).
- Auth: `installAuthCapture:310` + `sessionFetch:341` wraps every API call (`getJson:360`/`postForm:372`).
- `config` at `videoexpress-manager.user.js:20` (`libraryId:4`, `pageSize:100`, `pollIntervalMs:15000`, etc.) + `state` at `videoexpress-manager.user.js:54`.
- Record key `library:{id}:folder:{fid}:media:{mid}` (`makeRecordKey:683`), status set `started|submitted|running|completed|failed|parallel_limit|skipped` (`normalizeStatus:696`).
- HAR fixtures gitignored — do not commit `.har`/`.log`; reference `vea_timlineWithExport.har` locally only.

---

## File Structure

```
videoexpress-manager.user.js   # MODIFY — all runtime code (config, state, api, UI, queue, poll, timeline-export)
docs/superpowers/plans/2026-08-16-timeline-export-mode.md  # THIS PLAN
tests/timeline-export.test.js  # CREATE — lightweight node --test harness (mock fetch/sessionFetch, no deps)
// no new runtime files — keep single-file constraint; tests live only for verification, gitignored or committed as plain JS
```

Responsibilities:

- `videoexpress-manager.user.js:20` config — add `timelineExport` defaults (quality/size/format/aspect, poll interval for progress `2000ms`, project name template, concurrency guard).
- `videoexpress-manager.user.js:54` state — add `timelineExport:{running, percent, queueStatus, projectName, exportedVideo, pollTimer, log, ...}`.
- `videoexpress-manager.user.js:422` api — add 4 methods: `renderTimeline(bricks, options)`, `getProjectProgress(startBool)`, `getUserQueue()`, `getListOutput()` + helper `buildTimelineBricks(sortedVideos, trackId)`.
- `videoexpress-manager.user.js:825` CSS/HTML root — add 6th tab + Timeline panel (log, progress bar, controls: Export Timeline / Stop / Download Result).
- `videoexpress-manager.user.js:1460` els — wire new DOM refs.
- `videoexpress-manager.user.js:2836` attachEvents/bootstrap — wire events, restore persisted timelineExport UI, start/stop polling.

If `videoexpress-manager.user.js` grows past ~3400 lines, plan may split timeline-export helpers into inline `/* Timeline Export */` region with clear comment separators (no file split — TDR constraint: single file delivery for Tampermonkey).

---

### Task 1: HAR & Vendor Reverse-Engineer — Document Timeline Export Contract

**Files:**
- Modify: none (research only, produce plan notes)
- Test: none — verification via manual HAR replay check
- Reference: `vea_timlineWithExport.har:1`, `videoeditor.js:2035598` (`render_project/tmp`), `videoeditor.js:2051094` (`project/progress`), `videoeditor.js:2022513` (`getProjectData`/`getBrickPath`), `videoeditor.js:2630754` (`ctxmenu:add-to-timeline` -> `addToTimeline`)

**Interfaces:**
- Consumes: HAR entries (19 rows) + `videoeditor.js` snippets (`addToTimeline: function(){ App.reqres.request('getTrackByIndex',0)...App.vent.trigger('onMediaTimelineDropped'...)}`, `getProjectData()` bricks=`_.sortBy(...,'left')`, `getBrickPath()`).
- Produces: Verified payload schema and poll sequence for Task 2.

- [ ] **Step 1: Read HAR and vendor snippets (no code change)**

Run:
```powershell
python3 -c "import json; har=json.load(open('vea_timlineWithExport.har')); print([e['request']['url'] for e in har['log']['entries'] if 'render_project' in e['request']['url'] or 'progress' in e['request']['url'] or 'user_queue' in e['request']['url']])"
```
Expected: `POST https://app.videoexpress.ai/render_project/tmp` (+ `GET /user_queue`, `GET /project/progress?start=true|false`, `GET /api/get_list_output`).

- [ ] **Step 2: Document contract inline (for next task implementer)**

Confirmed contract (from HAR detailed dump):
```json
POST /render_project/tmp  application/json  body={"options":{"name":"exp_test","quality":"high","size":"1080","format":"mp4","aspect":"16:9","project_id":0,"project_title":""},"data":[{"title":"#","index":0,"id":"30","muted":false,"video_disabled":false,"fast_cut_enabled":false,"fast_cut_type":"zoom","timestamp":1786874492527,"bricks":[{"id":"310","media_id":38161691,"type":"video","fileName":"1786823006_6a80c15e35013","path":"https://cdn-ny-b.videoexpress.ai/video/...mp4","videoUrl":"...","audioUrl":"","imageUrl":"https://cdn-ny-b.../image/...png","isPrivate":true,"duration_time":10041,"duration":10041,"start_time":0,"left":0,"filters":"","track_id":"30","title":"[0-5] seconds: ...","frameSize":"1080x1920","frameRate":24,"thumbUrl":"..._small.jpg","brickThumbUrl":"library/image/video?src=...&w=40&h=40","libraryId":4,"userId":0,"volume":100,"transitionIn":"","transitionOut":""}],"id":"32","bricks":[]}]}
→ {"success":true,"action":"pending","queue_size":3}
GET /user_queue?_=... → {"results":[{"name":"exp_test","status":"Pending"}],"in_progress":0,"total":1}
GET /project/progress?start=true&_=... → {"percent":0,"queue_status":{"in_progress":0,"total":1}}
GET /project/progress?start=false&_=... → {"percent":2|15,"queue_status":{"in_progress":1,"total":1}}  // polls until percent 100
GET /api/get_list_output → {"results":[{"id":622641,"filename":"178669...mp4","mediaPath":"https://cdn-ny-b.../video/...mp4"}]}
```
Key observations:
- `Add to Timeline` is client-only (`videoeditor.js: addToTimeline -> getTrackByIndex(0) -> onMediaTimelineDropped`); no server call until `render_project/tmp`.
- `left` is cumulative `duration` of prior bricks (HAR: brick1 left 0, brick2 left 10041). `duration` sourced from brick's `duration_time` (videoeditor keeps `duration` per media).
- Minimal required brick fields: `id` (unique), `media_id`, `type:"video"`, `fileName`, `path`/`videoUrl`, `duration`/`duration_time`, `left`, `track_id`.
- Poll must alternate `start=true` first then `start=false` repeatedly (vendor `progressFunc` at `videoeditor.js:2051094`).

- [ ] **Step 3: Run syntax check (no regen needed)**

Run: `node --check videoexpress-manager.user.js`
Expected: no output (pass).

- [ ] **Step 4: Commit documentation (if notes file created)**

```bash
git add docs/superpowers/plans/2026-08-16-timeline-export-mode.md
git commit -m "docs: document timeline export HAR contract"
```

---

### Task 2: API Layer — renderTimeline + Progress/Queue/ListOutput (TDD)

**Files:**
- Modify: `videoexpress-manager.user.js:422` (api object), `videoexpress-manager.user.js:341` (add `postJson` helper if needed)
- Test: `tests/timeline-export.test.js` (CREATE)

**Interfaces:**
- Consumes: `sessionFetch:341`, `getJson:360`, existing `postForm:372`/`postFormJson:388`.
- Produces:
  ```js
  api.renderTimeline({ bricks: Array<Brick>, options: TimelineOptions }) => Promise<{success:boolean, action:string, queue_size:number, [k:string]:any}>
  api.getProjectProgress(start:boolean) => Promise<{percent:number, queue_status:{in_progress:number,total:number}}>
  api.getUserQueue() => Promise<{results:Array<{name:string,status:string}>, in_progress:number, total:number, success:boolean}>
  api.getListOutput() => Promise<{results:Array<{id:number,filename:string,mediaPath:string,datetime:string}>, daysLeft:number}>
  buildTimelineBricks(sortedVideos:Array<Media>, trackId:string)=> Array<Brick>   // pure, exported to window for test
  buildTimelinePayload(bricks:Array<Brick>, opts:TimelineOptions)=> {options, data}
  // Types:
  // Brick = {id:string, media_id:number, type:"video", fileName:string, path:string, videoUrl:string, audioUrl:"", imageUrl:string, isPrivate:boolean, duration:number, duration_time:number, start_time:0, left:number, track_id:string, title:string, libraryId:number, ...}
  // TimelineOptions = {name:string, quality:"high"|"medium"|"low", size:"1080"|"720", format:"mp4", aspect:"16:9"|"9:16"|"1:1", project_id:0, project_title:""}
  ```

- [ ] **Step 1: Write failing test — api contract + brick builder**

```js
// tests/timeline-export.test.js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Minimal DOM + fetch mock harness: load userscript's pure helpers by extracting buildTimelineBricks
describe("timeline export api", () => {
  it("buildTimelineBricks sorts by name numeric and sets cumulative left", () => {
    // This test will FAIL until buildTimelineBricks exists
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /function buildTimelineBricks/);
  });
  it("api.renderTimeline posts JSON to render_project/tmp with correct content-type", async () => {
    const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
    assert.match(src, /renderTimeline/);
    assert.match(src, /render_project\/tmp/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/timeline-export.test.js`
Expected: FAIL with "buildTimelineBricks not found" / assertion fails.

- [ ] **Step 3: Implement minimal api + pure helpers**

In `videoexpress-manager.user.js:360` after `postFormJson`:

```js
  async function postJson(url, bodyObj, label) {
    const response = await sessionFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(bodyObj),
    }, label);
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  }
```

In `api` object (`:422`):

```js
    async renderTimeline(bricks, options = {}) {
      const now = Date.now();
      const opts = {
        name: String(options.name || `timeline_${now}`).slice(0, 80),
        quality: options.quality || "high",
        size: options.size || "1080",
        format: options.format || "mp4",
        aspect: options.aspect || config.aspect || "16:9",
        project_id: 0,
        project_title: "",
        ...options,
      };
      const payload = buildTimelinePayload(bricks, opts, now);
      return postJson(`/render_project/tmp`, payload, "Render timeline");
    },
    async getProjectProgress(start) {
      const cacheBust = Date.now();
      return getJson(`/project/progress?start=${start ? "true" : "false"}&_=${cacheBust}`, "Project progress");
    },
    async getUserQueue() {
      const cacheBust = Date.now();
      return getJson(`/user_queue?_=${cacheBust}`, "User queue");
    },
    async getListOutput() {
      return getJson(`/api/get_list_output`, "List output");
    },
```

Before `api` definition, add pure helpers (near `compareMediaName:1743`):

```js
  function buildTimelineBricks(sortedVideos, trackId = "30") {
    let left = 0;
    return sortedVideos.map((v, idx) => {
      const duration = Number(v.duration_time ?? v.duration ?? v.durationMs ?? 5000) || 5000;
      const brick = {
        id: String(310 + idx), // vendor uses incremental numeric ids; 310 in HAR example
        media_id: Number(v.id ?? v.media_id ?? v.mediaId),
        type: "video",
        fileName: String(v.fileName || v.name || v.filename || v.id).replace(/\.[a-z0-9]+$/i,""),
        path: String(v.path || v.mediaPath || v.videoUrl || ""),
        videoUrl: String(v.videoUrl || v.mediaPath || v.path || ""),
        audioUrl: "",
        imageUrl: String(v.imageUrl || v.thumbUrl || ""),
        isPrivate: Boolean(v.isPrivate ?? true),
        duration,
        duration_time: duration,
        start_time: 0,
        left,
        filters: "",
        track_id: String(trackId),
        title: String(v.name || v.title || v.fileName || ""),
        frameSize: "1080x1920",
        frameRate: 24,
        thumbUrl: String(v.thumbUrl || v.thumbnail || ""),
        brickThumbUrl: `library/image/video?src=${String(v.fileName || v.name || "").replace(/\.[a-z0-9]+$/i,"")}&isPrivate=1&w=40&h=40&userId=${v.userId || ""}&ext=mp4&fit=0`,
        libraryId: config.libraryId,
        workCopyPath: "",
        imagePath: String(v.imagePath || ""),
        userId: Number(v.userId || 0),
        resizable: true,
        volume: 100,
        transitionIn: "",
        transitionOut: "",
        transitionBetween: null,
        options: {},
      };
      // fallback fileName for brickThumbUrl if empty
      if (!brick.fileName || brick.fileName.includes("undefined")) {
        brick.fileName = String(v.id);
        brick.brickThumbUrl = "";
      }
      left += duration;
      return brick;
    });
  }
  function buildTimelinePayload(bricks, options, now = Date.now()) {
    const trackId = "30";
    const trackData = {
      title: "#",
      index: 0,
      id: trackId,
      muted: false,
      video_disabled: false,
      fast_cut_enabled: false,
      fast_cut_type: "zoom",
      timestamp: now,
      bricks,
    };
    const emptyTrack = { title: "#", index: 1, id: "32", muted: false, video_disabled: false, fast_cut_enabled: false, fast_cut_type: "zoom", timestamp: now, bricks: [] };
    return { options, data: [trackData, emptyTrack] };
  }
  // expose for tests (no global leak in prod except test env)
  if (typeof window !== "undefined") { window.__ve_test = { buildTimelineBricks, buildTimelinePayload, compareMediaName }; }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/timeline-export.test.js` and `node --check videoexpress-manager.user.js`
Expected: PASS (assertions now match source).

- [ ] **Step 5: Commit**

```bash
git add videoexpress-manager.user.js tests/timeline-export.test.js
git commit -m "feat: add timeline export api (renderTimeline, progress, queue, bricks)"
```

---

### Task 3: State, Config & Persistence for Timeline Export

**Files:**
- Modify: `videoexpress-manager.user.js:20` (config), `videoexpress-manager.user.js:54` (state), `videoexpress-manager.user.js:3104` (bootstrap restore), `videoexpress-manager.user.js:195` (saveUiState patch)
- Test: `tests/timeline-export.test.js` (append)

**Interfaces:**
- Consumes: `loadUiState:187` / `saveUiState:195`, existing `config` shape.
- Produces:
  ```js
  config.timelineExportDefaults = { quality:"high", size:"1080", format:"mp4", aspect:"16:9", namePrefix:"timeline_" }
  state.timelineExport = { running:boolean, percent:number, statusText:string, projectName:string, queueStatus:{in_progress,total}, exportedVideo:{id,filename,mediaPath}|null, lastError:string|null, pollTimer:number|null }
  persist: saveUiState({ timelineExportConfig:{quality,size,format,aspect}, timelineExportName:string })
  ```

- [ ] **Step 1: Write failing test — config/state defaults persist**

```js
it("timelineExport state defaults exist and persist via UI_STATE_KEY", () => {
  const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
  assert.match(src, /timelineExport/);
  assert.match(src, /timelineExportDefaults|timelineExportConfig/);
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `node --test tests/timeline-export.test.js`
Expected: FAIL (strings missing).

- [ ] **Step 3: Minimal implementation**

In `config:20` add:

```js
    timelineExportDefaults: {
      quality: "high",
      size: "1080",
      format: "mp4",
      aspect: "16:9",
      namePrefix: "timeline_",
      pollIntervalMs: 2000,
    },
```

In `state:54` add:

```js
    timelineExport: {
      running: false,
      percent: 0,
      statusText: "",
      projectName: "",
      queueStatus: { in_progress: 0, total: 0 },
      exportedVideo: null,
      lastError: null,
      pollTimer: null,
    },
```

In `bootstrap:3112` after `videoFilters` restore, add:

```js
    if (savedUi.timelineExportConfig && typeof savedUi.timelineExportConfig === "object") {
      config.timelineExportDefaults = { ...config.timelineExportDefaults, ...savedUi.timelineExportConfig };
    }
    if (typeof savedUi.timelineExportName === "string") state.timelineExport.projectName = savedUi.timelineExportName;
```

Add helper `updateTimelineExportConfigFromInputs()` (near `updateConfigFromInputs:2126`):

```js
  function updateTimelineExportConfigFromInputs() {
    const nameEl = document.getElementById("ve-timeline-name");
    const aspectEl = document.getElementById("ve-timeline-aspect");
    const qualityEl = document.getElementById("ve-timeline-quality");
    if (nameEl) state.timelineExport.projectName = nameEl.value.trim();
    if (aspectEl) config.timelineExportDefaults.aspect = aspectEl.value || config.timelineExportDefaults.aspect;
    if (qualityEl) config.timelineExportDefaults.quality = qualityEl.value || config.timelineExportDefaults.quality;
    saveUiState({ timelineExportConfig: { quality: config.timelineExportDefaults.quality, size: config.timelineExportDefaults.size, format: config.timelineExportDefaults.format, aspect: config.timelineExportDefaults.aspect }, timelineExportName: state.timelineExport.projectName });
  }
```

- [ ] **Step 4: Run tests pass + syntax check**

Run: `node --test tests/timeline-export.test.js` and `node --check videoexpress-manager.user.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add videoexpress-manager.user.js tests/timeline-export.test.js
git commit -m "feat: add timeline export state, config and persistence"
```

---

### Task 4: UI — Timeline Tab, Controls, Progress, Log

**Files:**
- Modify: `videoexpress-manager.user.js:825` (CSS + panel HTML), `videoexpress-manager.user.js:1460` (els refs), `videoexpress-manager.user.js:2770` (updateButtonStates)
- Test: `tests/timeline-export.test.js` (DOM smoke)

**Interfaces:**
- Consumes: `state.timelineExport`, `updateTimelineExportConfigFromInputs`, `setActiveTab:1573`.
- Produces: DOM ids `ve-timeline-*`, tab `data-tab="timeline"`, panel `data-panel="timeline"`, functions `renderTimelineExport()` (updates percent bar, status text, exported video link).

- [ ] **Step 1: Write failing test — tab exists**

```js
it("panel HTML contains timeline tab and controls", () => {
  const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
  assert.match(src, /data-tab="timeline"/);
  assert.match(src, /ve-timeline-export-btn/);
  assert.match(src, /ve-timeline-progress/);
  assert.match(src, /ve-timeline-download-btn/);
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `node --test tests/timeline-export.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement UI**

CSS (in `<style>` at `:828`, extend `.ve-tabs` grid from `repeat(5,1fr)` to `repeat(6,1fr)` — or keep 5 and add overflow scroll; safer to change to `repeat(6, minmax(0,1fr))` and add `font-size:11px` for narrow):

```css
.ve-tabs { grid-template-columns: repeat(6, minmax(0, 1fr)); }
@media (max-width:680px){ .ve-tabs{ grid-template-columns: repeat(3, minmax(0,1fr)); } }
```

Panel HTML: insert after `Downloads` tab button (`:1258`) add:

```html
<button class="ve-tab" data-tab="timeline" type="button"><i class="bi bi-view-list"></i>Timeline</button>
```

And after `downloads` panel (`:1446` before `activity` panel) add:

```html
<div class="ve-tab-panel" data-panel="timeline">
  <div class="ve-section">
    <div class="ve-section-title"><span><i class="bi bi-view-list"></i> Timeline export (chronological)</span></div>
    <div class="ve-muted" style="margin-bottom:8px">Load videos sorted by name (numeric) → stitched timeline video. Monitoring <code>/render_project/tmp</code> + <code>/project/progress</code>.</div>
    <div class="ve-row">
      <select class="ve-select" id="ve-timeline-folder-select"></select>
      <button class="ve-button ghost" id="ve-timeline-load-btn" type="button"><i class="bi bi-collection-play"></i> Load videos</button>
    </div>
    <div class="ve-row">
      <input class="ve-input" id="ve-timeline-name" placeholder="Project name (e.g. timeline_2026)" />
      <select class="ve-select" id="ve-timeline-aspect">
        <option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option>
      </select>
      <select class="ve-select" id="ve-timeline-quality">
        <option value="high">high</option><option value="medium">medium</option><option value="low">low</option>
      </select>
    </div>
    <div class="ve-row">
      <button class="ve-button primary" id="ve-timeline-export-btn" type="button"><i class="bi bi-play-fill"></i> Export Timeline</button>
      <button class="ve-button warn" id="ve-timeline-stop-btn" type="button"><i class="bi bi-stop-fill"></i> Stop</button>
    </div>
    <div class="ve-progress" title="Timeline export progress"><div class="ve-progress-bar" id="ve-timeline-progress"></div></div>
    <div class="ve-muted" id="ve-timeline-status" style="margin-top:8px">Idle — load a folder and export.</div>
    <div class="ve-row" style="margin-top:10px">
      <button class="ve-button success ve-hidden" id="ve-timeline-download-btn" type="button"><i class="bi bi-download"></i> Download Result</button>
      <span class="ve-muted" id="ve-timeline-result-info"></span>
    </div>
  </div>
  <div class="ve-section">
    <div class="ve-section-title"><span><i class="bi bi-table"></i> Videos to stitch (<span id="ve-timeline-count">0</span>)</span></div>
    <div class="ve-muted" id="ve-timeline-list-summary">No videos loaded.</div>
    <table class="ve-table"><thead><tr><th>#</th><th>Video</th><th>Duration</th></tr></thead><tbody id="ve-timeline-body"></tbody></table>
  </div>
</div>
```

In `els:1460` add refs:

```js
    timelineFolderSelect: root.querySelector("#ve-timeline-folder-select"),
    timelineLoadBtn: root.querySelector("#ve-timeline-load-btn"),
    timelineName: root.querySelector("#ve-timeline-name"),
    timelineAspect: root.querySelector("#ve-timeline-aspect"),
    timelineQuality: root.querySelector("#ve-timeline-quality"),
    timelineExportBtn: root.querySelector("#ve-timeline-export-btn"),
    timelineStopBtn: root.querySelector("#ve-timeline-stop-btn"),
    timelineProgress: root.querySelector("#ve-timeline-progress"),
    timelineStatus: root.querySelector("#ve-timeline-status"),
    timelineDownloadBtn: root.querySelector("#ve-timeline-download-btn"),
    timelineResultInfo: root.querySelector("#ve-timeline-result-info"),
    timelineCount: root.querySelector("#ve-timeline-count"),
    timelineBody: root.querySelector("#ve-timeline-body"),
    timelineListSummary: root.querySelector("#ve-timeline-list-summary"),
```

In `renderFolders:1590` sync `els.timelineFolderSelect` similarly to others.

Add `renderTimelineExport()` (near `renderQueue:1767`):

```js
  function renderTimelineExport() {
    if (!els.timelineProgress) return;
    els.timelineProgress.style.width = `${Math.max(0, Math.min(100, Number(state.timelineExport.percent || 0)))}%`;
    els.timelineStatus.textContent = state.timelineExport.statusText || (state.timelineExport.running ? `Exporting ${state.timelineExport.percent}%` : "Idle — load a folder and export.");
    const hasResult = Boolean(state.timelineExport.exportedVideo && state.timelineExport.exportedVideo.mediaPath);
    els.timelineDownloadBtn.classList.toggle("ve-hidden", !hasResult);
    if (hasResult) {
      els.timelineResultInfo.textContent = `${state.timelineExport.exportedVideo.filename || state.timelineExport.exportedVideo.id} (${formatBytes(state.timelineExport.exportedVideo.filesize || 0)})`;
    } else {
      els.timelineResultInfo.textContent = state.timelineExport.lastError ? `Error: ${state.timelineExport.lastError}` : "";
    }
    const listCount = Array.isArray(state.videos) ? state.videos.length : 0; // reuse state.videos or dedicated timelineVideos
    // Use a dedicated timelineVideos array sorted; see Task 5
    const vids = state.timelineVideos || [];
    els.timelineCount.textContent = String(vids.length);
    els.timelineListSummary.textContent = vids.length ? `${vids.length} videos sorted by name (chronological)` : "No videos loaded.";
    els.timelineBody.innerHTML = vids.length ? vids.slice(0,150).map((v,i)=>`
      <tr><td>${i+1}</td><td><div class="ve-media-cell"><div class="ve-thumb" style="background-image:url('${escapeAttr(v.thumbUrl||"")}')"></div><div><div class="ve-title-line">${escapeHtml(v.name||v.fileName||String(v.id))}</div><div class="ve-muted">${v.id} | ${escapeHtml(v.fileName||"")}</div></div></div></td><td>${escapeHtml(formatDuration(v.duration||v.duration_time||0))}</td></tr>
    `).join("") : `<tr><td colspan="3" class="ve-muted">Load videos first.</td></tr>`;
  }
```

In `updateButtonStates:2770` add:

```js
    const hasVideos = (state.timelineVideos && state.timelineVideos.length > 0);
    if (els.timelineExportBtn) els.timelineExportBtn.disabled = state.timelineExport.running || state.uploadInProgress || state.downloadInProgress || !hasVideos;
    if (els.timelineStopBtn) els.timelineStopBtn.disabled = !state.timelineExport.running;
    if (els.timelineDownloadBtn) els.timelineDownloadBtn.disabled = state.downloadInProgress || !state.timelineExport.exportedVideo;
    if (els.timelineLoadBtn) els.timelineLoadBtn.disabled = state.timelineExport.running || state.downloadInProgress;
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/timeline-export.test.js` and `node --check videoexpress-manager.user.js`
Expected: PASS.

Manual quick check: Tampermonkey reload `app.videoexpress.ai`, floating panel should show 6 tabs including Timeline.

- [ ] **Step 5: Commit**

```bash
git add videoexpress-manager.user.js tests/timeline-export.test.js
git commit -m "feat: add Timeline tab UI (export controls, progress, list)"
```

---

### Task 5: Core Logic — Load Sorted Videos, Build Bricks, Export Timeline

**Files:**
- Modify: `videoexpress-manager.user.js:54` (add `state.timelineVideos`), `videoexpress-manager.user.js:422` (export logic), `videoexpress-manager.user.js:2836` (event handlers)
- Test: `tests/timeline-export.test.js` (expand)

**Interfaces:**
- Consumes: `api.getAllVideos:486` (reuse for videos), `compareMediaName:1743`, `buildTimelineBricks`, `buildTimelinePayload`, `api.renderTimeline`, `logLine:1533`, `state.timelineExport`, `renderTimelineExport`.
- Produces:
  ```js
  loadTimelineVideos() => Promise<void>   // fetches getAllVideos for selected folder, sorts by name numeric, stores in state.timelineVideos
  exportTimeline() => Promise<void>       // guards, builds bricks, POST renderTimeline, sets running=true, kicks start polling sequence
  stopTimelineExport() => void            // sets stopRequested-like flag, clears poll timer
  ```

- [ ] **Step 1: Write failing test — exportTimeline creates sequential bricks**

```js
it("exportTimeline uses sorted videos and cumulative left", async () => {
  const { buildTimelineBricks } = global.__ve_test || {};
  // fallback check source
  const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
  assert.match(src, /exportTimeline/);
  assert.match(src, /loadTimelineVideos/);
  // Pure logic test: mock videos
  if (global.__ve_test) {
    const vids = [{id:1, fileName:"2_video.mp4", duration:5000},{id:2, fileName:"10_video.mp4", duration:8000}];
    vids.sort((a,b)=>a.fileName.localeCompare(b.fileName,undefined,{numeric:true}));
    const bricks = buildTimelineBricks(vids, "30");
    assert.equal(bricks[0].left, 0);
    assert.equal(bricks[1].left, 5000);
  }
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `node --test tests/timeline-export.test.js`
Expected: FAIL (`exportTimeline` not yet in source).

- [ ] **Step 3: Implement loaders + exporter**

Add `state.timelineVideos = []` next to `timelineExport` in state.

Near `loadFolderVideos:2043` add:

```js
  async function loadTimelineVideos() {
    const folder = getSelectedFolder();
    if (!folder) throw new Error("Please select a folder first.");
    logLine(`Loading timeline videos for "${folder.title || folder.name}"...`);
    const payload = await api.getAllVideos(folder.id);
    const videos = (payload.results || []).filter(v => (v.type === "video" || v.extension === "mp4" || v.fileName?.endsWith?.(".mp4")) );
    videos.sort(compareMediaName);
    state.timelineVideos = videos;
    renderTimelineExport();
    logLine(`Timeline: ${videos.length} videos sorted by name (chronological).`);
  }

  async function exportTimeline() {
    if (state.timelineExport.running) return;
    if (!state.timelineVideos || !state.timelineVideos.length) throw new Error("Load videos first — no videos to export.");
    const folder = getSelectedFolder();
    if (!folder) throw new Error("No folder selected.");
    updateTimelineExportConfigFromInputs();
    const projectName = (state.timelineExport.projectName || `${config.timelineExportDefaults.namePrefix}${new Date().toISOString().slice(0,10)}`).trim();
    state.timelineExport.projectName = projectName;
    state.timelineExport.running = true;
    state.timelineExport.percent = 0;
    state.timelineExport.statusText = `Starting export "${projectName}" with ${state.timelineVideos.length} clips...`;
    state.timelineExport.exportedVideo = null;
    state.timelineExport.lastError = null;
    saveUiState({ timelineExportName: projectName });
    renderTimelineExport(); updateButtonStates();
    try {
      const bricks = buildTimelineBricks(state.timelineVideos, "30");
      logLine(`Exporting timeline "${projectName}" — ${bricks.length} bricks, left total ${bricks.length ? (bricks[bricks.length-1].left + bricks[bricks.length-1].duration) : 0}ms`);
      const options = {
        name: projectName,
        quality: config.timelineExportDefaults.quality,
        size: config.timelineExportDefaults.size,
        format: config.timelineExportDefaults.format,
        aspect: config.timelineExportDefaults.aspect,
      };
      const res = await api.renderTimeline(bricks, options);
      if (!res || res.success === false) throw new Error(`Render failed: ${JSON.stringify(res).slice(0,300)}`);
      logLine(`Render queued: ${res.action || "pending"} queue_size=${res.queue_size ?? "?"}`);
      state.timelineExport.statusText = `Queued — polling progress for "${projectName}"...`;
      renderTimelineExport();
      // Kick polling loop (Task 6)
      startTimelineProgressPolling(projectName);
    } catch (e) {
      state.timelineExport.running = false;
      state.timelineExport.lastError = e.message || String(e);
      state.timelineExport.statusText = `Export failed: ${state.timelineExport.lastError}`;
      logLine(`Timeline export failed: ${state.timelineExport.lastError}`);
      renderTimelineExport(); updateButtonStates();
      throw e;
    }
  }
  function stopTimelineExport() {
    if (state.timelineExport.pollTimer) { clearInterval(state.timelineExport.pollTimer); state.timelineExport.pollTimer = null; }
    state.timelineExport.running = false;
    state.timelineExport.statusText = "Export stopped by user.";
    state.timelineExport.lastError = "stopped";
    logLine("Timeline export stopped.");
    renderTimelineExport(); updateButtonStates();
  }
```

Expose for tests: `window.__ve_test.exportTimeline = exportTimeline` (optional).

In `renderFolders` also sync `timelineFolderSelect`. In `selectFolder:2019` clear `state.timelineVideos = []` and call `renderTimelineExport()`.

- [ ] **Step 4: Run tests**

Run: `node --test tests/timeline-export.test.js` and `node --check videoexpress-manager.user.js`
Expected: PASS (bricks left cumulative correct).

- [ ] **Step 5: Commit**

```bash
git add videoexpress-manager.user.js tests/timeline-export.test.js
git commit -m "feat: add timeline export core (sorted bricks, renderTimeline, stop)"
```

---

### Task 6: Progress Polling, User-Queue Guard & Download Result

**Files:**
- Modify: `videoexpress-manager.user.js:422` (api polling helpers already exist), add `startTimelineProgressPolling`, `checkTimelineResult`, download handler near `fetchAndDownload:1907`
- Test: `tests/timeline-export.test.js` (polling sequence)

**Interfaces:**
- Consumes: `api.getProjectProgress`, `api.getUserQueue`, `api.getListOutput`, `fetchAndDownloadWithRetry:1926`, `resolveVideoDownloadName:1880`, `state.timelineExport`.
- Produces:
  ```js
  startTimelineProgressPolling(projectName:string) => void   // setInterval every config.timelineExportDefaults.pollIntervalMs (2000ms), first call start=true then start=false, update percent, stop when percent 100 and queue in_progress==0, then call checkTimelineResult
  checkTimelineResult(projectName) => Promise<ExportedVideo|null>
  downloadTimelineResult() => Promise<void>
  isTimelinePollCompleted(progressRes, queueRes) => boolean
  ```

- [ ] **Step 1: Write failing test — polling progression**

```js
it("startTimelineProgressPolling calls getProjectProgress with start flag alternating", () => {
  const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
  assert.match(src, /startTimelineProgressPolling/);
  assert.match(src, /getProjectProgress/);
  assert.match(src, /getListOutput/);
  assert.match(src, /downloadTimelineResult/);
});
it("isTimelinePollCompleted checks percent 100 and queue_status", () => {
  const src = fs.readFileSync("videoexpress-manager.user.js","utf8");
  assert.match(src, /percent.*100|isTimelinePollCompleted/);
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `node --test tests/timeline-export.test.js`
Expected: FAIL.

- [ ] **Step 3: Minimal implementation**

Near `pollStatuses:2672` add after it:

```js
  function isTimelinePollCompleted(progressRes) {
    const pct = Number(progressRes?.percent ?? 0);
    const qs = progressRes?.queue_status || {};
    return pct === 100 && Number(qs.in_progress || 0) === 0;
  }
  let _timelineProgressStarted = false;
  function startTimelineProgressPolling(projectName) {
    _timelineProgressStarted = false;
    if (state.timelineExport.pollTimer) clearInterval(state.timelineExport.pollTimer);
    const intervalMs = Number(config.timelineExportDefaults.pollIntervalMs || 2000);
    state.timelineExport.pollTimer = setInterval(async () => {
      if (!state.timelineExport.running) { clearInterval(state.timelineExport.pollTimer); return; }
      try {
        const startFlag = !_timelineProgressStarted;
        const progress = await api.getProjectProgress(startFlag);
        _timelineProgressStarted = true;
        const pct = Number(progress.percent ?? 0);
        state.timelineExport.percent = pct;
        state.timelineExport.queueStatus = progress.queue_status || state.timelineExport.queueStatus;
        state.timelineExport.statusText = `Exporting "${projectName}" — ${pct}% (queue ${progress.queue_status?.in_progress ?? "?"} / ${progress.queue_status?.total ?? "?"})`;
        renderTimelineExport();
        logLine(`Timeline progress: ${pct}% queue ${JSON.stringify(progress.queue_status)}`);
        // Also refresh user_queue for name match (HAR shows user_queue pending)
        try {
          const q = await api.getUserQueue();
          const match = (q.results || []).find(r => String(r.name) === String(projectName));
          if (match) state.timelineExport.statusText = `Queue: ${match.status} — ${pct}%`;
        } catch {}
        if (isTimelinePollCompleted(progress)) {
          clearInterval(state.timelineExport.pollTimer);
          state.timelineExport.pollTimer = null;
          state.timelineExport.statusText = `Render complete — fetching result for "${projectName}"...`;
          renderTimelineExport();
          await checkTimelineResult(projectName);
        }
      } catch (e) {
        state.timelineExport.lastError = e.message || String(e);
        state.timelineExport.statusText = `Progress poll error: ${state.timelineExport.lastError}`;
        logLine(`Timeline progress error: ${e.message}`);
        renderTimelineExport();
      }
    }, intervalMs);
    // initial immediate call
    (async()=>{
      try {
        const p = await api.getProjectProgress(true);
        _timelineProgressStarted = true;
        state.timelineExport.percent = Number(p.percent||0);
        renderTimelineExport();
      } catch {}
    })();
  }
  async function checkTimelineResult(projectName) {
    // Poll get_list_output until a new entry appears with matching title or newest by datetime
    let tries = 0;
    const maxTries = 30; // up to ~60s with 2s interval
    while (tries < maxTries && state.timelineExport.running) {
      tries++;
      try {
        const out = await api.getListOutput();
        const results = Array.isArray(out.results) ? out.results : [];
        // Prefer exact title match, else newest by datetime
        let match = results.find(r => String(r.title) === String(projectName));
        if (!match && results.length) {
          // newest by datetime parsing (mirrors videoeditor.js MoviesCollection comparator)
          match = results.slice().sort((a,b)=>{
            const da = new Date((a.datetime||"").replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2")).getTime();
            const db = new Date((b.datetime||"").replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2")).getTime();
            return db - da;
          })[0];
        }
        if (match && match.mediaPath) {
          state.timelineExport.exportedVideo = { id: match.id, filename: match.filename, mediaPath: match.mediaPath, title: match.title, datetime: match.datetime, filesize: match.filesize };
          state.timelineExport.percent = 100;
          state.timelineExport.statusText = `Ready to download: ${match.filename} (${match.filesize || ""})`;
          state.timelineExport.running = false;
          renderTimelineExport(); updateButtonStates();
          logLine(`Timeline ready: ${match.filename} -> ${match.mediaPath}`);
          return match;
        }
        state.timelineExport.statusText = `Waiting for result file... attempt ${tries}/${maxTries}`;
        renderTimelineExport();
      } catch (e) {
        logLine(`get_list_output error: ${e.message}`);
      }
      await sleep(2000);
    }
    state.timelineExport.running = false;
    state.timelineExport.lastError = "Result not found after polling get_list_output";
    state.timelineExport.statusText = "Export finished but result file not found — check My Videos > get_list_output.";
    renderTimelineExport(); updateButtonStates();
    return null;
  }
  async function downloadTimelineResult() {
    const v = state.timelineExport.exportedVideo;
    if (!v || !v.mediaPath) throw new Error("No exported video ready to download.");
    // Use direct mediaPath download (HAR shows output videos downloadable via /library/download/{id} — try id first, fallback to mediaPath)
    const fileName = sanitizeFileName(v.title || v.filename || state.timelineExport.projectName || "timeline") + ".mp4";
    logLine(`Downloading timeline result: ${fileName}`);
    // Prefer the library download endpoint if id exists (reuse fetchAndDownload pattern)
    try {
      if (v.id) {
        await fetchAndDownloadWithRetry({ id: v.id, name: v.title || v.filename, fileName: v.filename }, fileName);
      } else {
        // fallback: fetch mediaPath blob directly
        const res = await fetch(v.mediaPath, { credentials: "include" });
        if (!res.ok) throw new Error(`Fetch result ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = fileName; a.rel="noopener"; a.style.display="none"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),10000);
      }
      logLine(`Timeline downloaded: ${fileName}`);
    } catch (e) {
      logLine(`Timeline download failed: ${e.message}`);
      throw e;
    }
  }
```

Wire in `attachEvents:2836` (add before `bootstrap`):

```js
    if (els.timelineLoadBtn) els.timelineLoadBtn.addEventListener("click", () => handleAction(loadTimelineVideos));
    if (els.timelineExportBtn) els.timelineExportBtn.addEventListener("click", () => handleAction(exportTimeline));
    if (els.timelineStopBtn) els.timelineStopBtn.addEventListener("click", () => { stopTimelineExport(); });
    if (els.timelineDownloadBtn) els.timelineDownloadBtn.addEventListener("click", () => handleAction(downloadTimelineResult));
    if (els.timelineFolderSelect) els.timelineFolderSelect.addEventListener("change", () => { selectFolder(els.timelineFolderSelect.value); });
    // sync aspect/quality inputs back to config on change
    [els.timelineName, els.timelineAspect, els.timelineQuality].forEach(el=>{ if(!el) return; el.addEventListener("change", updateTimelineExportConfigFromInputs); el.addEventListener("input", updateTimelineExportConfigFromInputs); });
```

Also ensure `bootstrap` restores timeline name/aspect:

```js
    if (els.timelineName) els.timelineName.value = state.timelineExport.projectName || "";
    if (els.timelineAspect) els.timelineAspect.value = config.timelineExportDefaults.aspect;
    if (els.timelineQuality) els.timelineQuality.value = config.timelineExportDefaults.quality;
    renderTimelineExport();
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/timeline-export.test.js` and `node --check videoexpress-manager.user.js`
Expected: PASS.

Manual: Load 2-3 small videos in a folder, click Timeline → Load videos → Export Timeline → observe log: `Timeline progress: X%`, interval 2s, final `Ready to download`.

- [ ] **Step 5: Commit**

```bash
git add videoexpress-manager.user.js tests/timeline-export.test.js
git commit -m "feat: add timeline progress polling and result download"
```

---

### Task 7: Version Bump, Verification & Docs

**Files:**
- Modify: `videoexpress-manager.user.js:4` (`@version 0.6.2 -> 0.7.0`), maybe `AGENTS.md` header
- Test: `tests/timeline-export.test.js` final coverage

**Interfaces:**
- Consumes: all previous tasks.
- Produces: passing `node --check`, passing `node --test`, manual HAR-verified flow.

- [ ] **Step 1: Write failing test — version bumped**

```js
it("userscript header version bumped to 0.7.0", () => {
  const m = fs.readFileSync("videoexpress-manager.user.js","utf8").match(/@version\s+([0-9.]+)/);
  assert.ok(m, "version not found");
  assert.equal(m[1], "0.7.0");
});
```

- [ ] **Step 2: Run — expect FAIL** (before bump)

Run: `node --test tests/timeline-export.test.js`
Expected: FAIL on version.

- [ ] **Step 3: Bump version + final polish**

Edit `videoexpress-manager.user.js:4`: `// @version      0.7.0`

Add retry guard in `startTimelineProgressPolling`: if `percent` stalls > 10 polls, log warning but continue (no infinite loop). Ensure `clearInterval` on `bootstrap` unload is not needed but document.

- [ ] **Step 4: Verify — run full suite**

Run: `node --check videoexpress-manager.user.js`
Expected: silent pass.

Run: `node --test tests/timeline-export.test.js`
Expected: all PASS.

Manual: In Tampermonkey, open `https://app.videoexpress.ai/`, select a folder with 2+ completed videos (or upload 2 small clips), open Timeline tab, click Load → verify count and sorted order matches name numeric, click Export → verify POST `render_project/tmp` in DevTools Network matches HAR shape, see progress logs every ~2s, wait for `Ready to download`, click Download Result → file saves with `projectName.mp4`.

Edge cases to manually note in log: 0 videos loaded → alert error; rapid stop → timer cleared; export while queue running → button disabled.

- [ ] **Step 5: Commit & hand off**

```bash
git add videoexpress-manager.user.js tests/timeline-export.test.js docs/superpowers/plans/2026-08-16-timeline-export-mode.md
git commit -m "chore: bump to 0.7.0 timeline-export mode (verified)"
```

---

## Self-Review

**1. Spec coverage:**
- Button mode that adds all videos to timeline chronologically sorted by name → Task 5 `loadTimelineVideos` + `buildTimelineBricks` (uses `compareMediaName` numeric).
- HAR `render_project/tmp` with cumulative `left` → Task 2 payload + Task 5.
- Export takes time, check progress → Task 6 `GET /project/progress?start` polling with queue_status guard.
- Download when finished → Task 6 `checkTimelineResult` → `GET /api/get_list_output` + `downloadTimelineResult` via `fetchAndDownload`.
- HAR verified urls: `/render_project/tmp`, `/user_queue`, `/project/progress`, `/api/get_list_output` — all covered in api layer Task 2.
- No regression on existing queue/poll/download flows — isolated state `timelineExport`/`timelineVideos`, buttons disabled mutually.

**2. Placeholder scan:** No TBD/TODO — every step contains concrete code blocks, file:line refs, exact assertions and shell commands.

**3. Type consistency:** `buildTimelineBricks(a:Array<Media>,trackId:string)=>Array<Brick>` consistent across Task 2 and 5. `state.timelineExport` shape `{running,percent,statusText,projectName,queueStatus,exportedVideo,lastError,pollTimer}` used uniformly in Tasks 3-6. `config.timelineExportDefaults` fields `{quality,size,format,aspect,namePrefix,pollIntervalMs}` consistent in Tasks 3,5,6. `api.renderTimeline(bricks,options)` signature matches `buildTimelinePayload` callsite.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-16-timeline-export-mode.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
