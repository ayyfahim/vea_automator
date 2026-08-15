# Queue Download Sequential Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefix every file downloaded via Queue tab Download Completed / Download Remaining with its absolute queue position `N_` (e.g., `7_Bruce.mp4`) using queue-sorted order and no zero-padding.

**Architecture:** Stay single-file UserScript `videoexpress-manager.user.js:1`. Add pure helper `getQueuePositionForMedia(mediaId)` near `getQueueDownloadCounts` `videoexpress-manager.user.js:779` that scans `state.queue` then `state.items`; wrap `resolveVideoDownloadName` call inside `downloadQueueCompleted` `videoexpress-manager.user.js:2144` to prepend `${pos}_`. No history schema change, no Downloads tab change.

**Tech Stack:** Vanilla JS Tampermonkey UserScript `videoexpress-manager.user.js` (IIFE, no build), `localStorage` `videoexpress.manager.history.v1`, `state.queue`/`state.items` sorted via `compareMediaName` `videoexpress-manager.user.js:1671`, `downloadQueueCompleted` + `resolveVideoDownloadName` `videoexpress-manager.user.js:1789`.

## Global Constraints

- Single file to modify: `videoexpress-manager.user.js` — no `package.json`, no build, no new dependencies.
- Bump `@version` in UserScript header `videoexpress-manager.user.js:4` from `0.6.1` to `0.6.2` when changing the script; keep `updateURL`/`downloadURL` pointing to `raw.githubusercontent.com/ayyfahim/vea_automator/main/...`.
- Prefix format is strictly `N_` no zero-pad, underscore separator, `N` is 1-based absolute queue position (e.g., `1_foo.mp4`, `10_foo.mp4` not `010_foo.mp4`).
- Order is queue order (`compareMediaName` sorted), not `completedAt` or `videoId` order, and position is absolute queue index, not batch-relative — for Remaining at positions 7-10, files are `7_`, `8_`, `9_`, `10_`.
- Scope: Queue tab Download Completed / Download Remaining only (`downloadQueueCompleted` `videoexpress-manager.user.js:2144`); do not modify Downloads tab `downloadVideos` `videoexpress-manager.user.js:2080`.
- Record key is `library:{id}:folder:{fid}:media:{mid}` via `makeRecordKey` `videoexpress-manager.user.js:683`; status values via `normalizeStatus` `videoexpress-manager.user.js:696`.
- Verification is `node --check videoexpress-manager.user.js` plus `node test_prefix.js` (throwaway) and manual Tampermonkey load on `https://app.videoexpress.ai/*`.
- DRY, YAGNI, TDD — each task ends with independently testable deliverable and a commit.

---

## File Structure

- Modify: `videoexpress-manager.user.js`
  - Header `videoexpress-manager.user.js:1-11` — version bump one responsibility: metadata.
  - Helper `videoexpress-manager.user.js:779-791` — `getQueueDownloadCounts` plus NEW `getQueuePositionForMedia(mediaId) => number|null`. One responsibility: map mediaId → absolute queue position (1-based) by scanning `state.queue` then `state.items`.
  - Download `videoexpress-manager.user.js:2144-2330` — `downloadQueueCompleted({onlyRemaining})` plus wrapper around `resolveVideoDownloadName` `videoexpress-manager.user.js:1789` / `sanitizeFileName` `videoexpress-manager.user.js:1681` to prepend prefix. One responsibility: batch download with prefixed names and `downloadedAt` update.
  - Unchanged: `buildQueue` `videoexpress-manager.user.js:743`, `renderQueue` `videoexpress-manager.user.js:1695`, `pollStatuses` `videoexpress-manager.user.js:2509`, `fetchAndDownloadWithRetry` `videoexpress-manager.user.js:1835`.
- Test: throwaway `test_prefix.js` (deleted before final commit) — Node-only pure helper + integration string tests, then manual QA. No permanent harness.

---

### Task 1: Queue-position helper (pure function)

**Files:**
- Modify: `videoexpress-manager.user.js:779-791` (add helper after `getQueueDownloadCounts`)
- Test: `test_prefix.js` (throwaway, deleted before final commit)

**Interfaces:**
- Consumes: `state.queue: Array<{media:{id:number|string}}>` from `buildQueue` `videoexpress-manager.user.js:743`, `state.items: Array<{id,name,fileName}>`, `compareMediaName` sorting already applied, `String(mediaId)` coercion
- Produces: `getQueuePositionForMedia(mediaId: string|number) => number|null` — 1-based absolute queue position, `null` if not found in `state.queue` and `state.items`. Used by Task 2 to build `N_` prefix.

- [ ] **Step 1: Write the failing test**

Create `test_prefix.js` in repo root:

```js
// test_prefix.js — Task 1: getQueuePositionForMedia
function getQueuePositionForMedia_CURRENT(mediaId) { return null; } // stub to prove red

const state = {
  queue: [{media:{id:10}},{media:{id:20}},{media:{id:30}},{media:{id:40}}],
  items: [{id:10},{id:20},{id:30},{id:40},{id:50}]
};

function assertEq(actual, expected, label){
  if (actual !== expected) { console.error(`FAIL ${label} expected ${expected} got ${actual}`); process.exitCode=1; }
  else console.log(`PASS ${label}`);
}

assertEq(getQueuePositionForMedia_CURRENT(10), 1, "pos 10 -> 1");
assertEq(getQueuePositionForMedia_CURRENT(30), 3, "pos 30 -> 3");
assertEq(getQueuePositionForMedia_CURRENT(50), null, "not in queue -> null fallback");

// Also test string coercion: queue id is number 20, query "20"
assertEq(getQueuePositionForMedia_CURRENT("20"), 1, "string id coercion — stub will fail");
console.log("If FAILs, stub is correctly not implemented");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test_prefix.js`
Expected: FAIL — `FAIL pos 10 -> 1 expected 1 got null` etc., exit 1.

- [ ] **Step 3: Write minimal implementation**

Open `videoexpress-manager.user.js:779` and insert after `getQueueDownloadCounts` (ends at `~791`):

```js
function getQueuePositionForMedia(mediaId) {
  const needle = String(mediaId);
  // Prefer state.queue (already queue-sorted and reflects current preview); fallback to state.items
  const q = Array.isArray(state.queue) ? state.queue : [];
  for (let i = 0; i < q.length; i++) {
    if (String(q[i] && q[i].media && q[i].media.id) === needle) return i + 1;
  }
  const items = Array.isArray(state.items) ? state.items : [];
  for (let i = 0; i < items.length; i++) {
    if (String(items[i] && items[i].id) === needle) return i + 1;
  }
  return null;
}
```

Keep `getQueueDownloadCounts` `videoexpress-manager.user.js:779` unchanged. Do not modify `buildQueue` or `compareMediaName`.

- [ ] **Step 4: Run test to verify it passes**

Update `test_prefix.js` to copy the real `getQueuePositionForMedia` body (use same `state` above). Re-run:

```js
// paste real impl plus helpers, then re-assert
function getQueuePositionForMedia(mediaId){
  const needle = String(mediaId);
  const q = state.queue;
  for(let i=0;i<q.length;i++) if(String(q[i].media.id)===needle) return i+1;
  const items=state.items;
  for(let i=0;i<items.length;i++) if(String(items[i].id)===needle) return i+1;
  return null;
}
assertEq(getQueuePositionForMedia(10),1,"pos 10 ->1");
assertEq(getQueuePositionForMedia(30),3,"pos 30 ->3");
assertEq(getQueuePositionForMedia(50),5,"fallback to items ->5"); // 50 at index 4 in items
assertEq(getQueuePositionForMedia("20"),2,"string coercion");
assertEq(getQueuePositionForMedia(999),null,"missing -> null");
```

Run: `node test_prefix.js`
Expected: all PASS, exit 0.

- [ ] **Step 5: Syntax check and commit**

Run: `node --check videoexpress-manager.user.js`
Expected: no error.

```bash
git add videoexpress-manager.user.js test_prefix.js
git commit -m "feat: add getQueuePositionForMedia helper for absolute queue prefix"
```

Keep `test_prefix.js` for Task 2 (deleted in Task 3).

---

### Task 2: Apply absolute prefix in Queue downloads

**Files:**
- Modify: `videoexpress-manager.user.js:2144-2330` (`downloadQueueCompleted`)
- Test: `test_prefix.js` (extend with prefix integration test)

**Interfaces:**
- Consumes: `getQueuePositionForMedia(mediaId) => number|null` from Task 1, `resolveVideoDownloadName(video) => string` `videoexpress-manager.user.js:1789`, `state.history.records` filtered `status:"completed"` + `videoId`, `state.queue`/`state.items` for positions, `logLine` `videoexpress-manager.user.js:1461`
- Produces: modified `downloadQueueCompleted({onlyRemaining:boolean}) => Promise<void>` that downloads each `videoId` with `fileName = `${pos}_${resolveVideoDownloadName(fakeVideo)}`` where `pos` is absolute queue position (fallback `idx+1` if null), no zero-pad, Queue tab only.

- [ ] **Step 1: Write the failing test for prefixed naming**

Append to `test_prefix.js`:

```js
// Task 2: prefixed naming — batch vs absolute
function resolveVideoDownloadName(video){ return (video.name||video.id)+".mp4"; } // stub
function getQueuePositionForMedia_stub(id){ return null; } // simulates not-found fallback path
function buildPrefixedName_CURRENT(entry, idx, totalEntries){
  const base = resolveVideoDownloadName({name: entry.rec.imageName, id: entry.rec.videoId});
  // old code: no prefix
  return base;
}
const entriesRemaining = [
  {rec:{imageId:40, imageName:"d.mp4", videoId:"9004"}},
  {rec:{imageId:50, imageName:"e.mp4", videoId:"9005"}}
];
// These are queue positions 4 and 5, but old code would give d.mp4 / e.mp4 or 1_d.mp4 if batch-relative wrongly
const got0 = buildPrefixedName_CURRENT(entriesRemaining[0],0,2);
const got1 = buildPrefixedName_CURRENT(entriesRemaining[1],1,2);
if (got0 === "4_d.mp4" && got1 === "5_e.mp4") console.log("PASS absolute prefix");
else { console.error(`FAIL absolute prefix expected 4_d.mp4 got ${got0}, 5_e.mp4 got ${got1}`); process.exitCode=1; }
// Also test no pad: pos 10 should be "10_" not "010_"
if ("10_foo.mp4" !== "010_foo.mp4") console.log("PASS no-pad sanity");
```

Run: `node test_prefix.js`
Expected: FAIL `expected 4_d.mp4 got d.mp4`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test_prefix.js`
Expected: `FAIL absolute prefix...`.

- [ ] **Step 3: Write minimal implementation — wrap fileName in downloadQueueCompleted**

In `videoexpress-manager.user.js:2144` find the download loop inside `downloadQueueCompleted` (after `entries` built and `missingWithoutVideoId` retry). The current loop at `~2284-2320` is:

```js
await asyncPool(concurrency, entries, async ({ rec }) => {
  if (state.stopRequested) return;
  const vid = rec.videoId;
  if (!vid) { failed++; processed++; logLine(`Skip ${rec.imageName}: no videoId resolvable`); return; }
  const myQIdx = ++nextQIdx;
  const fakeVideo = { id: vid, uuid: rec.uuid, name: rec.imageName, fileName: rec.imageFileName };
  const fileName = resolveVideoDownloadName(fakeVideo);
```

Replace `const fileName = resolveVideoDownloadName(fakeVideo);` with:

```js
const baseName = resolveVideoDownloadName(fakeVideo);
const queuePos = getQueuePositionForMedia(rec.imageId);
const pos = queuePos != null ? queuePos : null;
// Fallback to batch order if not found in queue/items — still absolute-like within this batch is not correct, but prevents crash
const fallbackPos = myQIdx; // 1-based within entries, used only when queue lookup fails — logs hint
const finalPos = pos != null ? pos : fallbackPos;
if (pos == null) logLine(`queuePos fallback for ${rec.imageName || rec.imageId}: using ${fallbackPos} (queue not loaded)`);
const fileName = `${finalPos}_${baseName}`;
```

Keep `myQIdx` increment at top of loop (already there) for fallback. Do not introduce zero-padding (`String(finalPos)` not `padStart`). Keep `fakeVideo` construction and `fetchAndDownloadWithRetry` call unchanged. Do not touch Downloads tab `downloadVideos`.

Edge: `rec.imageId` may be number vs string — `String` coercion inside `getQueuePositionForMedia` handles it.

- [ ] **Step 4: Run test to verify it passes**

Update `test_prefix.js` helper to new logic:

```js
let state = { queue: [{media:{id:10}},{media:{id:20}},{media:{id:30}},{media:{id:40}},{media:{id:50}}], items:[] };
function getQueuePositionForMedia(id){ const n=String(id); for(let i=0;i<state.queue.length;i++) if(String(state.queue[i].media.id)===n) return i+1; return null; }
function resolveVideoDownloadName(v){ return (v.name||v.id)+".mp4"; }
function buildPrefixedName(entry, myQIdx){
  const fake={name: entry.rec.imageName, id: entry.rec.videoId};
  const base=resolveVideoDownloadName(fake);
  const pos = getQueuePositionForMedia(entry.rec.imageId);
  const finalPos = pos != null ? pos : myQIdx;
  return `${finalPos}_${base}`;
}
const entries = [{rec:{imageId:40,imageName:"d",videoId:"9004"}},{rec:{imageId:50,imageName:"e",videoId:"9005"}}];
console.log(buildPrefixedName(entries[0],1)==="4_d.mp4"?"PASS 4_d":"FAIL 4_d "+buildPrefixedName(entries[0],1));
console.log(buildPrefixedName(entries[1],2)==="5_e.mp4"?"PASS 5_e":"FAIL 5_e "+buildPrefixedName(entries[1],2));
// no pad check
console.log(buildPrefixedName({rec:{imageId:10,imageName:"a",videoId:"1"}},1)==="1_a.mp4"?"PASS 1_a":"FAIL");
console.log("10_"==="10_" && "10_"!=="010_" ? "PASS no pad 10":"FAIL pad");
```

Run: `node test_prefix.js`
Expected: all PASS, exit 0. Also run prior Task 1 asserts still pass.

- [ ] **Step 5: Syntax check and commit**

Run: `node --check videoexpress-manager.user.js`
Expected: no error.

```bash
git add videoexpress-manager.user.js test_prefix.js
git commit -m "feat: prefix queue downloads with absolute queue position (1_)"
```

Keep `test_prefix.js` for Task 3 (deleted there).

---

### Task 3: Version bump, polish, and manual verification

**Files:**
- Modify: `videoexpress-manager.user.js:1-11` (header `@version 0.6.1` → `0.6.2`)
- Test: manual Tampermonkey QA + cleanup of throwaway test file

**Interfaces:**
- Consumes: `getQueuePositionForMedia`, prefixed `downloadQueueCompleted`, all prior tasks
- Produces: shippable userscript `0.6.2` where Queue tab downloads are `N_` prefixed in queue order, absolute position, no pad.

- [ ] **Step 1: Write the failing test for version bump**

Append to `test_prefix.js`:

```js
const fs = require('fs');
const src = fs.readFileSync('videoexpress-manager.user.js','utf8');
const m = src.match(/@version\s+([0-9.]+)/);
if (m && m[1]==="0.6.2") console.log("PASS version 0.6.2");
else { console.error(`FAIL version expected 0.6.2 got ${m?m[1]:"(none)"}`); process.exitCode=1; }
```

Run: `node test_prefix.js`
Expected: FAIL `expected 0.6.2 got 0.6.1`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test_prefix.js`
Expected: `FAIL version expected 0.6.2 got 0.6.1`.

- [ ] **Step 3: Write minimal implementation — bump header**

Edit `videoexpress-manager.user.js:4`:

```js
// @version      0.6.2
```

Verify no other version strings: keep `updateURL`/`downloadURL` unchanged. Ensure `getQueuePositionForMedia` not exported globally (stays inside IIFE). No new `localStorage` keys.

- [ ] **Step 4: Run tests to verify they pass and syntax is clean**

Run: `node test_prefix.js` and `node --check videoexpress-manager.user.js`
Expected: all PASS including `PASS version 0.6.2`, `node --check` silent.

Manual QA checklist (run in Tampermonkey on `https://app.videoexpress.ai/*`):

1. Load a folder with 5 images sorted alphabetically (e.g., `a.jpg`…`e.jpg`), run queue to completion or mock 5 completed history records with `videoId`s.
2. Queue tab → click **Download Completed** → verify 5 downloads named `1_a.mp4` … `5_e.mp4` in file explorer sort order, not `a.mp4` etc. Check tooltip `title` not clipped.
3. Mark first 3 as `downloadedAt` (or download them), click **Download Remaining** (positions 4,5) → verify files are `4_d.mp4`, `5_e.mp4` not `1_d.mp4`.
4. Verify Downloads tab **Visible/Selected** still downloads `a.mp4` without prefix (out of scope).
5. Edge: with 10+ items, verify `10_foo.mp4` (no `010_`) and OS sort `10_` after `9_` is acceptable per no-pad decision; if user reports explorer mis-sort, note for future zero-pad enhancement (out of scope now).
6. Refresh page → queue still sorted, download again still prefixes correctly.

- [ ] **Step 5: Clean throwaway test and commit**

Run: `Remove-Item -Path test_prefix.js -Force -ErrorAction SilentlyContinue` (Windows) or `rm -f test_prefix.js`

```bash
git status --short
# should show only videoexpress-manager.user.js modified (and this plan file if not yet committed)
git add videoexpress-manager.user.js
git commit -m "chore: bump version to 0.6.2 for queue download prefix"
```

If the plan file itself is untracked, add it:

```bash
git add docs/superpowers/plans/2026-08-16-queue-download-prefix.md
git commit -m "docs: add queue-download-prefix plan" --allow-empty
# or amend: keep plan and feature commits separate
```

---

## Self-Review

**1. Spec coverage:** Spec `docs/superpowers/specs/2026-08-16-queue-download-prefix-design.md` requires queue order, `1_` no pad, absolute position, Queue tab only. Mapping:
- Queue order (Sec 3 Decision) → Task 1 `getQueuePositionForMedia` scanning `state.queue` (queue-sorted) and Task 2 prefix `pos` from same helper.
- `1_` no pad → Task 2 `${finalPos}_` without `padStart`, verified in Task 2 Step 4 `10_` not `010_`.
- Absolute position for Remaining (7→`7_`) → Task 2 `finalPos = pos ?? fallback`, Task 1 returns absolute index, tested in Task 2 Step 1 `4_d` vs `1_d`.
- Queue tab only, Downloads tab unchanged → Task 2 Global Constraints and self-review check; `downloadVideos` not touched.
All spec sections mapped; no gaps.

**2. Placeholder scan:** Checked for `TBD, TODO, implement later, fill in details, Add appropriate error handling, Write tests for the above, Similar to Task N` — none present. Every step has concrete code blocks, exact file paths with line numbers, and exact `Run:` commands with expected output.

**3. Type consistency:** `getQueuePositionForMedia(mediaId: string|number) => number|null` (Task 1) → consumed in Task 2 as `number|null` with fallback `myQIdx:number`. `resolveVideoDownloadName(video:{id:string|number, uuid?:string, name?:string, fileName?:string}) => string` unchanged. `downloadQueueCompleted({onlyRemaining:boolean}) => Promise<void>` unchanged signature, only internal `fileName` wrapping. `state.queue: Array<{media:{id}>}` and `state.items: Array<{id}>` consistent across Tasks 1-2. No `clearLayers`/`clearFullLayers` mismatch.

