// ==UserScript==
// @name         VideoExpress Library Manager
// @namespace    https://app.videoexpress.ai/
// @version      0.6.2
// @description  Manage folders, upload images, and batch convert images to videos inside VideoExpress AI.
// @match        https://app.videoexpress.ai/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ayyfahim/vea_automator/main/videoexpress-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/ayyfahim/vea_automator/main/videoexpress-manager.user.js
// ==/UserScript==

(function () {
  "use strict";

  if (!location.hostname.endsWith("videoexpress.ai")) return;
  if (window.__videoExpressManagerLoaded) return;
  window.__videoExpressManagerLoaded = true;

  const config = {
    libraryId: 4,
    pageSize: 100,
    videoLength: 10,
    aspect: "16:9",
    delayBetweenRequestsMs: 1500,
    autoRetryOnParallelLimit: true,
    parallelLimitRetryDelayMs: 60000,
    maxParallelLimitRetries: Infinity,
    pollIntervalMs: 15000,
    skipStartedWithoutUuid: true,
    downloadMinDelayMs: 800,
    downloadMaxDelayMs: 1200,
    downloadConcurrency: 3,
    downloadRetryCount: 3,
    downloadRetryBaseDelayMs: 5000,
    promptCleaner: {
      stripExtension: true,
      replaceUnderscores: true,
      replaceDashes: true,
      removeNumbers: false,
      collapseWhitespace: true,
    },
    masterPrompt: "",
    masterPromptEnabled: false,
    appendFilenamePrompt: false,
    promptListEnabled: false,
    promptList: "",
    timelineExportDefaults: {
      quality: "high",
      size: "1080",
      format: "mp4",
      aspect: "16:9",
      namePrefix: "timeline_",
      pollIntervalMs: 2000,
    },
  };

  const HISTORY_KEY = "videoexpress.manager.history.v1";
  const UI_STATE_KEY = "videoexpress.manager.ui-state.v1";
  let _queryUuidSupported = null; // cache probe for server-side uuid query support (I3)

  const state = {
    folders: [],
    selectedFolderId: null,
    items: [],
    folderMediaCount: 0,
    history: loadHistory(),
    running: false,
    stopRequested: false,
    uploadInProgress: false,
    downloadInProgress: false,
    selectedFiles: [],
    videos: [],
    selectedVideoIds: new Set(),
    dragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    videoFilters: {
      query: "",
      dateFrom: "",
      dateTo: "",
      minSizeMb: "",
      maxSizeMb: "",
    },
    activeTab: "folders",
    queue: [],
    activeStatuses: new Map(),
    auth: {
      csrfToken: "",
      csrfHeaderName: "X-CSRF-TOKEN",
      bearerToken: "",
      lastRefreshedAt: 0,
    },
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
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const formatDateTime = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  };

  const formatBytes = (bytes) => {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatDuration = (milliseconds) => {
    const seconds = Math.round(Number(milliseconds || 0) / 1000);
    if (!seconds) return "-";
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}:${String(rest).padStart(2, "0")}`;
  };

  function cleanPrompt(name) {
    let value = String(name || "");
    if (config.promptCleaner.stripExtension) {
      value = value.replace(/\.[a-z0-9]+$/i, "");
    }
    value = value.replace(/^\d{4}[-_]\d{2}[-_]\d{2}[-_\s]*/i, "");
    value = value.replace(/\(\s*\d+\s*\)/g, " ");
    value = value.replace(/([a-z])([A-Z])/g, "$1 $2");
    if (config.promptCleaner.replaceUnderscores) {
      value = value.replace(/_/g, " ");
    }
    if (config.promptCleaner.replaceDashes) {
      value = value.replace(/-/g, " ");
    }
    if (config.promptCleaner.removeNumbers) {
      value = value.replace(/\d+/g, " ");
    }
    value = value.replace(/[()[\]{}]/g, " ");
    if (config.promptCleaner.collapseWhitespace) {
      value = value.replace(/\s+/g, " ");
    }
    const cleaned = value.trim();
    if (!cleaned) {
      return String(name || "").replace(/\.[a-z0-9]+$/i, "").trim();
    }
    return cleaned;
  }

  function composePrompt(imagePrompt) {
    const image = String(imagePrompt || "").trim();
    const master = String(config.masterPrompt || "").trim();
    if (!config.masterPromptEnabled) return image;
    if (!master) return "";
    if (!config.appendFilenamePrompt) return master;
    if (master.includes("{{image}}")) {
      return master.replace(/{{image}}/g, image).trim();
    }
    return [master, image].filter(Boolean).join(", ");
  }

  function parsePromptList(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map((line) =>
        line
          .trim()
          .replace(/^\s*[-*]\s+/, "")
          .replace(/^\s*\d+\s*[.)\]-]\s+/, "")
          .trim(),
      )
      .filter(Boolean);
  }

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}");
      return {
        version: 1,
        updatedAt: parsed.updatedAt || null,
        records:
          parsed.records && typeof parsed.records === "object"
            ? parsed.records
            : {},
      };
    } catch (error) {
      console.warn("VideoExpress manager history parse failed.", error);
      return { version: 1, updatedAt: null, records: {} };
    }
  }

  function saveHistory() {
    state.history.updatedAt = new Date().toISOString();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history, null, 2));
  }

  function loadUiState() {
    try {
      return JSON.parse(localStorage.getItem(UI_STATE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveUiState(patch) {
    const next = { ...loadUiState(), ...patch };
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(next, null, 2));
  }

  async function assertOk(response, label) {
    if (response.ok) return response;
    const text = await response.text().catch(() => "");
    const err = new Error(
      `${label} failed: ${response.status} ${response.statusText}\n${text}`,
    );
    err.status = response.status;
    err.statusText = response.statusText;
    err.bodyText = text;
    throw err;
  }

  function readCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`),
    );
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function captureAuthHeader(name, value) {
    if (!name || !value) return;
    const headerName = String(name);
    const headerValue = String(value).trim();
    if (
      /^authorization$/i.test(headerName) &&
      /^bearer\s+/i.test(headerValue)
    ) {
      state.auth.bearerToken = headerValue.replace(/^bearer\s+/i, "");
    } else if (/(csrf|xsrf)/i.test(headerName)) {
      state.auth.csrfHeaderName = headerName;
      state.auth.csrfToken = headerValue;
    }
  }

  function refreshAuthFromPage() {
    const csrfElement = document.querySelector(
      'meta[name="csrf-token"], meta[name="csrf_token"], meta[name="xsrf-token"], input[name="_token"], input[name="csrf_token"]',
    );
    const csrfValue = csrfElement && (csrfElement.content || csrfElement.value);
    const csrfCookie =
      readCookie("XSRF-TOKEN") ||
      readCookie("CSRF-TOKEN") ||
      readCookie("csrf_token");
    if (csrfValue) {
      state.auth.csrfHeaderName = "X-CSRF-TOKEN";
      state.auth.csrfToken = csrfValue;
    } else if (csrfCookie) {
      state.auth.csrfHeaderName = "X-XSRF-TOKEN";
      state.auth.csrfToken = csrfCookie;
    }

    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) || "";
          if (!/(access.?token|auth|bearer|jwt)/i.test(key)) continue;
          const value = storage.getItem(key) || "";
          const tokenMatch = value.match(
            /(?:access[_-]?token|token|jwt)"?\s*[:=]\s*"?([\w.-]+)/i,
          );
          const token = tokenMatch
            ? tokenMatch[1]
            : value.replace(/^Bearer\s+/i, "");
          if (token && /^[\w.-]+$/.test(token)) state.auth.bearerToken = token;
        }
      } catch {
        // Storage can be unavailable in restricted browser contexts.
      }
    }
    state.auth.lastRefreshedAt = Date.now();
  }

  function getDynamicAuthHeaders() {
    refreshAuthFromPage();
    const headers = {};
    if (state.auth.csrfToken) {
      headers[state.auth.csrfHeaderName || "X-CSRF-TOKEN"] =
        state.auth.csrfToken;
    }
    if (state.auth.bearerToken)
      headers.Authorization = `Bearer ${state.auth.bearerToken}`;
    return headers;
  }

  function isSameOriginRequest(input) {
    try {
      const url = input instanceof Request ? input.url : input;
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  function captureAuthHeaders(headers) {
    if (!headers) return;
    try {
      new Headers(headers).forEach((value, name) =>
        captureAuthHeader(name, value),
      );
    } catch {
      // Ignore malformed request headers from other page code.
    }
  }

  function installAuthCapture() {
    if (window.__videoExpressManagerAuthCaptureInstalled) return;
    window.__videoExpressManagerAuthCaptureInstalled = true;

    const originalFetch = window.fetch;
    window.fetch = function videoExpressAuthAwareFetch(input, init) {
      if (isSameOriginRequest(input)) {
        if (input instanceof Request) captureAuthHeaders(input.headers);
        captureAuthHeaders(init && init.headers);
      }
      return originalFetch.apply(this, arguments);
    };

    const xhrSameOrigin = Symbol("videoExpressSameOrigin");
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function videoExpressAuthAwareOpen(
      method,
      url,
    ) {
      this[xhrSameOrigin] = isSameOriginRequest(url);
      return originalOpen.apply(this, arguments);
    };

    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader =
      function videoExpressAuthAwareHeader(name, value) {
        if (this[xhrSameOrigin]) captureAuthHeader(name, value);
        return originalSetRequestHeader.apply(this, arguments);
      };
  }

  async function sessionFetch(url, options = {}, label = "Request") {
    const makeRequest = () =>
      fetch(url, {
        ...options,
        credentials: "include",
        headers: {
          ...getDynamicAuthHeaders(),
          ...(options.headers || {}),
        },
      });

    let response = await makeRequest();
    if ([401, 403, 419].includes(response.status)) {
      refreshAuthFromPage();
      response = await makeRequest();
    }
    return assertOk(response, label);
  }

  async function getJson(url, label) {
    const response = await sessionFetch(
      url,
      {
        method: "GET",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      },
      label,
    );
    return response.json();
  }

  async function postForm(url, params, label) {
    const response = await sessionFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: params,
      },
      label,
    );
    return response.text();
  }

  async function postFormJson(url, params, label) {
    const responseText = await postForm(url, params, label);
    try {
      return JSON.parse(responseText);
    } catch {
      return responseText;
    }
  }

  async function postJson(url, bodyObj, label) {
    const response = await sessionFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(bodyObj),
    }, label);
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  async function postMultipart(url, formData, label) {
    const response = await sessionFetch(
      url,
      {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        body: formData,
      },
      label,
    );
    return response.text();
  }

  async function deleteRequest(url, label) {
    const response = await sessionFetch(
      url,
      {
        method: "DELETE",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      },
      label,
    );
    return response.text();
  }

  const api = {
    async getFolders() {
      const payload = await getJson(
        `/library/get_categories/${config.libraryId}`,
        "Load folders",
      );
      return Array.isArray(payload.data) ? payload.data : [];
    },

    async createFolder(categoryName) {
      const params = new URLSearchParams({ categoryName });
      return postForm(
        `/library/add_category/${config.libraryId}`,
        params.toString(),
        "Create folder",
      );
    },

    async deleteFolder(folderId) {
      return deleteRequest(
        `/library/delete_category/${folderId}`,
        "Delete folder",
      );
    },

    async getMedia(folderId, page = 1, start = 0, filter = "image", query = "") {
      const params = new URLSearchParams({
        categoryId: String(folderId),
        page: String(page),
        start: String(start),
        limit: String(config.pageSize),
        query: String(query || ""),
        orderBy: "name",
        orderDir: "asc",
        filter,
      });
      return getJson(
        `/api/library/get_media/${config.libraryId}?${params.toString()}`,
        `Load media for folder ${folderId}`,
      );
    },
    async searchMedia(folderId, query, filter = "") {
      return api.getMedia(folderId, 1, 0, filter, query);
    },

    async getAllImages(folderId) {
      const items = [];
      let page = 1;
      let start = 0;
      let total = Infinity;

      while (start < total) {
        const payload = await api.getMedia(folderId, page, start, "image");
        const results = Array.isArray(payload.results) ? payload.results : [];
        total = Number(payload.total || results.length || 0);
        items.push(...results);
        if (!results.length || results.length < config.pageSize) break;
        page += 1;
        start += config.pageSize;
      }

      return { total: items.length, results: items };
    },

    async getAllVideos(folderId) {
      const first = await api.getMedia(folderId, 1, 0, "");
      const firstResults = Array.isArray(first.results) ? first.results : [];
      const total = Number(first.total ?? firstResults.length ?? 0);
      if (firstResults.length >= total || firstResults.length < config.pageSize) {
        return { total: first.total ?? firstResults.length, results: firstResults };
      }
      const remainingPages = [];
      for (let start = config.pageSize; start < total; start += config.pageSize) {
        const page = Math.floor(start / config.pageSize) + 1;
        remainingPages.push({ page, start, idx: remainingPages.length });
      }
      const buckets = new Array(remainingPages.length);
      await asyncPool(3, remainingPages, async ({ page, start, idx }) => {
        try {
          const payload = await api.getMedia(folderId, page, start, "");
          const r = Array.isArray(payload.results) ? payload.results : [];
          buckets[idx] = r;
        } catch (e) {
          console.warn(`[VE] getAllVideos page ${page} failed:`, e);
          buckets[idx] = [];
        }
      });
      const rest = buckets.flat();
      const all = [...firstResults, ...rest];
      // Sort by name to match previous behavior if needed, otherwise return as-is
      return { total: all.length, results: all };
    },

    async uploadFile(folderId, file) {
      const title = file.name.replace(/\.[a-z0-9]+$/i, "");
      const formData = new FormData();
      formData.append("title", title);
      formData.append("categoryId", String(folderId));
      formData.append("file", file, file.name);
      return postMultipart(
        `/library/upload/${config.libraryId}`,
        formData,
        `Upload ${file.name}`,
      );
    },

    async generateImageVideo(media, prompt, options = {}) {
      const finalPrompt = String(prompt || "").trim() || String(media.name || "").replace(/\.[a-z0-9]+$/i, "").trim();
      const mediaType = media.type || (media.isHumanTalkingVideo ? "human" : "image");
      const isShared = media.isShared === true || media.isShared === "1" ? "1" : "0";

      const params = new URLSearchParams({
        type: mediaType,
        imagePrompt: "",
        prompt: finalPrompt,
        uuid: media.uuid || "",
        mediaId: String(media.id),
        audioMediaId: "0",
        isShared,
        aspect: String(options.aspect || config.aspect),
        videoLength: String(options.videoLength || config.videoLength),
        enhanceHumanFace: "0",
        isTalkingVideoFromText: "0",
        isNarrationVideo: "0",
        enhanceVideoPrompt: "1",
        videoOnly: "0",
        speed: "",
        generatorName: "create_from_prompt",
        faceImageMediaId: "0",
        faceSwap: "0",
        mode: "",
      });
      return postFormJson(
        "/ai/api/image2video",
        params.toString(),
        "Generate video",
      );
    },

    async getStatus(uuid) {
      const cacheBust = Date.now();
      return getJson(
        `/ai/api/status/${uuid}?_=${cacheBust}`,
        `Load status ${uuid}`,
      );
    },
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
  };

  function getSelectedFolder() {
    return (
      state.folders.find(
        (item) => String(item.id) === String(state.selectedFolderId),
      ) || null
    );
  }

  function getAiVideosFolder(folders = state.folders) {
    if (!Array.isArray(folders)) return null;
    return (
      folders.find(
        (f) =>
          f &&
          (f.name === "my_ai_videos" ||
            (f.name && /^my_?ai_?videos$/i.test(f.name)) ||
            (f.title && /my ai videos/i.test(f.title)))
      ) || null
    );
  }

  async function fetchAiVideosMap(targetUuids = null, opts = {}) {
    let aiFolder = getAiVideosFolder();
    if (!aiFolder) {
      state.folders = await api.getFolders();
      renderFolders();
      aiFolder = getAiVideosFolder();
    }
    if (!aiFolder) return new Map();

    const skipStatusFallback = Boolean(opts.skipStatusFallback);
    // Faster path: if caller only needs a few uuids, query them directly instead of paginating 2000+ items
    if (Array.isArray(targetUuids) && targetUuids.length > 0 && targetUuids.length <= 20) {
      const map = new Map();
      await asyncPool(3, targetUuids, async (rawUuid) => {
        const uuid = String(rawUuid).toLowerCase().trim();
        if (!uuid || map.has(uuid)) return;
        // Try server-side query first if not yet proven unsupported (I3)
        if (_queryUuidSupported !== false) {
          try {
            const payload = await api.searchMedia(aiFolder.id, uuid, "");
            const hits = Array.isArray(payload.results) ? payload.results : [];
            const hit = hits.find((it) => it && String(it.uuid).toLowerCase().trim() === uuid);
            if (hit) {
              _queryUuidSupported = true;
              map.set(uuid, hit);
              return;
            }
            // No hit - don't yet conclude unsupported; could be transient. Only cache negative after probing known uuid.
          } catch (e) {
            console.warn(`[VE] searchMedia failed for ${uuid}:`, e);
          }
          // If we reach here, probe result suggests query may not index uuid; cache after first full miss when map still empty
          if (_queryUuidSupported === null && map.size === 0) {
            // Leave as null for one more try; will be set to false after full targeted batch shows 0 hits
          }
        }
        if (skipStatusFallback) return;
        // Fallback: resolve via status endpoint (authoritative for completed videos)
        try {
          const status = await api.getStatus(rawUuid);
          const vid = extractVideoIdFromStatus(status);
          if (vid) {
            map.set(uuid, { uuid: rawUuid, id: String(vid) });
          }
        } catch (e) {
          console.warn(`[VE] getStatus fallback failed for ${uuid}:`, e);
        }
      });
      if (_queryUuidSupported === null && map.size === 0) {
        // All queries missed and status fallback skipped or also missed -> likely query doesn't index uuid
        _queryUuidSupported = false;
        console.warn("[VE] query=uuid appears unsupported by server, will skip searchMedia next time");
      }
      // If we found at least some, return partial map; caller can fallback to full scan if needed
      if (map.size > 0) return map;
      // else fall through to full scan (caller handles)
    }

    const { results } = await api.getAllVideos(aiFolder.id);
    const map = new Map();
    for (const item of results) {
      if (item && item.uuid) {
        map.set(String(item.uuid).toLowerCase().trim(), item);
      }
    }
    return map;
  }

  async function resolveMissingVideoIdsViaStatus(missingRecs) {
    const resolved = [];
    await asyncPool(3, missingRecs, async (rec) => {
      if (!rec.uuid) return;
      try {
        const status = await api.getStatus(rec.uuid);
        const vid = extractVideoIdFromStatus(status);
        if (vid) {
          rec.videoId = String(vid);
          setRecord(rec.folderId, rec.imageId, {
            ...rec,
            videoId: String(vid),
            updatedAt: new Date().toISOString(),
          });
          resolved.push(rec);
          logLine(`Resolved ${rec.imageName} via status: video ID ${vid}`);
        }
      } catch (e) {
        // ignore, will fallback to library map
      }
    });
    return resolved;
  }

  function makeRecordKey(folderId, mediaId) {
    return `library:${config.libraryId}:folder:${folderId}:media:${mediaId}`;
  }

  function getRecord(folderId, mediaId) {
    return state.history.records[makeRecordKey(folderId, mediaId)] || null;
  }

  function setRecord(folderId, mediaId, value) {
    state.history.records[makeRecordKey(folderId, mediaId)] = value;
    saveHistory();
  }

  function normalizeStatus(value) {
    return String(value || "").toLowerCase();
  }

  function isParallelLimitMessage(message) {
    return /multiple videos in progress|up to 5 ai videos|parallel/i.test(
      String(message || ""),
    );
  }

  function getFailureReason(record) {
    if (!record || typeof record !== "object") return "";
    const status = normalizeStatus(record.status);
    if (status !== "failed" && status !== "parallel_limit") return "";
    const candidates = [
      record.error,
      record.response && (record.response.error || record.response.message),
      record.statusPayload && (record.statusPayload.error || record.statusPayload.message || record.statusPayload.status),
      typeof record.response === "string" ? record.response : "",
      typeof record.statusPayload === "string" ? record.statusPayload : "",
    ].filter(Boolean).map((v) => String(v).trim()).filter(Boolean);
    if (!candidates.length) return status === "parallel_limit" ? "Parallel limit — up to 5 AI videos in progress" : "Failed — no detail from server";
    let raw = candidates[0];
    raw = raw.replace(/^Generate video failed:\s*/i, "").replace(/^Status poll failed.*?:\s*/i, "").replace(/\n[\s\S]*$/, (m) => m.slice(0, 180));
    raw = raw.split("\n")[0].trim();
    if (raw.length > 180) raw = raw.slice(0, 177) + "...";
    return raw || (status === "parallel_limit" ? "Parallel limit" : "Failed");
  }

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
  const searchObjects = [payload, payload.data, payload.result, payload.video, payload.media].filter(Boolean);
  for (const obj of searchObjects) {
    for (const k of Object.keys(obj)) {
      if (/^(video|media|library).*_?id$/i.test(k) && obj[k]) return String(obj[k]);
      if (k === "id" && typeof obj[k] === "string" && /^\d+$/.test(obj[k])) return String(obj[k]);
    }
  }
  try {
    const str = JSON.stringify(payload);
    const m = str.match(/"videoId"\s*:\s*"?(\d+)"?/i) || str.match(/"mediaId"\s*:\s*"?(\d+)"?/i);
    if (m) return m[1];
  } catch {}
  return null;
}

  function buildQueue(folder, items) {
    const promptList = config.promptListEnabled
      ? parsePromptList(config.promptList)
      : [];
    return items.map((media, index) => {
      const individualPrompt = config.promptListEnabled
        ? promptList[index] || ""
        : cleanPrompt(media.name);
      const prompt = composePrompt(individualPrompt);
      const record = getRecord(folder.id, media.id);
      const historyStatus = record ? record.status : "";
      const pendingMediaStatus = media.uuid
        ? media.isPending
          ? "running"
          : "submitted"
        : "";
      const derivedStatus =
        pendingMediaStatus && !historyStatus
          ? pendingMediaStatus
          : historyStatus || "";
      const normalizedStatus = normalizeStatus(derivedStatus);
      return {
        media,
        prompt,
        record,
        status: derivedStatus,
        skip:
          !prompt ||
          normalizedStatus === "submitted" ||
          normalizedStatus === "running" ||
          normalizedStatus === "completed" ||
          (config.skipStartedWithoutUuid && normalizedStatus === "started"),
      };
    });
  }

  function getQueueDownloadCounts() {
    let completed = 0, downloaded = 0, remaining = 0;
    const folderId = state.selectedFolderId;
    if (!folderId) return { completed, downloaded, remaining };
    for (const rec of Object.values(state.history.records)) {
      if (String(rec.folderId) !== String(folderId)) continue;
      if (normalizeStatus(rec.status) !== "completed") continue;
      completed++;
      if (rec.downloadedAt) downloaded++;
      else remaining++;
    }
    return { completed, downloaded, remaining };
  }

  function getQueuePositionForMedia(mediaId) {
    const needle = String(mediaId);
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

  const root = document.createElement("div");
  root.id = "ve-manager-root";
  root.innerHTML = `
    <style>
      #ve-manager-root {
        position: fixed;
        top: 76px;
        right: 18px;
        z-index: 2147483647;
        font-family: Roboto, "Segoe UI", system-ui, sans-serif;
        color: #2f3d4c;
      }
      #ve-manager-panel {
        width: min(560px, calc(100vw - 28px));
        max-height: calc(100vh - 96px);
        overflow: hidden;
        background: #f7f9fc;
        border: 1px solid rgba(17, 24, 39, 0.1);
        border-radius: 6px;
        box-shadow: 0 16px 55px rgba(38, 50, 65, 0.26);
      }
      #ve-manager-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 13px 14px 12px;
        background: #ffffff;
        border-bottom: 1px solid #dfe5ed;
        cursor: move;
        user-select: none;
      }
      #ve-manager-header button {
        cursor: pointer;
      }
      #ve-manager-title {
        font-size: 16px;
        font-weight: 700;
        letter-spacing: 0;
        color: #263241;
      }
      #ve-manager-body {
        padding: 0 14px 14px;
        overflow: auto;
        max-height: calc(100vh - 155px);
      }
      #ve-manager-body::-webkit-scrollbar {
        width: 10px;
      }
      #ve-manager-body::-webkit-scrollbar-thumb {
        background: #c9d3df;
        border-radius: 999px;
      }
      .ve-tabs {
        position: sticky;
        top: 0;
        z-index: 2;
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 0;
        margin: 0 -14px 14px;
        padding: 0 14px;
        background: #ffffff;
        border-bottom: 1px solid #dfe5ed;
      }
      @media (max-width:680px){ .ve-tabs{ grid-template-columns: repeat(3, minmax(0,1fr)); } }
      .ve-tab {
        height: 42px;
        border: 0;
        border-bottom: 3px solid transparent;
        background: transparent;
        color: #667789;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
      }
      .ve-tab i {
        margin-right: 6px;
      }
      .ve-tab.active {
        color: #1683c7;
        border-bottom-color: #22a7f0;
      }
      .ve-tab-panel {
        display: none;
      }
      .ve-tab-panel.active {
        display: block;
      }
      .ve-section {
        margin-bottom: 12px;
        padding: 12px;
        border: 1px solid #dfe5ed;
        border-radius: 6px;
        background: #ffffff;
      }
      .ve-section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        color: #263241;
        font-size: 13px;
        font-weight: 700;
      }
      .ve-row {
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
      }
      .ve-row:last-child {
        margin-bottom: 0;
      }
      .ve-row > * {
        flex: 1;
      }
      .ve-input,
      .ve-select,
      .ve-button,
      .ve-textarea {
        width: 100%;
        border-radius: 4px;
        border: 1px solid #cfd9e4;
        background: #ffffff;
        color: #2f3d4c;
        padding: 9px 10px;
        font-size: 13px;
        outline: none;
      }
      .ve-input:focus,
      .ve-select:focus,
      .ve-textarea:focus {
        border-color: #22a7f0;
        box-shadow: 0 0 0 3px rgba(34, 167, 240, 0.12);
      }
      .ve-textarea {
        min-height: 74px;
        resize: vertical;
      }
      .ve-input::placeholder,
      .ve-textarea::placeholder {
        color: #8ca0b4;
      }
      .ve-button {
        cursor: pointer;
        font-weight: 600;
        white-space: nowrap;
        transition: transform 0.12s ease, box-shadow 0.12s ease;
      }
      .ve-button:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 5px 14px rgba(47, 61, 76, 0.14);
      }
      .ve-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .ve-button.primary {
        background: #22a7f0;
        border-color: #1683c7;
        color: #ffffff;
      }
      .ve-button.success {
        background: #20b486;
        border-color: #168f68;
        color: #ffffff;
      }
      .ve-button.warn {
        background: #f0ad4e;
        border-color: #d79535;
        color: #ffffff;
      }
      .ve-button.danger {
        background: #d9534f;
        border-color: #bd3e3a;
        color: #ffffff;
      }
      .ve-button.ghost {
        background: #ffffff;
        color: #4d5f73;
      }
      .ve-icon-button {
        flex: 0 0 42px;
        width: 42px;
        min-width: 42px;
        padding: 9px 0;
      }
      .ve-muted {
        color: #7a8da3;
        font-size: 12px;
      }
      .ve-stats {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 8px;
      }
      .ve-stat {
        padding: 10px 11px;
        border-radius: 6px;
        background: #f2f6fa;
        border: 1px solid #dfe5ed;
      }
      .ve-stat strong {
        display: block;
        font-size: 20px;
        color: #263241;
      }
      .ve-stat.failures {
        background: #fef2f2;
        border-color: #fecaca;
      }
      .ve-stat.failures strong {
        color: #dc2626;
      }
      .ve-stat.failures span {
        color: #b91c1c;
      }
      .ve-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .ve-table th,
      .ve-table td {
        border-bottom: 1px solid #e7edf4;
        padding: 8px 6px;
        vertical-align: top;
        text-align: left;
      }
      .ve-table th {
        color: #75879b;
        font-weight: 600;
      }
      .ve-thumb {
        width: 46px;
        height: 34px;
        flex: 0 0 46px;
        border-radius: 4px;
        background: #edf2f7 center / cover no-repeat;
        border: 1px solid #d7e0ea;
      }
      .ve-media-cell {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        min-width: 0;
      }
      .ve-title-line {
        word-break: break-word;
        color: #2f3d4c;
      }
      .ve-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 7px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
      }
      .ve-badge.idle { background: #eef3f7; color: #64748b; }
      .ve-badge.started { background: #e8f5fe; color: #1683c7; }
      .ve-badge.submitted { background: #e8f5fe; color: #1683c7; }
      .ve-badge.running { background: #e8f5fe; color: #1683c7; }
      .ve-badge.completed { background: #e8f7f1; color: #168f68; }
      .ve-badge.failed { background: #fdeeee; color: #bd3e3a; }
      .ve-badge.parallel_limit { background: #fff4df; color: #9b6a18; }
      .ve-badge.skipped { background: #eef3f7; color: #64748b; }
      .ve-info {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        margin-left: 6px;
        border-radius: 999px;
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #64748b;
        font-size: 10px;
        font-weight: 700;
        cursor: help;
        vertical-align: middle;
      }
      .ve-info:hover { background: #eef2f7; color: #334155; }
      .ve-retry-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        border-radius: 4px;
        border: 1px solid #22a7f0;
        background: #ffffff;
        color: #1683c7;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }
      .ve-retry-btn:hover { background: #e8f5fe; }
      .ve-retry-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .ve-queue-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .ve-log {
        margin-top: 8px;
        max-height: 178px;
        overflow: auto;
        font-size: 12px;
        white-space: pre-wrap;
        color: #405367;
        background: #f2f6fa;
        border: 1px solid #dfe5ed;
        border-radius: 6px;
        padding: 9px;
      }
      .ve-folder-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      .ve-folder-card {
        min-height: 82px;
        border: 1px solid #dfe5ed;
        border-radius: 6px;
        background: #fbfdff;
        color: #405367;
        cursor: pointer;
        padding: 10px 9px;
        text-align: left;
      }
      .ve-folder-card:hover {
        border-color: #22a7f0;
      }
      .ve-folder-card.active {
        border-color: #22a7f0;
        box-shadow: inset 0 0 0 1px #22a7f0;
        background: #f0f9ff;
      }
      .ve-folder-card i {
        color: #22a7f0;
        font-size: 22px;
      }
      .ve-folder-card strong {
        display: block;
        margin-top: 5px;
        line-height: 1.2;
        word-break: break-word;
      }
      .ve-file-picker {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .ve-download-controls {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 10px;
      }
      .ve-check-cell {
        width: 34px;
        text-align: center !important;
      }
      .ve-checkbox {
        width: 16px;
        height: 16px;
        cursor: pointer;
      }
      .ve-progress {
        height: 8px;
        overflow: hidden;
        border-radius: 999px;
        background: #e5edf5;
        border: 1px solid #d7e0ea;
      }
      .ve-progress-bar {
        width: 0%;
        height: 100%;
        background: #22a7f0;
        transition: width 0.2s ease;
      }
      .ve-file-input {
        display: none;
      }
      .ve-hidden {
        display: none !important;
      }
      #ve-manager-toggle {
        margin-top: 10px;
        margin-left: auto;
        display: block;
        width: 52px;
        height: 52px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        color: white;
        font-size: 20px;
        font-weight: 700;
        background: #22a7f0;
        box-shadow: 0 10px 28px rgba(38, 50, 65, 0.24);
      }
      @media (max-width: 620px) {
        #ve-manager-root {
          top: 8px;
          right: 8px;
          left: 8px;
        }
        #ve-manager-panel {
          width: auto;
          max-height: calc(100vh - 16px);
        }
        .ve-folder-grid,
        .ve-stats,
        .ve-file-picker,
        .ve-download-controls {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .ve-row {
          flex-wrap: wrap;
        }
      }
    </style>
    <div id="ve-manager-panel">
      <div id="ve-manager-header">
        <div>
          <div id="ve-manager-title">VideoExpress Manager</div>
          <div class="ve-muted">Batch media workflow for My Media</div>
        </div>
        <button class="ve-button ghost ve-icon-button" id="ve-close-btn" title="Hide panel"><i class="bi bi-x-lg"></i></button>
      </div>
      <div id="ve-manager-body">
        <div class="ve-tabs" role="tablist">
          <button class="ve-tab active" data-tab="folders" type="button"><i class="bi bi-folder2-open"></i>Folders</button>
          <button class="ve-tab" data-tab="upload" type="button"><i class="bi bi-upload"></i>Upload</button>
          <button class="ve-tab" data-tab="queue" type="button"><i class="bi bi-play-circle"></i>Queue</button>
          <button class="ve-tab" data-tab="downloads" type="button"><i class="bi bi-download"></i>Downloads</button>
          <button class="ve-tab" data-tab="timeline" type="button"><i class="bi bi-view-list"></i>Timeline</button>
          <button class="ve-tab" data-tab="activity" type="button"><i class="bi bi-activity"></i>Activity</button>
        </div>
        <div class="ve-tab-panel active" data-panel="folders">
        <div class="ve-section">
          <div class="ve-section-title">
            <span><i class="bi bi-collection-play"></i> Media folders</span>
            <button class="ve-button ghost ve-icon-button" id="ve-refresh-btn" title="Refresh folders"><i class="bi bi-arrow-clockwise"></i></button>
          </div>
          <div class="ve-row">
            <select class="ve-select" id="ve-folder-select"></select>
          </div>
          <div class="ve-folder-grid" id="ve-folder-grid"></div>
          <div class="ve-row" style="margin-top:10px">
            <button class="ve-button ghost" id="ve-show-create-folder-btn" type="button"><i class="bi bi-folder-plus"></i> Create folder</button>
            <button class="ve-button primary" id="ve-show-upload-btn" type="button"><i class="bi bi-upload"></i> Upload images</button>
          </div>
        </div>
        <div class="ve-section">
          <div class="ve-section-title"><span><i class="bi bi-folder-plus"></i> Create folder</span></div>
          <div class="ve-row">
            <input class="ve-input" id="ve-new-folder-input" placeholder="New folder name" />
            <button class="ve-button success" id="ve-create-folder-btn"><i class="bi bi-plus-lg"></i> Create</button>
          </div>
          <div class="ve-row">
            <button class="ve-button danger" id="ve-delete-folder-btn"><i class="bi bi-trash3"></i> Delete selected folder</button>
          </div>
        </div>
        </div>
        <div class="ve-tab-panel" data-panel="upload">
        <div class="ve-section">
          <div class="ve-section-title"><span><i class="bi bi-cloud-arrow-up"></i> Upload images</span></div>
          <div class="ve-row">
            <select class="ve-select" id="ve-upload-folder-select"></select>
          </div>
          <div class="ve-file-picker">
            <button class="ve-button ghost" id="ve-pick-files-btn" type="button"><i class="bi bi-images"></i> Choose images</button>
            <button class="ve-button ghost" id="ve-pick-folder-btn" type="button"><i class="bi bi-folder2-open"></i> Choose folder</button>
          </div>
          <input class="ve-file-input" id="ve-file-input" type="file" accept="image/*" multiple />
          <input class="ve-file-input" id="ve-folder-input" type="file" accept="image/*" multiple webkitdirectory directory />
          <div class="ve-row">
            <button class="ve-button success" id="ve-upload-btn"><i class="bi bi-upload"></i> Upload selected images</button>
            <button class="ve-button ghost" id="ve-clear-files-btn" type="button"><i class="bi bi-x-lg"></i> Clear</button>
          </div>
          <div class="ve-muted" id="ve-upload-summary">No files selected.</div>
        </div>
        </div>
        <div class="ve-tab-panel" data-panel="queue">
        <div class="ve-section">
          <div class="ve-section-title"><span><i class="bi bi-camera-video"></i> Image to video</span></div>
          <div class="ve-row">
            <input class="ve-input" id="ve-video-length" type="number" min="1" max="60" value="${config.videoLength}" />
            <select class="ve-select" id="ve-aspect">
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
            </select>
          </div>
          <div class="ve-row">
            <input class="ve-input" id="ve-delay-input" type="number" min="0" step="100" value="${config.delayBetweenRequestsMs}" />
            <input class="ve-input" id="ve-retry-delay-input" type="number" min="1000" step="1000" value="${config.parallelLimitRetryDelayMs}" />
          </div>
          <div class="ve-row" style="align-items:center">
            <label class="ve-muted" style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input class="ve-checkbox" id="ve-master-prompt-enabled" type="checkbox" />
              Use a master prompt for every image
            </label>
          </div>
          <div class="ve-row ve-hidden" id="ve-filename-prompt-row" style="align-items:center">
            <label class="ve-muted" style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input class="ve-checkbox" id="ve-append-filename-prompt" type="checkbox" />
              Also include each image's individual prompt
            </label>
          </div>
          <div class="ve-row">
            <textarea class="ve-textarea" id="ve-master-prompt" placeholder="e.g. cinematic product shot, soft studio light. {{image}} is optional when the individual prompt option is enabled."></textarea>
          </div>
          <div class="ve-muted" style="margin-top:-4px;margin-bottom:10px">Master mode uses only this text unless you turn on the individual prompt option.</div>
          <div class="ve-row" style="align-items:center">
            <label class="ve-muted" style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input class="ve-checkbox" id="ve-prompt-list-enabled" type="checkbox" />
              Use prompt list matched to sorted images
            </label>
          </div>
          <div class="ve-row ve-hidden" id="ve-prompt-list-row">
            <textarea class="ve-textarea" id="ve-prompt-list" placeholder="Paste one prompt per line. Line 1 = first sorted image, line 2 = second sorted image, etc."></textarea>
          </div>
          <div class="ve-muted ve-hidden" id="ve-prompt-list-summary" style="margin-top:-4px;margin-bottom:10px">Prompt list is off.</div>
          <div class="ve-row">
            <button class="ve-button primary" id="ve-load-media-btn"><i class="bi bi-list-check"></i> Load images</button>
            <button class="ve-button success" id="ve-run-btn"><i class="bi bi-play-fill"></i> Run queue</button>
            <button class="ve-button warn" id="ve-stop-btn"><i class="bi bi-stop-fill"></i> Stop</button>
          </div>
        </div>
        <div class="ve-section">
          <div class="ve-stats">
            <div class="ve-stat"><span class="ve-muted">Images</span><strong id="ve-stat-images">0</strong></div>
            <div class="ve-stat"><span class="ve-muted">Queued</span><strong id="ve-stat-queued">0</strong></div>
            <div class="ve-stat"><span class="ve-muted">Running</span><strong id="ve-stat-running">0</strong></div>
            <div class="ve-stat"><span class="ve-muted">Done</span><strong id="ve-stat-done">0</strong></div>
            <div class="ve-stat failures"><span>Failed</span><strong id="ve-stat-failed">0</strong></div>
          </div>
        </div>
        <div class="ve-section" id="ve-queue-download-section">
          <div class="ve-section-title"><span><i class="bi bi-download"></i> Download generated</span></div>
          <div class="ve-muted" id="ve-queue-download-summary">No completed videos yet.</div>
          <div class="ve-progress" title="Queue download progress"><div class="ve-progress-bar" id="ve-queue-download-progress"></div></div>
          <div class="ve-row" style="margin-top:10px">
            <button class="ve-button primary" id="ve-download-completed-btn" type="button"><i class="bi bi-download"></i> Download Completed</button>
            <button class="ve-button success" id="ve-download-remaining-btn" type="button"><i class="bi bi-download"></i> Download Remaining</button>
          </div>
          <div class="ve-row" style="margin-top:10px">
            <button class="ve-button warn" id="ve-retry-all-failed-btn" type="button" title="Retry every failed item in this folder"><i class="bi bi-arrow-clockwise"></i> Retry all failed</button>
            <span class="ve-muted" id="ve-retry-all-summary"></span>
          </div>
        </div>
        <div class="ve-section">
          <div class="ve-section-title">
            <span><i class="bi bi-table"></i> Queue preview</span>
            <button class="ve-button ghost ve-icon-button" id="ve-reset-history-btn" type="button" title="Clear saved queue history"><i class="bi bi-eraser"></i></button>
          </div>
          <div class="ve-row">
            <div class="ve-muted" id="ve-folder-summary">Select a folder to begin.</div>
          </div>
            <table class="ve-table">
            <thead>
              <tr>
                <th style="width: 24%">Image</th>
                <th style="width: 36%">Prompt</th>
                <th style="width: 14%">Status</th>
                <th style="width: 14%">Updated</th>
                <th style="width: 12%">Actions</th>
              </tr>
            </thead>
            <tbody id="ve-queue-body"></tbody>
          </table>
        </div>
        </div>
        <div class="ve-tab-panel" data-panel="downloads">
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-download"></i> Download videos</span></div>
            <div class="ve-row">
              <select class="ve-select" id="ve-download-folder-select"></select>
              <button class="ve-button primary" id="ve-load-videos-btn" type="button"><i class="bi bi-collection-play"></i> Load videos</button>
            </div>
            <div class="ve-row">
              <input class="ve-input" id="ve-video-filter-query" type="search" placeholder="Filter by name or media ID" />
            </div>
            <div class="ve-row">
              <input class="ve-input" id="ve-video-filter-date-from" type="date" title="Created from" />
              <input class="ve-input" id="ve-video-filter-date-to" type="date" title="Created to" />
            </div>
            <div class="ve-row">
              <input class="ve-input" id="ve-video-filter-min-size" type="number" min="0" step="1" placeholder="Min MB" />
              <input class="ve-input" id="ve-video-filter-max-size" type="number" min="0" step="1" placeholder="Max MB" />
              <button class="ve-button ghost" id="ve-clear-video-filters-btn" type="button"><i class="bi bi-x-lg"></i> Clear filters</button>
            </div>
            <div class="ve-row">
              <input class="ve-input" id="ve-download-min-delay" type="number" min="0" step="100" value="${config.downloadMinDelayMs}" title="Min delay between downloads (ms)" />
              <input class="ve-input" id="ve-download-max-delay" type="number" min="0" step="100" value="${config.downloadMaxDelayMs}" title="Max delay between downloads (ms)" />
              <input class="ve-input" id="ve-download-concurrency" type="number" min="1" max="5" step="1" value="${config.downloadConcurrency}" title="Parallel downloads (1-5)" />
            </div>
            <div class="ve-download-controls">
              <button class="ve-button ghost" id="ve-select-all-videos-btn" type="button"><i class="bi bi-check2-square"></i> Select all</button>
              <button class="ve-button success" id="ve-download-selected-btn" type="button"><i class="bi bi-download"></i> Selected</button>
              <button class="ve-button primary" id="ve-download-all-btn" type="button"><i class="bi bi-download"></i> Visible</button>
            </div>
            <div class="ve-row" style="margin-top:10px">
              <button class="ve-button warn" id="ve-stop-downloads-btn" type="button"><i class="bi bi-stop-fill"></i> Stop downloads</button>
            </div>
            <div class="ve-progress" title="Download queue progress"><div class="ve-progress-bar" id="ve-download-progress"></div></div>
            <div class="ve-muted" id="ve-download-summary" style="margin-top:8px">Load a video folder to begin.</div>
          </div>
          <div class="ve-section">
            <table class="ve-table">
              <thead>
                <tr>
                  <th class="ve-check-cell"><input class="ve-checkbox" id="ve-video-master-checkbox" type="checkbox" /></th>
                  <th style="width: 46%">Video</th>
                  <th style="width: 18%">Size</th>
                  <th style="width: 18%">Duration</th>
                  <th style="width: 18%">Created</th>
                </tr>
              </thead>
              <tbody id="ve-video-body"></tbody>
            </table>
          </div>
        </div>
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
        <div class="ve-tab-panel" data-panel="activity">
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-terminal"></i> Activity log</span></div>
            <div class="ve-log" id="ve-log"></div>
          </div>
        </div>
      </div>
    </div>
    <button id="ve-manager-toggle" class="ve-hidden" title="VideoExpress Manager"><i class="bi bi-collection-play"></i></button>
  `;

  document.body.appendChild(root);

  const els = {
    panel: root.querySelector("#ve-manager-panel"),
    toggle: root.querySelector("#ve-manager-toggle"),
    closeBtn: root.querySelector("#ve-close-btn"),
    tabs: Array.from(root.querySelectorAll(".ve-tab")),
    tabPanels: Array.from(root.querySelectorAll(".ve-tab-panel")),
    folderSelect: root.querySelector("#ve-folder-select"),
    uploadFolderSelect: root.querySelector("#ve-upload-folder-select"),
    downloadFolderSelect: root.querySelector("#ve-download-folder-select"),
    folderGrid: root.querySelector("#ve-folder-grid"),
    refreshBtn: root.querySelector("#ve-refresh-btn"),
    showCreateFolderBtn: root.querySelector("#ve-show-create-folder-btn"),
    showUploadBtn: root.querySelector("#ve-show-upload-btn"),
    newFolderInput: root.querySelector("#ve-new-folder-input"),
    createFolderBtn: root.querySelector("#ve-create-folder-btn"),
    deleteFolderBtn: root.querySelector("#ve-delete-folder-btn"),
    fileInput: root.querySelector("#ve-file-input"),
    folderInput: root.querySelector("#ve-folder-input"),
    pickFilesBtn: root.querySelector("#ve-pick-files-btn"),
    pickFolderBtn: root.querySelector("#ve-pick-folder-btn"),
    clearFilesBtn: root.querySelector("#ve-clear-files-btn"),
    uploadBtn: root.querySelector("#ve-upload-btn"),
    uploadSummary: root.querySelector("#ve-upload-summary"),
    videoLength: root.querySelector("#ve-video-length"),
    aspect: root.querySelector("#ve-aspect"),
    delayInput: root.querySelector("#ve-delay-input"),
    retryDelayInput: root.querySelector("#ve-retry-delay-input"),
    masterPromptEnabled: root.querySelector("#ve-master-prompt-enabled"),
    appendFilenamePrompt: root.querySelector("#ve-append-filename-prompt"),
    filenamePromptRow: root.querySelector("#ve-filename-prompt-row"),
    masterPrompt: root.querySelector("#ve-master-prompt"),
    promptListEnabled: root.querySelector("#ve-prompt-list-enabled"),
    promptListRow: root.querySelector("#ve-prompt-list-row"),
    promptList: root.querySelector("#ve-prompt-list"),
    promptListSummary: root.querySelector("#ve-prompt-list-summary"),
    loadMediaBtn: root.querySelector("#ve-load-media-btn"),
    runBtn: root.querySelector("#ve-run-btn"),
    stopBtn: root.querySelector("#ve-stop-btn"),
    resetHistoryBtn: root.querySelector("#ve-reset-history-btn"),
    loadVideosBtn: root.querySelector("#ve-load-videos-btn"),
    videoFilterQuery: root.querySelector("#ve-video-filter-query"),
    videoFilterDateFrom: root.querySelector("#ve-video-filter-date-from"),
    videoFilterDateTo: root.querySelector("#ve-video-filter-date-to"),
    videoFilterMinSize: root.querySelector("#ve-video-filter-min-size"),
    videoFilterMaxSize: root.querySelector("#ve-video-filter-max-size"),
    clearVideoFiltersBtn: root.querySelector("#ve-clear-video-filters-btn"),
    downloadMinDelay: root.querySelector("#ve-download-min-delay"),
    downloadMaxDelay: root.querySelector("#ve-download-max-delay"),
    downloadConcurrency: root.querySelector("#ve-download-concurrency"),
    selectAllVideosBtn: root.querySelector("#ve-select-all-videos-btn"),
    downloadSelectedBtn: root.querySelector("#ve-download-selected-btn"),
    downloadAllBtn: root.querySelector("#ve-download-all-btn"),
    stopDownloadsBtn: root.querySelector("#ve-stop-downloads-btn"),
    videoMasterCheckbox: root.querySelector("#ve-video-master-checkbox"),
    videoBody: root.querySelector("#ve-video-body"),
    downloadSummary: root.querySelector("#ve-download-summary"),
    downloadProgress: root.querySelector("#ve-download-progress"),
    statImages: root.querySelector("#ve-stat-images"),
    statQueued: root.querySelector("#ve-stat-queued"),
    statRunning: root.querySelector("#ve-stat-running"),
    statDone: root.querySelector("#ve-stat-done"),
    statFailed: root.querySelector("#ve-stat-failed"),
    folderSummary: root.querySelector("#ve-folder-summary"),
    queueBody: root.querySelector("#ve-queue-body"),
    queueDownloadSummary: root.querySelector("#ve-queue-download-summary"),
    queueDownloadProgress: root.querySelector("#ve-queue-download-progress"),
    downloadCompletedBtn: root.querySelector("#ve-download-completed-btn"),
    downloadRemainingBtn: root.querySelector("#ve-download-remaining-btn"),
    retryAllFailedBtn: root.querySelector("#ve-retry-all-failed-btn"),
    retryAllSummary: root.querySelector("#ve-retry-all-summary"),
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
    log: root.querySelector("#ve-log"),
  };

  function logLine(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    els.log.textContent = `${line}\n${els.log.textContent}`.trim();
  }

  function setPanelVisible(visible) {
    els.panel.classList.toggle("ve-hidden", !visible);
    els.toggle.classList.toggle("ve-hidden", visible);
    saveUiState({ collapsed: !visible });
  }

  function clampPanelPosition(left, top) {
    const rect = root.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop),
    };
  }

  function setPanelPosition(left, top, persist = true) {
    const next = clampPanelPosition(left, top);
    root.style.left = `${next.left}px`;
    root.style.top = `${next.top}px`;
    root.style.right = "auto";
    if (persist) saveUiState({ panelPosition: next });
  }

  function restorePanelPosition(position) {
    if (
      !position ||
      typeof position.left !== "number" ||
      typeof position.top !== "number"
    )
      return;
    setPanelPosition(position.left, position.top, false);
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    els.tabs.forEach((element) => {
      element.classList.toggle("active", element.dataset.tab === tab);
    });
    els.tabPanels.forEach((element) => {
      element.classList.toggle("active", element.dataset.panel === tab);
    });
    saveUiState({ activeTab: tab });
  }

  function getBadgeClass(status) {
    const value = normalizeStatus(status);
    if (!value) return "idle";
    return value.replace(/[^a-z0-9_-]/g, "_");
  }

  function renderFolders() {
    const options = state.folders
      .map((folder) => {
        const selected =
          String(folder.id) === String(state.selectedFolderId)
            ? "selected"
            : "";
        return `<option value="${folder.id}" ${selected}>${escapeHtml(folder.title || folder.name)} (${folder.id})</option>`;
      })
      .join("");
    els.folderSelect.innerHTML =
      options || `<option value="">No folders found</option>`;
    els.uploadFolderSelect.innerHTML =
      options || `<option value="">No folders found</option>`;
    els.downloadFolderSelect.innerHTML =
      options || `<option value="">No folders found</option>`;
    els.uploadFolderSelect.value = state.selectedFolderId || "";
    els.downloadFolderSelect.value = state.selectedFolderId || "";
    if (els.timelineFolderSelect) {
      els.timelineFolderSelect.innerHTML = options || `<option value="">No folders found</option>`;
      els.timelineFolderSelect.value = state.selectedFolderId || "";
    }
    els.folderGrid.innerHTML = state.folders.length
      ? state.folders
          .map((folder) => {
            const active =
              String(folder.id) === String(state.selectedFolderId)
                ? "active"
                : "";
            return `
              <button class="ve-folder-card ${active}" data-folder-id="${folder.id}" type="button" title="${escapeHtml(folder.title || folder.name)}">
                <i class="bi bi-folder2"></i>
                <strong>${escapeHtml(folder.title || folder.name)}</strong>
                <span class="ve-muted">${folder.id}</span>
              </button>
            `;
          })
          .join("")
      : `<div class="ve-muted">No folders found.</div>`;
  }

  function renderVideos() {
    const visibleVideos = getFilteredVideos();
    const selectedCount = state.selectedVideoIds.size;
    const total = state.videos.length;
    const visibleSelectedCount = visibleVideos.filter((video) =>
      state.selectedVideoIds.has(String(video.id)),
    ).length;
    els.downloadSummary.textContent = total
      ? `${visibleVideos.length}/${total} visible | ${visibleSelectedCount} visible selected | ${selectedCount} total selected`
      : "No videos loaded yet.";
    els.videoMasterCheckbox.checked =
      visibleVideos.length > 0 && visibleSelectedCount === visibleVideos.length;
    els.videoMasterCheckbox.indeterminate =
      visibleSelectedCount > 0 && visibleSelectedCount < visibleVideos.length;
    els.videoBody.innerHTML = visibleVideos.length
      ? visibleVideos
          .map((video) => {
            const checked = state.selectedVideoIds.has(String(video.id))
              ? "checked"
              : "";
            const imageUrl = video.thumbUrl || "";
            return `
              <tr>
                <td class="ve-check-cell"><input class="ve-checkbox ve-video-checkbox" type="checkbox" data-video-id="${video.id}" ${checked} /></td>
                <td>
                  <div class="ve-media-cell">
                    <div class="ve-thumb" style="background-image:url('${escapeAttr(imageUrl)}')"></div>
                    <div>
                      <div class="ve-title-line">${escapeHtml(video.name || video.fileName || String(video.id))}</div>
                      <div class="ve-muted">${video.id}</div>
                    </div>
                  </div>
                </td>
                <td>${escapeHtml(formatBytes(video.size))}</td>
                <td>${escapeHtml(formatDuration(video.duration))}</td>
                <td>${escapeHtml(formatDateTime(video.datetime) || "-")}</td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="5" class="ve-muted">Load videos from a folder first.</td></tr>`;
  }

  function getFilteredVideos() {
    const query = state.videoFilters.query.trim().toLowerCase();
    const fromTime = state.videoFilters.dateFrom
      ? new Date(`${state.videoFilters.dateFrom}T00:00:00`).getTime()
      : null;
    const toTime = state.videoFilters.dateTo
      ? new Date(`${state.videoFilters.dateTo}T23:59:59`).getTime()
      : null;
    const minBytes = state.videoFilters.minSizeMb
      ? Number(state.videoFilters.minSizeMb) * 1024 * 1024
      : null;
    const maxBytes = state.videoFilters.maxSizeMb
      ? Number(state.videoFilters.maxSizeMb) * 1024 * 1024
      : null;

    return state.videos.filter((video) => {
      const haystack =
        `${video.name || ""} ${video.fileName || ""} ${video.id || ""}`.toLowerCase();
      const createdAt = video.datetime
        ? new Date(video.datetime).getTime()
        : null;
      const size = Number(video.size || 0);
      if (query && !haystack.includes(query)) return false;
      if (fromTime && (!createdAt || createdAt < fromTime)) return false;
      if (toTime && (!createdAt || createdAt > toTime)) return false;
      if (minBytes !== null && size < minBytes) return false;
      if (maxBytes !== null && size > maxBytes) return false;
      return true;
    });
  }

  function syncVideoFiltersFromInputs() {
    state.videoFilters = {
      query: els.videoFilterQuery.value || "",
      dateFrom: els.videoFilterDateFrom.value || "",
      dateTo: els.videoFilterDateTo.value || "",
      minSizeMb: els.videoFilterMinSize.value || "",
      maxSizeMb: els.videoFilterMaxSize.value || "",
    };
    saveUiState({ videoFilters: state.videoFilters });
  }

  function applyVideoFiltersToInputs() {
    els.videoFilterQuery.value = state.videoFilters.query || "";
    els.videoFilterDateFrom.value = state.videoFilters.dateFrom || "";
    els.videoFilterDateTo.value = state.videoFilters.dateTo || "";
    els.videoFilterMinSize.value = state.videoFilters.minSizeMb || "";
    els.videoFilterMaxSize.value = state.videoFilters.maxSizeMb || "";
  }

  function renderSelectedFiles() {
    const files = state.selectedFiles;
    if (!files.length) {
      els.uploadSummary.textContent = "No files selected.";
      return;
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const sample = files
      .slice(0, 3)
      .map((file) => file.webkitRelativePath || file.name)
      .join(", ");
    const more = files.length > 3 ? `, +${files.length - 3} more` : "";
    els.uploadSummary.textContent = `${files.length} image${files.length === 1 ? "" : "s"} selected | ${formatBytes(totalBytes)} | ${sample}${more}`;
  }

  function isImageFile(file) {
    return (
      /^image\//i.test(file.type || "") ||
      /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || "")
    );
  }

  function compareMediaName(a, b) {
    const nameA = a.name || a.fileName || String(a.id || "");
    const nameB = b.name || b.fileName || String(b.id || "");
    return nameA.localeCompare(nameB, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

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

  function setSelectedFiles(fileList) {
    state.selectedFiles = Array.from(fileList || [])
      .filter(isImageFile)
      .sort((a, b) => {
        const nameA = a.webkitRelativePath || a.name;
        const nameB = b.webkitRelativePath || b.name;
        return nameA.localeCompare(nameB, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
    renderSelectedFiles();
    updateButtonStates();
  }

  function renderQueue() {
    const runningCount = state.queue.filter((item) => {
      const status = normalizeStatus(item.status);
      return (
        status === "submitted" || status === "running" || status === "started"
      );
    }).length;
    const doneCount = state.queue.filter(
      (item) => normalizeStatus(item.status) === "completed",
    ).length;
    const failedCount = state.queue.filter((item) => {
      const s = normalizeStatus(item.status);
      return s === "failed" || s === "parallel_limit";
    }).length;
    const queuedCount = state.queue.filter((item) => {
      const status = normalizeStatus(item.status);
      return !item.skip || status === "failed" || status === "parallel_limit";
    }).length;

    els.statImages.textContent = String(state.items.length);
    els.statQueued.textContent = String(queuedCount);
    els.statRunning.textContent = String(runningCount);
    els.statDone.textContent = String(doneCount);
    els.statFailed.textContent = String(failedCount);
    if (els.retryAllSummary) {
      els.retryAllSummary.textContent = failedCount ? `${failedCount} failed — click Retry all failed or per-row Retry` : "";
    }

    const folder = getSelectedFolder();
    els.folderSummary.textContent = folder
      ? `${folder.title || folder.name} | ${state.items.length} images loaded | history updated ${formatDateTime(state.history.updatedAt) || "never"}`
      : "Select a folder to begin.";

    els.queueBody.innerHTML = state.queue.length
      ? state.queue
          .slice(0, 150)
          .map((item) => {
            const record =
              item.record || getRecord(state.selectedFolderId, item.media.id);
            const latestStatus = item.status || (record && record.status) || "";
            const updatedAt =
              record &&
              (record.updatedAt || record.completedAt || record.startedAt);
            const imageUrl = item.media.thumbUrl || item.media.mediaPath || "";
            const displayStatus =
              latestStatus || (item.skip ? "skipped" : "idle");
            const isDownloaded = record && record.downloadedAt;
            const isFailed = normalizeStatus(latestStatus) === "failed";
            const isParallel = normalizeStatus(latestStatus) === "parallel_limit";
            const canRetry = isFailed || isParallel;
            const reason = canRetry ? getFailureReason(record || { status: latestStatus, error: item.record && item.record.error, response: item.record && item.record.response, statusPayload: item.record && item.record.statusPayload }) : "";
            const reasonAttr = escapeAttr(reason);
            const reasonHtml = escapeHtml(reason);
            return `
              <tr>
                <td>
                  <div class="ve-media-cell">
                    <div class="ve-thumb" style="background-image:url('${escapeAttr(imageUrl)}')"></div>
                    <div>
                      <div class="ve-title-line">${escapeHtml(item.media.name || item.media.fileName || String(item.media.id))}</div>
                      <div class="ve-muted">${item.media.id}</div>
                    </div>
                  </div>
                </td>
                <td>${escapeHtml(item.prompt || "(empty prompt)")}</td>
                <td>
                  <span class="ve-badge ${getBadgeClass(displayStatus)}">${escapeHtml(displayStatus)}</span>
                  ${canRetry && reason ? `<span class="ve-info" title="${reasonAttr}" data-failure-reason="${reasonAttr}" role="button" tabindex="0" aria-label="Failure reason">i</span>` : ""}
                  ${isDownloaded ? ` <span class="ve-badge completed">downloaded</span>` : ""}
                </td>
                <td>${escapeHtml(formatDateTime(updatedAt) || "-")}</td>
                <td>
                  <div class="ve-queue-actions">
                    ${canRetry ? `<button class="ve-retry-btn" data-retry-media-id="${escapeAttr(String(item.media.id))}" title="${canRetry ? `Retry ${reasonHtml}` : ""}"><i class="bi bi-arrow-clockwise"></i> Retry</button>` : `<span class="ve-muted">—</span>`}
                  </div>
                </td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="5" class="ve-muted">No items loaded yet.</td></tr>`;
    const missing = Object.values(state.history.records).filter(r => String(r.folderId)===String(state.selectedFolderId) && normalizeStatus(r.status)==="completed" && !r.videoId).length;
    const counts = getQueueDownloadCounts();
    els.queueDownloadSummary.textContent = counts.completed
      ? missing
        ? `Completed: ${counts.completed} | Downloaded: ${counts.downloaded} | Remaining: ${counts.remaining} | Attention: ${missing} missing videoId — wait 15s for poll or click Load images`
        : `Completed: ${counts.completed} | Downloaded: ${counts.downloaded} | Remaining: ${counts.remaining}`
      : missing ? `No completed with videoId yet — ${missing} completed but videoId missing (see Activity log)` : "No completed videos yet. Run queue and wait for completion.";
    els.queueDownloadProgress.style.width = counts.completed ? `${Math.round((counts.downloaded / counts.completed) * 100)}%` : "0%";
    updateButtonStates();
  }

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
    const vids = state.timelineVideos || [];
    els.timelineCount.textContent = String(vids.length);
    els.timelineListSummary.textContent = vids.length ? `${vids.length} videos sorted by name (chronological)` : "No videos loaded.";
    els.timelineBody.innerHTML = vids.length ? vids.slice(0,150).map((v,i)=>`
      <tr><td>${i+1}</td><td><div class="ve-media-cell"><div class="ve-thumb" style="background-image:url('${escapeAttr(v.thumbUrl||"")}')"></div><div><div class="ve-title-line">${escapeHtml(v.name||v.fileName||String(v.id))}</div><div class="ve-muted">${v.id} | ${escapeHtml(v.fileName||"")}</div></div></div></td><td>${escapeHtml(formatDuration(v.duration||v.duration_time||0))}</td></tr>
    `).join("") : `<tr><td colspan="3" class="ve-muted">Load videos first.</td></tr>`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
  }

  function sanitizeFileName(value) {
    const name = String(value || "video")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (name || "video").slice(0, 180);
  }

  function resolveVideoDownloadName(video) {
    if (video.uuid) {
      const records = state.history.records;
      const targetUuid = String(video.uuid).toLowerCase().trim();
      for (const key of Object.keys(records)) {
        const record = records[key];
        if (
          record &&
          record.uuid &&
          String(record.uuid).toLowerCase().trim() === targetUuid &&
          record.imageName
        ) {
          const baseName = String(record.imageName).replace(/\.[a-z0-9]+$/i, "");
          return sanitizeFileName(baseName) + ".mp4";
        }
      }
    }
    const rawName = String(
      video.name || video.fileName || video.id || "video",
    ).replace(/\.[a-z0-9]+$/i, "");
    return sanitizeFileName(rawName) + ".mp4";
  }

  function isRetryableDownloadStatus(status) {
    return [400, 404, 429, 500, 502, 503].includes(Number(status));
  }

  async function fetchAndDownload(video, fileName) {
    const response = await sessionFetch(
      `/library/download/${video.id}`,
      { method: "GET" },
      `Download ${fileName}`,
    );
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function fetchAndDownloadWithRetry(video, fileName, opts = {}) {
    const maxRetries = Number(opts.retries ?? config.downloadRetryCount ?? 3);
    const baseDelay = Number(opts.baseDelayMs ?? config.downloadRetryBaseDelayMs ?? 5000);
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await fetchAndDownload(video, fileName);
        if (attempt > 0) logLine(`Retry succeeded for ${fileName} on attempt ${attempt + 1}`);
        return;
      } catch (e) {
        lastError = e;
        const status = Number(e.status || 0) || (() => {
          const m = String(e.message || "").match(/failed:\s*(\d{3})/i);
          return m ? Number(m[1]) : 0;
        })();
        const retryable = isRetryableDownloadStatus(status) || /file not found|not ready/i.test(String(e.message || ""));
        if (attempt >= maxRetries || !retryable || state.stopRequested) throw e;
        const delay = Math.round(baseDelay * Math.pow(1.7, attempt) + randomDelay(0, 1000));
        logLine(`Download ${fileName} got ${status || "error"} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay / 1000)}s...`);
        const retryText = `Retrying ${fileName} in ${Math.round(delay / 1000)}s (${attempt + 1}/${maxRetries})`;
        if (els.queueDownloadSummary) els.queueDownloadSummary.textContent = retryText;
        if (els.downloadSummary) els.downloadSummary.textContent = retryText;
        await sleep(delay);
        if (state.stopRequested) throw new Error("stopped");
      }
    }
    throw lastError;
  }

  function randomDelay(minMs, maxMs) {
    const min = Math.max(0, Number(minMs || 0));
    const max = Math.max(min, Number(maxMs || min));
    return Math.round(min + Math.random() * (max - min));
  }

  async function asyncPool(poolLimit, items, iteratorFn) {
    const limit = Math.max(1, Number(poolLimit) || 1);
    if (limit === 1) {
      const results = [];
      for (const [idx, item] of items.entries()) {
        if (state.stopRequested) break;
        try {
          const v = await iteratorFn(item, idx);
          results.push({ status: "fulfilled", value: v });
        } catch (e) {
          console.warn(`[VE] asyncPool task failed idx ${idx}:`, e);
          results.push({ status: "rejected", reason: e });
        }
      }
      return results;
    }
    const ret = [];
    const executing = new Set();
    for (const [index, item] of items.entries()) {
      if (state.stopRequested) break;
      const p = (async () => iteratorFn(item, index))();
      ret.push(p);
      executing.add(p);
      const clean = () => executing.delete(p);
      p.then(clean).catch(clean);
      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }
    const settled = await Promise.allSettled(ret);
    settled.forEach((r, i) => {
      if (r.status === "rejected") console.warn(`[VE] asyncPool task failed idx ${i}:`, r.reason);
    });
    return settled;
  }

  async function refreshFolders() {
    logLine("Refreshing folder list...");
    state.folders = await api.getFolders();

    const currentExists = state.folders.some(
      (folder) => String(folder.id) === String(state.selectedFolderId),
    );
    if (!currentExists) {
      const saved = loadUiState().selectedFolderId;
      const savedExists = state.folders.some(
        (folder) => String(folder.id) === String(saved),
      );
      state.selectedFolderId = savedExists
        ? saved
        : (state.folders[0] && state.folders[0].id) || null;
    }

    renderFolders();
    saveUiState({ selectedFolderId: state.selectedFolderId });
    logLine(`Loaded ${state.folders.length} folders.`);
  }

  function selectFolder(folderId) {
    state.selectedFolderId = folderId || null;
    saveUiState({ selectedFolderId: state.selectedFolderId });
    state.items = [];
    state.queue = [];
    state.videos = [];
    state.selectedVideoIds = new Set();
    renderFolders();
    renderQueue();
    renderVideos();
  }

  async function loadFolderImages() {
    const folder = getSelectedFolder();
    if (!folder) throw new Error("Please select a folder first.");
    logLine(`Loading images for folder "${folder.title || folder.name}"...`);
    const payload = await api.getAllImages(folder.id);
    state.items = payload.results.slice().sort(compareMediaName);
    state.folderMediaCount = payload.total;
    state.queue = buildQueue(folder, state.items);
    renderQueue();
    logLine(`Loaded ${state.items.length} images from folder ${folder.id}.`);
  }

  async function loadFolderVideos() {
    const folder = getSelectedFolder();
    if (!folder) throw new Error("Please select a folder first.");
    logLine(`Loading videos for folder "${folder.title || folder.name}"...`);
    const payload = await api.getAllVideos(folder.id);
    state.videos = payload.results.filter(
      (item) => item.type === "video" || item.extension === "mp4",
    );
    state.selectedVideoIds = new Set();
    renderVideos();
    updateButtonStates();
    logLine(`Loaded ${state.videos.length} videos from folder ${folder.id}.`);
  }

  async function createFolder() {
    const name = els.newFolderInput.value.trim();
    if (!name) throw new Error("Folder name is required.");
    await api.createFolder(name);
    els.newFolderInput.value = "";
    await refreshFolders();
    const created = state.folders.find(
      (folder) => folder.name === name || folder.title === name,
    );
    if (created) {
      state.selectedFolderId = created.id;
      renderFolders();
      saveUiState({ selectedFolderId: created.id });
    }
    logLine(`Folder "${name}" created.`);
  }

  async function deleteSelectedFolder() {
    const folder = getSelectedFolder();
    if (!folder) throw new Error("No folder selected.");
    const ok = window.confirm(
      `Delete folder "${folder.title || folder.name}" (${folder.id})?`,
    );
    if (!ok) return;
    await api.deleteFolder(folder.id);
    state.items = [];
    state.queue = [];
    await refreshFolders();
    renderQueue();
    logLine(`Folder ${folder.id} deleted.`);
  }

  async function uploadSelectedFiles() {
    const folder = getSelectedFolder();
    const files = state.selectedFiles;
    if (!folder) throw new Error("Select a folder before uploading.");
    if (!files.length) throw new Error("Choose one or more image files first.");

    state.uploadInProgress = true;
    updateButtonStates();
    let successCount = 0;
    let failCount = 0;
    const failedNames = [];
    els.uploadSummary.textContent = `Uploading ${files.length} files...`;

    for (const file of files) {
      try {
        await api.uploadFile(folder.id, file);
        successCount += 1;
        const failedText = failedNames.length ? ` | Last fail: ${failedNames[failedNames.length - 1]}` : "";
        els.uploadSummary.textContent = `Uploaded ${successCount}/${files.length}${failedText}`;
      } catch (error) {
        failCount += 1;
        failedNames.push(file.name);
        logLine(`Upload failed for ${file.name}: ${error.message}`);
        els.uploadSummary.textContent = `Uploaded ${successCount}/${files.length} | Last fail: ${file.name}`;
      }
    }

    state.uploadInProgress = false;
    updateButtonStates();
    els.fileInput.value = "";
    els.folderInput.value = "";
    state.selectedFiles = [];
    const failedText = failedNames.length ? ` | Failed: ${failedNames.join(", ")}` : "";
    els.uploadSummary.textContent = `Upload complete. Success: ${successCount}, Failed: ${failCount}${failedText}`;
    await loadFolderImages();
  }

  function updateConfigFromInputs() {
    config.videoLength = Number(els.videoLength.value || 10);
    config.aspect = els.aspect.value || "16:9";
    config.delayBetweenRequestsMs = Number(els.delayInput.value || 0);
    config.parallelLimitRetryDelayMs = Number(
      els.retryDelayInput.value || 60000,
    );
    config.downloadMinDelayMs = Number(els.downloadMinDelay.value || 800);
    config.downloadMaxDelayMs = Number(
      els.downloadMaxDelay.value || config.downloadMinDelayMs,
    );
    config.downloadConcurrency = Math.min(5, Math.max(1, Number(els.downloadConcurrency.value || 3)));
    if (els.downloadConcurrency) els.downloadConcurrency.value = String(config.downloadConcurrency);
    config.masterPromptEnabled = Boolean(els.masterPromptEnabled.checked);
    config.appendFilenamePrompt = Boolean(els.appendFilenamePrompt.checked);
    config.masterPrompt = els.masterPrompt.value.trim();
    config.promptListEnabled = Boolean(els.promptListEnabled.checked);
    config.promptList = els.promptList.value;
    if (config.downloadMaxDelayMs < config.downloadMinDelayMs) {
      config.downloadMaxDelayMs = config.downloadMinDelayMs;
      els.downloadMaxDelay.value = String(config.downloadMaxDelayMs);
    }
  }

  function updateTimelineExportConfigFromInputs() {
    const nameEl = document.getElementById("ve-timeline-name");
    const aspectEl = document.getElementById("ve-timeline-aspect");
    const qualityEl = document.getElementById("ve-timeline-quality");
    if (nameEl) state.timelineExport.projectName = nameEl.value.trim();
    if (aspectEl) config.timelineExportDefaults.aspect = aspectEl.value || config.timelineExportDefaults.aspect;
    if (qualityEl) config.timelineExportDefaults.quality = qualityEl.value || config.timelineExportDefaults.quality;
    saveUiState({ timelineExportConfig: { quality: config.timelineExportDefaults.quality, size: config.timelineExportDefaults.size, format: config.timelineExportDefaults.format, aspect: config.timelineExportDefaults.aspect }, timelineExportName: state.timelineExport.projectName });
  }

  function updateMasterPromptControls() {
    const masterEnabled = els.masterPromptEnabled.checked;
    const promptListEnabled = els.promptListEnabled.checked;
    const promptCount = parsePromptList(els.promptList.value).length;
    const imageCount = state.items.length;
    const promptCountText = `${promptCount} prompt line${promptCount === 1 ? "" : "s"} detected`;
    const promptMismatchText =
      imageCount && promptCount !== imageCount
        ? ` Warning: ${imageCount} image${imageCount === 1 ? "" : "s"} loaded.`
        : "";
    els.filenamePromptRow.classList.toggle("ve-hidden", !masterEnabled);
    els.promptListRow.classList.toggle("ve-hidden", !promptListEnabled);
    els.promptListSummary.classList.toggle("ve-hidden", !promptListEnabled);
    els.promptListSummary.textContent = promptListEnabled
      ? `${promptCountText}. Line 1 matches the first sorted image.${promptMismatchText}`
      : "Prompt list is off.";
    els.masterPrompt.disabled = state.running || !masterEnabled;
    els.appendFilenamePrompt.disabled = state.running || !masterEnabled;
    els.promptList.disabled = state.running || !promptListEnabled;
  }

  async function downloadVideos(videos, label) {
    if (state.downloadInProgress) return;
    if (!videos.length) throw new Error("No videos selected for download.");

    updateConfigFromInputs();
    state.downloadInProgress = true;
    state.stopRequested = false;
    updateButtonStates();

    let processed = 0;
    let nextIdx = 0;
    let failCount = 0;
    const failedNames = [];
    const total = videos.length;
    const concurrency = Math.max(1, Number(config.downloadConcurrency) || 3);
    els.downloadProgress.style.width = "0%";
    els.downloadSummary.textContent = `${label}: starting ${total} files (x${concurrency})`;

    try {
      await asyncPool(concurrency, videos, async (video) => {
        if (state.stopRequested) return;
        const myIdx = ++nextIdx;
        const downloadName = resolveVideoDownloadName(video);
        els.downloadSummary.textContent = `${label}: downloading ${myIdx}/${total} | ${downloadName}`;
        try {
          await fetchAndDownloadWithRetry(video, downloadName);
          logLine(`Download completed ${myIdx}/${total}: ${downloadName}`);
        } catch (error) {
          failCount += 1;
          failedNames.push(downloadName);
          logLine(`Download failed for ${downloadName}: ${error.message}`);
        } finally {
          processed += 1;
          els.downloadProgress.style.width = `${Math.round((processed / total) * 100)}%`;
          if (concurrency === 1 && processed < total && !state.stopRequested) {
            const waitMs = randomDelay(config.downloadMinDelayMs, config.downloadMaxDelayMs);
            if (waitMs > 0) {
              const failedText = failedNames.length ? ` | Failed: ${failedNames.slice(-2).join(", ")}` : "";
              els.downloadSummary.textContent = `${label}: waiting ${Math.round(waitMs / 1000)}s before next (${processed}/${total})${failedText}`;
              await sleep(waitMs);
            }
          } else {
            els.downloadSummary.textContent = `${label}: ${processed}/${total} | success ${processed - failCount} failed ${failCount}`;
          }
        }
      });
    } finally {
      state.downloadInProgress = false;
      updateButtonStates();
      const successCount = processed - failCount;
      const failedText = failedNames.length ? ` | Failed: ${failedNames.join(", ")}` : "";
      if (state.stopRequested) {
        els.downloadSummary.textContent = `${label}: stopped after ${processed}/${total}${failedText}`;
      } else {
        els.downloadSummary.textContent = `${label}: ${successCount}/${total} downloaded, ${failCount} failed${failedText}`;
      }
      logLine(
        state.stopRequested
          ? "Download queue stopped."
          : `Download queue finished. ${successCount} succeeded, ${failCount} failed.`,
      );
    }
  }

async function downloadQueueCompleted({ onlyRemaining }) {
  if (state.downloadInProgress) return;
  updateConfigFromInputs();
  const folder = getSelectedFolder();
  if (!folder) throw new Error("No folder selected.");

  const missingBefore = Object.values(state.history.records).filter(
    (rec) => String(rec.folderId) === String(folder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt) && !rec.videoId && rec.uuid
  );

  if (missingBefore.length) {
    logLine(`Resolving ${missingBefore.length} completed video IDs...`);
    try {
      // Fast path 1: resolve via status endpoint (authoritative, ~300ms each, concurrent 3 → ~500ms for 5 items)
      const stillMissing = [...missingBefore];
      const resolvedViaStatus = await resolveMissingVideoIdsViaStatus(stillMissing);
      const remaining = stillMissing.filter((r) => !r.videoId);
      if (remaining.length) {
        logLine(`Status resolved ${resolvedViaStatus.length}/${missingBefore.length}, trying targeted library search for ${remaining.length} remaining...`);
        const uuids = remaining.map((r) => r.uuid);
        const aiMap = await fetchAiVideosMap(uuids, { skipStatusFallback: true });
        for (const rec of remaining) {
          const u = String(rec.uuid).toLowerCase().trim();
          if (aiMap.has(u)) {
            const matched = aiMap.get(u);
            const vid = String(matched.id || matched.videoId || "");
            if (vid) {
              rec.videoId = vid;
              setRecord(folder.id, rec.imageId, {
                ...rec,
                videoId: vid,
                updatedAt: new Date().toISOString(),
              });
              logLine(`Resolved ${rec.imageName} via library: video ID ${vid}`);
            }
          }
        }
        const still = remaining.filter((r) => !r.videoId);
        if (still.length) {
          // Fallback to full library scan if targeted search missed (covers query=uuid not indexed case)
          logLine(`Targeted search incomplete (${still.length} left), falling back to full library scan...`);
          const fullMap = await fetchAiVideosMap();
          for (const rec of still) {
            const u = String(rec.uuid).toLowerCase().trim();
            if (fullMap.has(u)) {
              const matched = fullMap.get(u);
              rec.videoId = String(matched.id);
              setRecord(folder.id, rec.imageId, {
                ...rec,
                videoId: String(matched.id),
                updatedAt: new Date().toISOString(),
              });
              logLine(`Resolved ${rec.imageName}: video ID ${matched.id}`);
            }
          }
        }
      } else {
        logLine(`All ${resolvedViaStatus.length} IDs resolved via status endpoint (no library scan).`);
      }
    } catch (e) {
      logLine(`Resolve error: ${e.message}`);
    }
  }

  let entries = Object.values(state.history.records)
    .filter((rec) => String(rec.folderId) === String(folder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt))
    .filter((rec) => rec.videoId)
    .map((rec) => ({ rec }));

  let missingWithoutVideoId = Object.values(state.history.records).filter(
    (rec) => String(rec.folderId) === String(folder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt) && !rec.videoId,
  );

  // Retry timer for eventual consistency: I2 fix — handle partial as well as full missing; I4 full fallback on retry; I6 dedupe by recompute; I3 cancellable
  if (missingWithoutVideoId.length) {
    const needRetry = entries.length === 0 || missingWithoutVideoId.length > 0;
    if (needRetry) {
      const retryMsg = entries.length === 0
        ? `No videoId yet for ${missingWithoutVideoId.length} completed items, retrying in 8s...`
        : `${missingWithoutVideoId.length} of ${missingWithoutVideoId.length + entries.length} completed items still missing videoId, retrying missing in 8s...`;
      logLine(retryMsg);
      els.queueDownloadSummary.textContent = `VideoId missing for ${missingWithoutVideoId.length}, retrying in 8s... (Stop to cancel)`;
      for (let waited = 0; waited < 8000; waited += 500) {
        if (state.stopRequested) break;
        await sleep(500);
      }
      if (state.stopRequested) throw new Error("stopped");
      // I4: reuse same 3-stage fallback as initial missingBefore block
      const toRetry = [...missingWithoutVideoId];
      await resolveMissingVideoIdsViaStatus(toRetry);
      let still = toRetry.filter((r) => !r.videoId);
      if (still.length) {
        const uuids = still.map((r) => r.uuid);
        const aiMap = await fetchAiVideosMap(uuids, { skipStatusFallback: true });
        for (const rec of still) {
          const u = String(rec.uuid).toLowerCase().trim();
          if (aiMap.has(u)) {
            const matched = aiMap.get(u);
            const vid = String(matched.id || matched.videoId || "");
            if (vid) {
              rec.videoId = vid;
              setRecord(folder.id, rec.imageId, { ...rec, videoId: vid, updatedAt: new Date().toISOString() });
            }
          }
        }
        still = still.filter((r) => !r.videoId);
        if (still.length) {
          logLine(`Retry still missing ${still.length}, falling back to full library scan...`);
          const fullMap = await fetchAiVideosMap();
          for (const rec of still) {
            const u = String(rec.uuid).toLowerCase().trim();
            if (fullMap.has(u)) {
              const matched = fullMap.get(u);
              rec.videoId = String(matched.id);
              setRecord(folder.id, rec.imageId, { ...rec, videoId: String(matched.id), updatedAt: new Date().toISOString() });
            }
          }
        }
      }
      // Recompute from scratch to avoid duplicates (I6) and include newly resolved
      entries = Object.values(state.history.records)
        .filter((rec) => String(rec.folderId) === String(folder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt))
        .filter((rec) => rec.videoId)
        .map((rec) => ({ rec }));
      missingWithoutVideoId = Object.values(state.history.records).filter(
        (rec) => String(rec.folderId) === String(folder.id) && normalizeStatus(rec.status) === "completed" && (!onlyRemaining || !rec.downloadedAt) && !rec.videoId,
      );
      if (entries.length) logLine(`Retry resolved ${entries.length} total entries, ${missingWithoutVideoId.length} still missing`);
    }
  }

  if (!entries.length) throw new Error(onlyRemaining ? "No remaining downloads." : "No completed videos to download." + (missingWithoutVideoId.length ? ` (${missingWithoutVideoId.length} completed but videoId missing — will auto-resolve on next 15s poll)` : ""));

  state.downloadInProgress = true;
  state.stopRequested = false;
  updateButtonStates();
  let completed = 0, failed = 0;
  const total = entries.length;
  els.queueDownloadProgress.style.width = "0%";

  const concurrency = Math.max(1, Number(config.downloadConcurrency) || 3);
  els.queueDownloadSummary.textContent = `${onlyRemaining ? "Remaining" : "Completed"}: starting ${total} files (x${concurrency})`;
  let processed = 0;
  let nextQIdx = 0;
  try {
    await asyncPool(concurrency, entries, async ({ rec }) => {
      if (state.stopRequested) return;
      const vid = rec.videoId;
      if (!vid) { failed++; processed++; logLine(`Skip ${rec.imageName}: no videoId resolvable`); return; }
      const myQIdx = ++nextQIdx;
      const fakeVideo = { id: vid, uuid: rec.uuid, name: rec.imageName, fileName: rec.imageFileName };
      const baseName = resolveVideoDownloadName(fakeVideo);
      const queuePos = getQueuePositionForMedia(rec.imageId);
      const fallbackPos = myQIdx; // 1-based within entries
      const finalPos = queuePos != null ? queuePos : fallbackPos;
      if (queuePos == null) logLine(`queuePos fallback for ${rec.imageName || rec.imageId}: using ${fallbackPos} (queue not loaded)`);
      const fileName = `${finalPos}_${baseName}`;
      els.queueDownloadSummary.textContent = `${onlyRemaining ? "Remaining" : "Completed"}: downloading ${myQIdx}/${total} | ${fileName}`;
      try {
        await fetchAndDownloadWithRetry(fakeVideo, fileName);
        const next = { ...rec, downloadedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        setRecord(folder.id, rec.imageId, next);
        completed++;
        logLine(`Queue download ${myQIdx}/${total}: ${fileName} (${completed} ok)`);
      } catch (e) {
        failed++;
        logLine(`Queue download failed ${fileName} [${myQIdx}/${total}]: ${e.message}`);
      } finally {
        processed++;
        els.queueDownloadProgress.style.width = `${Math.round((processed/total)*100)}%`;
        renderQueue(); updateButtonStates();
        if (concurrency === 1 && processed < total && !state.stopRequested) {
          const waitMs = randomDelay(config.downloadMinDelayMs, config.downloadMaxDelayMs);
          if (waitMs > 0) {
            els.queueDownloadSummary.textContent = `${onlyRemaining ? "Remaining" : "Completed"}: waiting ${Math.round(waitMs/1000)}s (${processed}/${total})`;
            await sleep(waitMs);
          }
        } else {
          els.queueDownloadSummary.textContent = `${onlyRemaining ? "Remaining" : "Completed"}: ${processed}/${total} | ${completed} ok ${failed} failed`;
        }
      }
    });
  } finally {
    state.downloadInProgress = false;
    updateButtonStates(); renderQueue();
    const ok = completed;
    els.queueDownloadSummary.textContent = state.stopRequested
      ? `${onlyRemaining ? "Remaining" : "Completed"}: stopped ${processed}/${total} downloaded`
      : `${onlyRemaining ? "Remaining" : "Completed"}: ${ok}/${total} downloaded, ${failed} failed | Remaining: ${getQueueDownloadCounts().remaining}`;
    logLine(state.stopRequested ? "Queue download stopped." : `Queue download finished ${ok}/${total}.`);
  }
}

  async function runQueue() {
    if (state.running) return;
    const folder = getSelectedFolder();
    if (!folder) throw new Error("No folder selected.");
    if (!state.queue.length) await loadFolderImages();

    updateConfigFromInputs();
    state.running = true;
    state.stopRequested = false;
    updateButtonStates();

    try {
      for (const item of state.queue) {
        if (state.stopRequested) break;
        if (!item.prompt) {
          item.status = "skipped";
          continue;
        }

        const existing = getRecord(folder.id, item.media.id);
        const existingStatus = existing ? normalizeStatus(existing.status) : "";
        if (
          existing &&
          (["submitted", "running", "completed"].includes(existingStatus) ||
            (config.skipStartedWithoutUuid && existingStatus === "started"))
        ) {
          item.status = existing.status;
          continue;
        }

        let retries =
          existing && existing.parallelLimitRetries
            ? existing.parallelLimitRetries
            : 0;
        let done = false;

        while (!done) {
          if (state.stopRequested) break;

          const startedAt = new Date().toISOString();
          const baseRecord = {
            libraryId: config.libraryId,
            folderId: folder.id,
            folderName: folder.name,
            folderTitle: folder.title,
            imageId: item.media.id,
            imageName: item.media.name,
            imageFileName: item.media.fileName,
            mediaPath: item.media.mediaPath,
            prompt: item.prompt,
            aspect: config.aspect,
            videoLength: config.videoLength,
            startedAt,
            updatedAt: startedAt,
            status: "started",
            videoId: null,
            downloadedAt: null,
            completedAt: null,
          };
          setRecord(folder.id, item.media.id, baseRecord);
          item.record = baseRecord;
          item.status = "started";
          renderQueue();
          logLine(`Submitting ${item.media.name}`);

          try {
            const result = await api.generateImageVideo(
              item.media,
              item.prompt,
            );
            const completedAt = new Date().toISOString();

            if (
              result &&
              isParallelLimitMessage(result.error || result.message)
            ) {
              retries += 1;
              const nextRecord = {
                ...baseRecord,
                status: "parallel_limit",
                response: result,
                parallelLimitRetries: retries,
                updatedAt: completedAt,
                completedAt,
              };
              setRecord(folder.id, item.media.id, nextRecord);
              item.record = nextRecord;
              item.status = "parallel_limit";
              renderQueue();

              if (
                config.autoRetryOnParallelLimit &&
                retries <= config.maxParallelLimitRetries
              ) {
                logLine(
                  `Parallel limit hit. Waiting ${Math.round(config.parallelLimitRetryDelayMs / 1000)}s before retry.`,
                );
                await sleep(config.parallelLimitRetryDelayMs);
                continue;
              }

              done = true;
              break;
            }

            const nextRecord = {
              ...baseRecord,
              status: result && result.success ? "submitted" : "failed",
              uuid: result && result.uuid ? result.uuid : null,
              estimatedTimeSeconds:
                result && typeof result.estimatedTimeSeconds !== "undefined"
                  ? result.estimatedTimeSeconds
                  : null,
              response: result,
              completedAt,
              updatedAt: completedAt,
            };
            setRecord(folder.id, item.media.id, nextRecord);
            item.record = nextRecord;
            item.status = nextRecord.status;
            if (nextRecord.uuid) {
              state.activeStatuses.set(nextRecord.uuid, {
                folderId: folder.id,
                mediaId: item.media.id,
              });
            }
            renderQueue();
            done = true;
          } catch (error) {
            const failedAt = new Date().toISOString();
            const message = String(
              error && (error.message || error.stack || error),
            );
            const status = isParallelLimitMessage(message)
              ? "parallel_limit"
              : "failed";
            if (status === "parallel_limit") retries += 1;

            const nextRecord = {
              ...baseRecord,
              status,
              error: message,
              parallelLimitRetries: retries,
              failedAt,
              updatedAt: failedAt,
            };
            setRecord(folder.id, item.media.id, nextRecord);
            item.record = nextRecord;
            item.status = status;
            renderQueue();
            logLine(`Submit failed for ${item.media.name}: ${message}`);

            if (
              status === "parallel_limit" &&
              config.autoRetryOnParallelLimit &&
              retries <= config.maxParallelLimitRetries
            ) {
              await sleep(config.parallelLimitRetryDelayMs);
              continue;
            }

            done = true;
          }
        }

        if (config.delayBetweenRequestsMs > 0 && !state.stopRequested) {
          await sleep(config.delayBetweenRequestsMs);
        }
      }
    } finally {
      state.running = false;
      updateButtonStates();
      renderQueue();
      logLine(state.stopRequested ? "Queue stopped." : "Queue run finished.");
    }
  }

  function resetRecordForRetry(record) {
    if (!record) return null;
    return {
      ...record,
      status: "idle",
      error: undefined,
      response: undefined,
      statusPayload: undefined,
      failedAt: undefined,
      parallelLimitRetries: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  async function retryFailedItem(mediaId) {
    const folder = getSelectedFolder();
    if (!folder) throw new Error("No folder selected.");
    const key = makeRecordKey(folder.id, mediaId);
    const existing = state.history.records[key];
    if (!existing) throw new Error(`No history record for media ${mediaId} in folder ${folder.id}`);
    const st = normalizeStatus(existing.status);
    if (st !== "failed" && st !== "parallel_limit") throw new Error(`Item ${mediaId} is not failed (status: ${existing.status || "idle"})`);
    const next = resetRecordForRetry(existing);
    if (next) {
      delete next.error;
      delete next.response;
      delete next.statusPayload;
      delete next.failedAt;
    }
    state.history.records[key] = next;
    saveHistory();
    logLine(`Retrying failed item ${existing.imageName || mediaId} — reason: ${getFailureReason(existing) || st}`);
    if (folder && state.items.length) {
      state.queue = buildQueue(folder, state.items);
      renderQueue();
    }
    if (!state.running) {
      await runQueue();
    } else {
      logLine(`Queue running — item ${mediaId} will be retried after current item finishes.`);
    }
  }
  async function retryAllFailed() {
    const folder = getSelectedFolder();
    if (!folder) throw new Error("No folder selected.");
    const failedKeys = Object.keys(state.history.records).filter((k) => {
      const rec = state.history.records[k];
      if (!rec || String(rec.folderId) !== String(folder.id)) return false;
      const s = normalizeStatus(rec.status);
      return s === "failed" || s === "parallel_limit";
    });
    if (!failedKeys.length) throw new Error("No failed items to retry in this folder.");
    for (const key of failedKeys) {
      const rec = state.history.records[key];
      const next = resetRecordForRetry(rec);
      if (next) { delete next.error; delete next.response; delete next.statusPayload; delete next.failedAt; }
      state.history.records[key] = next;
    }
    saveHistory();
    logLine(`Retrying ${failedKeys.length} failed item(s) in folder ${folder.title || folder.name}`);
    if (folder && state.items.length) {
      state.queue = buildQueue(folder, state.items);
      renderQueue();
    }
    if (!state.running) await runQueue();
    else logLine(`Queue running — ${failedKeys.length} item(s) queued for retry.`);
  }

  async function pollStatuses() {
    const pendingRecords = Object.values(state.history.records).filter(
      (record) => {
        const status = normalizeStatus(record.status);
        return (
          record.uuid &&
          ["submitted", "running", "parallel_limit"].includes(status)
        );
      },
    );

    for (const record of pendingRecords) {
      try {
        const statusPayload = await api.getStatus(record.uuid);
        const status = normalizeStatus(statusPayload.status);
        let mapped = "running";

        if (
          status === "succeeded" ||
          status === "success" ||
          status === "completed" ||
          status === "complete" ||
          status === "finished" ||
          status === "done"
        ) {
          mapped = "completed";
        } else if (status === "failed" || status === "error") {
          mapped = "failed";
        } else if (
          status === "queued" ||
          status === "pending" ||
          status === "running"
        ) {
          mapped = "running";
        }

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
        setRecord(record.folderId, record.imageId, nextRecord);
      } catch (error) {
        logLine(`Status poll failed for ${record.uuid}: ${error.message}`);
      }
    }

    if (pendingRecords.length > 0) {
      const completedWithoutVid = Object.values(state.history.records).filter(
        (r) => normalizeStatus(r.status) === "completed" && r.uuid && !r.videoId
      );
      if (completedWithoutVid.length) {
        try {
          // I5: cap to avoid 15s-interval full scan DOS; prefer status endpoint (cheaper) before library query
          const toResolve = completedWithoutVid.length > 20 ? completedWithoutVid.slice(0, 20) : completedWithoutVid;
          if (completedWithoutVid.length > 20) logLine(`Poll capping resolution to 20/${completedWithoutVid.length} to avoid full library scan`);
          await resolveMissingVideoIdsViaStatus(toResolve);
          const still = toResolve.filter((r) => !r.videoId);
          if (still.length) {
            const uuids = still.map((r) => r.uuid);
            const aiMap = await fetchAiVideosMap(uuids, { skipStatusFallback: true });
            for (const record of still) {
              const u = String(record.uuid).toLowerCase().trim();
              if (aiMap.has(u)) {
                const vidItem = aiMap.get(u);
                const vid = String(vidItem.id || vidItem.videoId || "");
                if (vid) {
                  record.videoId = vid;
                  setRecord(record.folderId, record.imageId, {
                    ...record,
                    videoId: vid,
                    updatedAt: new Date().toISOString()
                  });
                  logLine(`Matched video ID ${vid} for ${record.imageName || record.uuid} via library`);
                }
              }
            }
          }
        } catch (e) {
          console.warn("[VE] AI videos map resolution failed in pollStatuses:", e);
        }
      }
    }

    const folder = getSelectedFolder();
    if (folder && state.items.length) {
      state.queue = buildQueue(folder, state.items);
      renderQueue();
    }
  }

  function updateButtonStates() {
    const visibleVideoCount = getFilteredVideos().length;
    els.runBtn.disabled = state.running || state.uploadInProgress;
    els.stopBtn.disabled = !state.running;
    els.uploadBtn.disabled =
      state.uploadInProgress ||
      state.running ||
      state.downloadInProgress ||
      !state.selectedFiles.length;
    els.loadMediaBtn.disabled =
      state.running || state.uploadInProgress || state.downloadInProgress;
    els.createFolderBtn.disabled =
      state.running || state.uploadInProgress || state.downloadInProgress;
    els.deleteFolderBtn.disabled =
      state.running || state.uploadInProgress || state.downloadInProgress;
    els.refreshBtn.disabled =
      state.running || state.uploadInProgress || state.downloadInProgress;
    els.clearFilesBtn.disabled =
      state.uploadInProgress ||
      state.running ||
      state.downloadInProgress ||
      !state.selectedFiles.length;
    els.loadVideosBtn.disabled =
      state.running || state.uploadInProgress || state.downloadInProgress;
    els.downloadSelectedBtn.disabled =
      state.running ||
      state.uploadInProgress ||
      state.downloadInProgress ||
      !state.selectedVideoIds.size;
    els.downloadAllBtn.disabled =
      state.running ||
      state.uploadInProgress ||
      state.downloadInProgress ||
      !visibleVideoCount;
    els.selectAllVideosBtn.disabled =
      state.running ||
      state.uploadInProgress ||
      state.downloadInProgress ||
      !visibleVideoCount;
    els.stopDownloadsBtn.disabled = !state.downloadInProgress;
    const queueCounts = getQueueDownloadCounts();
    els.downloadCompletedBtn.disabled = state.running || state.uploadInProgress || state.downloadInProgress || queueCounts.completed === 0;
    els.downloadRemainingBtn.disabled = state.running || state.uploadInProgress || state.downloadInProgress || queueCounts.remaining === 0;
    const failedCountForBtn = state.queue.filter((item) => {
      const s = normalizeStatus(item.status);
      return s === "failed" || s === "parallel_limit";
    }).length;
    if (els.retryAllFailedBtn) {
      els.retryAllFailedBtn.disabled = state.running || state.uploadInProgress || state.downloadInProgress || failedCountForBtn === 0;
    }
    const hasVideos = (state.timelineVideos && state.timelineVideos.length > 0);
    if (els.timelineExportBtn) els.timelineExportBtn.disabled = state.timelineExport.running || state.uploadInProgress || state.downloadInProgress || !hasVideos;
    if (els.timelineStopBtn) els.timelineStopBtn.disabled = !state.timelineExport.running;
    if (els.timelineDownloadBtn) els.timelineDownloadBtn.disabled = state.downloadInProgress || !state.timelineExport.exportedVideo;
    if (els.timelineLoadBtn) els.timelineLoadBtn.disabled = state.timelineExport.running || state.downloadInProgress;
    els.masterPromptEnabled.disabled = state.running;
    els.promptListEnabled.disabled = state.running;
    updateMasterPromptControls();
  }

  async function handleAction(action) {
    try {
      updateConfigFromInputs();
      await action();
    } catch (error) {
      console.error(error);
      logLine(error.message || String(error));
      alert(error.message || String(error));
    }
  }

  function attachEvents() {
    els.closeBtn.addEventListener("click", () => setPanelVisible(false));
    els.toggle.addEventListener("click", () => setPanelVisible(true));
    root
      .querySelector("#ve-manager-header")
      .addEventListener("pointerdown", (event) => {
        if (event.target.closest("button")) return;
        const rect = root.getBoundingClientRect();
        state.dragging = true;
        state.dragOffsetX = event.clientX - rect.left;
        state.dragOffsetY = event.clientY - rect.top;
        event.currentTarget.setPointerCapture(event.pointerId);
      });
    root
      .querySelector("#ve-manager-header")
      .addEventListener("pointermove", (event) => {
        if (!state.dragging) return;
        setPanelPosition(
          event.clientX - state.dragOffsetX,
          event.clientY - state.dragOffsetY,
          false,
        );
      });
    root
      .querySelector("#ve-manager-header")
      .addEventListener("pointerup", (event) => {
        if (!state.dragging) return;
        state.dragging = false;
        const rect = root.getBoundingClientRect();
        setPanelPosition(rect.left, rect.top, true);
        event.currentTarget.releasePointerCapture(event.pointerId);
      });
    window.addEventListener("resize", () => {
      const rect = root.getBoundingClientRect();
      if (rect.width && rect.height)
        setPanelPosition(rect.left, rect.top, true);
    });
    els.tabs.forEach((tab) => {
      tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
    });

    els.folderSelect.addEventListener("change", async () => {
      selectFolder(els.folderSelect.value);
    });

    els.uploadFolderSelect.addEventListener("change", async () => {
      selectFolder(els.uploadFolderSelect.value);
    });

    els.downloadFolderSelect.addEventListener("change", async () => {
      selectFolder(els.downloadFolderSelect.value);
    });

    els.folderGrid.addEventListener("click", (event) => {
      const card = event.target.closest("[data-folder-id]");
      if (!card) return;
      selectFolder(card.dataset.folderId);
    });

    els.refreshBtn.addEventListener("click", () =>
      handleAction(refreshFolders),
    );
    els.showCreateFolderBtn.addEventListener("click", () => {
      els.newFolderInput.focus();
      els.newFolderInput.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
    els.showUploadBtn.addEventListener("click", () => setActiveTab("upload"));
    els.createFolderBtn.addEventListener("click", () =>
      handleAction(createFolder),
    );
    els.deleteFolderBtn.addEventListener("click", () =>
      handleAction(deleteSelectedFolder),
    );
    els.pickFilesBtn.addEventListener("click", () => els.fileInput.click());
    els.pickFolderBtn.addEventListener("click", () => els.folderInput.click());
    els.fileInput.addEventListener("change", () =>
      setSelectedFiles(els.fileInput.files),
    );
    els.folderInput.addEventListener("change", () =>
      setSelectedFiles(els.folderInput.files),
    );
    els.clearFilesBtn.addEventListener("click", () => {
      state.selectedFiles = [];
      els.fileInput.value = "";
      els.folderInput.value = "";
      renderSelectedFiles();
      updateButtonStates();
    });
    els.uploadBtn.addEventListener("click", () =>
      handleAction(uploadSelectedFiles),
    );
    els.loadMediaBtn.addEventListener("click", () =>
      handleAction(loadFolderImages),
    );
    els.runBtn.addEventListener("click", () => handleAction(runQueue));
    els.loadVideosBtn.addEventListener("click", () =>
      handleAction(loadFolderVideos),
    );
    [
      els.videoFilterQuery,
      els.videoFilterDateFrom,
      els.videoFilterDateTo,
      els.videoFilterMinSize,
      els.videoFilterMaxSize,
    ].forEach((element) => {
      element.addEventListener("input", () => {
        syncVideoFiltersFromInputs();
        renderVideos();
        updateButtonStates();
      });
      element.addEventListener("change", () => {
        syncVideoFiltersFromInputs();
        renderVideos();
        updateButtonStates();
      });
    });
    els.clearVideoFiltersBtn.addEventListener("click", () => {
      const todayStr = new Date().toISOString().slice(0, 10);
      state.videoFilters = {
        query: "",
        dateFrom: todayStr,
        dateTo: todayStr,
        minSizeMb: "",
        maxSizeMb: "",
      };
      applyVideoFiltersToInputs();
      saveUiState({ videoFilters: state.videoFilters });
      renderVideos();
      updateButtonStates();
    });
    els.videoMasterCheckbox.addEventListener("change", () => {
      const visibleVideos = getFilteredVideos();
      if (els.videoMasterCheckbox.checked) {
        visibleVideos.forEach((video) =>
          state.selectedVideoIds.add(String(video.id)),
        );
      } else {
        visibleVideos.forEach((video) =>
          state.selectedVideoIds.delete(String(video.id)),
        );
      }
      renderVideos();
      updateButtonStates();
    });
    els.videoBody.addEventListener("change", (event) => {
      const checkbox = event.target.closest(".ve-video-checkbox");
      if (!checkbox) return;
      if (checkbox.checked) {
        state.selectedVideoIds.add(String(checkbox.dataset.videoId));
      } else {
        state.selectedVideoIds.delete(String(checkbox.dataset.videoId));
      }
      renderVideos();
      updateButtonStates();
    });
    els.selectAllVideosBtn.addEventListener("click", () => {
      getFilteredVideos().forEach((video) =>
        state.selectedVideoIds.add(String(video.id)),
      );
      renderVideos();
      updateButtonStates();
    });
    els.downloadSelectedBtn.addEventListener("click", () => {
      const selected = state.videos.filter((video) =>
        state.selectedVideoIds.has(String(video.id)),
      );
      handleAction(() => downloadVideos(selected, "Selected downloads"));
    });
    els.downloadAllBtn.addEventListener("click", () => {
      handleAction(() =>
        downloadVideos(getFilteredVideos(), "Visible downloads"),
      );
    });
    els.downloadCompletedBtn.addEventListener("click", () => handleAction(() => downloadQueueCompleted({ onlyRemaining: false })));
    els.downloadRemainingBtn.addEventListener("click", () => handleAction(() => downloadQueueCompleted({ onlyRemaining: true })));
    els.stopDownloadsBtn.addEventListener("click", () => {
      state.stopRequested = true;
      logLine(
        "Download stop requested. Current browser download will finish starting first.",
      );
    });
    els.resetHistoryBtn.addEventListener("click", () => {
      const folder = getSelectedFolder();
      const scopeLabel = folder ? ` for "${folder.title || folder.name}"` : "";
      const ok = window.confirm(`Clear saved queue history${scopeLabel}?`);
      if (!ok) return;
      if (folder) {
        const prefix = `library:${config.libraryId}:folder:${folder.id}:`;
        Object.keys(state.history.records).forEach((key) => {
          if (key.startsWith(prefix)) delete state.history.records[key];
        });
      } else {
        state.history.records = {};
      }
      saveHistory();
      if (folder && state.items.length)
        state.queue = buildQueue(folder, state.items);
      renderQueue();
      logLine("Saved queue history cleared.");
    });
    els.stopBtn.addEventListener("click", () => {
      state.stopRequested = true;
      logLine("Stop requested. Current request will finish first.");
    });
    [
      els.masterPromptEnabled,
      els.appendFilenamePrompt,
      els.masterPrompt,
      els.promptListEnabled,
      els.promptList,
    ].forEach((element) => {
      element.addEventListener("input", () => {
        updateConfigFromInputs();
        updateMasterPromptControls();
        saveUiState({
          masterPromptEnabled: config.masterPromptEnabled,
          appendFilenamePrompt: config.appendFilenamePrompt,
          masterPrompt: config.masterPrompt,
          promptListEnabled: config.promptListEnabled,
          promptList: config.promptList,
        });
        if (state.items.length && !state.running) {
          const folder = getSelectedFolder();
          if (folder) state.queue = buildQueue(folder, state.items);
          renderQueue();
        }
        updateButtonStates();
      });
      element.addEventListener("change", () =>
        element.dispatchEvent(new Event("input")),
      );
    });
    // Retry: per-row button (delegated) and Retry All
    if (els.queueBody) {
      els.queueBody.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-retry-media-id]");
        if (!btn) return;
        const mediaId = btn.dataset.retryMediaId;
        if (!mediaId) return;
        if (btn.disabled) return;
        handleAction(() => retryFailedItem(mediaId));
      });
      // Info icon click -> log full reason
      els.queueBody.addEventListener("click", (event) => {
        const info = event.target.closest(".ve-info");
        if (!info || info.closest("[data-retry-media-id]")) return;
        const fullReason = info.getAttribute("data-failure-reason") || info.getAttribute("title") || "";
        const row = info.closest("tr");
        const mediaLine = row ? (row.querySelector(".ve-title-line")?.textContent || row.querySelector(".ve-muted")?.textContent || "") : "";
        const msg = `Failure reason for ${mediaLine || "item"}: ${fullReason || "(no detail)"}`;
        logLine(msg);
      });
      els.queueBody.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const info = event.target.closest(".ve-info");
        if (!info) return;
        event.preventDefault();
        info.click();
      });
    }
    if (els.retryAllFailedBtn) {
      els.retryAllFailedBtn.addEventListener("click", () => handleAction(retryAllFailed));
    }
  }

  async function bootstrap() {
    installAuthCapture();
    refreshAuthFromPage();
    window.addEventListener("focus", refreshAuthFromPage);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshAuthFromPage();
    });
    const savedUi = loadUiState();
    if (savedUi.aspect) config.aspect = savedUi.aspect;
    if (savedUi.videoLength) config.videoLength = savedUi.videoLength;
    if (savedUi.delayBetweenRequestsMs)
      config.delayBetweenRequestsMs = savedUi.delayBetweenRequestsMs;
    if (savedUi.parallelLimitRetryDelayMs) {
      config.parallelLimitRetryDelayMs = savedUi.parallelLimitRetryDelayMs;
    }
    if (savedUi.downloadMinDelayMs)
      config.downloadMinDelayMs = savedUi.downloadMinDelayMs;
    if (savedUi.downloadMaxDelayMs)
      config.downloadMaxDelayMs = savedUi.downloadMaxDelayMs;
    if (savedUi.downloadConcurrency)
      config.downloadConcurrency = Math.min(5, Math.max(1, Number(savedUi.downloadConcurrency) || 3));
    // Migrate old slow defaults (6-14s) to new fast defaults once — only if user had old defaults saved
    if (savedUi.downloadMinDelayMs === 6000 && savedUi.downloadMaxDelayMs === 14000) {
      config.downloadMinDelayMs = 800;
      config.downloadMaxDelayMs = 1200;
      saveUiState({ downloadMinDelayMs: 800, downloadMaxDelayMs: 1200 });
    }
    if (typeof savedUi.masterPromptEnabled === "boolean") {
      config.masterPromptEnabled = savedUi.masterPromptEnabled;
    }
    if (typeof savedUi.appendFilenamePrompt === "boolean") {
      config.appendFilenamePrompt = savedUi.appendFilenamePrompt;
    }
    if (typeof savedUi.masterPrompt === "string") {
      config.masterPrompt = savedUi.masterPrompt;
    }
    if (typeof savedUi.promptListEnabled === "boolean") {
      config.promptListEnabled = savedUi.promptListEnabled;
    }
    if (typeof savedUi.promptList === "string") {
      config.promptList = savedUi.promptList;
    }
    if (savedUi.videoFilters && typeof savedUi.videoFilters === "object") {
      state.videoFilters = {
        ...state.videoFilters,
        ...savedUi.videoFilters,
      };
    }
    if (savedUi.timelineExportConfig && typeof savedUi.timelineExportConfig === "object") {
      config.timelineExportDefaults = { ...config.timelineExportDefaults, ...savedUi.timelineExportConfig };
    }
    if (typeof savedUi.timelineExportName === "string") state.timelineExport.projectName = savedUi.timelineExportName;
    const todayStr = new Date().toISOString().slice(0, 10);
    state.videoFilters.dateFrom = todayStr;
    state.videoFilters.dateTo = todayStr;

    els.aspect.value = config.aspect;
    els.videoLength.value = String(config.videoLength);
    els.delayInput.value = String(config.delayBetweenRequestsMs);
    els.retryDelayInput.value = String(config.parallelLimitRetryDelayMs);
    els.downloadMinDelay.value = String(config.downloadMinDelayMs);
    els.downloadMaxDelay.value = String(config.downloadMaxDelayMs);
    if (els.downloadConcurrency) els.downloadConcurrency.value = String(config.downloadConcurrency);
    els.masterPromptEnabled.checked = config.masterPromptEnabled;
    els.appendFilenamePrompt.checked = config.appendFilenamePrompt;
    els.masterPrompt.value = config.masterPrompt;
    els.promptListEnabled.checked = config.promptListEnabled;
    els.promptList.value = config.promptList;
    updateMasterPromptControls();
    state.selectedFolderId = savedUi.selectedFolderId || null;
    applyVideoFiltersToInputs();

    [
      "aspect",
      "videoLength",
      "delayInput",
      "retryDelayInput",
      "downloadMinDelay",
      "downloadMaxDelay",
      "downloadConcurrency",
    ].forEach((key) => {
      const element = els[key];
      if (!element) return;
      element.addEventListener("change", () => {
        updateConfigFromInputs();
        saveUiState({
          aspect: config.aspect,
          videoLength: config.videoLength,
          delayBetweenRequestsMs: config.delayBetweenRequestsMs,
          parallelLimitRetryDelayMs: config.parallelLimitRetryDelayMs,
          downloadMinDelayMs: config.downloadMinDelayMs,
          downloadMaxDelayMs: config.downloadMaxDelayMs,
          downloadConcurrency: config.downloadConcurrency,
          masterPromptEnabled: config.masterPromptEnabled,
          appendFilenamePrompt: config.appendFilenamePrompt,
          masterPrompt: config.masterPrompt,
          promptListEnabled: config.promptListEnabled,
          promptList: config.promptList,
        });
      });
    });

    attachEvents();
    setPanelVisible(!savedUi.collapsed);
    restorePanelPosition(savedUi.panelPosition);
    setActiveTab(savedUi.activeTab || "folders");
    renderSelectedFiles();
    renderVideos();
    updateButtonStates();
    await refreshFolders();
    renderQueue();
    await pollStatuses();
    setInterval(() => {
      pollStatuses().catch((error) =>
        console.warn("Status poll failed", error),
      );
    }, config.pollIntervalMs);
    logLine("Manager ready.");
  }

  bootstrap().catch((error) => {
    console.error("VideoExpress manager bootstrap failed.", error);
    alert(`VideoExpress manager failed to start.\n\n${error.message || error}`);
  });
})();
