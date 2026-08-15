const assert = require("assert");

// Helper for normalizeStatus
function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function makeRecordKey(folderId, mediaId) {
  return `library:test:folder:${folderId}:media:${mediaId}`;
}

async function testPollStatuses() {
  console.log("Testing pollStatuses resolution...");

  const logs = [];
  const logLine = (msg) => logs.push(msg);

  const k1 = makeRecordKey("f1", "img1");
  const k2 = makeRecordKey("f1", "img2");
  const k3 = makeRecordKey("f1", "img3");
  const k4 = makeRecordKey("f1", "img4");

  const state = {
    history: {
      records: {
        [k1]: { folderId: "f1", imageId: "img1", uuid: "UUID-1", status: "completed", videoId: null, imageName: "image1.png" },
        [k2]: { folderId: "f1", imageId: "img2", uuid: "UUID-2", status: "completed", videoId: "existing-vid-2", imageName: "image2.png" },
        [k3]: { folderId: "f1", imageId: "img3", uuid: "UUID-3", status: "running", videoId: null, imageName: "image3.png" },
        [k4]: { folderId: "f1", imageId: "img4", uuid: "UUID-4", status: "completed", videoId: null, imageName: "image4.png" },
      }
    },
    items: [],
    queue: []
  };

  const recordsSaved = [];
  function setRecord(folderId, mediaId, record) {
    state.history.records[makeRecordKey(folderId, mediaId)] = record;
    recordsSaved.push({ folderId, mediaId, record });
  }

  const aiMap = new Map();
  aiMap.set("uuid-1", { id: "vid-101", uuid: "UUID-1" });
  // UUID-4 not in aiMap

  const fetchAiVideosMap = async () => aiMap;

  // Simulate the pollStatuses resolution logic
  const completedWithoutVid = Object.values(state.history.records).filter(
    (r) => normalizeStatus(r.status) === "completed" && r.uuid && !r.videoId
  );
  assert.strictEqual(completedWithoutVid.length, 2); // k1 and k4

  if (completedWithoutVid.length) {
    try {
      const map = await fetchAiVideosMap();
      for (const record of completedWithoutVid) {
        const u = String(record.uuid).toLowerCase().trim();
        if (map.has(u)) {
          const vidItem = map.get(u);
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

  // Verify k1 resolved
  assert.strictEqual(state.history.records[k1].videoId, "vid-101");
  // Verify k2 untouched
  assert.strictEqual(state.history.records[k2].videoId, "existing-vid-2");
  // Verify k3 untouched
  assert.strictEqual(state.history.records[k3].videoId, null);
  // Verify k4 still null (not found in aiMap)
  assert.strictEqual(state.history.records[k4].videoId, null);

  assert.strictEqual(recordsSaved.length, 1);
  assert.strictEqual(recordsSaved[0].record.videoId, "vid-101");
  assert(logs.some(l => l.includes("Matched video ID vid-101 for image1.png")));

  console.log("pollStatuses resolution tests passed.");
}

async function testDownloadQueueCompleted() {
  console.log("Testing downloadQueueCompleted resolution...");

  const logs = [];
  const logLine = (msg) => logs.push(msg);

  const folder = { id: "f1", name: "My Folder" };
  const k1 = makeRecordKey("f1", "img1");
  const k2 = makeRecordKey("f1", "img2");
  const k3 = makeRecordKey("f2", "img3");

  const state = {
    downloadInProgress: false,
    stopRequested: false,
    history: {
      records: {
        [k1]: { folderId: "f1", imageId: "img1", uuid: "UUID-A", status: "completed", videoId: null, imageName: "a.png", imageFileName: "a.png" },
        [k2]: { folderId: "f1", imageId: "img2", uuid: "UUID-B", status: "completed", videoId: "existing-vid-b", imageName: "b.png", imageFileName: "b.png" },
        [k3]: { folderId: "f2", imageId: "img3", uuid: "UUID-C", status: "completed", videoId: null, imageName: "c.png", imageFileName: "c.png" }, // different folder
      }
    }
  };

  const recordsSaved = [];
  function setRecord(folderId, mediaId, record) {
    state.history.records[makeRecordKey(folderId, mediaId)] = record;
    recordsSaved.push({ folderId, mediaId, record });
  }

  const aiMap = new Map();
  aiMap.set("uuid-a", { id: "vid-a-99", uuid: "UUID-A" });

  const fetchAiVideosMap = async () => aiMap;

  const downloadedVideos = [];
  async function fetchAndDownload(video, fileName) {
    downloadedVideos.push({ video, fileName });
  }

  function resolveVideoDownloadName(video) {
    return `${video.name || video.id}.mp4`;
  }

  async function downloadQueueCompleted({ onlyRemaining }) {
    if (state.downloadInProgress) return;
    const currentFolder = folder;
    if (!currentFolder) throw new Error("No folder selected.");

    const missingBefore = Object.values(state.history.records).filter(
      (rec) => String(rec.folderId) === String(currentFolder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt) && !rec.videoId && rec.uuid
    );

    if (missingBefore.length) {
      logLine(`Resolving ${missingBefore.length} completed video IDs from library...`);
      try {
        const map = await fetchAiVideosMap();
        for (const rec of missingBefore) {
          const u = String(rec.uuid).toLowerCase().trim();
          if (map.has(u)) {
            const matched = map.get(u);
            rec.videoId = String(matched.id);
            setRecord(currentFolder.id, rec.imageId, {
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

    const entries = Object.values(state.history.records)
      .filter((rec) => String(rec.folderId) === String(currentFolder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt))
      .filter((rec) => rec.videoId)
      .map((rec) => ({ rec }));

    const missingWithoutVideoId = Object.values(state.history.records).filter(
      (rec) => String(rec.folderId) === String(currentFolder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt) && !rec.videoId,
    );

    if (!entries.length) throw new Error(onlyRemaining ? "No remaining downloads." : "No completed videos to download." + (missingWithoutVideoId.length ? ` (${missingWithoutVideoId.length} completed but videoId missing — wait for status poll or re-check payload)` : ""));

    state.downloadInProgress = true;
    try {
      for (const { rec } of entries) {
        const vid = rec.videoId;
        const fakeVideo = { id: vid, uuid: rec.uuid, name: rec.imageName, fileName: rec.imageFileName };
        const fileName = resolveVideoDownloadName(fakeVideo);
        await fetchAndDownload(fakeVideo, fileName);
        const next = { ...rec, downloadedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        setRecord(currentFolder.id, rec.imageId, next);
      }
    } finally {
      state.downloadInProgress = false;
    }
  }

  await downloadQueueCompleted({ onlyRemaining: false });

  assert.strictEqual(downloadedVideos.length, 2);
  assert.strictEqual(downloadedVideos[0].video.id, "vid-a-99");
  assert.strictEqual(downloadedVideos[1].video.id, "existing-vid-b");
  assert.strictEqual(state.history.records[k1].videoId, "vid-a-99");
  assert(state.history.records[k1].downloadedAt);

  console.log("downloadQueueCompleted resolution tests passed.");
}

async function runAll() {
  await testPollStatuses();
  await testDownloadQueueCompleted();
  console.log("All unit tests passed!");
}

runAll().catch(e => {
  console.error("Test error:", e);
  process.exit(1);
});
