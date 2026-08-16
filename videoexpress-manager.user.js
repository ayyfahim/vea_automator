// ==UserScript==
// @name         VideoExpress Library Manager
// @namespace    https://app.videoexpress.ai/
// @version      0.9.2
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
    autoExpireSessions: true,
    sessionExpiryDays: 30,
  };

  const HISTORY_KEY = "videoexpress.manager.history.v1";
  const UI_STATE_KEY = "videoexpress.manager.ui-state.v1";
  const SESSION_META_KEY = "videoexpress.manager.sessions.v1";
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
    timelineVideos: [],
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
  // —— Sessions — unique naming + 30-day auto-expiry (only locally created) ——
  function loadSessions() {
    try {
      const raw = JSON.parse(localStorage.getItem(SESSION_META_KEY) || "{}");
      if (raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object") return raw;
      if (Array.isArray(raw)) return { version: 1, sessions: {} };
      return { version: 1, sessions: raw.sessions || {} };
    } catch {
      return { version: 1, sessions: {} };
    }
  }
  function saveSessions(data) {
    const toSave = data.sessions ? { version: 1, updatedAt: new Date().toISOString(), sessions: data.sessions } : { version: 1, updatedAt: new Date().toISOString(), sessions: data };
    localStorage.setItem(SESSION_META_KEY, JSON.stringify(toSave, null, 2));
  }
  function isSessionFolder(folder) {
    try {
      const meta = loadSessions();
      const id = String(folder && folder.id || "");
      if (id && meta.sessions[id]) return true;
      const name = String(folder && (folder.title || folder.name) || "").trim();
      return Object.values(meta.sessions).some(s => s && String(s.folderName) === name);
    } catch { return false; }
  }
  function sanitizeSessionBase(raw) {
    let s = String(raw || "").trim();
    if (!s) return "session";
    s = s.replace(/\.[a-z0-9]+$/i, "");
    s = s.replace(/[<>:"\/\\|?*\x00-\x1f]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/\s/g, "-").replace(/_+/g, "-").replace(/-+/g, "-");
    s = s.replace(/^[-.]+|[-.]+$/g, "");
    if (!s) s = "session";
    if (s.length > 32) s = s.slice(0, 32).replace(/[-.]+$/g, "");
    return s;
  }
  function generateSessionSuffix() {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let uniq = "";
    for (let i = 0; i < 4; i++) uniq += charset[Math.floor(Math.random() * charset.length)];
    return `-${dd}${mm}-${uniq}`;
  }
  function isFolderNameTaken(name) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) return false;
    return (state.folders || []).some(f => {
      const n = String(f.title || f.name || "").trim().toLowerCase();
      return n === needle;
    });
  }
  function buildSessionFolderName(rawBase) {
    const base = sanitizeSessionBase(rawBase);
    let suffix = generateSessionSuffix();
    let candidate = `${base}${suffix}`;
    let attempts = 0;
    while (isFolderNameTaken(candidate) && attempts < 20) {
      suffix = generateSessionSuffix();
      candidate = `${base}${suffix}`;
      attempts++;
    }
    if (isFolderNameTaken(candidate)) {
      const ts = Date.now().toString(36).slice(-4).toUpperCase();
      candidate = `${base}-${ts}`;
      let t = 0;
      while (isFolderNameTaken(candidate) && t < 10) {
        candidate = `${base}-${ts}${t}`;
        t++;
      }
    }
    return candidate;
  }
  function isDuplicateFolderError(err) {
    const msg = String(err && (err.bodyText || err.message) || "").toLowerCase();
    return /duplicate|already exists|exists/.test(msg);
  }
  function updateSessionPreview() {
    const input = document.getElementById("ve-session-name-input");
    const out = document.getElementById("ve-session-preview-name");
    if (!input || !out) return;
    const raw = input.value.trim();
    if (!raw) {
      out.textContent = "\u2014";
      out.style.color = "#9AA0B0";
      return;
    }
    out.style.color = "var(--cut-orange)";
    out.textContent = buildSessionFolderName(raw);
  }
  async function createSession(rawBase) {
    const base = String(rawBase || "").trim();
    if (!base) throw new Error("Session name is required.");
    if (base.length < 2) throw new Error("Session name too short — use at least 2 characters.");
    let folderName = buildSessionFolderName(base);
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await api.createFolder(folderName);
        lastErr = null;
        break;
      } catch (e) {
        if (isDuplicateFolderError(e)) {
          lastErr = e;
          folderName = buildSessionFolderName(base);
          logLine(`Name ${folderName} collided — shuffling unique suffix (attempt ${attempt + 2}/5)`);
          continue;
        }
        throw e;
      }
    }
    if (lastErr) throw lastErr;
    await refreshFolders();
    const created = state.folders.find(f => String(f.title || f.name) === folderName) || state.folders.find(f => String(f.name) === folderName);
    const folderId = created ? String(created.id) : "";
    if (created) {
      state.selectedFolderId = created.id;
      saveUiState({ selectedFolderId: created.id });
      renderFolders();
    }
    try {
      const meta = loadSessions();
      const now = Date.now();
      const expiresAt = now + Number(config.sessionExpiryDays || 30) * 24 * 60 * 60 * 1000;
      const key = folderId || folderName;
      meta.sessions[key] = {
        folderId: folderId || null,
        folderName,
        baseName: sanitizeSessionBase(base),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        autoExpire: Boolean(config.autoExpireSessions),
      };
      saveSessions(meta);
      if (config.autoExpireSessions) logLine(`Session "${folderName}" will auto-delete after ${config.sessionExpiryDays} days (only locally created)`);
      else logLine(`Session "${folderName}" created — auto-delete is off`);
    } catch (e) {
      console.warn("[VE] session meta save failed", e);
    }
    return { folderName, folder: created };
  }
  async function checkExpiredSessions() {
    if (!config.autoExpireSessions) return;
    let meta;
    try { meta = loadSessions(); } catch { return; }
    const now = Date.now();
    const entries = Object.entries(meta.sessions || {});
    if (!entries.length) return;
    let changed = false;
    for (const [key, s] of entries) {
      if (!s || !s.expiresAt || s.autoExpire === false) continue;
      const exp = new Date(s.expiresAt).getTime();
      if (!Number.isFinite(exp) || now < exp) continue;
      const folderId = s.folderId ? String(s.folderId) : "";
      const folderName = s.folderName || key;
      let live = null;
      if (folderId) live = (state.folders || []).find(f => String(f.id) === folderId);
      if (!live) live = (state.folders || []).find(f => String(f.title || f.name) === folderName);
      if (!live) {
        delete meta.sessions[key];
        changed = true;
        logLine(`Cleaned expired session meta "${folderName}" — folder already gone`);
        continue;
      }
      try {
        logLine(`Auto-deleting expired session "${folderName}" (#${live.id}) + its assets after 30 days`);
        await api.deleteFolder(live.id);
        const prefix = `library:${config.libraryId}:folder:${live.id}:`;
        Object.keys(state.history.records).forEach(k => { if (k.startsWith(prefix)) delete state.history.records[k]; });
        saveHistory();
        delete meta.sessions[key];
        for (const k2 of Object.keys(meta.sessions)) {
          const v2 = meta.sessions[k2];
          if (v2 && String(v2.folderName) === folderName && k2 !== key) delete meta.sessions[k2];
        }
        changed = true;
        await refreshFolders();
        renderQueue();
        logLine(`Expired session "${folderName}" deleted`);
      } catch (e) {
        logLine(`Auto-delete failed for "${folderName}": ${e.message}`);
        s.expiresAt = new Date(now + 24*60*60*1000).toISOString();
        changed = true;
      }
      await sleep(800);
      if (changed) saveSessions(meta);
    }
    if (changed) saveSessions(meta);
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
        quality: "high",
        size: "1080",
        format: "mp4",
        aspect: config.aspect || "16:9",
        project_id: 0,
        project_title: "",
        ...options,
        name: String(options.name || `timeline_${now}`).slice(0, 80),
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
    <!--
THESIS: The batch queue is a physical select rail of punched frames; queue position is frame position, status is a mark not a hue. Refuses same-size icon+heading cards and the hero-metric stat template.
OWN-WORLD: True-black grain field (#0A0A0D) with flag-orange (var(--cut-orange)) holding 1/3 of chrome; running copy in punched white windows (#F5F1EB); hairline sprockets; one size condensed grotesk caps (Barlow Condensed 600/700) for labels, JetBrains Mono for data; rank is cell count not type size.
STORY: Operator sees every image as a frame on the rail, understands 5-parallel limit as bench capacity, believes hung trims stay reachable, and does load->run->download without hunting status color.
FIRST VIEWPORT: Orange perforated rail fixed 44px high (8px sprocket row) with 6 frame-label tabs; below, folder grid as 3-col white windows with punch holes; stats as orange-flag tape band; primary sits on rail as grease cross.
FORM: operate-a-cutting-bench-select-rail at 4/7 grounded, seed 2b9fb7b1 challengers fused; quality bar board https://impeccable.style/worlds/cards/operate-a-cutting-bench-select-rail + hero.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=JetBrains+Mono:wght@400;600&family=Instrument+Sans:wght@400;500;600&display=swap');
#ve-manager-root {
    position: fixed;
    top: 72px;
    right: 16px;
    z-index: 2147483647;
    font-family: 'Instrument Sans', 'Barlow Condensed', system-ui, sans-serif;
    color: #111827;
    --cut-orange: #6F5CCF;
    --cut-orange-deep: #5B4DB3;
    --cut-orange-soft: #8A75D6;
    --cut-black: #111827;
    --cut-panel: #F5F6F8;
    --cut-window: #FFFFFF;
    --cut-window-warm: #F9FAFB;
    --cut-ink: #111827;
    --cut-line: #E6E8EF;
    --cut-line-soft: #DADDE3;
    --cut-border-warm: #E9EBEF;
    --cut-border-warm-2: #E9EBEF;
    --cut-muted: #6E7583;
    --cut-muted-light: #9AA0B0;
    --cut-success: #0EA768;
    --cut-warn: #F59E0B;
    --cut-danger-ink: #111827;
  }
  #ve-manager-root[data-theme="bench"] {
    --cut-orange: #FF3B0A;
    --cut-orange-deep: #D12E04;
    --cut-orange-soft: #FF6B35;
    --cut-black: #0A0A0D;
    --cut-panel: #0F1012;
    --cut-window: #F5F1EB;
    --cut-window-warm: #F7F3EC;
    --cut-ink: #1A1A18;
    --cut-line: #1A1D20;
    --cut-line-soft: #2A2E33;
    --cut-border-warm: #D8D0C2;
    --cut-border-warm-2: #E0D8CC;
    --cut-muted: #5A5752;
    --cut-muted-light: #6B6760;
    --cut-success: #0EA768;
    --cut-warn: #FFC83D;
    --cut-danger-ink: #1A1A1E;
  }
  #ve-manager-root[data-theme="teal"] {
    --cut-orange: #0F766E;
    --cut-orange-deep: #115E59;
    --cut-orange-soft: #14B8A6;
    --cut-black: #042F2E;
    --cut-panel: #0B1A1F;
    --cut-window: #F0FDFA;
    --cut-window-warm: #CCFBF1;
    --cut-ink: #042F2E;
    --cut-line: #134E4A;
    --cut-line-soft: #1F5F57;
    --cut-border-warm: #99F6E4;
    --cut-border-warm-2: #5EEAD4;
    --cut-muted: #5F6B6A;
    --cut-muted-light: #7A8A89;
    --cut-success: #0EA768;
    --cut-warn: #F59E0B;
    --cut-danger-ink: #042F2E;
  }
  #ve-manager-root[data-theme="amber"] {
    --cut-orange: #D97706;
    --cut-orange-deep: #B45309;
    --cut-orange-soft: #F59E0B;
    --cut-black: #1C1917;
    --cut-panel: #292524;
    --cut-window: #FFFBEB;
    --cut-window-warm: #FEF3C7;
    --cut-ink: #1C1917;
    --cut-line: #44403C;
    --cut-line-soft: #57534E;
    --cut-border-warm: #FDE68A;
    --cut-border-warm-2: #FCD34D;
    --cut-muted: #78716C;
    --cut-muted-light: #A8A29E;
    --cut-success: #0EA768;
    --cut-warn: #F59E0B;
    --cut-danger-ink: #1C1917;
  }
  #ve-manager-root * { scrollbar-width: thin; scrollbar-color: var(--cut-line-soft) transparent; }
  #ve-manager-panel {
    width: min(660px, calc(100vw - 24px));
    max-height: calc(100vh - 88px);
    overflow: hidden;
    background: var(--cut-panel);
    border: 1px solid #E2E4E9;
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(17,24,39,0.11), 0 1px 0 rgba(17,24,39,0.06) inset;
    display: flex;
    flex-direction: column;
  }
  #ve-manager-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 11px 12px 10px;
    background: var(--cut-orange);
    border-bottom: 1px solid rgba(0,0,0,0.07);
    cursor: move;
    user-select: none;
    position: relative;
  }
  /* sprocket removed — visual noise */
  #ve-manager-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #fff;
    line-height: 1;
    text-shadow: none;
  }
  #ve-manager-header .ve-header-sub {
    font-family: 'Instrument Sans', sans-serif;
    font-size: 11px;
    letter-spacing: 0.01em;
    color: rgba(255,255,255,0.88);
    margin-top: 2px;
    font-weight: 500;
  }
  #ve-manager-header button {
    cursor: pointer;
    border: 1px solid rgba(0,0,0,0.10);
    background: rgba(255,255,255,0.94);
    color: #0A0A0D;
    border-radius: 1px;
    width: 30px; height: 30px;
    display: grid; place-items: center;
  }
  #ve-manager-body {
    padding: 16px 12px 12px;
    overflow: auto;
    max-height: calc(100vh - 150px);
    background: var(--cut-panel);
  }
  #ve-manager-body::-webkit-scrollbar { width: 10px; height: 10px; }
  #ve-manager-body::-webkit-scrollbar-thumb { background: #DADDE3; border: 1px solid #E6E8EF; border-radius: 999px; }
  #ve-manager-body::-webkit-scrollbar-track { background: #F5F6F8; }

   /* Context bar — distilled: one line, no double meta */
  .ve-context-bar {
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    background: #FFFFFF; color:#111827; border:1px solid #E6E8EF; border-radius:8px;
    padding:8px 10px; margin-bottom:10px;
    position:sticky; top:0; z-index:4;
  }
  .ve-context-left { display:flex; align-items:center; gap:8px; min-width:0; }
  .ve-context-pill {
    display:inline-flex; align-items:center; gap:6px;
    background:#F3F4F6; color:#111827; border:1px solid #E5E7EB; border-radius:999px;
    padding:4px 8px; font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:600;
    letter-spacing:0.04em; white-space:nowrap;
  }
  .ve-context-pill i { color: var(--cut-orange); font-size:11px; }
  .ve-context-meta { font-family:'Instrument Sans',sans-serif; font-size:11px; color:#6B7280; white-space:nowrap; }
  .ve-context-meta strong { color:#111827; font-weight:600; }
  .ve-context-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }
  .ve-context-select {
    font-family:'Instrument Sans',sans-serif; font-size:12px; font-weight:500;
    background:#fff; color:#111827; border:1px solid #D1D5DB; border-radius:6px; padding:6px 8px; cursor:pointer;
  }

  /* Onboarding — distilled to one line tip */
  .ve-onboarding {
    background: #FFFFFF;
    border:1px solid #E6E8EF; border-radius:8px; padding:8px 10px; margin-bottom:10px;
    display:flex; gap:10px; align-items:center; position:relative;
  }
  .ve-onboarding-icon { width:24px; height:24px; background:#F3F0FF; color:var(--cut-orange); display:grid; place-items:center; flex-shrink:0; border-radius:6px; font-size:12px; }
  .ve-onboarding h4 { margin:0; font-family:'Instrument Sans',sans-serif; font-size:12px; font-weight:600; color:#111827; }
  .ve-onboarding p { margin:2px 0 0; font-size:11px; line-height:1.4; color:#6B7280; }
  .ve-onboarding .ve-step-hint { display:none; }
  .ve-mini-step { display:none; }
  .ve-onboarding-dismiss { margin-left:auto; border:0; background:transparent; color:#9CA3AF; width:22px; height:22px; display:grid; place-items:center; cursor:pointer; border-radius:6px; flex-shrink:0; }
  .ve-onboarding-dismiss:hover{ background:#F3F4F6; color:#111827; }

  /* Stepper */
  .ve-steps {
    display:grid; grid-template-columns: 1fr 1fr 1fr 1fr auto;
    gap:6px; background:transparent; border:0; overflow:visible;
    margin: 0 0 12px;
  }
  .ve-step {
    background: #FFFFFF;
    color:#4B5162; border:1px solid #E6E8EF; cursor:pointer; text-align:left;
    padding:9px 10px 9px; display:flex; flex-direction:column; gap:2px;
    font-family:'Barlow Condensed',sans-serif; position:relative; min-height:56px;
    transition: all .14s ease;
    border-radius:9px;
    box-shadow: 0 1px 2px rgba(17,24,39,0.04);
  }
  .ve-step:hover { border-color:#DADDE3; background:#F9FAFB; }
  .ve-step.active { background:#FFFFFF; color:#1F2328; border-color: var(--cut-orange); box-shadow: 0 0 0 3px rgba(111,92,207,0.12), 0 1px 2px rgba(17,24,39,0.04); }
  .ve-step-top { display:flex; align-items:center; gap:6px; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; opacity:.9; }
  .ve-step.active .ve-step-top { color: var(--cut-orange); }
  .ve-step-num { width:18px; height:18px; display:grid; place-items:center; border:1px solid #DADDE3; background:#F5F6F8; color:#6E7583; font-family:'JetBrains Mono',monospace; font-size:9px; font-weight:600; border-radius:999px; flex-shrink:0; }
  .ve-step.active .ve-step-num { background:var(--cut-orange); color:#fff; border-color:var(--cut-orange); }
  .ve-step strong { font-size:11px; letter-spacing:0.06em; text-transform:uppercase; line-height:1.1; }
  .ve-step span { font-family:'Instrument Sans',sans-serif; font-size:10.5px; font-weight:500; opacity:.82; text-transform:none; letter-spacing:0; line-height:1.1; white-space:nowrap; }
  .ve-step.active span { opacity:.7; color:#3A3A36; }
  .ve-step--log { min-width:56px; align-items:center; justify-content:center; text-align:center; padding:8px 6px; }
  .ve-step--log i { font-size:14px; }
  .ve-step--log span { font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:0.06em; text-transform:uppercase; }
  .ve-step-dot { position:absolute; top:6px; right:7px; width:6px; height:6px; background:#fff; border:1px solid #000; border-radius:50%; opacity:0; }
  .ve-step.has-activity .ve-step-dot { opacity:1; background: var(--cut-warn); }
  .ve-step.active.has-activity .ve-step-dot { background: var(--cut-orange); }

  .ve-tab-panel { display: none; animation: veIn 0.16s steps(2); }
  .ve-tab-panel.active { display: block; }
  @keyframes veIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }

  .ve-section {
    margin-bottom: 10px;
    padding: 14px 13px;
    border: 1px solid #E5E7EB;
    border-radius: 8px;
    background: #FFFFFF;
    color: #111827;
    position: relative;
  }
  .ve-section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 0 0 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid #E6E8EF;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #111827;
  }
  .ve-section-title i { color: var(--cut-orange); }
  .ve-section-help { font-family:'Instrument Sans',sans-serif; font-size:11px; color:#6B7280; margin:0 0 10px; line-height:1.45; }
  /* kicker removed — banned per craft floor, heading carries weight */
  .ve-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .ve-row:last-child { margin-bottom: 0; }
  .ve-row > * { flex: 1; }
  .ve-input, .ve-select, .ve-textarea {
    width: 100%;
    border-radius: 8px;
    border: 1px solid #DADDE3;
    background: #fff;
    color: #0A0A0D;
    padding: 9px 10px;
    font-family: 'Instrument Sans', sans-serif;
    font-size: 12.5px;
    outline: none;
  }
  .ve-input:focus, .ve-select:focus, .ve-textarea:focus {
    border-color: var(--cut-orange);
    box-shadow: 0 0 0 3px rgba(111,92,207,0.12);
  }
  .ve-textarea { min-height: 68px; resize: vertical; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; line-height:1.5; }
  .ve-input::placeholder, .ve-textarea::placeholder { color: #8A8680; }
  .ve-field-label { display:block; font-family:'JetBrains Mono',monospace; font-size:9px; font-weight:700; letter-spacing:0.07em; text-transform:uppercase; color:#5A5752; margin-bottom:4px; }
  .ve-field-hint { font-size:10.5px; color:#6B6760; margin-top:3px; line-height:1.3; }
  .ve-button {
    cursor: pointer;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    white-space: nowrap;
    border: 1px solid rgba(0,0,0,0.10);
    border-radius: 8px;
    padding: 8px 11px;
    transition: all .14s ease;
    display:inline-flex; align-items:center; justify-content:center; gap:6px;
  }
  .ve-button:hover:not(:disabled) { transform: translateY(-0.5px); filter: brightness(1.02); box-shadow: 0 2px 8px rgba(17,24,39,0.07); }
  .ve-button:active:not(:disabled) { transform: translateY(0); box-shadow: 0 1px 2px rgba(17,24,39,0.06); }
  .ve-button:disabled { opacity: 0.42; cursor: not-allowed; transform:none; box-shadow:none; }
  .ve-button.primary { background: var(--cut-orange); color: #fff; border-color: #000; }
  .ve-button.success { background: #0EA768; border-color: #000; color: #fff; }
  .ve-button.warn { background: #FFC83D; border-color: #000; color: #0A0A0D; }
  .ve-button.danger { background: #1A1A1E; color: #FFC83D; border-color: #000; }
  .ve-button.ghost { background: #fff; color: #0A0A0D; border-color: #1A1D20; }
  .ve-button.small { padding:6px 8px; font-size:10.5px; }
  .ve-icon-button { flex: 0 0 34px; width: 34px; min-width: 34px; padding: 7px 0; font-size: 13px; }
  .ve-muted { color: #5A5752; font-size: 11.5px; font-family: 'Instrument Sans', sans-serif; line-height:1.4; }
  .ve-empty {
    text-align:center; padding:18px 12px; border:1px dashed #DADDE3; background: #FFFFFF; border-radius:1px;
  }
  .ve-empty i { font-size:22px; color: var(--cut-orange); display:block; margin-bottom:6px; }
  .ve-empty strong { font-family:'Barlow Condensed',sans-serif; font-size:11px; letter-spacing:0.07em; text-transform:uppercase; color:#0A0A0D; }
  .ve-empty p { margin:4px 0 10px; font-size:11.5px; color:#6B6760; }
  /* Stats distilled: inline summary replaces 5 cards */
  .ve-stats { display:none; }
  .ve-stat { display:none; }
  .ve-status-line { display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-family:'JetBrains Mono',monospace; font-size:10px; color:#6B7280; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:6px; padding:7px 9px; }
  .ve-status-line strong { color:#111827; font-weight:700; }
  .ve-status-line .dot { width:6px; height:6px; border-radius:50%; background:#D1D5DB; display:inline-block; }
  .ve-status-line .dot.running{ background:var(--cut-orange); }
  .ve-status-line .dot.done{ background:#0EA768; }
  .ve-status-line .dot.fail{ background:#111827; }
  .ve-table { width: 100%; border-collapse: collapse; font-size: 11.5px; font-family: 'Instrument Sans', sans-serif; }
  .ve-table th, .ve-table td { border-bottom: 1px solid #EFF0F3; padding: 9px 6px; vertical-align: top; text-align: left; }
  .ve-table th { font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: #5A5752; background: #F9FAFB; border-bottom: 1px solid #E6E8EF; }
  .ve-table tr:hover td { background: #FFF8EE; }
  .ve-thumb { width: 44px; height: 32px; flex: 0 0 44px; border-radius: 1px; background: #F5F6F8 center / cover no-repeat; border: 1px solid #E6E8EF; }
  .ve-media-cell { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
  .ve-title-line { word-break: break-word; color: #0A0A0D; font-weight: 600; font-size: 12px; line-height: 1.25; }
  .ve-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 6px; border-radius: 1px;
    font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
    border: 1px solid #E6E8EF;
  }
  .ve-badge::before { content: ''; width: 7px; height: 7px; border: 1px solid currentColor; background: transparent; }
  .ve-badge.idle { background: #EDE8DF; color: #5A5752; }
  .ve-badge.started, .ve-badge.submitted, .ve-badge.running { background: var(--cut-orange); color: #fff; }
  .ve-badge.started::before, .ve-badge.submitted::before, .ve-badge.running::before { background: #fff; border-color: #fff; box-shadow: 0 0 0 1px #000; }
  .ve-badge.completed { background: #0EA768; color: #fff; }
  .ve-badge.completed::before { content: '✓'; font-size: 9px; border: 0; width: auto; height: auto; background:transparent; }
  .ve-badge.failed { background: #0A0A0D; color: #FFC83D; }
  .ve-badge.parallel_limit { background: #FFC83D; color: #0A0A0D; }
  .ve-badge.skipped { background: #EDE8DF; color: #8A8680; border-style: dashed; }
  .ve-info { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-left: 6px; border-radius: 50%; border: 1px solid #DADDE3; background: #F9FAFB; color: #1A1D20; font-family: 'JetBrains Mono', monospace; font-size: 8px; font-weight: 700; cursor: help; }
  .ve-info:hover { background: var(--cut-orange); color: #fff; border-color: #000; }
  .ve-retry-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 1px; border: 1.5px solid #000; background: #fff; color: #0A0A0D; font-family: 'Barlow Condensed', sans-serif; font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; cursor: pointer; }
  .ve-retry-btn:hover { background: var(--cut-orange); color: #fff; }
  .ve-folder-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .ve-folder-card { min-height: 66px; border: 1px solid #E5E7EB; border-radius: 8px; background: #FFFFFF; color: #111827; cursor: pointer; padding: 10px 9px 8px; text-align: left; position: relative; transition: all .12s ease; }
  .ve-folder-card:hover { border-color: #D1D5DB; background: #F9FAFB; }
  .ve-folder-card.active { border-color: var(--cut-orange); background: #FFFFFF; box-shadow: 0 0 0 2px rgba(111,92,207,0.12); }
  .ve-folder-card i { color: #6B6760; font-size: 17px; }
  .ve-folder-card.active i { color: var(--cut-orange); }
  .ve-folder-card strong { display: block; margin-top: 6px; font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 700; line-height: 1.15; letter-spacing: 0.02em; text-transform: uppercase; word-break: break-word; }
  .ve-folder-card .ve-muted { font-family: 'JetBrains Mono', monospace; font-size: 9px; }
  .ve-file-drop { border: 1px dashed #D1D5DB; background:#F9FAFB; border-radius:8px; padding:12px; text-align:center; margin-bottom:8px; transition: all .12s; }
  .ve-file-drop.has-files { border-color: var(--cut-orange); background: #F5F0FF; border-style:solid; }
  .ve-file-drop i { font-size:18px; color:var(--cut-orange); }
  .ve-file-drop p { margin:4px 0 0; font-size:12px; color:#374151; }
  .ve-file-picker, .ve-download-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ve-download-controls { grid-template-columns: 1fr 1fr 1fr; }
  .ve-check-cell { width: 32px; text-align: center !important; }
  .ve-checkbox { width: 15px; height: 15px; cursor: pointer; accent-color: var(--cut-orange); }
  .ve-progress { height: 6px; overflow: hidden; border-radius: 999px; background: #EFF0F3; border: 0; position: relative; }
  .ve-progress::before { display:none; }
  .ve-progress-bar { width: 0%; height: 100%; background: var(--cut-orange); transition: width 0.3s ease; position: relative; border-radius:999px; }
   #ve-manager-root .ve-file-input, .ve-file-input { display: none !important; position: absolute !important; width: 1px !important; height: 1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; clip-path: inset(50%) !important; white-space: nowrap !important; border: 0 !important; padding: 0 !important; margin: -1px !important; pointer-events: none !important; opacity: 0 !important; }
   /* extra guard: any file input inside the panel that isn't styled as ve-file-input */
   #ve-manager-root input[type="file"].ve-file-input { display: none !important; }
   .ve-hidden { display: none !important; }
  #ve-manager-toggle { margin-top: 10px; margin-left: auto; display: block; width: 54px; height: 54px; border-radius: 2px; border: 1.5px solid #000; cursor: pointer; color: #fff; font-size: 18px; font-weight: 700; background: var(--cut-orange); box-shadow: 0 8px 22px rgba(0,0,0,0.45); font-family: 'Barlow Condensed', sans-serif; }
  #ve-manager-toggle:hover { filter: brightness(1.08); transform: translateY(-1px); }
  #ve-manager-toggle:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .ve-log { background:#1F2328; color:#E6E8EF; border:1px solid #2A2E33; border-radius:8px; padding:10px; font-family:'JetBrains Mono',monospace; font-size:11px; line-height:1.45; min-height:96px; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; }
  .ve-next-cta { display:none; }
  .ve-advanced-toggle { width:100%; display:flex; align-items:center; justify-content:space-between; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:1px; padding:8px 10px; cursor:pointer; font-family:'Barlow Condensed',sans-serif; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#0A0A0D; }
  .ve-advanced-toggle i { transition: transform .15s; }
  .ve-advanced-toggle[aria-expanded="true"] i { transform: rotate(180deg); }
  .ve-collapsible { overflow:hidden; transition: max-height .2s ease; }
  .ve-collapsible.collapsed { max-height:0 !important; opacity:0; pointer-events:none; }
  .ve-collapsible.expanded { max-height:800px; opacity:1; }
  /* Session creator — primary action, distilled */
  #ve-session-section { border-color: var(--cut-line); }
  #ve-session-preview { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  #ve-session-preview-name { font-family:'JetBrains Mono',monospace; font-weight:700; color: var(--cut-orange); word-break:break-all; }
  #ve-session-section .ve-field-label { color: var(--cut-ink); }
  .ve-session-badge { display:inline-flex; align-items:center; gap:4px; font-family:'JetBrains Mono',monospace; font-size:8px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; background:#F3F0FF; color:var(--cut-orange); border:1px solid #E6E8EF; border-radius:4px; padding:2px 5px; }
  .ve-folder-card.is-session { border-color: var(--cut-orange); }
  .ve-folder-card.is-session::after { content:'SESSION'; position:absolute; top:6px; right:6px; font-family:'JetBrains Mono',monospace; font-size:7px; font-weight:700; letter-spacing:0.06em; color:#fff; background:var(--cut-orange); border:1px solid var(--cut-orange-deep); border-radius:4px; padding:1px 4px; line-height:1; }
  /* helper toolbar under context bar */
  .ve-toolbar { display:flex; gap:6px; margin-bottom:8px; }
  .ve-toolbar .ve-button{ flex:1; }
  @media (max-width: 640px) {
    #ve-manager-root { top: 8px; right: 8px; left: 8px; }
    #ve-manager-panel { width: auto; max-height: calc(100vh - 16px); }
    .ve-folder-grid, .ve-stats, .ve-file-picker, .ve-download-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ve-row { flex-wrap: wrap; }
    .ve-steps { grid-template-columns: 1fr 1fr; }
    .ve-step--log{ grid-column: span 2; flex-direction:row; min-height:36px; }
  }

  /* Upload summary — stateful, failure impossible to miss */
  #ve-upload-summary { margin-top:8px; background:#fff; border:1px solid #E0D8CC; border-radius:6px; padding:8px 9px; font-family:'Instrument Sans',sans-serif; font-size:11.5px; line-height:1.4; display:flex; align-items:flex-start; gap:8px; transition:all .14s ease; }
  #ve-upload-summary.is-idle { background:#fff; color:#5A5752; border-color:#E0D8CC; }
  #ve-upload-summary.is-selected { background:#F9FAFB; color:#111827; border-color:#E6E8EF; }
  #ve-upload-summary.is-uploading { background:#F3F0FF; color:#6D28D9; border-color:var(--cut-orange); border-left-width:3px; }
  #ve-upload-summary.is-success { background:#ECFDF5; color:#065F46; border-color:#0EA768; border-left-width:3px; border-left-color:#0EA768; }
  #ve-upload-summary.is-error { background:#FFFBEB; color:#111827; border-color:#F59E0B; border-left-width:3px; border-left-color:#F59E0B; box-shadow:0 0 0 3px rgba(245,158,11,0.14); animation: veShake .32s ease 1; }
  #ve-upload-summary i.ve-summary-icon { font-size:15px; flex-shrink:0; margin-top:1px; }
  #ve-upload-summary .ve-summary-main { flex:1; min-width:0; }
  #ve-upload-summary .ve-summary-title { font-family:'Barlow Condensed',sans-serif; font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; line-height:1.1; }
  #ve-upload-summary .ve-summary-detail { font-size:11px; color:inherit; opacity:.92; word-break:break-word; }
  #ve-upload-summary .ve-summary-detail strong { color:inherit; }
  #ve-upload-summary .ve-fail-chip { display:inline-flex; align-items:center; font-family:'JetBrains Mono',monospace; font-size:9px; font-weight:700; background:#1A1A1E; color:#FFC83D; border:1px solid #000; border-radius:4px; padding:2px 6px; margin:3px 4px 0 0; max-width:100%; word-break:break-all; }
  @keyframes veShake { 0%,100%{ transform:translateX(0)} 20%{ transform:translateX(-2px)} 40%{ transform:translateX(2px)} 60%{ transform:translateX(-1px)} 80%{ transform:translateX(1px)} }

    </style>
    <div id="ve-manager-panel">
      <div id="ve-manager-header">
        <div>
          <div id="ve-manager-title">VideoExpress Manager</div>
           <div class="ve-header-sub">Batch image → video · Library 4 · drag header to move</div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <select id="ve-theme-select" class="ve-select" style="width:auto;min-width:128px;padding:6px 28px 6px 10px;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;border:1.5px solid #000;background:#fff;color:#111827;border-radius:1px;cursor:pointer" title="Palette">
            <option value="videoexpress">VideoExpress</option>
            <option value="bench">Bench Red</option>
            <option value="teal">Teal Dark</option>
            <option value="amber">Amber Warm</option>
          </select>
          <button class="ve-button ghost ve-icon-button" id="ve-close-btn" title="Hide panel"><i class="bi bi-x-lg"></i></button>
        </div>
      </div>
      <div id="ve-manager-body">
        <!-- Persistent context bar: single source of truth for folder -->
        <div class="ve-context-bar" id="ve-context-bar">
          <div class="ve-context-left">
            <span class="ve-context-pill" id="ve-context-pill"><i class="bi bi-folder2"></i> <span id="ve-context-name">product-shots-04</span> <small id="ve-context-id" style="opacity:.65">#101</small></span>
            <span class="ve-context-meta" id="ve-context-meta"><strong id="ve-context-count">8</strong> images · <strong id="ve-context-done">2</strong> done</span>
          </div>
          <div class="ve-context-right">
            <select id="ve-context-select" class="ve-context-select" title="Switch active folder"></select>
            <button class="ve-button ghost small" id="ve-context-change-btn" type="button" style="padding:5px 7px; border:1px solid #E6E8EF; color:#111827; background:#fff;"><i class="bi bi-arrow-repeat"></i></button>
          </div>
        </div>

        <!-- Onboarding — distilled -->
        <div class="ve-onboarding" id="ve-onboarding">
          <div class="ve-onboarding-icon"><i class="bi bi-lightbulb"></i></div>
          <div style="flex:1; min-width:0;">
            <h4>Pick a folder → upload → Generate</h4>
            <p>Queue runs in the background even if you switch tabs.</p>
          </div>
          <button class="ve-onboarding-dismiss" id="ve-onboarding-dismiss" title="Dismiss"><i class="bi bi-x-lg" style="font-size:10px;"></i></button>
        </div>

        <nav class="ve-steps" role="tablist" aria-label="Workflow steps">
          <button class="ve-step active" data-tab="library" type="button" role="tab" aria-selected="true"><span class="ve-step-top"><span class="ve-step-num">1</span> Step 01</span><strong>Library</strong><span>Pick & upload images</span><span class="ve-step-dot"></span></button>
          <button class="ve-step" data-tab="queue" type="button" role="tab" aria-selected="false"><span class="ve-step-top"><span class="ve-step-num">2</span> Step 02</span><strong>Generate</strong><span>Image → Video</span><span class="ve-step-dot"></span></button>
          <button class="ve-step" data-tab="downloads" type="button" role="tab" aria-selected="false"><span class="ve-step-top"><span class="ve-step-num">3</span> Step 03</span><strong>Collect</strong><span>Download videos</span><span class="ve-step-dot"></span></button>
          <button class="ve-step" data-tab="timeline" type="button" role="tab" aria-selected="false"><span class="ve-step-top"><span class="ve-step-num">4</span> Step 04</span><strong>Stitch</strong><span>Timeline export</span><span class="ve-step-dot"></span></button>
          <button class="ve-step ve-step--log" data-tab="activity" type="button" role="tab" aria-selected="false" title="Event log"><i class="bi bi-activity"></i><span>Log</span></button>
        </nav>

        <!-- LIBRARY -->
        <div class="ve-tab-panel active" data-panel="library">
          <!-- Session creator — primary -->
          <div class="ve-section" id="ve-session-section">
            <div class="ve-section-title"><span><i class="bi bi-lightning-charge"></i> New session</span><span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">auto-named · no duplicates</span></div>
            <p class="ve-section-help">Name it once — we mint the folder with a date-stamped unique suffix so it never collides.</p>
            <div class="ve-row" style="align-items:flex-end;">
              <div style="flex:1; min-width:0;">
                <label class="ve-field-label" for="ve-session-name-input">Session name</label>
                <input class="ve-input" id="ve-session-name-input" placeholder="Session name" aria-label="Session name" autocomplete="off" />
              </div>
              <div style="flex:0 0 auto; display:flex; align-items:flex-end;">
                <button class="ve-button primary" id="ve-create-session-btn" type="button"><i class="bi bi-plus-lg"></i> Create session</button>
              </div>
            </div>
            <div class="ve-muted" id="ve-session-preview" style="margin-top:8px; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:6px; padding:7px 9px; font-family:'JetBrains Mono',monospace; font-size:10.5px; line-height:1.4;">Will create: <strong id="ve-session-preview-name" style="color:var(--cut-orange); font-weight:700;">—</strong> <span style="color:#6B7280;">· preview updates as you type</span></div>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:6px; padding:8px 9px; margin-top:8px; font-family:'Instrument Sans',sans-serif; font-size:11.5px; color:#111827;">
              <input class="ve-checkbox" id="ve-auto-expire-toggle" type="checkbox" />
              <span><b>Auto-delete after 30 days</b> <span style="color:#6B7280; font-weight:400;">— only for sessions you create here</span></span>
            </label>
            <p class="ve-field-hint" id="ve-session-hint" style="margin-top:6px;">Creates instantly, selects it, and queues it for expiry. Manage folders below.</p>
          </div>

          <!-- Library folders — accordion -->
          <div class="ve-section" id="ve-folder-browser-section">
            <div class="ve-section-title"><span><i class="bi bi-collection"></i> Library folders</span>
              <button class="ve-button ghost ve-icon-button" id="ve-refresh-btn" title="Refresh folders"><i class="bi bi-arrow-clockwise"></i></button>
            </div>
            <button class="ve-advanced-toggle" type="button" aria-expanded="false" id="ve-folder-browser-toggle"><span><i class="bi bi-folder2"></i> Browse & manage folders <span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px; text-transform:none; letter-spacing:0; margin-left:6px;"><span id="ve-folder-count">5</span> in Library 4</span></span><i class="bi bi-chevron-down"></i></button>
            <div class="ve-collapsible collapsed" id="ve-folder-browser">
              <div style="padding-top:10px">
                <p class="ve-section-help" style="margin-bottom:8px;">Click a card to switch active folder. Sessions are marked <span style="font-family:'JetBrains Mono',monospace; font-size:9px; background:#F3F0FF; border:1px solid #E6E8EF; padding:1px 4px; border-radius:4px; color:var(--cut-orange);">SESSION</span></p>
                <!-- hidden legacy selects kept for JS compatibility; visually hidden but present -->
                <div class="ve-hidden">
                  <select class="ve-select" id="ve-folder-select"></select>
                  <select class="ve-select" id="ve-upload-folder-select"></select>
                  <select class="ve-select" id="ve-download-folder-select"></select>
                  <select class="ve-select" id="ve-timeline-folder-select"></select>
                </div>
                <div class="ve-folder-grid" id="ve-folder-grid"></div>
                <div class="ve-row" style="margin-top:10px">
                  <div style="flex:1; min-width:0;">
                    <label class="ve-field-label" for="ve-new-folder-input">Manual folder name <span style="font-weight:400; text-transform:none; letter-spacing:0; color:#6B7280;">— advanced</span></label>
                    <input class="ve-input" id="ve-new-folder-input" placeholder="e.g. product-shots-04" aria-label="New folder name" />
                  </div>
                  <div style="flex:0 0 auto; display:flex; align-items:flex-end; gap:6px;">
                    <button class="ve-button ghost" id="ve-show-create-folder-btn" type="button" style="display:none;">focus</button>
                    <button class="ve-button ghost" id="ve-create-folder-btn"><i class="bi bi-plus-lg"></i> Create folder</button>
                  </div>
                </div>
                <div class="ve-row">
                  <button class="ve-button danger" id="ve-delete-folder-btn" title="Delete the selected library folder — references only, not source files"><i class="bi bi-trash3"></i> Delete selected folder</button>
                </div>
              </div>
            </div>
          </div>

          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-cloud-arrow-up"></i> Add images <span id="ve-upload-folder-name" style="color:var(--cut-orange); font-family:'Instrument Sans',sans-serif; text-transform:none; letter-spacing:0; font-size:11px; font-weight:600;">→ product-shots-04</span></span><span class="ve-muted" id="ve-upload-count" style="font-family:'JetBrains Mono',monospace; font-size:10px;">0 selected</span></div>
            <div class="ve-file-drop" id="ve-file-drop">
              <i class="bi bi-images"></i>
              <p><b>Drop images</b> or choose files</p>
              <p class="ve-muted" style="font-size:11px; margin-top:2px;">PNG · JPG · WEBP — multiple</p>
            </div>
            <div class="ve-file-picker">
              <button class="ve-button ghost" id="ve-pick-files-btn" type="button"><i class="bi bi-images"></i> Choose images</button>
              <button class="ve-button ghost" id="ve-pick-folder-btn" type="button"><i class="bi bi-folder2-open"></i> Choose folder</button>
            </div>
            <input class="ve-file-input" id="ve-file-input" type="file" accept="image/*" multiple />
            <input class="ve-file-input" id="ve-folder-input" type="file" accept="image/*" multiple webkitdirectory directory />
            <div class="ve-upload-summary is-idle" id="ve-upload-summary" role="status" aria-live="polite"><i class="bi bi-inbox ve-summary-icon"></i><div class="ve-summary-main"><div class="ve-summary-title">No images chosen</div><div class="ve-summary-detail">pick files or a folder above.</div></div></div>
            <div class="ve-row" style="margin-top:8px">
              <button class="ve-button success" id="ve-upload-btn"><i class="bi bi-upload"></i> Upload to library</button>
              <button class="ve-button ghost" id="ve-clear-files-btn" type="button"><i class="bi bi-x-lg"></i> Clear</button>
              <button class="ve-button ghost" id="ve-show-upload-btn" type="button" style="display:none;">legacy</button>
            </div>
          </div>
        </div>

        <!-- GENERATE -->
        <div class="ve-tab-panel" data-panel="queue">
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-camera-video"></i> Generate</span><span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">sequential · auto-retry at 5 max</span></div>
            <p class="ve-section-help">Default 10s video. Queue runs 1 by 1; parallel limit retries automatically.</p>
            <div class="ve-row">
              <div>
                <label class="ve-field-label">Video length (seconds)</label>
                <input class="ve-input" id="ve-video-length" type="number" min="1" max="60" value="10" aria-label="Video length (seconds, 1–60)" title="Video length in seconds" />
              </div>
              <div>
                <label class="ve-field-label">Aspect</label>
                <select class="ve-select" id="ve-aspect" aria-label="Aspect ratio" title="Aspect ratio">
                  <option value="16:9" selected>16:9 — landscape</option>
                  <option value="9:16">9:16 — portrait</option>
                  <option value="1:1">1:1 — square</option>
                </select>
              </div>
            </div>
            <button class="ve-advanced-toggle" type="button" aria-expanded="false" id="ve-advanced-timings-toggle"><span><i class="bi bi-sliders"></i> Advanced timings</span><i class="bi bi-chevron-down"></i></button>
            <div class="ve-collapsible collapsed" id="ve-advanced-timings">
              <div style="padding-top:8px">
                <div class="ve-row">
                  <div>
                    <label class="ve-field-label">Delay between requests (ms)</label>
                    <input class="ve-input" id="ve-delay-input" type="number" min="0" step="100" value="1500" aria-label="Delay between requests (ms)" />
                  </div>
                  <div>
                    <label class="ve-field-label">Retry delay on parallel limit (ms)</label>
                    <input class="ve-input" id="ve-retry-delay-input" type="number" min="1000" step="1000" value="60000" aria-label="Retry delay on parallel limit (ms)" />
                  </div>
                </div>
                <p class="ve-field-hint">Defaults are safe for VideoExpress. Increase retry delay if you hit repeated parallel-limit loops.</p>
              </div>
            </div>
          </div>

          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-type"></i> Prompts</span><span class="ve-muted" style="font-size:10px; font-family:'JetBrains Mono',monospace;">Filenames → cleaned prompts</span></div>
            <label class="ve-muted" style="display:flex;align-items:center;gap:8px;cursor:pointer; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:1px; padding:8px 9px;">
              <input class="ve-checkbox" id="ve-master-prompt-enabled" type="checkbox" />
              <span><b style="color:#0A0A0D;">Use a master prompt</b> for every image <span style="opacity:.7">— {{image}} is replaced by the image name</span></span>
            </label>
            <div class="ve-hidden" id="ve-filename-prompt-row" style="margin-top:6px; background:#FFF8EE; border:1px dashed #E0D8CC; padding:7px 9px; border-radius:1px;">
              <label class="ve-muted" style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input class="ve-checkbox" id="ve-append-filename-prompt" type="checkbox" />
                Also include each image's individual cleaned prompt
              </label>
            </div>
            <div style="margin-top:8px">
              <label class="ve-field-label">Master prompt</label>
              <textarea class="ve-textarea" id="ve-master-prompt" placeholder="e.g. cinematic product shot, soft studio light — use {{image}} where image name should appear" aria-label="Master prompt"></textarea>
              <p class="ve-field-hint">With master prompt <b>off</b>, each image uses its filename as prompt (underscores/dashes cleaned).</p>
            </div>
            <label class="ve-muted" style="display:flex;align-items:center;gap:8px;cursor:pointer; margin-top:10px; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:1px; padding:8px 9px;">
              <input class="ve-checkbox" id="ve-prompt-list-enabled" type="checkbox" />
              <span><b style="color:#0A0A0D;">Use prompt list</b> — one line per image, sorted by name</span>
            </label>
            <div class="ve-hidden" id="ve-prompt-list-row" style="margin-top:8px">
              <label class="ve-field-label">Prompt list (line 1 → first sorted image)</label>
              <textarea class="ve-textarea" id="ve-prompt-list" placeholder="One prompt per line — line 1 → first sorted image, line 2 → second, …" aria-label="Prompt list" style="min-height:84px;"></textarea>
              <div class="ve-muted" id="ve-prompt-list-summary" style="margin-top:6px; background:#F7F3EC; border:1px solid #E0D8CC; padding:6px 8px; border-radius:1px; font-family:'JetBrains Mono',monospace; font-size:10px;">Off — turn on “Use prompt list” to map one prompt per sorted image.</div>
            </div>
            <div class="ve-muted ve-hidden" id="ve-prompt-list-summary-legacy" style="display:none;"></div>
          </div>

          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-play-circle"></i> Queue</span>
              <button class="ve-button ghost ve-icon-button" id="ve-reset-history-btn" type="button" title="Clear saved queue history"><i class="bi bi-eraser"></i></button>
            </div>
            <div class="ve-status-line" id="ve-status-line"><span><strong id="ve-stat-images">0</strong> images</span><span class="dot running"></span><span><strong id="ve-stat-running">0</strong> running</span><span class="dot done"></span><span><strong id="ve-stat-done">0</strong> done</span><span class="dot fail"></span><span><strong id="ve-stat-failed">0</strong> need retry</span><span style="opacity:.4">·</span><span><strong id="ve-stat-queued">0</strong> ready</span></div>
            <div class="ve-row" style="margin-top:10px">
              <button class="ve-button ghost" id="ve-load-media-btn"><i class="bi bi-list-check"></i> Load images from folder</button>
              <button class="ve-button success" id="ve-run-btn"><i class="bi bi-play-fill"></i> Start generating</button>
              <button class="ve-button warn" id="ve-stop-btn"><i class="bi bi-stop-fill"></i> Pause</button>
            </div>
            <p class="ve-field-hint" id="ve-folder-summary" style="margin:6px 0 0;">Choose a folder, then “Load images from folder” to build the queue.</p>
          </div>

          <div class="ve-section" id="ve-queue-download-section">
            <div class="ve-section-title"><span><i class="bi bi-download"></i> Completed</span></div>
            <div class="ve-muted" id="ve-queue-download-summary" style="background:#F9FAFB; border:1px solid #E6E8EF; padding:7px 9px; border-radius:6px; margin-bottom:8px; font-size:11px;">No completed videos yet.</div>
            <div class="ve-progress" title="Download progress"><div class="ve-progress-bar" id="ve-queue-download-progress"></div></div>
            <div class="ve-row" style="margin-top:10px">
              <button class="ve-button primary" id="ve-download-completed-btn" type="button"><i class="bi bi-download"></i> Download completed</button>
              <button class="ve-button ghost small" id="ve-retry-all-failed-btn" type="button" title="Retry every failed item"><i class="bi bi-arrow-clockwise"></i> Retry failed</button>
            </div>
            <button class="ve-button ghost small ve-hidden" id="ve-download-remaining-btn" type="button" style="display:none;">Remaining only</button>
            <p class="ve-field-hint" id="ve-retry-all-summary"></p>
          </div>

          <div class="ve-section">
            <div class="ve-section-title">
              <span><i class="bi bi-table"></i> Queue preview</span>
              <span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">up to 150 shown</span>
            </div>
            <div style="max-height:360px; overflow:auto; border:1px solid #E0D8CC; border-radius:1px;">
              <table class="ve-table">
                <thead>
                  <tr>
                    <th style="width: 26%">Image</th>
                    <th style="width: 36%">Prompt</th>
                    <th style="width: 14%">Status</th>
                    <th style="width: 14%">Updated</th>
                    <th style="width: 10%">Action</th>
                  </tr>
                </thead>
                <tbody id="ve-queue-body"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- DOWNLOADS -->
        <div class="ve-tab-panel" data-panel="downloads">
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-download"></i> Collect</span><span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">select · download</span></div>
            <p class="ve-section-help">Load videos from the active folder, select, then download.</p>
            <div class="ve-row">
              <button class="ve-button primary" id="ve-load-videos-btn" type="button"><i class="bi bi-collection-play"></i> Load videos in folder</button>
              <button class="ve-button ghost" id="ve-select-all-videos-btn" type="button"><i class="bi bi-check2-square"></i> Select visible</button>
            </div>
            <div style="margin:10px 0; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:1px; padding:9px;">
              <div class="ve-field-label" style="margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;">Search & filters <span class="ve-muted" style="font-weight:400; text-transform:none; letter-spacing:0; font-size:10.5px;" id="ve-filter-count">—</span></div>
              <input class="ve-input" id="ve-video-filter-query" type="search" placeholder="Search by name or ID" aria-label="Search videos" />
              <button class="ve-advanced-toggle" type="button" aria-expanded="false" id="ve-download-filters-toggle" style="margin-top:8px;"><span><i class="bi bi-funnel"></i> Advanced filters</span><i class="bi bi-chevron-down"></i></button>
              <div class="ve-collapsible collapsed" id="ve-download-filters">
                <div style="padding-top:8px">
                  <div class="ve-row">
                    <div><label class="ve-field-label">Created from</label><input class="ve-input" id="ve-video-filter-date-from" type="date" title="Created from" /></div>
                    <div><label class="ve-field-label">Created to</label><input class="ve-input" id="ve-video-filter-date-to" type="date" title="Created to" /></div>
                  </div>
                  <div class="ve-row">
                    <div><label class="ve-field-label">Min size (MB)</label><input class="ve-input" id="ve-video-filter-min-size" type="number" min="0" step="1" placeholder="Min MB" /></div>
                    <div><label class="ve-field-label">Max size (MB)</label><input class="ve-input" id="ve-video-filter-max-size" type="number" min="0" step="1" placeholder="Max MB" /></div>
                  </div>
                  <div class="ve-row" style="margin-top:6px">
                    <button class="ve-button ghost small" id="ve-clear-video-filters-btn" type="button"><i class="bi bi-x-lg"></i> Clear filters</button>
                  </div>
                  <div class="ve-row" style="margin-top:8px">
                    <div><label class="ve-field-label">Min delay (ms)</label><input class="ve-input" id="ve-download-min-delay" type="number" min="0" step="100" value="800" title="Min delay between downloads (ms)" /></div>
                    <div><label class="ve-field-label">Max delay (ms)</label><input class="ve-input" id="ve-download-max-delay" type="number" min="0" step="100" value="1200" title="Max delay between downloads (ms)" /></div>
                    <div><label class="ve-field-label">Parallel (1-5)</label><input class="ve-input" id="ve-download-concurrency" type="number" min="1" max="5" step="1" value="3" title="Parallel downloads (1-5)" /></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="ve-download-controls">
              <button class="ve-button success" id="ve-download-selected-btn" type="button"><i class="bi bi-download"></i> Download selected</button>
              <button class="ve-button primary" id="ve-download-all-btn" type="button"><i class="bi bi-download"></i> Download visible</button>
              <button class="ve-button warn" id="ve-stop-downloads-btn" type="button"><i class="bi bi-stop-fill"></i> Pause</button>
            </div>
            <div class="ve-progress" title="Download queue progress" style="margin-top:10px"><div class="ve-progress-bar" id="ve-download-progress"></div></div>
            <div class="ve-muted" id="ve-download-summary" style="margin-top:8px; background:#fff; border:1px solid #E0D8CC; padding:7px 9px; border-radius:1px;">Choose a folder and “Load videos in folder” to browse.</div>
          </div>
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-film"></i> Videos</span><label style="display:flex; align-items:center; gap:6px; font-family:'Instrument Sans',sans-serif; font-size:11.5px; font-weight:600; cursor:pointer;"><input class="ve-checkbox" id="ve-video-master-checkbox" type="checkbox" /> Select visible</label></div>
            <div style="max-height:380px; overflow:auto; border:1px solid #E0D8CC; border-radius:1px;">
              <table class="ve-table">
                <thead>
                  <tr>
                    <th class="ve-check-cell"><span style="font-size:9px">✓</span></th>
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
        </div>

        <!-- TIMELINE -->
        <div class="ve-tab-panel" data-panel="timeline">
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-view-list"></i> Stitch</span><span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">optional · numeric order</span></div>
            <p class="ve-section-help">Combine clips in numeric name order into one export.</p>
            <div class="ve-row">
              <button class="ve-button ghost" id="ve-timeline-load-btn" type="button"><i class="bi bi-collection-play"></i> Load videos in folder</button>
              <button class="ve-button ghost" id="ve-timeline-add-completed-btn" type="button"><i class="bi bi-plus-circle"></i> Add completed to timeline</button>
              <button class="ve-button ghost" id="ve-timeline-clear-btn" type="button"><i class="bi bi-x-lg"></i> Clear</button>
            </div>
            <div class="ve-muted" id="ve-timeline-completed-summary" style="margin:6px 0 10px; background:#fff; border:1px solid #E0D8CC; padding:7px 9px; border-radius:1px;"></div>
            <div class="ve-row">
              <div style="flex:1.4">
                <label class="ve-field-label">Timeline name</label>
                <input class="ve-input" id="ve-timeline-name" placeholder="Timeline name — e.g. timeline_2026" aria-label="Timeline project name" value="timeline_2026-08-16" />
              </div>
              <div>
                <label class="ve-field-label">Aspect</label>
                <select class="ve-select" id="ve-timeline-aspect">
                  <option value="16:9" selected>16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option>
                </select>
              </div>
              <div>
                <label class="ve-field-label">Quality</label>
                <select class="ve-select" id="ve-timeline-quality">
                  <option value="high" selected>high</option><option value="medium">medium</option><option value="low">low</option>
                </select>
              </div>
            </div>
            <div class="ve-row">
              <button class="ve-button primary" id="ve-timeline-export-btn" type="button"><i class="bi bi-play-fill"></i> Stitch & export timeline</button>
              <button class="ve-button warn" id="ve-timeline-stop-btn" type="button"><i class="bi bi-stop-fill"></i> Cancel</button>
            </div>
            <div class="ve-progress" title="Timeline export progress"><div class="ve-progress-bar" id="ve-timeline-progress"></div></div>
            <div class="ve-muted" id="ve-timeline-status" style="margin-top:8px; background:#0A0A0D; color:#F5F1EB; border:1px solid #000; padding:8px 9px; border-radius:1px;">Idle — load videos, then export.</div>
            <div class="ve-row" style="margin-top:10px">
              <button class="ve-button success ve-hidden" id="ve-timeline-download-btn" type="button"><i class="bi bi-download"></i> Download Result</button>
              <span class="ve-muted" id="ve-timeline-result-info"></span>
            </div>
          </div>
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-table"></i> Videos to stitch (<span id="ve-timeline-count">0</span>)</span><span class="ve-muted" style="font-size:10px; font-family:'JetBrains Mono',monospace;" id="ve-timeline-list-summary">No videos — load a folder to stitch.</span></div>
            <div style="max-height:320px; overflow:auto; border:1px solid #E0D8CC; border-radius:1px;">
              <table class="ve-table"><thead><tr><th style="width:10%">#</th><th>Video</th><th style="width:18%">Duration</th></tr></thead><tbody id="ve-timeline-body"></tbody></table>
            </div>
          </div>
        </div>

        <!-- ACTIVITY -->
        <div class="ve-tab-panel" data-panel="activity">
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-terminal"></i> Event log</span><span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">live · stays on page</span></div>
            <p class="ve-section-help">Polling, retries, and download progress appear here. Helpful when queue seems stuck on “5 in progress”.</p>
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
    themeSelect: root.querySelector("#ve-theme-select"),
    tabs: Array.from(root.querySelectorAll(".ve-step,.ve-tab")),
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
    timelineAddCompletedBtn: root.querySelector("#ve-timeline-add-completed-btn"),
    timelineClearBtn: root.querySelector("#ve-timeline-clear-btn"),
    timelineCompletedSummary: root.querySelector("#ve-timeline-completed-summary"),
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
    contextSelect: root.querySelector("#ve-context-select"),
    contextPill: root.querySelector("#ve-context-pill"),
    contextName: root.querySelector("#ve-context-name"),
    contextId: root.querySelector("#ve-context-id"),
    contextCount: root.querySelector("#ve-context-count"),
    contextDone: root.querySelector("#ve-context-done"),
    contextChangeBtn: root.querySelector("#ve-context-change-btn"),
    onboarding: root.querySelector("#ve-onboarding"),
    onboardingDismiss: root.querySelector("#ve-onboarding-dismiss"),
    fileDrop: root.querySelector("#ve-file-drop"),
    uploadFolderName: root.querySelector("#ve-upload-folder-name"),
    uploadCount: root.querySelector("#ve-upload-count"),
    advancedTimingsToggle: root.querySelector("#ve-advanced-timings-toggle"),
    advancedTimings: root.querySelector("#ve-advanced-timings"),
    downloadFiltersToggle: root.querySelector("#ve-download-filters-toggle"),
    downloadFilters: root.querySelector("#ve-download-filters"),
    statusLine: root.querySelector("#ve-status-line"),
    filterCount: root.querySelector("#ve-filter-count"),
    sessionNameInput: root.querySelector("#ve-session-name-input"),
    createSessionBtn: root.querySelector("#ve-create-session-btn"),
    sessionPreviewName: root.querySelector("#ve-session-preview-name"),
    sessionPreview: root.querySelector("#ve-session-preview"),
    autoExpireToggle: root.querySelector("#ve-auto-expire-toggle"),
    folderBrowserToggle: root.querySelector("#ve-folder-browser-toggle"),
    folderBrowser: root.querySelector("#ve-folder-browser"),
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

  function applyTheme(theme){
    const allowed = ["videoexpress","bench","teal","amber"];
    const next = allowed.includes(theme) ? theme : "videoexpress";
    if(next === "videoexpress") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    if(els.themeSelect) els.themeSelect.value = next;
    saveUiState({ theme: next });
    logLine(`Palette: ${next}`);
  }
  function setActiveTab(tab) {
    const domTab = tab === "folders" ? "library" : tab === "upload" ? "library" : tab;
    const persistTab = domTab;
    state.activeTab = persistTab;
    els.tabs.forEach((element) => {
      const t = element.dataset.tab;
      element.classList.toggle("active", t === persistTab || t === tab || (persistTab === "library" && (t === "folders" || t === "upload")));
    });
    els.tabPanels.forEach((element) => {
      const p = element.dataset.panel;
      element.classList.toggle("active", p === persistTab || p === tab || (persistTab === "library" && (p === "folders" || p === "upload")));
    });
    saveUiState({ activeTab: persistTab });
  }
  if(els.themeSelect){
    els.themeSelect.addEventListener("change", () => applyTheme(els.themeSelect.value));
  }
  if (els.advancedTimingsToggle && els.advancedTimings) {
    els.advancedTimingsToggle.addEventListener("click", () => {
      const exp = els.advancedTimingsToggle.getAttribute("aria-expanded") === "true";
      els.advancedTimingsToggle.setAttribute("aria-expanded", String(!exp));
      els.advancedTimings.classList.toggle("collapsed", exp);
      els.advancedTimings.classList.toggle("expanded", !exp);
    });
  }
  if (els.downloadFiltersToggle && els.downloadFilters) {
    els.downloadFiltersToggle.addEventListener("click", () => {
      const exp = els.downloadFiltersToggle.getAttribute("aria-expanded") === "true";
      els.downloadFiltersToggle.setAttribute("aria-expanded", String(!exp));
      els.downloadFilters.classList.toggle("collapsed", exp);
      els.downloadFilters.classList.toggle("expanded", !exp);
    });
  }
  if (els.folderBrowserToggle && els.folderBrowser) {
    els.folderBrowserToggle.addEventListener("click", () => {
      const exp = els.folderBrowserToggle.getAttribute("aria-expanded") === "true";
      els.folderBrowserToggle.setAttribute("aria-expanded", String(!exp));
      els.folderBrowser.classList.toggle("collapsed", exp);
      els.folderBrowser.classList.toggle("expanded", !exp);
      saveUiState({ folderBrowserOpen: !exp });
    });
  }
  if (els.sessionNameInput) {
    els.sessionNameInput.addEventListener("input", () => { updateSessionPreview(); updateButtonStates(); });
    els.sessionNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (els.createSessionBtn && !els.createSessionBtn.disabled) els.createSessionBtn.click(); }});
  }
  if (els.autoExpireToggle) {
    els.autoExpireToggle.addEventListener("change", () => {
      config.autoExpireSessions = Boolean(els.autoExpireToggle.checked);
      saveUiState({ autoExpireSessions: config.autoExpireSessions });
      logLine(config.autoExpireSessions ? "Auto-delete after 30 days: ON (only locally created sessions)" : "Auto-delete after 30 days: OFF");
    });
  }
  if (els.fileDrop) {
    els.fileDrop.addEventListener("click", () => els.fileInput && els.fileInput.click());
    els.fileDrop.addEventListener("dragover", (e) => { e.preventDefault(); els.fileDrop.style.borderColor = "#6F5CCF"; });
    els.fileDrop.addEventListener("dragleave", () => { els.fileDrop.style.borderColor = ""; });
    els.fileDrop.addEventListener("drop", (e) => {
      e.preventDefault(); els.fileDrop.style.borderColor = "";
      const files = Array.from(e.dataTransfer.files || []).filter(isImageFile);
      if (files.length) { setSelectedFiles(files); logLine(`Dropped ${files.length} image(s)`); }
    });
  }
  if (els.onboardingDismiss && els.onboarding) els.onboardingDismiss.addEventListener("click", () => { els.onboarding.classList.add("ve-hidden"); saveUiState({ onboardingDismissed: true }); });
  if (els.contextSelect) els.contextSelect.addEventListener("change", () => selectFolder(els.contextSelect.value));
  if (els.contextChangeBtn) els.contextChangeBtn.addEventListener("click", () => { setActiveTab("library"); const g=document.getElementById("ve-folder-grid"); if(g) g.scrollIntoView({behavior:"smooth", block:"center"}); });

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
    if (els.contextSelect) {
      els.contextSelect.innerHTML = options || `<option value="">No folders found</option>`;
      els.contextSelect.value = state.selectedFolderId || "";
    }
    const sel = getSelectedFolder();
    if (sel) {
      if (els.contextName) els.contextName.textContent = sel.title || sel.name;
      if (els.contextId) els.contextId.textContent = `#${sel.id}`;
      if (els.uploadFolderName) els.uploadFolderName.textContent = `\u2192 ${sel.title || sel.name}`;
    }
    if (els.folderCount) els.folderCount.textContent = String(state.folders.length);
    if (els.contextCount) els.contextCount.textContent = String(state.items.length);
    try {
      const counts = getQueueDownloadCounts();
      if (els.contextDone) els.contextDone.textContent = String(counts.completed || state.queue.filter((q) => normalizeStatus(q.status) === "completed").length);
    } catch {}

    els.folderGrid.innerHTML = state.folders.length
      ? state.folders
          .map((folder) => {
            const active =
              String(folder.id) === String(state.selectedFolderId)
                ? "active"
                : "";
            const sessionCls = isSessionFolder(folder) ? " is-session" : "";
            return `
              <button class="ve-folder-card ${active}${sessionCls}" data-folder-id="${folder.id}" type="button" title="${escapeHtml(folder.title || folder.name)}">
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
      : "No videos loaded — choose a folder and “Load videos in folder.”";
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


  function setUploadSummary(kind, title, detailHtml) {
    const el = els.uploadSummary;
    if (!el) return;
    el.className = "ve-upload-summary is-" + (kind || "idle");
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    const icons = { idle: "bi-inbox", selected: "bi-images", uploading: "bi-arrow-repeat", success: "bi-check-circle-fill", error: "bi-exclamation-triangle-fill" };
    const icon = icons[kind] || icons.idle;
    const titleHtml = title ? `<div class="ve-summary-title">${escapeHtml(title)}</div>` : "";
    const detail = detailHtml ? `<div class="ve-summary-detail">${detailHtml}</div>` : "";
    el.innerHTML = `<i class="bi ${icon} ve-summary-icon"></i><div class="ve-summary-main">${titleHtml}${detail}</div>`;
    // nudge into view when error
    if (kind === "error") {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
    }
  }

  function renderSelectedFiles() {
    const files = state.selectedFiles;
    if (!files.length) {
      setUploadSummary("idle", "No images chosen", "pick files or a folder above.");
      if (els.fileDrop) els.fileDrop.classList.remove("has-files");
      if (els.uploadCount) els.uploadCount.textContent = "0 selected";
      return;
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const sample = files
      .slice(0, 3)
      .map((file) => file.webkitRelativePath || file.name)
      .join(", ");
    const more = files.length > 3 ? `, +${files.length - 3} more` : "";
    const detail = `${escapeHtml(formatBytes(totalBytes))} &middot; ${escapeHtml(sample)}${more ? escapeHtml(more) : ""}`;
    setUploadSummary("selected", `${files.length} image${files.length === 1 ? "" : "s"} ready`, detail);
    if (els.fileDrop) els.fileDrop.classList.toggle("has-files", state.selectedFiles.length > 0);
    if (els.uploadCount) els.uploadCount.textContent = state.selectedFiles.length ? `${state.selectedFiles.length} selected` : "0 selected";
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

  function getTimelineFrameSize(aspect, size) {
    const a = aspect || config.timelineExportDefaults?.aspect || "16:9";
    const s = String(size || config.timelineExportDefaults?.size || "1080");
    if (a === "16:9") return s === "720" ? "1280x720" : "1920x1080";
    if (a === "9:16") return s === "720" ? "720x1280" : "1080x1920";
    return s === "720" ? "720x720" : "1080x1080";
  }
  function buildTimelineBricks(sortedVideos, trackId = "30", brickOptions = null) {
    const frameSize = getTimelineFrameSize(brickOptions?.aspect, brickOptions?.size);
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
        frameSize,
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
  if (typeof window !== "undefined") { window.__ve_test = { buildTimelineBricks, buildTimelinePayload, compareMediaName, getTimelineFrameSize }; }

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
    if (els.statusLine) {
      els.statusLine.innerHTML = `<span><strong>${state.items.length}</strong> images</span><span class="dot running"></span><span><strong>${runningCount}</strong> running</span><span class="dot done"></span><span><strong>${doneCount}</strong> done</span><span class="dot fail"></span><span><strong>${failedCount}</strong> need retry</span><span style="opacity:.4">\u00b7</span><span><strong>${queuedCount}</strong> ready</span>`;
    }
    if (els.retryAllSummary) {
      els.retryAllSummary.textContent = failedCount ? `${failedCount} failed — click Retry all failed or per-row Retry` : "";
    }

    const folder = getSelectedFolder();
    els.folderSummary.textContent = folder
      ? `${folder.title || folder.name} | ${state.items.length} images loaded | history updated ${formatDateTime(state.history.updatedAt) || "never"}`
      : "Choose a folder, then “Show images in folder” to build the queue.";

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
      : missing ? `No completed with videoId yet — ${missing} completed but videoId missing (see Activity log)` : "No completed videos in this folder yet. Generate some in Generate, then download here. Run queue and wait for completion.";
    els.queueDownloadProgress.style.width = counts.completed ? `${Math.round((counts.downloaded / counts.completed) * 100)}%` : "0%";
    updateButtonStates();
  }

  function renderTimelineExport() {
    if (!els.timelineProgress) return;
    els.timelineProgress.style.width = `${Math.max(0, Math.min(100, Number(state.timelineExport.percent || 0)))}%`;
    els.timelineStatus.textContent = state.timelineExport.statusText || (state.timelineExport.running ? `Exporting ${state.timelineExport.percent}%` : "Idle — choose a folder, load videos, then export.");
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
    if (els.timelineCompletedSummary) {
      const completedTotal = Object.values(state.history.records).filter((r)=> normalizeStatus(r && r.status)==="completed").length;
      const completedScoped = state.selectedFolderId ? Object.values(state.history.records).filter((r)=> normalizeStatus(r && r.status)==="completed" && String(r.folderId)===String(state.selectedFolderId)).length : completedTotal;
      const note = vids.length ? `${vids.length} on timeline` : "Timeline empty";
      if (completedTotal) {
        const scopeLabel = state.selectedFolderId ? ` — ${completedScoped} completed in this folder, ${completedTotal} total` : ` — ${completedTotal} completed total`;
        els.timelineCompletedSummary.textContent = `${note}${scopeLabel}. Click "Add Completed Generated" to add them.`;
      } else {
        els.timelineCompletedSummary.textContent = `${note}. No completed generated videos yet — run queue first.`;
      }
    }
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
    const id = String(video && (video.id || video.mediaId || video.videoId) || "").trim();
    const rawMedia = String(video && (video.mediaPath || video.videoUrl || video.path || video.fileName) || "").trim();
    // Normalize potential CDN / path candidates
    const isAbsoluteCdn = /^https?:\/\//i.test(rawMedia) && /cdn|videoexpress/i.test(rawMedia);
    const cdnUrl = isAbsoluteCdn ? rawMedia : "";
    // Candidates in priority: output (works for timeline/output), library (works for library media), then direct CDN blob
    const candidates = [];
    if (id) {
      candidates.push({ url: `/download/output/${id}`, label: `download/output/${id}`, useSession: true });
      candidates.push({ url: `/library/download/${id}`, label: `library/download/${id}`, useSession: true });
    }
    if (cdnUrl) candidates.push({ url: cdnUrl, label: `cdn ${cdnUrl.slice(0, 64)}`, useSession: false });
    // If rawMedia is a bare path like "69320/xxx.mp4", try to resolve via CDN guess (ny-b) — leave as last resort
    if (!cdnUrl && rawMedia && rawMedia.includes("/") && rawMedia.endsWith(".mp4")) {
      const guessed = `https://cdn-ny-b.videoexpress.ai/video/${rawMedia.split("/").pop()}`;
      candidates.push({ url: guessed, label: `cdn-guess ${guessed.slice(0,64)}`, useSession: false });
    }
    if (!candidates.length) throw new Error(`Download ${fileName} failed: no id or mediaPath on video object`);
    let lastErr = null;
    for (const cand of candidates) {
      try {
        let res;
        if (cand.useSession) {
          res = await sessionFetch(cand.url, { method: "GET" }, `Download ${fileName} via ${cand.label}`);
        } else {
          // Direct CDN — no auth headers, no credentials, follow redirects
          res = await fetch(cand.url, { method: "GET", credentials: "omit", mode: "cors" });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            const e = new Error(`Download ${fileName} via ${cand.label} failed: ${res.status} ${res.statusText}\n${txt.slice(0,300)}`);
            e.status = res.status; e.bodyText = txt; throw e;
          }
        }
        // Guard: server sometimes returns JSON {"error":"Media file not found."} with 200 or 400
        const ct = (res.headers && res.headers.get("content-type")) || "";
        if (ct.includes("application/json")) {
          const jtxt = await res.clone().text().catch(() => "");
          if (/\"error\"\s*:/i.test(jtxt)) throw new Error(`Download ${fileName} via ${cand.label} returned JSON error: ${jtxt.slice(0,400)}`);
        }
        const blob = await res.blob();
        // Tiny JSON error masquerading as blob
        if (blob.size < 2048) {
          try {
            const maybe = await blob.slice(0, 2048).text();
            if (/\"error\"\s*:/i.test(maybe)) throw new Error(`Download ${fileName} via ${cand.label} returned error JSON: ${maybe.slice(0,400)}`);
          } catch {}
          // if still tiny but not JSON, still allow — some videos could be tiny?
          if (blob.size < 100) throw new Error(`Download ${fileName} via ${cand.label} returned empty blob (${blob.size} bytes)`);
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName; a.rel = "noopener"; a.style.display = "none";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        logLine(`Downloaded ${fileName} via ${cand.label} (${(blob.size/1024/1024).toFixed(2)} MB)`);
        return;
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || e).split("\n")[0].slice(0,180);
        logLine(`Download attempt via ${cand.label} failed: ${msg}`);
        // 400/404 on library/download means try next candidate; continue loop
        continue;
      }
    }
    throw lastErr || new Error(`Download ${fileName} failed: all candidates exhausted`);
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
    state.timelineVideos = [];
    renderFolders();
    renderQueue();
    renderVideos();
    renderTimelineExport();
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

  async function loadTimelineVideos() {
    const folder = getSelectedFolder();
    if (!folder) throw new Error("Please select a folder first.");
    logLine(`Loading timeline videos for "${folder.title || folder.name}"...`);
    const payload = await api.getAllVideos(folder.id);
    const videos = (payload.results || []).filter(v => (v.type === "video" || v.extension === "mp4" || v.fileName?.endsWith?.(".mp4")) );
    videos.sort(compareMediaName);
    state.timelineVideos = videos;
    renderTimelineExport();
    updateButtonStates();
    logLine(`Timeline: ${videos.length} videos sorted by name (chronological).`);
  }

  async function addCompletedGeneratedToTimeline() {
    const completedRecs = Object.values(state.history.records).filter(
      (r) => r && normalizeStatus(r.status) === "completed"
    );
    if (!completedRecs.length) throw new Error("No completed generated videos found — run queue first and wait for status to become completed.");
    // Scope: if a folder is selected, prefer its completed items, but allow fallback to all when empty
    const selectedFolderId = state.selectedFolderId ? String(state.selectedFolderId) : "";
    let scoped = selectedFolderId
      ? completedRecs.filter((r) => String(r.folderId) === selectedFolderId)
      : completedRecs.slice();
    // If folder selected but no completed in that folder, offer all and log hint
    if (selectedFolderId && !scoped.length) {
      logLine(`No completed items in folder ${selectedFolderId} — showing completed from all folders (${completedRecs.length})`);
      scoped = completedRecs.slice();
    }
    logLine(`Adding ${scoped.length} completed generated video(s) to timeline${selectedFolderId ? ` (folder ${selectedFolderId})` : " (all folders)"}...`);

    // Resolve missing videoIds first (up to 20 at a time, then bulk)
    const missing = scoped.filter((r) => !r.videoId && r.uuid);
    if (missing.length) {
      logLine(`Resolving ${missing.length} missing videoId(s) before adding to timeline...`);
      try {
        const toResolve = missing.length > 20 ? missing.slice(0, 20) : missing;
        await resolveMissingVideoIdsViaStatus(toResolve);
        const still = toResolve.filter((r) => !r.videoId);
        if (still.length) {
          const uuids = still.map((r) => r.uuid);
          const aiMap = await fetchAiVideosMap(uuids, { skipStatusFallback: true });
          for (const rec of still) {
            const u = String(rec.uuid).toLowerCase().trim();
            if (aiMap.has(u)) {
              const m = aiMap.get(u);
              const vid = String(m.id || m.videoId || "");
              if (vid) { rec.videoId = vid; setRecord(rec.folderId, rec.imageId, { ...rec, videoId: vid, updatedAt: new Date().toISOString() }); }
            }
          }
        }
        const stillAfter = scoped.filter((r) => !r.videoId && r.uuid);
        if (stillAfter.length) logLine(`Still missing videoId for ${stillAfter.length} item(s) — they will be skipped`);
      } catch (e) {
        logLine(`Resolve error while preparing timeline add: ${e.message}`);
      }
    }

    const withId = scoped.filter((r) => r.videoId);
    if (!withId.length) throw new Error(`All ${scoped.length} completed items are missing videoId — try again in ~15s or check Activity log`);
    // Sort by queue position (chronological generation order), fallback to completedAt
    withId.sort((a, b) => {
      const posA = getQueuePositionForMedia(a.imageId);
      const posB = getQueuePositionForMedia(b.imageId);
      if (posA != null && posB != null) return posA - posB;
      if (posA != null) return -1;
      if (posB != null) return 1;
      const tA = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const tB = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return tA - tB;
    });

    // Fetch video metadata from AI library so bricks have path/thumb/duration
    let aiMapById = new Map();
    let aiMapByUuid = new Map();
    try {
      const fullMap = await fetchAiVideosMap();
      for (const v of fullMap.values()) {
        aiMapById.set(String(v.id), v);
        if (v.uuid) aiMapByUuid.set(String(v.uuid).toLowerCase().trim(), v);
      }
    } catch (e) {
      logLine(`AI library fetch failed, using history fallback: ${e.message}`);
    }

    const existingIds = new Set((state.timelineVideos || []).map((v) => String(v.id)));
    let added = 0;
    let skipped = 0;
    for (const rec of withId) {
      const vid = String(rec.videoId);
      if (existingIds.has(vid)) { skipped++; continue; }
      let video = aiMapById.get(vid) || (rec.uuid ? aiMapByUuid.get(String(rec.uuid).toLowerCase().trim()) : null);
      if (!video) {
        // Fallback synthetic entry — still stitchable if server accepts media_id only, but warn
        video = {
          id: vid,
          uuid: rec.uuid || "",
          name: rec.imageName || `video_${vid}`,
          fileName: rec.imageFileName || `${vid}.mp4`,
          duration: 5000,
          thumbUrl: "",
          path: "",
          videoUrl: "",
          imageUrl: "",
        };
        logLine(`Using synthetic metadata for ${rec.imageName || vid} (not found in AI library)`);
      }
      state.timelineVideos.push(video);
      existingIds.add(vid);
      added++;
    }
    // Keep stitch order chronological by name (numeric) + retain generation order for ties
    state.timelineVideos.sort(compareMediaName);
    renderTimelineExport();
    updateButtonStates();
    logLine(`Added ${added} completed video(s) to timeline${skipped ? ` (${skipped} already present)` : ""} — total ${state.timelineVideos.length}`);
  }

  function clearTimelineVideos() {
    const n = (state.timelineVideos || []).length;
    state.timelineVideos = [];
    renderTimelineExport();
    updateButtonStates();
    logLine(n ? `Cleared ${n} video(s) from timeline stitch list` : "Timeline already empty");
  }

  function isTimelinePollCompleted(progressRes) {
    const pct = Number(progressRes?.percent ?? 0);
    const qs = progressRes?.queue_status || {};
    return pct === 100 && Number(qs.in_progress || 0) === 0;
  }
  let _timelineProgressStarted = false;
  let _timelineStallCount = 0;
  let _timelineLastPercent = null;
  let _timelinePollInFlight = false;
  function startTimelineProgressPolling(projectName) {
    _timelineProgressStarted = false;
    _timelineStallCount = 0;
    _timelineLastPercent = null;
    _timelinePollInFlight = false;
    if (state.timelineExport.pollTimer) clearInterval(state.timelineExport.pollTimer);
    const intervalMs = Number(config.timelineExportDefaults.pollIntervalMs || 2000);
    state.timelineExport.pollTimer = setInterval(async () => {
      if (!state.timelineExport.running) { clearInterval(state.timelineExport.pollTimer); state.timelineExport.pollTimer = null; return; }
      if (_timelinePollInFlight) return;
      _timelinePollInFlight = true;
      try {
        const startFlag = !_timelineProgressStarted;
        const progress = await api.getProjectProgress(startFlag);
        _timelineProgressStarted = true;
        const pct = Number(progress.percent ?? 0);
        // retry guard: detect stalled percent >10 polls — log warning but continue (no infinite loop)
        if (_timelineLastPercent !== null && pct === _timelineLastPercent) {
          _timelineStallCount++;
        } else {
          _timelineStallCount = 0;
          _timelineLastPercent = pct;
        }
        if (_timelineStallCount > 10) {
          logLine(`Timeline progress stalled at ${pct}% for ${_timelineStallCount} polls — still polling (no infinite loop)`);
        }
        state.timelineExport.percent = pct;
        state.timelineExport.queueStatus = progress.queue_status || state.timelineExport.queueStatus;
        state.timelineExport.statusText = `Exporting "${projectName}" — ${pct}% (queue ${progress.queue_status?.in_progress ?? "?"} / ${progress.queue_status?.total ?? "?"})`;
        renderTimelineExport();
        logLine(`Timeline progress: ${pct}% queue ${JSON.stringify(progress.queue_status)}`);
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
      } finally {
        _timelinePollInFlight = false;
      }
    }, intervalMs);
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
    let tries = 0;
    const maxTries = 30;
    while (tries < maxTries && state.timelineExport.running) {
      tries++;
      try {
        const out = await api.getListOutput();
        const results = Array.isArray(out.results) ? out.results : [];
        let match = results.find(r => String(r.title) === String(projectName));
        if (!match && results.length) {
          const newest = results.slice().sort((a,b)=>{
            const da = new Date((a.datetime||"").replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2")).getTime();
            const db = new Date((b.datetime||"").replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2")).getTime();
            return db - da;
          })[0];
          if (newest) {
            const dtStr = String(newest.datetime || "");
            const parsed = new Date(dtStr.replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2")).getTime();
            const ageMs = Date.now() - parsed;
            const isRecent = Number.isFinite(parsed) && ageMs >= 0 && ageMs < 5 * 60 * 1000;
            if (isRecent) {
              logLine(`Warning: title "${projectName}" not found — falling back to newest result "${newest.title}" (${newest.datetime}, age ${Math.round(ageMs/1000)}s)`);
              match = newest;
            } else {
              logLine(`Warning: title "${projectName}" not found and newest result "${newest.title}" is not recent (${newest.datetime}) — not using fallback (requires <5 min)`);
            }
          }
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
    if (!state.timelineExport.running && state.timelineExport.lastError === "stopped") return null;
    if (tries < maxTries) return null;
    state.timelineExport.running = false;
    state.timelineExport.lastError = "Result not found after polling get_list_output";
    state.timelineExport.statusText = "Export finished but result not found — check My Videos";
    renderTimelineExport(); updateButtonStates();
    return null;
  }
  async function downloadTimelineResult() {
    const v = state.timelineExport.exportedVideo;
    if (!v || !v.mediaPath) throw new Error("No exported video ready to download.");
    const fileName = sanitizeFileName(v.title || v.filename || state.timelineExport.projectName || "timeline") + ".mp4";
    logLine(`Downloading timeline result: ${fileName}`);
    try {
      if (v.id) {
        await fetchAndDownloadWithRetry({ id: v.id, name: v.title || v.filename, fileName: v.filename }, fileName);
      } else {
        const res = await sessionFetch(v.mediaPath, { method: "GET" }, "Download timeline result");
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
      const options = {
        name: projectName,
        quality: config.timelineExportDefaults.quality,
        size: config.timelineExportDefaults.size,
        format: config.timelineExportDefaults.format,
        aspect: config.timelineExportDefaults.aspect,
      };
      const bricks = buildTimelineBricks(state.timelineVideos, "30", options);
      logLine(`Exporting timeline "${projectName}" — ${bricks.length} bricks, left total ${bricks.length ? (bricks[bricks.length-1].left + bricks[bricks.length-1].duration) : 0}ms frameSize=${bricks[0]?.frameSize || "n/a"}`);
      const res = await api.renderTimeline(bricks, options);
      if (!res || res.success === false) throw new Error(`Render failed: ${JSON.stringify(res).slice(0,300)}`);
      logLine(`Render queued: ${res.action || "pending"} queue_size=${res.queue_size ?? "?"}`);
      state.timelineExport.statusText = `Queued — polling progress for "${projectName}"...`;
      renderTimelineExport();
      if (typeof startTimelineProgressPolling === "function") startTimelineProgressPolling(projectName);
    } catch (e) {
      state.timelineExport.running = false;
      state.timelineExport.lastError = e.message || String(e);
      state.timelineExport.statusText = `Export failed: ${state.timelineExport.lastError}`;
      logLine(`Timeline export failed: ${state.timelineExport.lastError}`);
      renderTimelineExport(); updateButtonStates();
      throw e;
    }
  }
  // pollTimer lifecycle: cleared on running=false, on completed via startTimelineProgressPolling, and here; no bootstrap unload handler needed (panel lifetime = page lifetime)
  function stopTimelineExport() {
    if (state.timelineExport.pollTimer) { clearInterval(state.timelineExport.pollTimer); state.timelineExport.pollTimer = null; }
    state.timelineExport.running = false;
    state.timelineExport.statusText = "Export stopped by user.";
    state.timelineExport.lastError = "stopped";
    logLine("Timeline export stopped.");
    renderTimelineExport(); updateButtonStates();
  }
  if (typeof window !== "undefined") {
    window.__ve_test = Object.assign(window.__ve_test || {}, { loadTimelineVideos, addCompletedGeneratedToTimeline, clearTimelineVideos, exportTimeline, stopTimelineExport, startTimelineProgressPolling, isTimelinePollCompleted, checkTimelineResult, downloadTimelineResult });
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
    setUploadSummary("uploading", `Uploading ${files.length} files…`, `0 / ${files.length} &middot; ${escapeHtml(folder.title || folder.name)}`);

    for (const file of files) {
      try {
        await api.uploadFile(folder.id, file);
        successCount += 1;
        if (failedNames.length) {
          const chips = failedNames.map(n => `<span class="ve-fail-chip">${escapeHtml(n)}</span>`).join("");
          setUploadSummary("uploading", `Uploaded ${successCount} / ${files.length}`, `Success ${successCount} &middot; Failed ${failCount} ${chips}`);
        } else {
          setUploadSummary("uploading", `Uploaded ${successCount} / ${files.length}`, `Success ${successCount} &middot; ${escapeHtml(folder.title || folder.name)}`);
        }
      } catch (error) {
        failCount += 1;
        failedNames.push(file.name);
        logLine(`Upload failed for ${file.name}: ${error.message}`);
        const chips = failedNames.map(n => `<span class="ve-fail-chip">${escapeHtml(n)}</span>`).join("");
        setUploadSummary("uploading", `Uploaded ${successCount} / ${files.length}`, `Last fail: ${escapeHtml(file.name)} ${chips}`);
      }
    }

    state.uploadInProgress = false;
    updateButtonStates();
    els.fileInput.value = "";
    els.folderInput.value = "";
    state.selectedFiles = [];
    if (failCount > 0) {
      const chips = failedNames.map(n => `<span class="ve-fail-chip">${escapeHtml(n)}</span>`).join("");
      const detail = `Success: <strong>${successCount}</strong> &middot; Failed: <strong>${failCount}</strong><br>${chips}<br><span style="opacity:.78">Check Activity log for the full error. Retry the failed file(s) or pick a new set.</span>`;
      setUploadSummary("error", `Upload incomplete — ${failCount} failed`, detail);
    } else {
      const detail = `Success: <strong>${successCount}</strong> / ${files.length} &middot; Folder now has ${state.items.length || successCount} images`;
      setUploadSummary("success", "Upload complete", detail);
    }
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
      : "Off — turn on “Use prompt list” to map one prompt per sorted image (line 1 → first image).";
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
    const completedTotalForBtn = Object.values(state.history.records).filter((r)=> normalizeStatus(r && r.status)==="completed").length;
    if (els.timelineAddCompletedBtn) els.timelineAddCompletedBtn.disabled = state.timelineExport.running || state.downloadInProgress || completedTotalForBtn === 0;
    if (els.timelineClearBtn) els.timelineClearBtn.disabled = state.timelineExport.running || !hasVideos;
    els.masterPromptEnabled.disabled = state.running;
    els.promptListEnabled.disabled = state.running;
    if (els.createSessionBtn) {
      const raw = els.sessionNameInput ? els.sessionNameInput.value.trim() : "";
      els.createSessionBtn.disabled = state.running || state.uploadInProgress || state.downloadInProgress || !raw || raw.length < 2;
    }
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
    if (els.createSessionBtn) {
      els.createSessionBtn.addEventListener("click", () =>
        handleAction(async () => {
          const raw = els.sessionNameInput ? els.sessionNameInput.value : "";
          const result = await createSession(raw);
          if (result && els.sessionNameInput) {
            els.sessionNameInput.value = "";
            updateSessionPreview();
            updateButtonStates();
            logLine(`Session ready: "${result.folderName}" — upload images below`);
            // gentle focus to upload drop
            if (els.fileDrop) els.fileDrop.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }),
      );
    }
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
    if (els.timelineLoadBtn) els.timelineLoadBtn.addEventListener("click", () => handleAction(loadTimelineVideos));
    if (els.timelineAddCompletedBtn) els.timelineAddCompletedBtn.addEventListener("click", () => handleAction(addCompletedGeneratedToTimeline));
    if (els.timelineClearBtn) els.timelineClearBtn.addEventListener("click", () => { clearTimelineVideos(); });
    if (els.timelineExportBtn) els.timelineExportBtn.addEventListener("click", () => handleAction(exportTimeline));
    if (els.timelineStopBtn) els.timelineStopBtn.addEventListener("click", () => { stopTimelineExport(); });
    if (els.timelineDownloadBtn) els.timelineDownloadBtn.addEventListener("click", () => handleAction(downloadTimelineResult));
    if (els.timelineFolderSelect) els.timelineFolderSelect.addEventListener("change", () => { selectFolder(els.timelineFolderSelect.value); });
    [els.timelineName, els.timelineAspect, els.timelineQuality].forEach(el=>{ if(!el) return; el.addEventListener("change", updateTimelineExportConfigFromInputs); el.addEventListener("input", updateTimelineExportConfigFromInputs); });
  }

  async function bootstrap() {
    installAuthCapture();
    refreshAuthFromPage();
    window.addEventListener("focus", refreshAuthFromPage);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshAuthFromPage();
    });
    const savedUi = loadUiState();
    applyTheme(savedUi.theme || "videoexpress");
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
    if (typeof savedUi.autoExpireSessions === "boolean") config.autoExpireSessions = savedUi.autoExpireSessions;
    if (typeof savedUi.sessionExpiryDays === "number" && savedUi.sessionExpiryDays >= 1) config.sessionExpiryDays = Math.max(1, Math.min(90, Number(savedUi.sessionExpiryDays)));
    if (savedUi.onboardingDismissed && els.onboarding) els.onboarding.classList.add("ve-hidden");
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
    if (els.timelineName) els.timelineName.value = state.timelineExport.projectName || "";
    if (els.timelineAspect) els.timelineAspect.value = config.timelineExportDefaults.aspect;
    if (els.timelineQuality) els.timelineQuality.value = config.timelineExportDefaults.quality;
    renderTimelineExport();
    if (els.autoExpireToggle) els.autoExpireToggle.checked = Boolean(config.autoExpireSessions);
    if (els.folderBrowserToggle && els.folderBrowser) {
      const open = Boolean(savedUi.folderBrowserOpen);
      els.folderBrowserToggle.setAttribute("aria-expanded", String(open));
      els.folderBrowser.classList.toggle("collapsed", !open);
      els.folderBrowser.classList.toggle("expanded", open);
    }
    updateSessionPreview();

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
    updateSessionPreview();
    await pollStatuses();
    // auto-expiry: only locally created sessions, runs hourly + on visibility
    try { await checkExpiredSessions(); } catch (e) { console.warn("[VE] expiry check failed", e); }
    setInterval(() => {
      checkExpiredSessions().catch(e => console.warn("[VE] expiry check failed", e));
    }, 6 * 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkExpiredSessions().catch(()=>{}); });
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
