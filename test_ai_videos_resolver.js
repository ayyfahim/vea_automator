const assert = require("assert");

// Mock environment and implementations
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

async function createFetchAiVideosMap(state, api, config, renderFolders) {
  return async function fetchAiVideosMap() {
    let aiFolder = getAiVideosFolder(state.folders);
    if (!aiFolder) {
      state.folders = await api.getFolders();
      renderFolders();
      aiFolder = getAiVideosFolder(state.folders);
    }
    if (!aiFolder) return new Map();

    const map = new Map();
    let page = 1;
    let start = 0;
    const maxPages = 5;
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
  };
}

async function runTests() {
  console.log("Running getAiVideosFolder tests...");

  // Test 1: getAiVideosFolder with invalid / empty inputs
  assert.strictEqual(getAiVideosFolder(null), null);
  assert.strictEqual(getAiVideosFolder(undefined), null);
  assert.strictEqual(getAiVideosFolder([]), null);
  assert.strictEqual(getAiVideosFolder([{ name: "random_folder" }]), null);

  // Test 2: getAiVideosFolder matches name === "my_ai_videos"
  const folder1 = { id: 101, name: "my_ai_videos", title: "" };
  assert.deepStrictEqual(getAiVideosFolder([folder1]), folder1);

  // Test 3: getAiVideosFolder matches regex /^my_?ai_?videos$/i on name
  const folder2 = { id: 102, name: "My_AI_Videos" };
  assert.deepStrictEqual(getAiVideosFolder([folder2]), folder2);
  const folder2b = { id: 103, name: "myaivideos" };
  assert.deepStrictEqual(getAiVideosFolder([folder2b]), folder2b);

  // Test 4: getAiVideosFolder matches /my ai videos/i on title
  const folder3 = { id: 104, name: "custom", title: "My AI Videos" };
  assert.deepStrictEqual(getAiVideosFolder([folder3]), folder3);

  console.log("Running fetchAiVideosMap tests...");

  // Test 5: fetchAiVideosMap when folder exists in state
  let renderCount = 0;
  const renderFolders = () => { renderCount++; };
  const config = { pageSize: 2 };
  const state1 = {
    folders: [{ id: 500, name: "my_ai_videos" }],
  };
  const api1 = {
    async getFolders() {
      throw new Error("Should not call getFolders if already present");
    },
    async getMedia(folderId, page, start, filter) {
      assert.strictEqual(folderId, 500);
      assert.strictEqual(filter, "");
      if (page === 1) {
        return {
          results: [
            { id: 1, uuid: "UUID-AAA-111", video_url: "https://example.com/1.mp4" },
            { id: 2, uuid: "uuid-bbb-222", video_url: "https://example.com/2.mp4" },
          ],
        };
      } else if (page === 2) {
        return {
          results: [
            { id: 3, uuid: "UUID-CCC-333", video_url: "https://example.com/3.mp4" },
          ],
        };
      }
      return { results: [] };
    },
  };

  const fetchAiVideosMap1 = await createFetchAiVideosMap(state1, api1, config, renderFolders);
  const map1 = await fetchAiVideosMap1();

  assert.strictEqual(map1.size, 3);
  assert(map1.has("uuid-aaa-111"));
  assert(map1.has("uuid-bbb-222"));
  assert(map1.has("uuid-ccc-333"));
  assert.strictEqual(map1.get("uuid-aaa-111").id, 1);
  assert.strictEqual(renderCount, 0);

  // Test 6: fetchAiVideosMap when folder not initially present, fetched via getFolders()
  const state2 = { folders: [] };
  const api2 = {
    async getFolders() {
      return [{ id: 999, name: "my_ai_videos" }];
    },
    async getMedia(folderId, page, start, filter) {
      assert.strictEqual(folderId, 999);
      return {
        results: [
          { id: 42, uuid: "UUID-RESOLVED-99", video_url: "https://example.com/42.mp4" },
        ],
      };
    },
  };

  const fetchAiVideosMap2 = await createFetchAiVideosMap(state2, api2, config, renderFolders);
  const map2 = await fetchAiVideosMap2();

  assert.strictEqual(renderCount, 1);
  assert.strictEqual(state2.folders.length, 1);
  assert.strictEqual(map2.size, 1);
  assert(map2.has("uuid-resolved-99"));
  assert.strictEqual(map2.get("uuid-resolved-99").id, 42);

  // Test 7: fetchAiVideosMap when folder not found even after getFolders()
  const state3 = { folders: [] };
  const api3 = {
    async getFolders() {
      return [{ id: 888, name: "other_category" }];
    },
    async getMedia() {
      throw new Error("Should not getMedia if folder not found");
    },
  };

  const fetchAiVideosMap3 = await createFetchAiVideosMap(state3, api3, config, renderFolders);
  const map3 = await fetchAiVideosMap3();

  assert.strictEqual(map3.size, 0);

  console.log("All tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
