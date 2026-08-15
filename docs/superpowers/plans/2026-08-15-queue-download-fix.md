# Queue & Downloads videoId Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Queue `Download Completed` / `Download Remaining` and Downloads tab work seamlessly by automatically resolving video IDs from the `My AI Videos` (`my_ai_videos`) category via job `uuid`.

**Architecture:** VideoExpress backend `/ai/api/status/{uuid}` only returns `{"status":"SUCCEEDED"}` without video IDs, and places generated AI videos into the system category `My AI Videos` (`name: "my_ai_videos"`, category ID e.g. `567535`). We introduce `getAiVideosFolder()`, an active `fetchAiVideosMap()` resolver that indexes recent videos in `my_ai_videos` by `uuid`, and wire it into both `pollStatuses()` and `downloadQueueCompleted()`.

**Tech Stack:** Vanilla JS userscript `videoexpress-manager.user.js`, VideoExpress REST APIs (`/library/get_categories/4`, `/api/library/get_media/4?categoryId=...`, `/library/download/{id}`).

## Global Constraints

- Single file script change: `videoexpress-manager.user.js` only.
- Strict backward compatibility with existing `localStorage` history structure (`HISTORY_KEY = "videoexpress.manager.history.v1"`).
- Exact `uuid` matching (`video.uuid.toLowerCase() === rec.uuid.toLowerCase()`) with zero index-based guesswork.
- Every task verified via automated Node.js test script and `node --check videoexpress-manager.user.js`.

---

### Task 1: Add `getAiVideosFolder()` and `fetchAiVideosMap()` helper

**Files:**
- Modify: `videoexpress-manager.user.js:550-615`
- Test: `test_ai_videos_resolver.js` (throwaway Node test)

**Interfaces:**
- `getAiVideosFolder(folders?: Array<object>) => object|null`: Returns folder object where `f.name === "my_ai_videos"` or `/my ai videos/i.test(f.title)`.
- `fetchAiVideosMap() => Promise<Map<string, object>>`: Queries `api.getMedia(aiFolder.id, 1, 0, "")` (fetching recent pages) and returns map of `uuid.toLowerCase() -> videoObject`.

- [ ] **Step 1: Write unit test for folder finder and UUID map builder**

```javascript
// test_ai_videos_resolver.js
const assert = require('assert');

function getAiVideosFolder(folders) {
  if (!Array.isArray(folders)) return null;
  return (
    folders.find(
      (f) =>
        f.name === "my_ai_videos" ||
        /^my_?ai_?videos$/i.test(f.name) ||
        /my ai videos/i.test(f.title || "")
    ) || null
  );
}

function buildUuidVideoMap(videos) {
  const map = new Map();
  for (const v of videos) {
    if (v && v.uuid) {
      map.set(String(v.uuid).toLowerCase().trim(), v);
    }
  }
  return map;
}

const mockFolders = [
  { id: 608847, name: "zxzxvxzc2", title: "ZXZXVXZC2" },
  { id: 567535, name: "my_ai_videos", title: "My AI Videos", sortOrder: 4 },
  { id: 567534, name: "images", title: "Images" }
];

const foundFolder = getAiVideosFolder(mockFolders);
assert.strictEqual(foundFolder.id, 567535);

const mockVideos = [
  { id: 38140890, name: "Video 1", uuid: "E4F8B155-09B9-474A-9292-F90A10191C92" },
  { id: 38140891, name: "Video 2", uuid: "4E75583B-13A1-4587-8722-F8EF9C197385" }
];

const map = buildUuidVideoMap(mockVideos);
assert.strictEqual(map.get("e4f8b155-09b9-474a-9292-f90a10191c92").id, 38140890);
assert.strictEqual(map.get("4e75583b-13a1-4587-8722-f8ef9c197385").id, 38140891);
console.log("PASS: Task 1 unit test");
```

- [ ] **Step 2: Run test to verify logic**

Run: `node test_ai_videos_resolver.js`
Expected: `PASS: Task 1 unit test`

- [ ] **Step 3: Implement helpers in `videoexpress-manager.user.js`**

Add `getAiVideosFolder` and `fetchAiVideosMap`:
```javascript
  function getAiVideosFolder(folders = state.folders) {
    if (!Array.isArray(folders)) return null;
    return (
      folders.find(
        (f) =>
          f.name === "my_ai_videos" ||
          /^my_?ai_?videos$/i.test(f.name) ||
          /my ai videos/i.test(f.title || "")
      ) || null
    );
  }

  async function fetchAiVideosMap() {
    let aiFolder = getAiVideosFolder();
    if (!aiFolder) {
      state.folders = await api.getFolders();
      renderFolders();
      aiFolder = getAiVideosFolder();
    }
    if (!aiFolder) return new Map();

    const map = new Map();
    // Fetch recent pages of AI videos
    let page = 1;
    let start = 0;
    const maxPages = 5; // fetch up to 500 most recent videos
    while (page <= maxPages) {
      const payload = await api.getMedia(aiFolder.id, page, start, "");
      const results = Array.isArray(payload.results) ? payload.results : [];
      for (const item of results) {
        if (item && item.uuid) {
          map.set(String(item.uuid).toLowerCase().trim(), item);
        }
      }
      if (!results.length || results.length < config.pageSize) break;
      page += 1;
      start += config.pageSize;
    }
    return map;
  }
```

- [ ] **Step 4: Run syntax check**

Run: `node --check videoexpress-manager.user.js`
Expected: no syntax errors.

---

### Task 2: Wire UUID Correlation into `pollStatuses` and `downloadQueueCompleted`

**Files:**
- Modify: `videoexpress-manager.user.js:1930-2005` (`downloadQueueCompleted`), `2185-2240` (`pollStatuses`)
- Test: `test_queue_download_resolution.js` (throwaway Node test)

**Interfaces:**
- `pollStatuses()`: When any job transitions to `completed`, automatically calls `fetchAiVideosMap()` if `videoId` is missing, and updates `record.videoId`.
- `downloadQueueCompleted({ onlyRemaining })`: Automatically resolves any completed records with missing `videoId` by querying `fetchAiVideosMap()` before filtering entries, ensuring downloads proceed immediately without throwing error.

- [ ] **Step 1: Write test for queue download resolution flow**

```javascript
// test_queue_download_resolution.js
const assert = require('assert');

const state = {
  history: {
    records: {
      "rec1": { folderId: "608847", imageId: 1, imageName: "img1", uuid: "4e75583b-13a1-4587-8722-f8ef9c197385", status: "completed", videoId: null },
      "rec2": { folderId: "608847", imageId: 2, imageName: "img2", uuid: "e4f8b155-09b9-474a-9292-f90a10191c92", status: "completed", videoId: null }
    }
  }
};

const aiVideoMap = new Map([
  ["4e75583b-13a1-4587-8722-f8ef9c197385", { id: 38140888, name: "Vid 1" }],
  ["e4f8b155-09b9-474a-9292-f90a10191c92", { id: 38140890, name: "Vid 2" }]
]);

// Resolution logic
function resolveMissingInHistory(folderId, map) {
  for (const rec of Object.values(state.history.records)) {
    if (String(rec.folderId) === String(folderId) && rec.status === "completed" && !rec.videoId && rec.uuid) {
      const vid = map.get(rec.uuid.toLowerCase());
      if (vid) {
        rec.videoId = String(vid.id);
      }
    }
  }
}

resolveMissingInHistory("608847", aiVideoMap);
assert.strictEqual(state.history.records["rec1"].videoId, "38140888");
assert.strictEqual(state.history.records["rec2"].videoId, "38140890");
console.log("PASS: Queue download resolution test");
```

- [ ] **Step 2: Run test**

Run: `node test_queue_download_resolution.js`
Expected: `PASS: Queue download resolution test`

- [ ] **Step 3: Update `pollStatuses` and `downloadQueueCompleted` in `videoexpress-manager.user.js`**

In `pollStatuses`:
```javascript
    const completedWithoutVid = pendingRecords.filter(r => r.uuid && !r.videoId);
    if (completedWithoutVid.length) {
      try {
        const aiMap = await fetchAiVideosMap();
        for (const record of completedWithoutVid) {
          const u = String(record.uuid).toLowerCase().trim();
          if (aiMap.has(u)) {
            const vidItem = aiMap.get(u);
            record.videoId = String(vidItem.id);
            setRecord(record.folderId, record.imageId, {
              ...record,
              videoId: String(vidItem.id),
              updatedAt: new Date().toISOString()
            });
            logLine(`Matched video ID ${vidItem.id} for ${record.imageName || record.uuid}`);
          }
        }
      } catch (e) {
        console.warn("[VE] AI videos map resolution failed in pollStatuses:", e);
      }
    }
```

In `downloadQueueCompleted`:
```javascript
  // Resolve any completed records missing videoId via My AI Videos map before starting
  const missingBefore = Object.values(state.history.records).filter(
    (rec) => String(rec.folderId) === String(folder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt) && !rec.videoId && rec.uuid
  );

  if (missingBefore.length) {
    logLine(`Resolving ${missingBefore.length} completed video IDs from library...`);
    try {
      const aiMap = await fetchAiVideosMap();
      for (const rec of missingBefore) {
        const u = String(rec.uuid).toLowerCase().trim();
        if (aiMap.has(u)) {
          const matched = aiMap.get(u);
          rec.videoId = String(matched.id);
          setRecord(folder.id, rec.imageId, {
            ...rec,
            videoId: String(matched.id),
            updatedAt: new Date().toISOString(),
          });
          logLine(`Resolved ${rec.imageName}: video ID ${matched.id}`);
        }
      }
    } catch (e) {
      logLine(`Library resolution error: ${e.message}`);
    }
  }
```

- [ ] **Step 4: Run syntax check**

Run: `node --check videoexpress-manager.user.js`
Expected: no syntax errors.

---

### Task 3: Clean up throwaway tests & End-to-End Verification

**Files:**
- Clean: remove temporary `test_*.js`
- Validate: `videoexpress-manager.user.js`

- [ ] **Step 1: Clean up test scripts**
- [ ] **Step 2: Run syntax verification on `videoexpress-manager.user.js`**
- [ ] **Step 3: Review diff and ensure clean code changes**
