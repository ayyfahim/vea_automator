// ==UserScript==
// @name         VideoExpress Library Manager
// @namespace    https://app.videoexpress.ai/
// @version      0.5.0
// @description  Manage folders, upload images, and batch convert images to videos inside VideoExpress AI.
// @match        https://app.videoexpress.ai/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ayyfahim/vea_automator/master/videoexpress-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/ayyfahim/vea_automator/master/videoexpress-manager.user.js
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
    downloadMinDelayMs: 6000,
    downloadMaxDelayMs: 14000,
    promptCleaner: {
      stripExtension: true,
      replaceUnderscores: true,
      replaceDashes: true,
      removeNumbers: true,
      collapseWhitespace: true,
    },
    masterPrompt: "",
    masterPromptEnabled: false,
    appendFilenamePrompt: false,
  };

  const HISTORY_KEY = "videoexpress.manager.history.v1";
  const UI_STATE_KEY = "videoexpress.manager.ui-state.v1";

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
    return value.trim();
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
    throw new Error(
      `${label} failed: ${response.status} ${response.statusText}\n${text}`,
    );
  }

  function readCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
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
    if (/^authorization$/i.test(headerName) && /^bearer\s+/i.test(headerValue)) {
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
      readCookie("XSRF-TOKEN") || readCookie("CSRF-TOKEN") || readCookie("csrf_token");
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
          const tokenMatch = value.match(/(?:access[_-]?token|token|jwt)"?\s*[:=]\s*"?([\w.-]+)/i);
          const token = tokenMatch ? tokenMatch[1] : value.replace(/^Bearer\s+/i, "");
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
      headers[state.auth.csrfHeaderName || "X-CSRF-TOKEN"] = state.auth.csrfToken;
    }
    if (state.auth.bearerToken) headers.Authorization = `Bearer ${state.auth.bearerToken}`;
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
      new Headers(headers).forEach((value, name) => captureAuthHeader(name, value));
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
    XMLHttpRequest.prototype.open = function videoExpressAuthAwareOpen(method, url) {
      this[xhrSameOrigin] = isSameOriginRequest(url);
      return originalOpen.apply(this, arguments);
    };

    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function videoExpressAuthAwareHeader(name, value) {
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
    const response = await sessionFetch(url, {
      method: "GET",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    }, label);
    return response.json();
  }

  async function postForm(url, params, label) {
    const response = await sessionFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: params,
    }, label);
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

  async function postMultipart(url, formData, label) {
    const response = await sessionFetch(url, {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest" },
      body: formData,
    }, label);
    return response.text();
  }

  async function deleteRequest(url, label) {
    const response = await sessionFetch(url, {
      method: "DELETE",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    }, label);
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

    async getMedia(folderId, page = 1, start = 0, filter = "image") {
      const params = new URLSearchParams({
        categoryId: String(folderId),
        page: String(page),
        start: String(start),
        limit: String(config.pageSize),
        query: "",
        orderBy: "name",
        orderDir: "asc",
        filter,
      });
      return getJson(
        `/api/library/get_media/${config.libraryId}?${params.toString()}`,
        `Load media for folder ${folderId}`,
      );
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
      const items = [];
      let page = 1;
      let start = 0;
      let total = Infinity;

      while (start < total) {
        const payload = await api.getMedia(folderId, page, start, "");
        const results = Array.isArray(payload.results) ? payload.results : [];
        total = Number(payload.total || results.length || 0);
        items.push(...results);
        if (!results.length || results.length < config.pageSize) break;
        page += 1;
        start += config.pageSize;
      }

      return { total: items.length, results: items };
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
      const params = new URLSearchParams({
        type: "human",
        imagePrompt: "",
        prompt,
        uuid: media.uuid || "",
        mediaId: String(media.id),
        audioMediaId: "0",
        isShared: media.isShared ? "1" : "0",
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
  };

  function getSelectedFolder() {
    return (
      state.folders.find(
        (item) => String(item.id) === String(state.selectedFolderId),
      ) || null
    );
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

  function buildQueue(folder, items) {
    return items.map((media) => {
      const prompt = composePrompt(cleanPrompt(media.name));
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
        grid-template-columns: repeat(5, 1fr);
        gap: 0;
        margin: 0 -14px 14px;
        padding: 0 14px;
        background: #ffffff;
        border-bottom: 1px solid #dfe5ed;
      }
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
        grid-template-columns: repeat(4, 1fr);
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
              Also include the image filename in the prompt
            </label>
          </div>
          <div class="ve-row">
            <textarea class="ve-textarea" id="ve-master-prompt" placeholder="e.g. cinematic product shot, soft studio light. {{image}} is optional when the filename option is enabled."></textarea>
          </div>
          <div class="ve-muted" style="margin-top:-4px;margin-bottom:10px">Master mode uses only this text unless you turn on the filename option.</div>
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
                <th style="width: 26%">Image</th>
                <th style="width: 42%">Prompt</th>
                <th style="width: 16%">Status</th>
                <th style="width: 16%">Updated</th>
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
              <input class="ve-input" id="ve-download-min-delay" type="number" min="1000" step="1000" value="${config.downloadMinDelayMs}" />
              <input class="ve-input" id="ve-download-max-delay" type="number" min="1000" step="1000" value="${config.downloadMaxDelayMs}" />
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
    folderSummary: root.querySelector("#ve-folder-summary"),
    queueBody: root.querySelector("#ve-queue-body"),
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
    if (!position || typeof position.left !== "number" || typeof position.top !== "number") return;
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
      const haystack = `${video.name || ""} ${video.fileName || ""} ${video.id || ""}`.toLowerCase();
      const createdAt = video.datetime ? new Date(video.datetime).getTime() : null;
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
    const queuedCount = state.queue.filter((item) => {
      const status = normalizeStatus(item.status);
      return !item.skip || status === "failed" || status === "parallel_limit";
    }).length;

    els.statImages.textContent = String(state.items.length);
    els.statQueued.textContent = String(queuedCount);
    els.statRunning.textContent = String(runningCount);
    els.statDone.textContent = String(doneCount);

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
                <td><span class="ve-badge ${getBadgeClass(displayStatus)}">${escapeHtml(displayStatus)}</span></td>
                <td>${escapeHtml(formatDateTime(updatedAt) || "-")}</td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="4" class="ve-muted">No items loaded yet.</td></tr>`;
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

  function randomDelay(minMs, maxMs) {
    const min = Math.max(1000, Number(minMs || 1000));
    const max = Math.max(min, Number(maxMs || min));
    return Math.round(min + Math.random() * (max - min));
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
    state.items = payload.results;
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
    els.uploadSummary.textContent = `Uploading ${files.length} files...`;

    for (const file of files) {
      try {
        await api.uploadFile(folder.id, file);
        successCount += 1;
        els.uploadSummary.textContent = `Uploaded ${successCount}/${files.length}`;
      } catch (error) {
        failCount += 1;
        logLine(`Upload failed for ${file.name}: ${error.message}`);
      }
    }

    state.uploadInProgress = false;
    updateButtonStates();
    els.fileInput.value = "";
    els.folderInput.value = "";
    state.selectedFiles = [];
    els.uploadSummary.textContent = `Upload complete. Success: ${successCount}, Failed: ${failCount}`;
    await loadFolderImages();
  }

  function updateConfigFromInputs() {
    config.videoLength = Number(els.videoLength.value || 10);
    config.aspect = els.aspect.value || "16:9";
    config.delayBetweenRequestsMs = Number(els.delayInput.value || 0);
    config.parallelLimitRetryDelayMs = Number(
      els.retryDelayInput.value || 60000,
    );
    config.downloadMinDelayMs = Number(els.downloadMinDelay.value || 6000);
    config.downloadMaxDelayMs = Number(
      els.downloadMaxDelay.value || config.downloadMinDelayMs,
    );
    config.masterPromptEnabled = Boolean(els.masterPromptEnabled.checked);
    config.appendFilenamePrompt = Boolean(els.appendFilenamePrompt.checked);
    config.masterPrompt = els.masterPrompt.value.trim();
    if (config.downloadMaxDelayMs < config.downloadMinDelayMs) {
      config.downloadMaxDelayMs = config.downloadMinDelayMs;
      els.downloadMaxDelay.value = String(config.downloadMaxDelayMs);
    }
  }

  function updateMasterPromptControls() {
    const masterEnabled = els.masterPromptEnabled.checked;
    els.filenamePromptRow.classList.toggle("ve-hidden", !masterEnabled);
    els.masterPrompt.disabled = state.running || !masterEnabled;
    els.appendFilenamePrompt.disabled = state.running || !masterEnabled;
  }

  function triggerBrowserDownload(video) {
    const link = document.createElement("a");
    link.href = `/library/download/${video.id}`;
    link.download = `${sanitizeFileName(video.name || video.fileName || video.id)}.mp4`;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function downloadVideos(videos, label) {
    if (state.downloadInProgress) return;
    if (!videos.length) throw new Error("No videos selected for download.");

    updateConfigFromInputs();
    state.downloadInProgress = true;
    state.stopRequested = false;
    updateButtonStates();

    let completed = 0;
    const total = videos.length;
    els.downloadProgress.style.width = "0%";

    try {
      for (const video of videos) {
        if (state.stopRequested) break;
        completed += 1;
        els.downloadSummary.textContent = `${label}: starting ${completed}/${total} | ${video.name || video.id}`;
        triggerBrowserDownload(video);
        els.downloadProgress.style.width = `${Math.round((completed / total) * 100)}%`;
        logLine(
          `Download started ${completed}/${total}: ${video.name || video.id}`,
        );

        if (completed < total && !state.stopRequested) {
          const waitMs = randomDelay(
            config.downloadMinDelayMs,
            config.downloadMaxDelayMs,
          );
          els.downloadSummary.textContent = `${label}: waiting ${Math.round(waitMs / 1000)}s before next download (${completed}/${total})`;
          await sleep(waitMs);
        }
      }
    } finally {
      state.downloadInProgress = false;
      updateButtonStates();
      els.downloadSummary.textContent = state.stopRequested
        ? `${label}: stopped after ${completed}/${total}`
        : `${label}: queued ${completed}/${total} downloads`;
      logLine(
        state.stopRequested
          ? "Download queue stopped."
          : "Download queue finished.",
      );
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

        const nextRecord = {
          ...record,
          status: mapped,
          statusPayload,
          updatedAt: new Date().toISOString(),
        };
        setRecord(record.folderId, record.imageId, nextRecord);
      } catch (error) {
        logLine(`Status poll failed for ${record.uuid}: ${error.message}`);
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
    els.masterPromptEnabled.disabled = state.running;
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
      if (rect.width && rect.height) setPanelPosition(rect.left, rect.top, true);
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
      els.newFolderInput.scrollIntoView({ behavior: "smooth", block: "center" });
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
      state.videoFilters = {
        query: "",
        dateFrom: "",
        dateTo: "",
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
        visibleVideos.forEach((video) => state.selectedVideoIds.add(String(video.id)));
      } else {
        visibleVideos.forEach((video) => state.selectedVideoIds.delete(String(video.id)));
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
      getFilteredVideos().forEach((video) => state.selectedVideoIds.add(String(video.id)));
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
    ].forEach((element) => {
      element.addEventListener("input", () => {
        updateConfigFromInputs();
        updateMasterPromptControls();
        saveUiState({
          masterPromptEnabled: config.masterPromptEnabled,
          appendFilenamePrompt: config.appendFilenamePrompt,
          masterPrompt: config.masterPrompt,
        });
        if (state.items.length && !state.running) {
          const folder = getSelectedFolder();
          if (folder) state.queue = buildQueue(folder, state.items);
          renderQueue();
        }
        updateButtonStates();
      });
      element.addEventListener("change", () => element.dispatchEvent(new Event("input")));
    });
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
    if (typeof savedUi.masterPromptEnabled === "boolean") {
      config.masterPromptEnabled = savedUi.masterPromptEnabled;
    }
    if (typeof savedUi.appendFilenamePrompt === "boolean") {
      config.appendFilenamePrompt = savedUi.appendFilenamePrompt;
    }
    if (typeof savedUi.masterPrompt === "string") {
      config.masterPrompt = savedUi.masterPrompt;
    }
    if (savedUi.videoFilters && typeof savedUi.videoFilters === "object") {
      state.videoFilters = {
        ...state.videoFilters,
        ...savedUi.videoFilters,
      };
    }

    els.aspect.value = config.aspect;
    els.videoLength.value = String(config.videoLength);
    els.delayInput.value = String(config.delayBetweenRequestsMs);
    els.retryDelayInput.value = String(config.parallelLimitRetryDelayMs);
    els.downloadMinDelay.value = String(config.downloadMinDelayMs);
    els.downloadMaxDelay.value = String(config.downloadMaxDelayMs);
    els.masterPromptEnabled.checked = config.masterPromptEnabled;
    els.appendFilenamePrompt.checked = config.appendFilenamePrompt;
    els.masterPrompt.value = config.masterPrompt;
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
    ].forEach((key) => {
      const element = els[key];
      element.addEventListener("change", () => {
        updateConfigFromInputs();
        saveUiState({
          aspect: config.aspect,
          videoLength: config.videoLength,
          delayBetweenRequestsMs: config.delayBetweenRequestsMs,
          parallelLimitRetryDelayMs: config.parallelLimitRetryDelayMs,
          downloadMinDelayMs: config.downloadMinDelayMs,
          downloadMaxDelayMs: config.downloadMaxDelayMs,
          masterPromptEnabled: config.masterPromptEnabled,
          appendFilenamePrompt: config.appendFilenamePrompt,
          masterPrompt: config.masterPrompt,
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
