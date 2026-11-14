// ==UserScript==
// @name         VideoExpress Library Manager
// @namespace    https://app.videoexpress.ai/
// @version      0.9.9
// @description  Manage folders, upload images, batch generate images from prompts, and batch convert images to videos inside VideoExpress AI.
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
    // Generate step mode: "image2video" (prompts -> image -> video), "image" (prompts -> images),
    // "video" (the folder's existing images -> videos).
    mode: "image2video",
    imageType: "photorealistic",
    enhanceImagePrompt: true,
    enhanceVideoPrompt: true,
    // Characters: a list of { tag, description, mediaId }. A prompt line that contains @tag keeps
    // that character (site Consistent Character, max 2 per line). mediaId "" = the character is
    // created by the first line that uses its tag. defaultCharacterTag applies to untagged lines.
    characters: [],
    defaultCharacterTag: "",
    imageConcurrency: 3,
    imageTimeoutMs: 6 * 60 * 1000,
    renameOutputs: true,
    moveVideosToFolder: true,
    // Generate: put each new run in its own dated folder (2026-11-20-01, -02, ...) created when Start is pressed.
    autoSession: true,
    imagePrompts: "",
    videoPrompts: "",
  };

  const MAX_VIDEO_LENGTH = 10; // The server caps AI videos at 10 seconds.
  const MIN_VIDEO_LENGTH = 3;
  const GENERATOR_NAME = "create_from_prompt";
  const PREVIEW_BASE_URL = "https://user-assets.renderplatform.com/preview/";

  const HISTORY_KEY = "videoexpress.manager.history.v1";
  const UI_STATE_KEY = "videoexpress.manager.ui-state.v1";
  const SESSION_META_KEY = "videoexpress.manager.sessions.v1";
  const GEN_RUN_KEY = "videoexpress.manager.generator-run.v1";
  const IMAGE_DOWNLOAD_KEY = "videoexpress.manager.image-download.v1";
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
    queuePage: 0,
    queuePageSize: 150,
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
    gen: {
      run: loadGenRun(),
      running: false,
      stopRequested: false,
    },
    referenceImages: [],
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

  function loadGenRun() {
    try {
      const parsed = JSON.parse(localStorage.getItem(GEN_RUN_KEY) || "null");
      return parsed && Array.isArray(parsed.items) ? normalizeGenRun(parsed) : null;
    } catch {
      return null;
    }
  }

  function saveGenRun() {
    if (!state.gen.run) {
      localStorage.removeItem(GEN_RUN_KEY);
      return;
    }
    state.gen.run.updatedAt = new Date().toISOString();
    localStorage.setItem(GEN_RUN_KEY, JSON.stringify(state.gen.run));
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
  // Generate, "New dated folder per run": a run gets its own folder named YYYY-MM-DD-NN (local date,
  // NN = next free number that day). It is made only when Start is pressed, never on page load or
  // reload, so several batches on one day never share a folder and reloading creates nothing.
  let runSessionPromise = null;
  function nextRunSessionName(day) {
    const taken = new Set();
    let max = 0;
    for (const f of state.folders || []) {
      const name = String(f.title || f.name || "").trim();
      taken.add(name.toLowerCase());
      const m = name.match(/^(\d{4}-\d{2}-\d{2})-(\d+)$/);
      if (m && m[1] === day) max = Math.max(max, Number(m[2]));
    }
    let n = max + 1;
    let name = `${day}-${String(n).padStart(2, "0")}`;
    while (taken.has(name.toLowerCase())) {
      n += 1;
      name = `${day}-${String(n).padStart(2, "0")}`;
    }
    return name;
  }
  function ensureRunSession() {
    if (!runSessionPromise) {
      runSessionPromise = createRunSession().finally(() => { runSessionPromise = null; });
    }
    return runSessionPromise;
  }
  async function createRunSession() {
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; // local date
    await refreshFolders(); // other tabs or an earlier batch may have taken numbers
    let folderName = nextRunSessionName(day);
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await api.createFolder(folderName);
        lastErr = null;
        break;
      } catch (e) {
        if (!isDuplicateFolderError(e)) throw e;
        lastErr = e;
        await refreshFolders();
        folderName = nextRunSessionName(day);
      }
    }
    if (lastErr) throw lastErr;
    await refreshFolders();
    const created = state.folders.find((f) => String(f.title || f.name) === folderName);
    if (!created) throw new Error(`Created folder "${folderName}" but could not find it in the folder list.`);
    state.selectedFolderId = created.id;
    saveUiState({ selectedFolderId: created.id });
    renderFolders();
    try {
      const meta = loadSessions();
      const now = Date.now();
      meta.sessions[String(created.id)] = {
        folderId: String(created.id),
        folderName,
        baseName: day,
        kind: "run",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + Number(config.sessionExpiryDays || 30) * 24 * 60 * 60 * 1000).toISOString(),
        autoExpire: Boolean(config.autoExpireSessions),
      };
      saveSessions(meta);
    } catch (e) {
      console.warn("[VE] session meta save failed", e);
    }
    logLine(`New folder for this run: "${folderName}"${config.autoExpireSessions ? ` (auto-deletes after ${config.sessionExpiryDays} days)` : ""}`);
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
        enhanceVideoPrompt:
          options.enhanceVideoPrompt === undefined || options.enhanceVideoPrompt
            ? "1"
            : "0",
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

    // Rewrites a prompt with the site's enhancer. kind: "image" or "consistent_character".
    async extendPrompt(kind, prompt, options = {}) {
      const params = new URLSearchParams({
        prompt,
        imageType: options.type || "photorealistic",
      });
      if (kind === "consistent_character") {
        params.set("imageMediaId", String(options.mediaId || ""));
        params.set("imageMediaId2", String(options.mediaId2 || ""));
      }
      const result = await postFormJson(
        `/ai/api/extend_prompt/${kind}`,
        params.toString(),
        "Enhance prompt",
      );
      return result && result.prompt ? String(result.prompt) : prompt;
    },

    async generateImage(prompt, options = {}) {
      const params = new URLSearchParams({
        prompt,
        enhancePrompt: "0",
        type: options.type || "photorealistic",
        uuid: "",
        mediaId: "0",
        seed: "",
        aspect: options.aspect || config.aspect,
        generatorName: GENERATOR_NAME,
      });
      return postFormJson("/ai/api/generate_image", params.toString(), "Generate image");
    },

    // Keeps the character from the reference image(s): the site's "Use Consistent Character".
    async generateConsistentImage(prompt, options = {}) {
      const params = new URLSearchParams({
        prompt,
        type: options.type || "photorealistic",
        mediaId: String(options.mediaId || 0),
        mediaId2: String(options.mediaId2 || 0),
        aspect: options.aspect || config.aspect,
        generatorName: GENERATOR_NAME,
      });
      return postFormJson(
        "/ai/api/generate_image_consistent_character",
        params.toString(),
        "Generate consistent character image",
      );
    },

    // Saves a finished generated image to "My AI Images". Returns HTTP 400 "Image is empty." until ready.
    async saveGeneratedImage(uuid) {
      const params = new URLSearchParams({ uuid, isShared: "0", generatorName: GENERATOR_NAME });
      return postFormJson("/ai/api/save_generated_image", params.toString(), "Save image");
    },

    async renameItem(mediaId, name) {
      const params = new URLSearchParams({ name });
      return postFormJson(`/library/edit_item/${mediaId}`, params.toString(), "Rename item");
    },

    async moveItem(mediaId, categoryId) {
      const params = new URLSearchParams({ categoryId: String(categoryId) });
      return postFormJson(`/library/move_item/${mediaId}`, params.toString(), "Move item");
    },

    // Newest-first page of a folder (get_media sorted by id desc).
    async getRecentMedia(folderId, page = 1) {
      const params = new URLSearchParams({
        categoryId: String(folderId),
        page: String(page),
        start: String((page - 1) * config.pageSize),
        limit: String(config.pageSize),
        query: "",
        orderBy: "id",
        orderDir: "desc",
        filter: "",
      });
      return getJson(
        `/api/library/get_media/${config.libraryId}?${params.toString()}`,
        "Load recent media",
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
  /* Generate modes */
  .ve-mode-switch { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:0 0 10px; }
  .ve-mode-btn { display:flex; flex-direction:column; align-items:flex-start; gap:2px; background:#FFFFFF; color:#4B5162; border:1px solid #E6E8EF; border-radius:9px; padding:8px 10px; cursor:pointer; text-align:left; transition:all .14s ease; box-shadow:0 1px 2px rgba(17,24,39,0.04); }
  .ve-mode-btn i { color:#6B6760; font-size:14px; }
  .ve-mode-btn strong { font-family:'Barlow Condensed',sans-serif; font-size:11.5px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#111827; }
  .ve-mode-btn span { font-family:'Instrument Sans',sans-serif; font-size:10.5px; color:#6B7280; }
  .ve-mode-btn:hover:not(:disabled) { border-color:#DADDE3; background:#F9FAFB; }
  .ve-mode-btn.active { border-color:var(--cut-orange); box-shadow:0 0 0 3px rgba(111,92,207,0.12); }
  .ve-mode-btn.active i { color:var(--cut-orange); }
  .ve-mode-btn:disabled { opacity:.55; cursor:not-allowed; }
  .ve-prompt-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .ve-prompt-grid.single { grid-template-columns:1fr; }
  .ve-prompt-box { min-height:180px; white-space:pre; overflow-x:auto; }
  .ve-count { display:inline-block; min-width:18px; margin-left:4px; padding:0 5px; border-radius:999px; background:#F3F0FF; color:var(--cut-orange); text-align:center; letter-spacing:0; }
  #ve-prompt-check.is-warning { color:#B45309; font-weight:600; }
  .ve-options { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  .ve-check { display:flex; align-items:flex-start; gap:8px; cursor:pointer; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:6px; padding:7px 9px; font-family:'Instrument Sans',sans-serif; font-size:11.5px; color:#374151; }
  .ve-check b { color:#111827; font-weight:600; }
  .ve-check .ve-checkbox { flex:0 0 15px; margin-top:1px; }
  .ve-reference-preview { display:flex; gap:8px; }
  .ve-reference-preview .ve-thumb { width:96px; height:54px; flex-basis:96px; }
  .ve-char-row { display:grid; grid-template-columns: 54px 110px 1fr 1.3fr 30px; gap:6px; align-items:center; padding:6px; margin-bottom:6px; background:#F9FAFB; border:1px solid #E6E8EF; border-radius:6px; }
  .ve-char-row .ve-thumb { width:54px; height:32px; flex-basis:54px; }
  .ve-char-row .ve-input, .ve-char-row .ve-select { padding:6px 8px; font-size:11.5px; }
  .ve-char-tag { position:relative; }
  .ve-char-tag::before { content:'@'; position:absolute; left:8px; top:50%; transform:translateY(-50%); font-family:'JetBrains Mono',monospace; font-size:11.5px; color:var(--cut-orange); font-weight:700; }
  .ve-char-tag .ve-input { padding-left:20px; font-family:'JetBrains Mono',monospace; }
  .ve-char-count { font-family:'JetBrains Mono',monospace; font-size:9px; color:#6B7280; }
  .ve-tag-chip { display:inline-block; margin-right:4px; padding:0 5px; border-radius:999px; background:#F3F0FF; color:var(--cut-orange); font-family:'JetBrains Mono',monospace; font-size:9.5px; font-weight:700; }
  @media (max-width: 640px) { .ve-char-row { grid-template-columns: 1fr 1fr; } }
  .ve-cell-prompt { word-break:break-word; }
  .ve-cell-prompt .ve-muted { display:block; margin-top:3px; font-size:11px; }
  .ve-error-line { display:block; margin-top:4px; color:#B45309; font-size:10.5px; word-break:break-word; }
  .ve-use-character { margin-top:4px; padding:3px 6px; font-size:9.5px; }
  .ve-prompt-helper { display:flex; align-items:center; justify-content:space-between; gap:10px; margin:0 0 10px; padding:9px 11px; background:#F5F3FF; border:1px solid #DDD6FE; border-radius:8px; }
  .ve-prompt-helper-text { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .ve-prompt-helper-text strong { font-family:'Barlow Condensed',sans-serif; font-size:11.5px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#111827; }
  .ve-prompt-helper-text strong i { color:var(--cut-orange); margin-right:4px; }
  .ve-prompt-helper-text span { font-family:'Instrument Sans',sans-serif; font-size:11px; color:#4B5563; line-height:1.4; }
  .ve-prompt-helper .ve-button { flex:0 0 auto; }
  .ve-badge.pending, .ve-badge.stopped { background:#EDE8DF; color:#5A5752; }
  .ve-badge.generating, .ve-badge.saving, .ve-badge.submitting { background:var(--cut-orange); color:#fff; }
  .ve-badge.saved { background:#0EA768; color:#fff; }
  @media (max-width: 640px) {
    .ve-mode-switch, .ve-prompt-grid, .ve-options { grid-template-columns:1fr; }
  }
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
          <div class="ve-mode-switch" role="radiogroup" aria-label="Generate mode">
            <button class="ve-mode-btn" data-mode="image2video" type="button" role="radio" title="Each line: generate an image from the image prompt, then animate it with the video prompt"><i class="bi bi-film"></i><strong>Image → Video</strong><span>prompts to finished videos</span></button>
            <button class="ve-mode-btn" data-mode="image" type="button" role="radio" title="Each line becomes one image"><i class="bi bi-image"></i><strong>Image maker</strong><span>prompts to images</span></button>
            <button class="ve-mode-btn" data-mode="video" type="button" role="radio" title="Turn the images already in the folder into videos"><i class="bi bi-camera-video"></i><strong>Video maker</strong><span>folder images to videos</span></button>
          </div>
          <div class="ve-section">
            <div class="ve-section-title"><span><i class="bi bi-camera-video"></i> Generate</span><span class="ve-muted" id="ve-generate-subtitle" style="font-family:'JetBrains Mono',monospace; font-size:9px;">sequential · auto-retry at 5 max</span></div>
            <p class="ve-section-help" id="ve-generate-help">Default 10s video. Queue runs 1 by 1; parallel limit retries automatically.</p>
            <div class="ve-row">
              <div data-show-modes="image2video video">
                <label class="ve-field-label" for="ve-video-length">Video length</label>
                <select class="ve-select" id="ve-video-length" aria-label="Video length in seconds" title="Lengths offered by VideoExpress (3–10 s)">
                  <option value="3">3 seconds</option>
                  <option value="4">4 seconds</option>
                  <option value="5">5 seconds</option>
                  <option value="6">6 seconds</option>
                  <option value="7">7 seconds</option>
                  <option value="8">8 seconds</option>
                  <option value="9">9 seconds</option>
                  <option value="10" selected>10 seconds</option>
                </select>
              </div>
              <div>
                <label class="ve-field-label">Aspect</label>
                <select class="ve-select" id="ve-aspect" aria-label="Aspect ratio" title="Aspect ratio">
                  <option value="16:9" selected>16:9 — landscape</option>
                  <option value="9:16">9:16 — portrait</option>
                  <option value="1:1">1:1 — square</option>
                </select>
              </div>
              <div data-show-modes="image2video image">
                <label class="ve-field-label">Image type</label>
                <select class="ve-select" id="ve-image-type" aria-label="Image type">
                  <option value="photorealistic">Photorealistic (cinematic)</option>
                  <option value="human">Human</option>
                  <option value="2d">2D</option>
                  <option value="3d">3D</option>
                  <option value="other">Other</option>
                  <option value="creative">Creative mode</option>
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
                <div class="ve-row" data-show-modes="image2video image" style="margin-top:8px">
                  <div>
                    <label class="ve-field-label">Images at the same time (1–8)</label>
                    <input class="ve-input" id="ve-image-concurrency" type="number" min="1" max="8" step="1" value="3" aria-label="Images generated at the same time" />
                  </div>
                  <div></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Prompt helper: copies instructions for an AI agent, based on VideoExpress's own prompt guidance -->
          <div class="ve-prompt-helper" id="ve-prompt-helper">
            <div class="ve-prompt-helper-text">
              <strong><i class="bi bi-robot"></i> Prompt helper</strong>
              <span id="ve-prompt-helper-hint">Copies instructions you can paste into ChatGPT, Claude, etc. so it writes prompts the way VideoExpress wants them.</span>
            </div>
            <button class="ve-button primary small" id="ve-copy-prompt-guide-btn" type="button" title="Copy the prompt-writing instructions to the clipboard"><i class="bi bi-clipboard"></i> <span id="ve-copy-prompt-guide-label">Copy prompt guide</span></button>
          </div>

          <!-- PROMPTS → IMAGES / VIDEOS (Image → Video and Image maker modes) -->
          <div class="ve-section" data-show-modes="image2video image">
            <div class="ve-section-title"><span><i class="bi bi-card-text"></i> Prompts</span><span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">one per line · line N = output N</span></div>
            <div class="ve-prompt-grid" id="ve-prompt-grid">
              <div>
                <label class="ve-field-label" for="ve-image-prompts">Image prompts <span class="ve-count" id="ve-image-prompt-count">0</span></label>
                <textarea class="ve-textarea ve-prompt-box" id="ve-image-prompts" wrap="off" spellcheck="false" aria-label="Image prompts, one per line" placeholder="Line 1 → image 1&#10;Line 2 → image 2&#10;…"></textarea>
              </div>
              <div data-show-modes="image2video">
                <label class="ve-field-label" for="ve-video-prompts">Video prompts <span class="ve-count" id="ve-video-prompt-count">0</span></label>
                <textarea class="ve-textarea ve-prompt-box" id="ve-video-prompts" wrap="off" spellcheck="false" aria-label="Video prompts, one per line" placeholder="Line 1 animates image 1&#10;One line only → used for every image"></textarea>
              </div>
            </div>
            <p class="ve-field-hint" id="ve-prompt-check">Images are saved into the active folder.</p>
          </div>

          <div class="ve-section" data-show-modes="image2video image">
            <div class="ve-section-title"><span><i class="bi bi-person-bounding-box"></i> Characters</span><span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">tag lines with @name · max 2 per line</span></div>
            <p class="ve-section-help">Write <b>@name</b> in any prompt line where that character appears. Only tagged lines keep the character; other lines are generated normally. A character without a reference image is created by the first line that uses its tag.</p>
            <div id="ve-character-list"></div>
            <div class="ve-row" style="margin-top:8px; align-items:flex-end;">
              <div style="flex:0 0 auto;">
                <button class="ve-button ghost small" id="ve-add-character-btn" type="button"><i class="bi bi-person-plus"></i> Add character</button>
              </div>
              <div style="flex:1; min-width:0;">
                <label class="ve-field-label" for="ve-default-character">Lines without a tag</label>
                <select class="ve-select" id="ve-default-character" aria-label="Character for lines without a tag"></select>
              </div>
            </div>
            <div class="ve-row" style="align-items:flex-end;">
              <div style="flex:1; min-width:0;">
                <label class="ve-field-label" for="ve-reference-folder-select">Reference images from folder</label>
                <select class="ve-select" id="ve-reference-folder-select" aria-label="Reference folder"></select>
              </div>
              <div style="flex:0 0 auto;">
                <button class="ve-button ghost" id="ve-load-references-btn" type="button"><i class="bi bi-arrow-clockwise"></i> Load images</button>
              </div>
            </div>
            <p class="ve-field-hint" id="ve-character-help"></p>
          </div>

          <div class="ve-section" data-show-modes="image2video image">
            <div class="ve-section-title"><span><i class="bi bi-play-circle"></i> Run</span>
              <button class="ve-button ghost ve-icon-button" id="ve-gen-clear-btn" type="button" title="Clear this run from the list"><i class="bi bi-eraser"></i></button>
            </div>
            <div class="ve-options">
              <label class="ve-check"><input class="ve-checkbox" id="ve-enhance-image-prompt" type="checkbox" /> <span><b>Enhance image prompts</b> — the site's AI rewrites them</span></label>
              <label class="ve-check" data-show-modes="image2video"><input class="ve-checkbox" id="ve-enhance-video-prompt" type="checkbox" /> <span><b>Enhance video prompts</b></span></label>
              <label class="ve-check"><input class="ve-checkbox" id="ve-auto-session" type="checkbox" /> <span><b>New dated folder per run</b> - 2026-11-20-01, -02, ... made when you press Start</span></label>
              <label class="ve-check"><input class="ve-checkbox" id="ve-rename-outputs" type="checkbox" /> <span><b>Name in prompt order</b> — 001 - …</span></label>
              <label class="ve-check" data-show-modes="image2video"><input class="ve-checkbox" id="ve-move-videos" type="checkbox" /> <span><b>Put videos in the folder</b> — not only My AI Videos</span></label>
            </div>
            <div class="ve-status-line" id="ve-gen-status-line" style="margin-top:10px"><span><strong id="ve-gen-stat-total">0</strong> lines</span><span class="dot done"></span><span><strong id="ve-gen-stat-images">0</strong> images</span><span class="dot running" data-show-modes="image2video"></span><span data-show-modes="image2video"><strong id="ve-gen-stat-videos">0</strong> videos</span><span class="dot fail"></span><span><strong id="ve-gen-stat-failed">0</strong> failed</span></div>
            <div class="ve-row" style="margin-top:10px">
              <button class="ve-button success" id="ve-gen-start-btn" type="button"><i class="bi bi-play-fill"></i> Start</button>
              <button class="ve-button primary" id="ve-gen-resume-btn" type="button" title="Continue unfinished lines and retry failed ones"><i class="bi bi-arrow-repeat"></i> Resume</button>
              <button class="ve-button warn" id="ve-gen-stop-btn" type="button"><i class="bi bi-stop-fill"></i> Stop</button>
            </div>
            <p class="ve-field-hint" id="ve-gen-summary" style="margin:6px 0 0;">No run yet.</p>
          </div>

          <div class="ve-section" data-show-modes="image2video image">
            <div class="ve-section-title"><span><i class="bi bi-table"></i> Run progress</span></div>
            <div class="ve-row" style="margin-bottom:8px">
              <button class="ve-button primary small" id="ve-download-images-btn" type="button"><i class="bi bi-download"></i> Download all images</button>
              <button class="ve-button ghost small" id="ve-resume-images-btn" type="button"><i class="bi bi-arrow-repeat"></i> Resume download</button>
            </div>
            <div style="max-height:360px; overflow:auto; border:1px solid #E0D8CC; border-radius:1px;">
              <table class="ve-table">
                <thead>
                  <tr>
                    <th style="width: 7%">#</th>
                    <th style="width: 19%">Image</th>
                    <th style="width: 44%">Prompts</th>
                    <th style="width: 15%">Image</th>
                    <th style="width: 15%" data-show-modes="image2video">Video</th>
                  </tr>
                </thead>
                <tbody id="ve-gen-body"></tbody>
              </table>
            </div>
          </div>

          <div class="ve-section" data-show-modes="video">
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

          <div class="ve-section" data-show-modes="video">
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

          <div class="ve-section" id="ve-queue-download-section" data-show-modes="image2video video">
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

          <div class="ve-section" data-show-modes="video">
            <div class="ve-section-title">
              <span><i class="bi bi-table"></i> Queue preview</span>
              <span class="ve-muted" id="ve-queue-count" style="font-family:'JetBrains Mono',monospace; font-size:9px;">up to 150 shown</span>
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
            <div id="ve-queue-pager" style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:6px; font-family:'Instrument Sans',sans-serif; font-size:11px; color:#6B7280;">
              <span id="ve-queue-pager-info" style="font-family:'JetBrains Mono',monospace; font-size:10px;"></span>
              <span style="display:flex; gap:6px;">
                <button class="ve-button ghost small" id="ve-queue-prev" type="button" title="Previous page"><i class="bi bi-chevron-left"></i> Prev</button>
                <button class="ve-button ghost small" id="ve-queue-next" type="button" title="Next page">Next <i class="bi bi-chevron-right"></i></button>
              </span>
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
            <div class="ve-section-title"><span><i class="bi bi-view-list"></i> Stitch</span><span class="ve-muted" style="font-family:'JetBrains Mono',monospace; font-size:9px;">optional · generation order</span></div>
            <p class="ve-section-help">Combine clips in generation order (queue order) into one export.</p>
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
    queuePager: root.querySelector("#ve-queue-pager"),
    queuePagerInfo: root.querySelector("#ve-queue-pager-info"),
    queuePrev: root.querySelector("#ve-queue-prev"),
    queueNext: root.querySelector("#ve-queue-next"),
    modeButtons: Array.from(root.querySelectorAll(".ve-mode-btn")),
    modeScoped: Array.from(root.querySelectorAll("[data-show-modes]")),
    generateSubtitle: root.querySelector("#ve-generate-subtitle"),
    generateHelp: root.querySelector("#ve-generate-help"),
    imageType: root.querySelector("#ve-image-type"),
    imageConcurrency: root.querySelector("#ve-image-concurrency"),
    promptGrid: root.querySelector("#ve-prompt-grid"),
    imagePrompts: root.querySelector("#ve-image-prompts"),
    videoPrompts: root.querySelector("#ve-video-prompts"),
    imagePromptCount: root.querySelector("#ve-image-prompt-count"),
    videoPromptCount: root.querySelector("#ve-video-prompt-count"),
    promptCheck: root.querySelector("#ve-prompt-check"),
    characterList: root.querySelector("#ve-character-list"),
    characterHelp: root.querySelector("#ve-character-help"),
    addCharacterBtn: root.querySelector("#ve-add-character-btn"),
    defaultCharacter: root.querySelector("#ve-default-character"),
    referenceFolderSelect: root.querySelector("#ve-reference-folder-select"),
    loadReferencesBtn: root.querySelector("#ve-load-references-btn"),
    enhanceImagePrompt: root.querySelector("#ve-enhance-image-prompt"),
    enhanceVideoPrompt: root.querySelector("#ve-enhance-video-prompt"),
    autoSession: root.querySelector("#ve-auto-session"),
    renameOutputs: root.querySelector("#ve-rename-outputs"),
    moveVideos: root.querySelector("#ve-move-videos"),
    genStartBtn: root.querySelector("#ve-gen-start-btn"),
    genResumeBtn: root.querySelector("#ve-gen-resume-btn"),
    genStopBtn: root.querySelector("#ve-gen-stop-btn"),
    genClearBtn: root.querySelector("#ve-gen-clear-btn"),
    downloadImagesBtn: root.querySelector("#ve-download-images-btn"),
    resumeImagesBtn: root.querySelector("#ve-resume-images-btn"),
    genSummary: root.querySelector("#ve-gen-summary"),
    genBody: root.querySelector("#ve-gen-body"),
    genStatTotal: root.querySelector("#ve-gen-stat-total"),
    genStatImages: root.querySelector("#ve-gen-stat-images"),
    genStatVideos: root.querySelector("#ve-gen-stat-videos"),
    genStatFailed: root.querySelector("#ve-gen-stat-failed"),
    copyPromptGuideBtn: root.querySelector("#ve-copy-prompt-guide-btn"),
    copyPromptGuideLabel: root.querySelector("#ve-copy-prompt-guide-label"),
    promptHelperHint: root.querySelector("#ve-prompt-helper-hint"),
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
    if (els.referenceFolderSelect) {
      const referenceValue = els.referenceFolderSelect.value || state.selectedFolderId || "";
      els.referenceFolderSelect.innerHTML = options || `<option value="">No folders found</option>`;
      els.referenceFolderSelect.value = referenceValue;
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

  function getRecordForVideo(video) {
    if (!video) return null;
    const vid = String(video.id || video.mediaId || video.videoId || "").trim();
    const uuid = video.uuid ? String(video.uuid).toLowerCase().trim() : "";
    if (!vid && !uuid) return null;
    for (const rec of Object.values(state.history.records)) {
      if (!rec) continue;
      if (vid && String(rec.videoId) === vid) return rec;
      if (uuid && rec.uuid && String(rec.uuid).toLowerCase().trim() === uuid) return rec;
    }
    return null;
  }

  function sortTimelineVideosByGeneration(videos) {
    if (!Array.isArray(videos) || videos.length <= 1) return videos;
    const byVideoId = new Map();
    const byUuid = new Map();
    for (const rec of Object.values(state.history.records)) {
      if (!rec) continue;
      if (rec.videoId) byVideoId.set(String(rec.videoId), rec);
      if (rec.uuid) byUuid.set(String(rec.uuid).toLowerCase().trim(), rec);
    }
    const getRecFast = (video) => {
      if (!video) return null;
      const vid = video.id != null ? String(video.id) : "";
      if (vid && byVideoId.has(vid)) return byVideoId.get(vid);
      const uuid = video.uuid ? String(video.uuid).toLowerCase().trim() : "";
      if (uuid && byUuid.has(uuid)) return byUuid.get(uuid);
      return null;
    };
    videos.sort((a, b) => {
      const recA = getRecFast(a);
      const recB = getRecFast(b);
      const posA = recA ? getQueuePositionForMedia(recA.imageId) : null;
      const posB = recB ? getQueuePositionForMedia(recB.imageId) : null;
      if (posA != null && posB != null) return posA - posB;
      if (posA != null) return -1;
      if (posB != null) return 1;
      const tA = recA ? (recA.completedAt ? new Date(recA.completedAt).getTime() : (recA.updatedAt ? new Date(recA.updatedAt).getTime() : 0)) : 0;
      const tB = recB ? (recB.completedAt ? new Date(recB.completedAt).getTime() : (recB.updatedAt ? new Date(recB.updatedAt).getTime() : 0)) : 0;
      if (tA && tB && tA !== tB) return tA - tB;
      if (tA) return -1;
      if (tB) return 1;
      return compareMediaName(a, b);
    });
    return videos;
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
  if (typeof window !== "undefined") { window.__ve_test = { buildTimelineBricks, buildTimelinePayload, compareMediaName, getTimelineFrameSize, sortTimelineVideosByGeneration, getRecordForVideo }; }

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

    // Queue preview pagination — 150/page, header shows page range (UI-only, no queue logic change)
    const _qTotal = state.queue.length;
    const _qPageSize = Number(state.queuePageSize || 150);
    const _qTotalPages = Math.max(1, Math.ceil(_qTotal / _qPageSize));
    if (state.queuePage >= _qTotalPages) state.queuePage = Math.max(0, _qTotalPages - 1);
    if (state.queuePage < 0) state.queuePage = 0;
    const _qStart = state.queuePage * _qPageSize;
    const _qEnd = Math.min(_qStart + _qPageSize, _qTotal);
    try {
      const el = document.getElementById("ve-queue-count");
      if (el) {
        if (!_qTotal) el.textContent = "up to 150 shown";
        else if (_qTotal > _qPageSize) el.textContent = `Showing ${_qStart + 1}-${_qEnd} / ${_qTotal} (page ${state.queuePage + 1}/${_qTotalPages})`;
        else el.textContent = `${_qTotal} shown`;
      }
      if (els.queuePager) els.queuePager.style.display = _qTotal > _qPageSize ? "flex" : "none";
      if (els.queuePagerInfo) {
        if (!_qTotal) els.queuePagerInfo.textContent = "";
        else if (_qTotal > _qPageSize) els.queuePagerInfo.textContent = `${_qStart + 1}-${_qEnd} of ${_qTotal} · page ${state.queuePage + 1}/${_qTotalPages}`;
        else els.queuePagerInfo.textContent = `${_qTotal} items`;
      }
      if (els.queuePrev) els.queuePrev.disabled = state.queuePage <= 0;
      if (els.queueNext) els.queueNext.disabled = state.queuePage >= _qTotalPages - 1 || _qTotal <= _qPageSize;
    } catch {}

    els.queueBody.innerHTML = state.queue.length
      ? state.queue
          .slice(_qStart, _qEnd)
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
    els.timelineListSummary.textContent = vids.length ? `${vids.length} videos sorted by generation order` : "No videos loaded.";
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

  // Saves files in a fixed order even when downloads run in parallel: each task fetches its
  // blob freely, then waits for its turn before the browser save starts. Tasks must call
  // finish(i) when done (success, failure or skip) so later ones are never blocked.
  function createSaveGate() {
    let next = 0;
    const finished = new Set();
    const waiting = new Map();
    const wake = () => {
      const w = waiting.get(next);
      if (w) { waiting.delete(next); w(); }
    };
    return {
      async wait(i) {
        while (next < i) await new Promise((resolve) => waiting.set(i, resolve));
      },
      finish(i) {
        finished.add(i);
        while (finished.has(next)) { finished.delete(next); next += 1; }
        wake();
      },
    };
  }

  // Orders completed records and gives each a serial number so the saved files sort in order.
  // Source of the number, first one that covers every record: Generate line number, queue
  // position, else plain rank by start time and name.
  function planQueueDownloads(records) {
    const run = state.gen && state.gen.run;
    const genPos = (rec) => {
      if (!run || String(run.folderId) !== String(rec.folderId)) return null;
      const item = (run.items || []).find((it) => it.image && String(it.image.mediaId) === String(rec.imageId));
      return item ? item.index + 1 : null;
    };
    const queuePos = (rec) => getQueuePositionForMedia(rec.imageId);
    const natural = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
    let pos = null;
    for (const source of [genPos, queuePos]) {
      const all = records.map(source);
      if (all.every((p) => p != null)) { pos = all; break; }
    }
    const rows = records.map((rec, i) => ({ rec, pos: pos ? pos[i] : null }));
    rows.sort((a, b) =>
      (a.pos != null && b.pos != null && a.pos !== b.pos) ? a.pos - b.pos
        : (Date.parse(a.rec.startedAt || "") || 0) - (Date.parse(b.rec.startedAt || "") || 0)
          || natural(a.rec.imageName, b.rec.imageName));
    const maxNum = Math.max(1, ...rows.map((r, i) => (r.pos != null ? r.pos : i + 1)));
    const width = Math.max(3, String(maxNum).length);
    return rows.map((r, i) => ({ rec: r.rec, num: r.pos != null ? r.pos : i + 1, width }));
  }

  function serialFileName(num, width, baseName) {
    const label = String(num).padStart(width, "0");
    // Generate names already start with their line number ("001 - prompt.mp4").
    const lead = baseName.match(/^0*(\d+)\b/);
    if (lead && Number(lead[1]) === num) return baseName;
    return `${label}_${baseName}`;
  }

  async function fetchAndDownload(video, fileName, turn = null) {
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
        if (turn) await turn.gate.wait(turn.i);
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
        await fetchAndDownload(video, fileName, opts.turn || null);
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
    updateButtonStates();
  }

  function selectFolder(folderId) {
    state.selectedFolderId = folderId || null;
    saveUiState({ selectedFolderId: state.selectedFolderId });
    state.items = [];
    state.queue = [];
    state.queuePage = 0;
    state.videos = [];
    state.selectedVideoIds = new Set();
    state.timelineVideos = [];
    renderFolders();
    renderQueue();
    renderVideos();
    renderTimelineExport();
    updatePromptCheck();
    updateButtonStates();
  }

  async function loadFolderImages() {
    const folder = getSelectedFolder();
    if (!folder) throw new Error("Please select a folder first.");
    logLine(`Loading images for folder "${folder.title || folder.name}"...`);
    const payload = await api.getAllImages(folder.id);
    state.items = payload.results.slice().sort(compareMediaName);
    state.folderMediaCount = payload.total;
    state.queue = buildQueue(folder, state.items);
    state.queuePage = 0;
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
    sortTimelineVideosByGeneration(videos);
    state.timelineVideos = videos;
    renderTimelineExport();
    updateButtonStates();
    logLine(`Timeline: ${videos.length} videos sorted by generation order.`);
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
    // Keep stitch order by generation (queue position -> completedAt -> name fallback)
    sortTimelineVideosByGeneration(state.timelineVideos);
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

  function clampVideoLength(value) {
    const number = Math.round(Number(value) || Number(config.videoLength) || 10);
    return Math.min(MAX_VIDEO_LENGTH, Math.max(MIN_VIDEO_LENGTH, number));
  }

  function updateConfigFromInputs() {
    config.videoLength = clampVideoLength(els.videoLength.value);
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
    config.imageType = els.imageType.value || "photorealistic";
    config.imageConcurrency = Math.min(8, Math.max(1, Math.round(Number(els.imageConcurrency.value) || 3)));
    config.enhanceImagePrompt = Boolean(els.enhanceImagePrompt.checked);
    config.enhanceVideoPrompt = Boolean(els.enhanceVideoPrompt.checked);
    if (els.autoSession) config.autoSession = Boolean(els.autoSession.checked);
    config.renameOutputs = Boolean(els.renameOutputs.checked);
    config.moveVideosToFolder = Boolean(els.moveVideos.checked);
    config.defaultCharacterTag = els.defaultCharacter.value || "";
    config.imagePrompts = els.imagePrompts.value;
    config.videoPrompts = els.videoPrompts.value;
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


  // Download every image in the selected folder; completed files are tracked so Resume
  // continues only the ones that were not downloaded successfully.
  function loadImageDownloadSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(IMAGE_DOWNLOAD_KEY) || "null");
      return saved && Array.isArray(saved.images) && Array.isArray(saved.downloadedIds) ? saved : null;
    } catch {
      return null;
    }
  }

  function imageDownloadName(image) {
    const source = String(image.fileName || image.name || image.mediaPath || "");
    const matched = source.match(/\\.(png|jpe?g|webp|gif|avif)(?:[?#].*)?$/i);
    const rawExtension = String(image.extension || "").toLowerCase().replace(/^\\./, "");
    const extension = matched ? matched[1].toLowerCase()
      : /^(png|jpe?g|webp|gif|avif)$/.test(rawExtension) ? rawExtension : "jpg";
    const baseName = String(image.name || image.title || image.fileName || image.id)
      .replace(/\\.(png|jpe?g|webp|gif|avif)$/i, "");
    return sanitizeFileName(baseName) + "." + extension;
  }

  async function fetchImageDownload(image) {
    const filename = image.fileName;
    const retryCount = Math.max(0, Number(config.downloadRetryCount) || 0);
    let lastError;
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        const response = await sessionFetch(
          `/library/download/${encodeURIComponent(image.id)}`,
          { method: "GET" },
          `Download image ${filename}`,
        );
        const type = String(response.headers.get("content-type") || "").toLowerCase();
        if (type.includes("json") || type.includes("html") || type.startsWith("text/")) {
          throw new Error("The server returned a page instead of an image.");
        }
        const blob = await response.blob();
        if (blob.size < 100) throw new Error("The downloaded image is empty.");
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < retryCount) {
          await sleep(Math.max(500, Number(config.downloadRetryBaseDelayMs) || 5000));
        }
      }
    }
    throw lastError;
  }

  async function downloadFolderImages(resume = false) {
    if (state.downloadInProgress) return;
    const folder = getSelectedFolder();
    if (!folder) throw new Error("Select a folder first.");
    const saved = loadImageDownloadSession();
    if (resume && (!saved || String(saved.folderId) !== String(folder.id))) {
      throw new Error("There is no image download to resume for this folder.");
    }

    state.downloadInProgress = true;
    state.stopRequested = false;
    updateButtonStates();
    try {
      let batch = saved;
      if (!resume) {
        const payload = await api.getAllImages(folder.id);
        // Same order as the queue (natural name order), saved as 001_name.jpg, 002_name.jpg, ...
        const sorted = (payload.results || [])
          .filter((image) => image && image.id != null)
          .sort(compareMediaName);
        const width = Math.max(3, String(sorted.length).length);
        const images = sorted.map((image, index) => ({
          id: String(image.id),
          fileName: serialFileName(index + 1, width, imageDownloadName(image)),
        }));
        if (!images.length) throw new Error("No images found in the selected folder.");
        batch = { folderId: String(folder.id), images, downloadedIds: [] };
        localStorage.setItem(IMAGE_DOWNLOAD_KEY, JSON.stringify(batch));
      }
      const completed = new Set(batch.downloadedIds.map(String));
      const remaining = batch.images.filter((image) => !completed.has(String(image.id)));
      let failures = 0;
      logLine(`${resume ? "Resuming" : "Starting"} image downloads: ${remaining.length} remaining of ${batch.images.length}.`);
      for (let index = 0; index < remaining.length && !state.stopRequested; index++) {
        const image = remaining[index];
        try {
          await fetchImageDownload(image);
          completed.add(String(image.id));
          batch.downloadedIds = [...completed];
          localStorage.setItem(IMAGE_DOWNLOAD_KEY, JSON.stringify(batch));
          logLine(`Image downloaded ${completed.size}/${batch.images.length}: ${image.fileName}`);
        } catch (error) {
          failures++;
          logLine(`Image download failed (${image.fileName}): ${shortError(error)}`);
        }
        if (index < remaining.length - 1 && !state.stopRequested) {
          await sleep(randomDelay(config.downloadMinDelayMs, config.downloadMaxDelayMs));
        }
      }
      logLine(`Image downloads: ${completed.size}/${batch.images.length} completed${failures ? `; ${failures} failed — click Resume download to retry` : ""}.`);
    } finally {
      state.downloadInProgress = false;
      updateButtonStates();
    }
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
      // Serial order: by generation order when every video is in the saved history, else list order.
      const recOf = (video) => {
        const u = String(video.uuid || "").toLowerCase().trim();
        return u ? Object.values(state.history.records).find((r) => r && r.uuid && String(r.uuid).toLowerCase().trim() === u) : null;
      };
      const recs = videos.map(recOf);
      let ordered;
      if (recs.every(Boolean)) {
        const byRec = new Map(recs.map((r, i) => [r, videos[i]]));
        ordered = planQueueDownloads(recs).map((p) => ({ video: byRec.get(p.rec), num: p.num, width: p.width }));
      } else {
        const width = Math.max(3, String(videos.length).length);
        ordered = videos.map((video, i) => ({ video, num: i + 1, width }));
      }
      const gate = createSaveGate();
      await asyncPool(concurrency, ordered, async ({ video, num, width }, planIdx) => {
        try {
        if (state.stopRequested) return;
        const myIdx = ++nextIdx;
        const downloadName = serialFileName(num, width, resolveVideoDownloadName(video));
        els.downloadSummary.textContent = `${label}: downloading ${myIdx}/${total} | ${downloadName}`;
        try {
          await fetchAndDownloadWithRetry(video, downloadName, { turn: { gate, i: planIdx } });
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
        } finally {
          gate.finish(planIdx);
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
  const plan = planQueueDownloads(entries.map((e) => e.rec));
  const gate = createSaveGate();
  try {
    await asyncPool(concurrency, plan, async ({ rec, num, width }, planIdx) => {
      try {
      if (state.stopRequested) return;
      const vid = rec.videoId;
      if (!vid) { failed++; processed++; logLine(`Skip ${rec.imageName}: no videoId resolvable`); return; }
      const myQIdx = ++nextQIdx;
      const fakeVideo = { id: vid, uuid: rec.uuid, name: rec.imageName, fileName: rec.imageFileName };
      const baseName = resolveVideoDownloadName(fakeVideo);
      const fileName = serialFileName(num, width, baseName);
      els.queueDownloadSummary.textContent = `${onlyRemaining ? "Remaining" : "Completed"}: downloading ${myQIdx}/${total} | ${fileName}`;
      try {
        await fetchAndDownloadWithRetry(fakeVideo, fileName, { turn: { gate, i: planIdx } });
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
      } finally {
        gate.finish(planIdx);
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

  /* ------------------------------------------------------------------
   * Generate modes: Image maker and Image → Video
   * A run turns prompt lines into images (and videos). It is saved in
   * localStorage (GEN_RUN_KEY) so Resume works after a page reload.
   * Video status is polled by pollStatuses() through normal history
   * records, so finished videos also appear in Completed / Collect / Stitch.
   * ------------------------------------------------------------------ */

  const GEN_VIDEO_FINAL = ["completed", "failed"];

  function padIndex(index) {
    return String(index + 1).padStart(3, "0");
  }

  function makeOutputName(index, prompt) {
    const text = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 80).trim();
    return text ? `${padIndex(index)} - ${text}` : padIndex(index);
  }

  // "creative" is a generation mode, not a type the enhancer or video step understands.
  function apiImageType(type) {
    return type === "creative" ? "other" : type || "photorealistic";
  }

  function getGenPromptLists() {
    return {
      imagePrompts: parsePromptList(els.imagePrompts.value),
      videoPrompts: parsePromptList(els.videoPrompts.value),
    };
  }

  function resolveVideoPrompt(videoPrompts, index) {
    if (videoPrompts.length === 1) return videoPrompts[0];
    return videoPrompts[index] || "";
  }

  // Problems that block starting a run (empty list = OK).
  function validateGenInputs(mode) {
    const problems = [];
    const { imagePrompts, videoPrompts } = getGenPromptLists();
    const folder = getSelectedFolder();
    if (!folder && config.autoSession) {
      // A dated folder is created when Start is pressed.
    } else if (!folder) problems.push("Pick a folder in the bar at the top first.");
    else if (!config.autoSession && getAiVideosFolder() && String(getAiVideosFolder().id) === String(folder.id)) {
      problems.push('Pick one of your own folders, not "My AI Videos".');
    }
    if (!imagePrompts.length) problems.push("Add at least one image prompt.");
    if (mode === "image2video") {
      if (!videoPrompts.length) {
        problems.push("Add video prompts (a single line is used for every image).");
      } else if (videoPrompts.length !== 1 && videoPrompts.length !== imagePrompts.length) {
        problems.push(
          `There are ${imagePrompts.length} image prompts but ${videoPrompts.length} video prompts. Use the same number of lines, or one video prompt for all.`,
        );
      }
    }
    if (!["16:9", "9:16"].includes(config.aspect)) {
      problems.push("Image generation supports 16:9 and 9:16 only.");
    }
    problems.push(...validateCharacters(imagePrompts));
    return problems;
  }

  /* —— Characters (@tag system) —— */

  const TAG_PATTERN = /(^|[^\w@])@([A-Za-z][\w-]{0,30})\b/g;

  function normalizeTag(tag) {
    return String(tag || "").replace(/^@/, "").trim().toLowerCase();
  }

  // Tags written in a line, in order, lowercased, without duplicates.
  function extractTags(line) {
    const tags = [];
    for (const match of String(line || "").matchAll(TAG_PATTERN)) {
      const tag = normalizeTag(match[2]);
      if (!tags.includes(tag)) tags.push(tag);
    }
    return tags;
  }

  // Characters used by a line: its own tags, or the default when it has none. "@none" = no character.
  function resolveLineTags(line, defaultTag) {
    const tags = extractTags(line);
    if (tags.includes("none")) return [];
    if (tags.length) return tags;
    return defaultTag ? [defaultTag] : [];
  }

  // Replaces @tag with the character's description (or removes it) so the site gets plain text.
  function applyCharacterTags(line, characters) {
    const byTag = new Map(characters.map((character) => [normalizeTag(character.tag), character]));
    return String(line || "")
      .replace(TAG_PATTERN, (whole, before, raw) => {
        const tag = normalizeTag(raw);
        if (tag === "none") return before;
        const character = byTag.get(tag);
        if (!character) return whole;
        const description = String(character.description || "").trim();
        // No description: use the tag as a name ("@mia" -> "Mia") so the sentence keeps its subject.
        const name = tag.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
        return `${before}${description || name}`;
      })
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/^[\s,;:]+/, "")
      .trim();
  }

  function getCharacters() {
    return (Array.isArray(config.characters) ? config.characters : []).filter(
      (character) => normalizeTag(character.tag),
    );
  }

  function validateCharacters(imagePrompts) {
    const problems = [];
    const characters = getCharacters();
    const tags = characters.map((character) => normalizeTag(character.tag));
    const duplicates = tags.filter((tag, index) => tags.indexOf(tag) !== index);
    if (duplicates.length) problems.push(`Character tags must be unique: @${[...new Set(duplicates)].join(", @")}.`);
    if (tags.includes("none")) problems.push('"@none" is reserved (it marks a line with no character).');
    const unknown = new Map();
    const tooMany = [];
    imagePrompts.forEach((line, index) => {
      const used = resolveLineTags(line, config.defaultCharacterTag);
      used.forEach((tag) => {
        if (!tags.includes(tag)) unknown.set(tag, (unknown.get(tag) || []).concat(index + 1));
      });
      if (used.length > 2) tooMany.push(index + 1);
    });
    unknown.forEach((lines, tag) => {
      problems.push(`@${tag} is used on line ${lines.slice(0, 5).join(", ")}${lines.length > 5 ? "…" : ""} but is not in the character list. Add it, or fix the spelling.`);
    });
    if (tooMany.length) {
      problems.push(`The site keeps at most 2 characters per image. Too many tags on line ${tooMany.slice(0, 5).join(", ")}${tooMany.length > 5 ? "…" : ""}.`);
    }
    return problems;
  }

  // Short summary for the prompt check line: "@anna 40 lines · @bob 12 · 48 with no character".
  function describeTagUsage(imagePrompts) {
    const characters = getCharacters();
    if (!characters.length && !extractTags(imagePrompts.join("\n")).length) return "";
    const counts = new Map();
    let none = 0;
    imagePrompts.forEach((line) => {
      const used = resolveLineTags(line, config.defaultCharacterTag);
      if (!used.length) none += 1;
      used.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1));
    });
    const parts = [...counts].map(([tag, count]) => `@${tag} ${count} line${count === 1 ? "" : "s"}`);
    if (none) parts.push(`${none} without a character`);
    return parts.join(" · ");
  }

  function createCharacterId() {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function referenceThumb(mediaId) {
    if (!mediaId) return "";
    const image = state.referenceImages.find((item) => String(item.id) === String(mediaId));
    return image ? image.thumbUrl || image.mediaPath || "" : "";
  }

  function renderCharacters() {
    if (!els.characterList) return;
    const characters = Array.isArray(config.characters) ? config.characters : [];
    const usage = new Map();
    parsePromptList(els.imagePrompts.value).forEach((line) => {
      resolveLineTags(line, config.defaultCharacterTag).forEach((tag) => usage.set(tag, (usage.get(tag) || 0) + 1));
    });
    const imageOptions = state.referenceImages
      .map((image) => `<option value="${escapeAttr(String(image.id))}">${escapeHtml(image.name || image.fileName || String(image.id))} (${escapeHtml(String(image.id))})</option>`)
      .join("");
    els.characterList.innerHTML = characters.length
      ? characters
          .map((character) => {
            const id = escapeAttr(character.id);
            const mediaId = String(character.mediaId || "");
            const known = state.referenceImages.some((image) => String(image.id) === mediaId);
            const extra = mediaId && !known ? `<option value="${escapeAttr(mediaId)}">Image ${escapeHtml(mediaId)}</option>` : "";
            const thumb = referenceThumb(mediaId) || character.thumbUrl || "";
            const count = usage.get(normalizeTag(character.tag)) || 0;
            return `
              <div class="ve-char-row" data-character-id="${id}">
                <div class="ve-thumb" title="${mediaId ? `Reference image ${escapeAttr(mediaId)}` : "Created by its first line"}" style="${thumb ? `background-image:url('${escapeAttr(thumb)}')` : ""}"></div>
                <div class="ve-char-tag"><input class="ve-input" data-field="tag" value="${escapeAttr(character.tag || "")}" placeholder="name" aria-label="Character tag" spellcheck="false" /></div>
                <select class="ve-select" data-field="mediaId" aria-label="Reference image">
                  <option value="">Created by its first line</option>${extra}${imageOptions}
                </select>
                <input class="ve-input" data-field="description" value="${escapeAttr(character.description || "")}" placeholder="optional — replaces @tag (default: its name)" aria-label="Description that replaces the tag" />
                <button class="ve-button ghost ve-icon-button" type="button" data-remove-character="${id}" title="Remove character (${count} line${count === 1 ? "" : "s"} use it)"><i class="bi bi-x-lg"></i></button>
              </div>`;
          })
          .join("")
      : `<p class="ve-field-hint" style="margin:0 0 4px;">No characters yet. Without characters every image is generated on its own.</p>`;
    characters.forEach((character) => {
      const select = els.characterList.querySelector(`[data-character-id="${CSS.escape(character.id)}"] select[data-field="mediaId"]`);
      if (select) select.value = String(character.mediaId || "");
    });
    const current = config.defaultCharacterTag;
    els.defaultCharacter.innerHTML =
      `<option value="">No character</option>` +
      characters
        .filter((character) => normalizeTag(character.tag))
        .map((character) => `<option value="${escapeAttr(normalizeTag(character.tag))}">Use @${escapeHtml(normalizeTag(character.tag))}</option>`)
        .join("");
    els.defaultCharacter.value = characters.some((character) => normalizeTag(character.tag) === current) ? current : "";
    config.defaultCharacterTag = els.defaultCharacter.value;
    els.characterHelp.textContent = characters.length
      ? `Example line: "@${normalizeTag(characters[0].tag) || "name"} sits in a cafe by the window". With a default set, write @none on lines that should have no character.`
      : "";
  }

  function readCharactersFromList() {
    if (!els.characterList) return;
    config.characters = (Array.isArray(config.characters) ? config.characters : []).map((character) => {
      const row = els.characterList.querySelector(`[data-character-id="${CSS.escape(character.id)}"]`);
      if (!row) return character;
      return {
        ...character,
        tag: normalizeTag(row.querySelector('[data-field="tag"]').value).replace(/[^\w-]/g, ""),
        mediaId: row.querySelector('[data-field="mediaId"]').value || "",
        description: row.querySelector('[data-field="description"]').value.trim(),
      };
    });
  }

  function addCharacter(patch = {}) {
    const characters = Array.isArray(config.characters) ? config.characters : [];
    const used = characters.map((character) => normalizeTag(character.tag));
    let tag = normalizeTag(patch.tag || "");
    if (!tag) {
      const names = ["hero", "friend", "villain", "guide", "child", "partner"];
      tag = names.find((name) => !used.includes(name)) || `character${characters.length + 1}`;
    }
    config.characters = characters.concat({ id: createCharacterId(), tag, description: "", mediaId: "", ...patch, tag });
    renderCharacters();
    persistGenSettings();
    updatePromptCheck();
    return tag;
  }

  function updatePromptCheck() {
    if (!els.imagePrompts) return;
    const { imagePrompts, videoPrompts } = getGenPromptLists();
    els.imagePromptCount.textContent = String(imagePrompts.length);
    els.videoPromptCount.textContent = String(videoPrompts.length);
    const folder = getSelectedFolder();
    const target = folder ? `“${folder.title || folder.name}”` : "the active folder";
    let message = `Outputs are saved into ${target}.`;
    let warn = false;
    if (config.mode === "image2video" && imagePrompts.length) {
      if (!videoPrompts.length) {
        message = "Add video prompts. A single line is used for every image.";
        warn = true;
      } else if (videoPrompts.length === 1 && imagePrompts.length > 1) {
        message = `The one video prompt is used for all ${imagePrompts.length} images. Saved into ${target}.`;
      } else if (videoPrompts.length !== imagePrompts.length) {
        message = `Line counts differ: ${imagePrompts.length} image vs ${videoPrompts.length} video prompts.`;
        warn = true;
      } else {
        message = `${imagePrompts.length} image → video pairs. Saved into ${target}.`;
      }
    } else if (config.mode === "image" && imagePrompts.length) {
      message = `${imagePrompts.length} image${imagePrompts.length === 1 ? "" : "s"} will be made in ${target}.`;
    }
    const usage = describeTagUsage(imagePrompts);
    if (usage && !warn) message += ` Characters: ${usage}.`;
    const characterProblems = imagePrompts.length ? validateCharacters(imagePrompts) : [];
    if (characterProblems.length) {
      message = characterProblems[0];
      warn = true;
    }
    els.promptCheck.textContent = message;
    els.promptCheck.classList.toggle("is-warning", warn);
  }

  async function loadReferenceImages() {
    const folderId = els.referenceFolderSelect.value;
    if (!folderId) throw new Error("Pick a reference folder first.");
    const payload = await api.getAllImages(folderId);
    state.referenceImages = payload.results.slice().sort(compareMediaName);
    renderCharacters();
    logLine(`Loaded ${state.referenceImages.length} reference images from folder ${folderId}.`);
  }

  // "Use as character" on a finished row: adds (or updates) a character with that image as its reference.
  function useImageAsCharacter(mediaId, imageUrl) {
    readCharactersFromList();
    const answer = window.prompt("Tag for this character (you will write @tag in prompt lines):", "hero");
    if (answer === null) return;
    const tag = normalizeTag(answer).replace(/[^\w-]/g, "");
    if (!tag || tag === "none") {
      alert("Use letters, numbers, - or _ for the tag (not \"none\").");
      return;
    }
    if (!state.referenceImages.some((image) => String(image.id) === String(mediaId))) {
      state.referenceImages.unshift({ id: mediaId, name: `Image ${mediaId}`, thumbUrl: imageUrl });
    }
    const existing = (config.characters || []).find((character) => normalizeTag(character.tag) === tag);
    if (existing) {
      existing.mediaId = String(mediaId);
      existing.thumbUrl = imageUrl;
      renderCharacters();
      persistGenSettings();
    } else {
      addCharacter({ tag, mediaId: String(mediaId), thumbUrl: imageUrl });
    }
    updatePromptCheck();
    logLine(`@${tag} now uses image ${mediaId} as its reference.`);
  }

  function persistGenSettings() {
    saveUiState({
      mode: config.mode,
      imageType: config.imageType,
      imageConcurrency: config.imageConcurrency,
      enhanceImagePrompt: config.enhanceImagePrompt,
      enhanceVideoPrompt: config.enhanceVideoPrompt,
      autoSession: config.autoSession,
      renameOutputs: config.renameOutputs,
      moveVideosToFolder: config.moveVideosToFolder,
      characters: (config.characters || []).map(({ id, tag, description, mediaId, thumbUrl }) => ({ id, tag, description, mediaId, thumbUrl })),
      defaultCharacterTag: config.defaultCharacterTag,
      referenceFolderId: els.referenceFolderSelect.value || "",
      imagePrompts: config.imagePrompts,
      videoPrompts: config.videoPrompts,
    });
  }

  function createGenRun(mode) {
    const folder = getSelectedFolder();
    const { imagePrompts, videoPrompts } = getGenPromptLists();
    return {
      id: `run-${Date.now()}`,
      mode,
      folderId: folder.id,
      folderTitle: folder.title || folder.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: {
        aspect: config.aspect,
        imageType: config.imageType,
        videoLength: config.videoLength,
        enhanceImagePrompt: config.enhanceImagePrompt,
        enhanceVideoPrompt: config.enhanceVideoPrompt,
        characters: getCharacters().map((character) => ({
          tag: normalizeTag(character.tag),
          description: character.description || "",
          mediaId: character.mediaId ? String(character.mediaId) : "",
        })),
        defaultCharacterTag: config.defaultCharacterTag || "",
        renameOutputs: config.renameOutputs,
        moveVideosToFolder: config.moveVideosToFolder,
      },
      // tag -> media id of the character's reference image (library pick, or the line that created it)
      characterMedia: Object.fromEntries(
        getCharacters()
          .filter((character) => character.mediaId)
          .map((character) => [normalizeTag(character.tag), String(character.mediaId)]),
      ),
      items: imagePrompts.map((imagePrompt, index) => {
        const characters = getCharacters();
        const rawVideo = mode === "image2video" ? resolveVideoPrompt(videoPrompts, index) : "";
        return {
          index,
          imagePrompt,
          tags: resolveLineTags(imagePrompt, config.defaultCharacterTag),
          promptText: applyCharacterTags(imagePrompt, characters),
          videoPrompt: rawVideo,
          videoPromptText: applyCharacterTags(rawVideo, characters),
          image: { status: "pending" },
          video: mode === "image2video" ? { status: "pending" } : null,
        };
      }),
    };
  }

  function updateGenItem(item, part, patch) {
    item[part] = { ...(item[part] || {}), ...patch, updatedAt: new Date().toISOString() };
    saveGenRun();
    renderGenRun();
  }

  // Older (0.9.6) runs used characterMode "first" / "reference" for every line. Convert them.
  function normalizeGenRun(run) {
    if (!run || run.characterMedia) return run;
    const settings = run.settings || {};
    run.characterMedia = {};
    let tags = [];
    if (settings.characterMode === "first") {
      tags = ["character"];
      settings.characters = [{ tag: "character", description: "", mediaId: "" }];
      if (run.characterMediaId) run.characterMedia.character = String(run.characterMediaId);
    } else if (settings.characterMode === "reference") {
      settings.characters = (settings.referenceIds || []).map((mediaId, index) => ({ tag: `ref${index + 1}`, description: "", mediaId: String(mediaId) }));
      settings.characters.forEach((character) => {
        run.characterMedia[character.tag] = character.mediaId;
      });
      tags = settings.characters.map((character) => character.tag);
    } else {
      settings.characters = [];
    }
    run.items.forEach((item) => {
      if (!item.tags) item.tags = tags.slice();
      if (!item.promptText) item.promptText = item.imagePrompt;
      if (item.videoPromptText === undefined) item.videoPromptText = item.videoPrompt || "";
    });
    return run;
  }

  // The first line that uses a tag creates that character when it has no reference image.
  function definingItem(run, tag) {
    return run.items.find((item) => (item.tags || []).includes(tag)) || null;
  }

  // "ready", "wait" (a character this line needs is still being created) or { blocked: reason }.
  function genReadiness(run, item) {
    for (const tag of item.tags || []) {
      if (run.characterMedia[tag]) continue;
      const owner = definingItem(run, tag);
      if (!owner || owner === item) continue;
      if (owner.image.status === "saved" && owner.image.mediaId) {
        run.characterMedia[tag] = String(owner.image.mediaId);
        continue;
      }
      if (owner.image.status === "failed") {
        return { blocked: `@${tag} was not created because line ${owner.index + 1} failed. Fix that line and press Resume.` };
      }
      return "wait";
    }
    return "ready";
  }

  function genCharacterRefs(run, item) {
    return (item.tags || [])
      .map((tag) => run.characterMedia[tag])
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index)
      .slice(0, 2);
  }

  async function sleepUnlessStopped(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !state.gen.stopRequested) {
      await sleep(Math.min(1000, Math.max(0, until - Date.now())));
    }
  }

  // Resolves with the saved media id once the generated image exists.
  // Saving is retried until the site stops answering "Image is empty."; the WebSocket push only wakes the loop early.
  function waitForGeneratedImage(uuid, timeoutMs = config.imageTimeoutMs) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let wake = null;
      let socket = null;
      const startedAt = Date.now();
      const done = (error, value) => {
        if (finished) return;
        finished = true;
        try {
          if (socket) socket.close();
        } catch {
          // ignore
        }
        if (error) reject(error);
        else resolve(value);
      };
      try {
        const wsUrl = (window.app && window.app.options && window.app.options.wsServerUrl) || "wss://ws.talkingphotos.ai/";
        socket = new WebSocket(wsUrl);
        socket.onopen = () => socket.send(JSON.stringify({ recipient_uuid: uuid, message: "connected" }));
        socket.onmessage = (event) => {
          const data = String(event.data || "");
          if (/^error:/i.test(data)) done(new Error(data.replace(/^error:\s*/i, "") || "Image generation failed."));
          else if (data === "abuse_block") done(new Error("The site blocked this request (abuse_block)."));
          else if (/^https?:\/\//.test(data) && wake) wake();
        };
      } catch {
        socket = null;
      }
      (async () => {
        await sleep(3000);
        while (!finished) {
          try {
            const result = await api.saveGeneratedImage(uuid);
            if (result && result.mediaId) return done(null, result.mediaId);
            if (result && result.error && !/image is empty/i.test(result.error)) return done(new Error(result.error));
          } catch (error) {
            if (!/image is empty/i.test(String(error.message))) return done(error);
          }
          if (Date.now() - startedAt > timeoutMs) return done(new Error("Timed out waiting for the image."));
          await new Promise((resolveWait) => {
            wake = resolveWait;
            setTimeout(resolveWait, 5000);
          });
          wake = null;
        }
      })();
    });
  }

  function shortError(error) {
    const text = String((error && (error.bodyText || error.message)) || error || "");
    try {
      const json = JSON.parse(error && error.bodyText ? error.bodyText : "");
      if (json && (json.error || json.message || json.msg)) return String(json.error || json.message || json.msg);
    } catch {
      // not JSON
    }
    return text.split("\n")[0].slice(0, 200);
  }

  async function processGenImage(run, item) {
    const refs = genCharacterRefs(run, item);
    const settings = run.settings;
    const tag = `#${padIndex(item.index)}`;
    try {
      let mediaId = item.image.mediaId || null;
      // A uuid without a media id means the page reloaded mid-generation: try to save it first.
      if (!mediaId && item.image.uuid) {
        updateGenItem(item, "image", { status: "saving", error: "" });
        try {
          mediaId = await waitForGeneratedImage(item.image.uuid, 20000);
        } catch (error) {
          logLine(`${tag} earlier image could not be saved (${shortError(error)}); generating again.`);
        }
      }
      if (!mediaId) {
        updateGenItem(item, "image", { status: "generating", error: "", uuid: null, character: refs.join(",") });
        let prompt = item.promptText || item.imagePrompt;
        if (settings.enhanceImagePrompt) {
          try {
            prompt = refs.length
              ? await api.extendPrompt("consistent_character", prompt, { type: apiImageType(settings.imageType), mediaId: refs[0], mediaId2: refs[1] || "" })
              : await api.extendPrompt("image", prompt, { type: apiImageType(settings.imageType) });
          } catch (error) {
            logLine(`${tag} prompt enhance failed, using the original: ${shortError(error)}`);
          }
        }
        const options = { type: settings.imageType, aspect: settings.aspect };
        const result = refs.length
          ? await api.generateConsistentImage(prompt, { ...options, mediaId: refs[0], mediaId2: refs[1] || 0 })
          : await api.generateImage(prompt, options);
        if (!result || !result.success || !result.uuid) {
          throw new Error((result && (result.message || result.msg || result.error)) || "The site did not accept the image request.");
        }
        updateGenItem(item, "image", { status: "generating", uuid: result.uuid, finalPrompt: prompt });
        logLine(`${tag} image started.`);
        mediaId = await waitForGeneratedImage(result.uuid);
      }
      updateGenItem(item, "image", { status: "saving", mediaId });
      try {
        await api.moveItem(mediaId, run.folderId);
      } catch (error) {
        logLine(`${tag} could not move the image into the folder: ${shortError(error)}`);
      }
      if (settings.renameOutputs) {
        try {
          await api.renameItem(mediaId, makeOutputName(item.index, item.promptText || item.imagePrompt));
        } catch (error) {
          logLine(`${tag} could not rename the image: ${shortError(error)}`);
        }
      }
      updateGenItem(item, "image", {
        status: "saved",
        mediaId,
        url: item.image.uuid ? `${PREVIEW_BASE_URL}${item.image.uuid}.jpg` : item.image.url || "",
      });
      // This line created any of its characters that had no reference yet.
      const created = (item.tags || []).filter((name) => !run.characterMedia[name] && definingItem(run, name) === item);
      created.forEach((name) => {
        run.characterMedia[name] = String(mediaId);
      });
      if (created.length) saveGenRun();
      logLine(`${tag} image saved (media ${mediaId})${created.length ? ` — created @${created.join(", @")}` : ""}.`);
      return true;
    } catch (error) {
      updateGenItem(item, "image", { status: "failed", error: shortError(error) });
      logLine(`${tag} image failed: ${shortError(error)}`);
      return false;
    }
  }

  // Finds a just-submitted video in "My AI Videos" (newest first) by its job uuid.
  async function findRecentAiVideo(uuid) {
    const folder = getAiVideosFolder();
    if (!folder) return null;
    const needle = String(uuid).toLowerCase();
    for (let page = 1; page <= 3; page += 1) {
      const payload = await api.getRecentMedia(folder.id, page);
      const results = Array.isArray(payload.results) ? payload.results : [];
      const hit = results.find((media) => String(media.uuid || "").toLowerCase() === needle);
      if (hit) return hit;
      if (results.length < config.pageSize) break;
    }
    return null;
  }

  // Moves the video next to its image (right after submit) and renames it once finished
  // (the site renames videos itself when they finish).
  async function placeGenVideo(run, item, finished) {
    const video = item.video;
    const tag = `#${padIndex(item.index)}`;
    try {
      let videoId = video.mediaId;
      if (!videoId) {
        const record = getRecord(run.folderId, item.image.mediaId);
        videoId = (record && record.videoId) || null;
        if (!videoId) {
          const found = await findRecentAiVideo(video.uuid);
          if (!found) return;
          videoId = String(found.id);
        }
        updateGenItem(item, "video", { mediaId: videoId });
        const record2 = getRecord(run.folderId, item.image.mediaId);
        if (record2 && !record2.videoId) setRecord(run.folderId, item.image.mediaId, { ...record2, videoId });
      }
      if (run.settings.moveVideosToFolder && !item.video.moved) {
        await api.moveItem(videoId, run.folderId);
        updateGenItem(item, "video", { moved: true });
      }
      if (finished && run.settings.renameOutputs && !item.video.renamed) {
        await api.renameItem(videoId, makeOutputName(item.index, item.promptText || item.imagePrompt));
        updateGenItem(item, "video", { renamed: true, renameChecks: 0 });
      }
    } catch (error) {
      logLine(`${tag} could not place the video: ${shortError(error)}`);
    }
  }

  // The site may rename a video again a few seconds after it reports "finished".
  // Check once per poll and re-apply our name, up to 3 times.
  async function verifyGenVideoName(run, item) {
    const video = item.video;
    const expected = makeOutputName(item.index, item.promptText || item.imagePrompt);
    try {
      const media = await getJson(`/library/get_media_item/${video.mediaId}`, "Load media item");
      const current = String((media && media.name) || "");
      // The site trims names to about 50 characters, so compare the start only.
      if (current && expected.startsWith(current.replace(/\.\.\.$/, "").trim())) {
        updateGenItem(item, "video", { nameVerified: true });
        return;
      }
      const checks = Number(video.renameChecks || 0) + 1;
      await api.renameItem(video.mediaId, expected);
      updateGenItem(item, "video", { renameChecks: checks, nameVerified: checks >= 3 });
    } catch (error) {
      logLine(`#${padIndex(item.index)} could not check the video name: ${shortError(error)}`);
    }
  }

  async function submitGenVideo(run, item) {
    const settings = run.settings;
    const tag = `#${padIndex(item.index)}`;
    let attempts = 0;
    while (!state.gen.stopRequested) {
      attempts += 1;
      updateGenItem(item, "video", { status: "submitting", error: "" });
      try {
        const result = await api.generateImageVideo(
          { id: item.image.mediaId, uuid: "", type: apiImageType(settings.imageType), isShared: false },
          item.videoPromptText || item.videoPrompt,
          { aspect: settings.aspect, videoLength: settings.videoLength, enhanceVideoPrompt: settings.enhanceVideoPrompt },
        );
        if (!result || !result.success || !result.uuid) {
          const message = (result && (result.error || result.message || result.msg)) || "The site did not accept the video request.";
          throw Object.assign(new Error(message), { final: !isParallelLimitMessage(message) });
        }
        const now = new Date().toISOString();
        updateGenItem(item, "video", { status: "running", uuid: result.uuid, submittedAt: now });
        setRecord(run.folderId, item.image.mediaId, {
          libraryId: config.libraryId,
          folderId: run.folderId,
          folderTitle: run.folderTitle,
          imageId: item.image.mediaId,
          imageName: makeOutputName(item.index, item.promptText || item.imagePrompt),
          prompt: item.videoPromptText || item.videoPrompt,
          aspect: settings.aspect,
          videoLength: settings.videoLength,
          generatorRunId: run.id,
          uuid: result.uuid,
          status: "submitted",
          startedAt: now,
          updatedAt: now,
          videoId: null,
          downloadedAt: null,
          completedAt: null,
        });
        logLine(`${tag} video submitted.`);
        await sleep(1500);
        await placeGenVideo(run, item, false);
        return;
      } catch (error) {
        const message = shortError(error);
        if (!error.final && isParallelLimitMessage(message)) {
          updateGenItem(item, "video", { status: "parallel_limit", error: "5 videos already running — waiting for a free slot" });
          logLine(`${tag} waiting ${Math.round(config.parallelLimitRetryDelayMs / 1000)}s for a free video slot.`);
          await sleepUnlessStopped(config.parallelLimitRetryDelayMs);
          continue;
        }
        if (attempts < 2 && !error.final) {
          await sleepUnlessStopped(5000);
          continue;
        }
        updateGenItem(item, "video", { status: "failed", error: message });
        logLine(`${tag} video failed: ${message}`);
        return;
      }
    }
    if (item.video.status !== "running") updateGenItem(item, "video", { status: "pending", error: "" });
  }

  // Syncs run items with history records (pollStatuses updates those every 15 s),
  // and moves/renames videos that have finished.
  async function pollGenRun() {
    const run = state.gen.run;
    if (!run || run.mode !== "image2video") return;
    for (const item of run.items) {
      const video = item.video;
      if (!video || !video.uuid) continue;
      if (video.status === "running") {
        const record = getRecord(run.folderId, item.image.mediaId);
        let mapped = null;
        let detail = "";
        if (record && record.uuid === video.uuid) {
          const status = normalizeStatus(record.status);
          if (status === "completed") mapped = "completed";
          else if (status === "failed") {
            mapped = "failed";
            detail = getFailureReason(record);
          }
        } else {
          // History was cleared: ask the site directly.
          try {
            const payload = await api.getStatus(video.uuid);
            const status = normalizeStatus(payload && payload.status);
            if (["succeeded", "success", "completed", "complete", "finished", "done"].includes(status)) mapped = "completed";
            else if (["failed", "error", "canceled", "cancelled", "absent"].includes(status)) mapped = "failed";
          } catch (error) {
            logLine(`#${padIndex(item.index)} status check failed: ${shortError(error)}`);
          }
        }
        if (!mapped) continue;
        updateGenItem(item, "video", { status: mapped, error: detail, finishedAt: new Date().toISOString() });
        logLine(`#${padIndex(item.index)} video ${mapped}.`);
      }
      if (
        item.video.status === "completed" &&
        Number(item.video.placeAttempts || 0) < 10 &&
        ((run.settings.moveVideosToFolder && !item.video.moved) || (run.settings.renameOutputs && !item.video.renamed))
      ) {
        updateGenItem(item, "video", { placeAttempts: Number(item.video.placeAttempts || 0) + 1 });
        await placeGenVideo(run, item, true);
      } else if (
        item.video.status === "completed" &&
        run.settings.renameOutputs &&
        item.video.renamed &&
        !item.video.nameVerified &&
        item.video.mediaId
      ) {
        await verifyGenVideoName(run, item);
      }
    }
  }

  function genNeedsFollowUp(run) {
    return run.items.some(
      (item) =>
        item.video &&
        (item.video.status === "running" ||
          (item.video.status === "completed" && run.settings.renameOutputs && item.video.mediaId && !item.video.nameVerified)),
    );
  }

  function getGenCounts(run) {
    const items = run ? run.items : [];
    return {
      total: items.length,
      images: items.filter((item) => item.image.status === "saved").length,
      videos: items.filter((item) => item.video && item.video.status === "completed").length,
      running: items.filter((item) => item.video && item.video.status === "running").length,
      failed: items.filter((item) => item.image.status === "failed" || (item.video && item.video.status === "failed")).length,
      unfinished: items.filter(
        (item) =>
          item.image.status !== "saved" ||
          (item.video && (!GEN_VIDEO_FINAL.includes(item.video.status) || item.video.status === "failed")),
      ).length,
    };
  }

  async function runGenerator(run) {
    state.gen.running = true;
    state.gen.stopRequested = false;
    updateButtonStates();
    renderGenRun();
    const label = run.mode === "image2video" ? "Image → Video" : "Image maker";
    logLine(`${label}: ${run.items.length} line(s) into "${run.folderTitle}".`);
    const imageQueue = run.items.filter((item) => item.image.status !== "saved");
    let imagesActive = 0;
    try {
      // Picks the next line whose characters exist. A line that creates a character runs before
      // the lines that use it, so hundreds of lines can share a few characters.
      const imageWorker = async () => {
        while (!state.gen.stopRequested && imageQueue.length) {
          const readyIndex = imageQueue.findIndex((item) => genReadiness(run, item) === "ready");
          if (readyIndex === -1) {
            const blocked = imageQueue.filter((item) => typeof genReadiness(run, item) === "object");
            if (blocked.length) {
              blocked.forEach((item) => {
                imageQueue.splice(imageQueue.indexOf(item), 1);
                updateGenItem(item, "image", { status: "failed", error: genReadiness(run, item).blocked });
              });
              continue;
            }
            if (imagesActive === 0) break; // nothing can make progress
            await sleep(700);
            continue;
          }
          const [item] = imageQueue.splice(readyIndex, 1);
          imagesActive += 1;
          try {
            await processGenImage(run, item);
          } finally {
            imagesActive -= 1;
          }
        }
      };
      // Videos are submitted in line order as their images become ready.
      const videoWorker = async () => {
        if (run.mode !== "image2video") return;
        while (!state.gen.stopRequested) {
          const next = run.items.find((item) => item.image.status === "saved" && item.video.status === "pending");
          if (next) {
            await submitGenVideo(run, next);
            if (config.delayBetweenRequestsMs > 0) await sleepUnlessStopped(config.delayBetweenRequestsMs);
            continue;
          }
          if (!imageQueue.length && imagesActive === 0) return;
          await sleep(1000);
        }
      };
      const workers = [videoWorker()];
      for (let index = 0; index < Math.max(1, config.imageConcurrency); index += 1) workers.push(imageWorker());
      await Promise.all(workers);
      // Keep going until the submitted videos finish and their names stick (pollStatuses runs every 15 s).
      while (run.mode === "image2video" && !state.gen.stopRequested && genNeedsFollowUp(run)) {
        await sleepUnlessStopped(config.pollIntervalMs);
        await pollGenRun();
      }
    } catch (error) {
      logLine(shortError(error));
      alert(shortError(error));
    } finally {
      state.gen.running = false;
      saveGenRun();
      renderGenRun();
      updateButtonStates();
      const counts = getGenCounts(run);
      logLine(
        state.gen.stopRequested
          ? `${label} stopped: ${counts.images}/${counts.total} images done. Press Resume to continue.`
          : `${label} finished: ${counts.images}/${counts.total} images${run.mode === "image2video" ? `, ${counts.videos}/${counts.total} videos` : ""}, ${counts.failed} failed.`,
      );
    }
  }

  async function startGenerator() {
    if (state.gen.running || state.running) return;
    readCharactersFromList();
    updateConfigFromInputs();
    const problems = validateGenInputs(config.mode);
    if (problems.length) throw new Error(problems.join("\n"));
    const current = state.gen.run;
    if (current && getGenCounts(current).unfinished > 0) {
      const ok = window.confirm("The last run still has unfinished lines. Start a new run instead? (Everything already made stays in your library.)");
      if (!ok) return;
    }
    if (config.autoSession) await ensureRunSession();
    if (!getSelectedFolder()) throw new Error("Pick a folder in the bar at the top first.");
    if (getAiVideosFolder() && String(getAiVideosFolder().id) === String(getSelectedFolder().id)) {
      throw new Error('Pick one of your own folders, not "My AI Videos".');
    }
    state.gen.run = createGenRun(config.mode);
    saveGenRun();
    await runGenerator(state.gen.run);
  }

  async function resumeGenerator() {
    if (state.gen.running || state.running) return;
    const run = state.gen.run;
    if (!run) throw new Error("There is no run to resume.");
    normalizeGenRun(run);
    if (!state.folders.some((folder) => String(folder.id) === String(run.folderId))) {
      throw new Error(`The run's folder (${run.folderTitle}) no longer exists.`);
    }
    run.items.forEach((item) => {
      if (["failed", "stopped"].includes(item.image.status)) item.image = { ...item.image, status: "pending", error: "" };
      if (["generating", "saving"].includes(item.image.status) && !item.image.uuid && !item.image.mediaId) {
        item.image = { status: "pending" };
      }
      if (item.video && ["failed", "stopped", "submitting", "parallel_limit"].includes(item.video.status)) {
        item.video = { status: "pending" };
      }
    });
    saveGenRun();
    await runGenerator(run);
  }

  function clearGenRun() {
    if (state.gen.running || !state.gen.run) return;
    if (!window.confirm("Clear this run from the list? Everything already made stays in your library.")) return;
    state.gen.run = null;
    saveGenRun();
    renderGenRun();
    updateButtonStates();
  }

  function renderGenRun() {
    if (!els.genBody) return;
    const run = state.gen.run;
    const counts = getGenCounts(run);
    els.genStatTotal.textContent = String(counts.total);
    els.genStatImages.textContent = String(counts.images);
    els.genStatVideos.textContent = String(counts.videos);
    els.genStatFailed.textContent = String(counts.failed);
    if (!run) {
      els.genSummary.textContent = "No run yet. Write prompts, then press Start.";
      els.genBody.innerHTML = `<tr><td colspan="5" class="ve-muted">No run yet.</td></tr>`;
      return;
    }
    const modeLabel = run.mode === "image2video" ? "Image → Video" : "Image maker";
    const castTags = (run.settings.characters || []).map((character) => `@${character.tag}`);
    const character = castTags.length ? `characters ${castTags.join(" ")}` : "no characters";
    els.genSummary.textContent = `${modeLabel} → “${run.folderTitle}” · ${run.settings.aspect} · ${character} · started ${formatDateTime(run.createdAt)}${state.gen.running ? " · running" : counts.unfinished ? " · press Resume to continue" : " · done"}`;
    const showVideo = run.mode === "image2video";
    const shown = 300;
    els.genBody.innerHTML = run.items
      .slice(0, shown)
      .map((item) => {
        const image = item.image || {};
        const video = item.video || {};
        const thumb = image.url || (image.uuid ? `${PREVIEW_BASE_URL}${image.uuid}.jpg` : "");
        const showThumb = image.status === "saved" || (image.uuid && image.status === "saving");
        const useButton = image.status === "saved" && image.mediaId
          ? `<button class="ve-button ghost small ve-use-character" type="button" data-use-character="${escapeAttr(String(image.mediaId))}" data-thumb="${escapeAttr(thumb)}" title="Make this image a character reference (asks for a @tag)">Use as character</button>`
          : "";
        const imageError = image.error ? `<span class="ve-error-line">${escapeHtml(image.error)}</span>` : "";
        const videoError = video.error ? `<span class="ve-error-line">${escapeHtml(video.error)}</span>` : "";
        const chips = (item.tags || [])
          .map((name) => {
            const creates = !(run.settings.characters || []).some((c) => c.tag === name && c.mediaId) && definingItem(run, name) === item;
            return `<span class="ve-tag-chip" title="${creates ? "This line creates the character" : "Keeps this character"}">@${escapeHtml(name)}${creates ? " ✦" : ""}</span>`;
          })
          .join("");
        return `
          <tr>
            <td>${padIndex(item.index)}</td>
            <td><div class="ve-thumb" style="${showThumb ? `background-image:url('${escapeAttr(thumb)}')` : ""}"></div>${useButton}</td>
            <td class="ve-cell-prompt">${chips}${escapeHtml(item.promptText || item.imagePrompt)}${item.videoPrompt ? `<span class="ve-muted">▶ ${escapeHtml(item.videoPromptText || item.videoPrompt)}</span>` : ""}</td>
            <td><span class="ve-badge ${getBadgeClass(image.status)}">${escapeHtml(image.status || "pending")}</span>${imageError}</td>
            <td>${showVideo ? `<span class="ve-badge ${getBadgeClass(video.status)}">${escapeHtml(video.status || "pending")}</span>${videoError}` : ""}</td>
          </tr>`;
      })
      .join("") +
      (run.items.length > shown
        ? `<tr><td colspan="5" class="ve-muted">… ${run.items.length - shown} more lines run in the background (counts above include them).</td></tr>`
        : "");
  }

  // —— Prompt helper ——
  // Instructions for another AI agent. The video rules quote VideoExpress's own prompt guidance
  // (the "Automatically enhance my video prompt" tooltip and the Text to Video tip).
  const VE_VIDEO_PROMPT_RULES = [
    "Write one flowing description in the present tense, like a director describing a shot.",
    'Start with the shot and camera ("Medium shot, camera static" or "slow push-in ending on her face"), then what happens, in order.',
    "Put dialogue in quotes and name who says it, one line per speaker. The video has sound, so you can also describe sounds. Example: The man says \"delicious\" and sets down the empty cup.",
    "Say what stays still as well as what moves.",
    "No timestamps or bullet lists.",
    "If there is more than one character, define each by gender, age and clothing and give them an actor number (Actor 1, Actor 2).",
  ];

  function buildPromptGuide() {
    updateConfigFromInputs();
    const mode = config.mode;
    const seconds = config.videoLength;
    const aspect = config.aspect === "9:16" ? "9:16 (vertical)" : config.aspect === "1:1" ? "1:1 (square)" : "16:9 (landscape)";
    const typeLabel = (els.imageType.selectedOptions[0] && els.imageType.selectedOptions[0].text) || config.imageType;
    const existing = getGenPromptLists().imagePrompts.length;
    const lines = [];
    const add = (...rows) => lines.push(...rows);
    const imageRules = [
      "Describe one still moment, not a sequence of actions. It is the first frame the video starts from.",
      "Include the subject and how they look (gender, age, hair, clothing), their pose, the setting, lighting, mood and framing (close-up, medium shot or wide shot).",
      "Keep each prompt to 1–3 sentences on a single line.",
    ];
    const cast = getCharacters();
    const tagRules = [
      "Recurring characters are marked with an @tag written where their name would go, e.g. \"@anna sits by the cafe window\". The tool keeps the same person in every image prompt line that contains their tag (at most 2 tags per line).",
      "Only put a tag in lines where that character is actually visible. Lines without a tag are generated without a fixed character, which is right for landscapes, objects and crowds.",
    ];
    let characterRules;
    if (cast.length) {
      characterRules = [
        ...tagRules,
        "Use only these tags:",
        ...cast.map((character) => {
          const tag = normalizeTag(character.tag);
          const source = character.mediaId ? "has a reference photo" : "is created by the first line that uses the tag";
          const text = character.description ? ` (the tag is replaced by "${character.description}")` : ` (the tag is replaced by the name "${tag.charAt(0).toUpperCase()}${tag.slice(1)}", so in the first line that uses it describe the character right after it)`;
          return `  @${tag}: ${source}${text}`;
        }),
      ];
      if (config.defaultCharacterTag) {
        characterRules.push(`Lines with no tag automatically get @${config.defaultCharacterTag}. Write @none in a line that should have no character.`);
      }
    } else {
      characterRules = [
        ...tagRules,
        "Invent a short lowercase tag for each recurring character (e.g. @anna, @dad). In the FIRST line that uses a tag, describe the character fully right after it (gender, age, hair, face, clothing); later lines only need the tag plus the new pose, place and action.",
        "Before the prompt blocks, add one block called CHARACTERS listing each tag as \"@tag — one-line description\".",
      ];
    }
    characterRules.push("You may use the tags in video prompts too; they are replaced the same way.");

    add("You are writing prompts for VideoExpress.ai, an AI tool that generates images and turns each image into a short video clip.");
    if (mode === "image2video") {
      add(
        "Turn my idea (at the end) into a list of scenes. Each scene becomes one image, and that image is then animated into one video clip.",
        "",
        "OUTPUT FORMAT",
        `Return ${cast.length ? "exactly two" : "the CHARACTERS block (if any) and then two"} plain-text code blocks and nothing else:`,
        "1. IMAGE PROMPTS: one line per scene.",
        "2. VIDEO PROMPTS: one line per scene, same order, same number of lines.",
        "Line N of the video block animates line N of the image block. No numbering, bullets, headings, blank lines, or line breaks inside a prompt.",
      );
    } else if (mode === "image") {
      add(
        "Turn my idea (at the end) into a list of images.",
        "",
        "OUTPUT FORMAT",
        `Return ${cast.length ? "one" : "the CHARACTERS block (if any) and then one"} plain-text code block with one image prompt per line and nothing else. No numbering, bullets, headings or blank lines.`,
      );
    } else {
      const names = state.items.map((item) => cleanPrompt(item.name || item.fileName || ""));
      add(
        `I already have ${names.length || "N"} images. Write one video prompt per image that animates it into a short clip.`,
        "",
        "OUTPUT FORMAT",
        "Return one plain-text code block with one video prompt per line, in the same order as the images below, and nothing else. No numbering, bullets, headings or blank lines.",
      );
      if (names.length) {
        add("", "MY IMAGES (in order)", ...names.slice(0, 150).map((name, index) => `${index + 1}. ${name}`));
      }
    }

    add("", "SETTINGS", `- Aspect ratio: ${aspect}.`);
    if (mode !== "video") add(`- Image style: ${typeLabel}.`);
    if (mode !== "image") {
      add(
        `- Each video clip is ${seconds} seconds long (VideoExpress makes clips of 3–10 seconds). Describe only what fits in ${seconds} seconds: one main action or movement per clip.`,
      );
    }
    if (mode !== "video") add("", "CHARACTERS", ...characterRules.map((rule) => (rule.startsWith("  @") ? rule : `- ${rule}`)));

    if (mode !== "video") add("", "IMAGE PROMPT RULES", ...imageRules.map((rule) => `- ${rule}`));
    if (mode !== "image") {
      add(
        "",
        "VIDEO PROMPT RULES (VideoExpress's own guidance)",
        ...VE_VIDEO_PROMPT_RULES.map((rule) => `- ${rule}`),
        "- The clip starts from its image, so keep the same people, place and lighting. Don't introduce new characters or jump to a new location.",
        "- Keep the motion realistic and gentle enough for the clip length; fast, chaotic action tends to blur.",
      );
    }
    if (mode !== "video") {
      add("", existing ? `How many scenes: about ${existing}, unless the idea needs a different number.` : "How many scenes: choose a sensible number for the idea, or use the number I give.");
    }
    add("", "MY IDEA:", "[describe your video or story here]");
    return lines.join("\n");
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  async function copyPromptGuide() {
    const text = buildPromptGuide();
    const ok = await copyTextToClipboard(text);
    els.copyPromptGuideLabel.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => {
      els.copyPromptGuideLabel.textContent = "Copy prompt guide";
    }, 2000);
    logLine(ok ? `Prompt guide copied (${config.mode} mode, ${text.length} characters). Paste it into your AI assistant.` : "Could not copy the prompt guide; see the console.");
    if (!ok) console.log(text);
  }

  function setMode(mode) {
    if (state.gen.running || state.running) return;
    config.mode = ["image2video", "image", "video"].includes(mode) ? mode : "image2video";
    els.modeButtons.forEach((button) => {
      const active = button.dataset.mode === config.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    });
    els.modeScoped.forEach((element) => {
      const modes = String(element.dataset.showModes || "").split(/\s+/);
      element.classList.toggle("ve-hidden", !modes.includes(config.mode));
    });
    els.promptGrid.classList.toggle("single", config.mode === "image");
    const copy = {
      image2video: ["prompts → image → video", "Each line makes an image, then turns it into a video. Images run in parallel; videos run up to 5 at a time."],
      image: ["prompts → images", "Each line makes one image, saved into the active folder."],
      video: ["sequential · auto-retry at 5 max", "Default 10s video. Queue runs 1 by 1; parallel limit retries automatically."],
    }[config.mode];
    if (els.generateSubtitle) els.generateSubtitle.textContent = copy[0];
    if (els.generateHelp) els.generateHelp.textContent = copy[1];
    if (els.promptHelperHint) {
      els.promptHelperHint.textContent = {
        image2video: "Copies instructions for ChatGPT, Claude, etc. It replies with image and video prompts in the right format, using VideoExpress's own prompt rules.",
        image: "Copies instructions for ChatGPT, Claude, etc. It replies with image prompts, one per line, ready to paste.",
        video: "Copies instructions for ChatGPT, Claude, etc. It replies with one video prompt per loaded image, using VideoExpress's own prompt rules.",
      }[config.mode];
    }
    // Image generation offers 16:9 and 9:16 only.
    const square = els.aspect.querySelector('option[value="1:1"]');
    if (square) square.disabled = config.mode !== "video";
    if (config.mode !== "video" && els.aspect.value === "1:1") {
      els.aspect.value = "16:9";
      config.aspect = "16:9";
      saveUiState({ aspect: "16:9" });
    }
    updatePromptCheck();
    saveUiState({ mode: config.mode });
  }

  function updateButtonStates() {
    const visibleVideoCount = getFilteredVideos().length;
    const genBusy = state.gen.running;
    const imageDownload = loadImageDownloadSession();
    const imageDownloadsRemaining = imageDownload &&
      imageDownload.images.some((image) => !imageDownload.downloadedIds.includes(String(image.id)));
    const imageDownloadBusy = state.running || state.uploadInProgress || state.downloadInProgress || genBusy;
    els.downloadImagesBtn.disabled = imageDownloadBusy || !getSelectedFolder();
    els.resumeImagesBtn.disabled = imageDownloadBusy || !imageDownloadsRemaining ||
      !getSelectedFolder() || String(imageDownload.folderId) !== String(state.selectedFolderId);
    els.runBtn.disabled = state.running || state.uploadInProgress || genBusy;
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
    if (els.genStartBtn) {
      const genCounts = getGenCounts(state.gen.run);
      els.genStartBtn.disabled = genBusy || state.running || state.uploadInProgress;
      els.genResumeBtn.disabled = genBusy || state.running || !state.gen.run || genCounts.unfinished === 0;
      els.genStopBtn.disabled = !genBusy;
      els.genClearBtn.disabled = genBusy || !state.gen.run;
      els.modeButtons.forEach((button) => {
        button.disabled = genBusy || state.running;
      });
      [
        els.aspect, els.imageType, els.videoLength, els.imageConcurrency, els.imagePrompts, els.videoPrompts,
        els.addCharacterBtn, els.defaultCharacter, els.referenceFolderSelect, els.loadReferencesBtn,
        els.enhanceImagePrompt, els.enhanceVideoPrompt, els.renameOutputs, els.moveVideos, els.autoSession,
      ].forEach((element) => {
        if (element) element.disabled = genBusy;
      });
      els.characterList.querySelectorAll("input, select, button").forEach((element) => {
        element.disabled = genBusy;
      });
      if (genBusy) els.loadMediaBtn.disabled = true;
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
    // Queue pager — 150/page, UI-only
    if (els.queuePrev) els.queuePrev.addEventListener("click", () => { if (state.queuePage > 0) { state.queuePage--; renderQueue(); } });
    if (els.queueNext) els.queueNext.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(state.queue.length / Number(state.queuePageSize || 150)));
      if (state.queuePage < totalPages - 1) { state.queuePage++; renderQueue(); }
    });
    if (els.timelineLoadBtn) els.timelineLoadBtn.addEventListener("click", () => handleAction(loadTimelineVideos));
    if (els.timelineAddCompletedBtn) els.timelineAddCompletedBtn.addEventListener("click", () => handleAction(addCompletedGeneratedToTimeline));
    if (els.timelineClearBtn) els.timelineClearBtn.addEventListener("click", () => { clearTimelineVideos(); });
    if (els.timelineExportBtn) els.timelineExportBtn.addEventListener("click", () => handleAction(exportTimeline));
    if (els.timelineStopBtn) els.timelineStopBtn.addEventListener("click", () => { stopTimelineExport(); });
    if (els.timelineDownloadBtn) els.timelineDownloadBtn.addEventListener("click", () => handleAction(downloadTimelineResult));
    if (els.timelineFolderSelect) els.timelineFolderSelect.addEventListener("change", () => { selectFolder(els.timelineFolderSelect.value); });
    [els.timelineName, els.timelineAspect, els.timelineQuality].forEach(el=>{ if(!el) return; el.addEventListener("change", updateTimelineExportConfigFromInputs); el.addEventListener("input", updateTimelineExportConfigFromInputs); });

    // —— Generate modes ——
    els.modeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setMode(button.dataset.mode);
        updateButtonStates();
      });
    });
    [els.imagePrompts, els.videoPrompts].forEach((element) => {
      element.addEventListener("input", () => {
        updateConfigFromInputs();
        updatePromptCheck();
      });
      element.addEventListener("change", () => {
        updateConfigFromInputs();
        persistGenSettings();
        renderCharacters();
      });
    });
    [
      els.imageType, els.imageConcurrency, els.defaultCharacter,
      els.enhanceImagePrompt, els.enhanceVideoPrompt, els.renameOutputs, els.moveVideos, els.autoSession,
    ].forEach((element) => {
      if (!element) return;
      element.addEventListener("change", () => {
        updateConfigFromInputs();
        persistGenSettings();
        updatePromptCheck();
      });
    });
    els.addCharacterBtn.addEventListener("click", () => {
      readCharactersFromList();
      addCharacter();
      const rows = els.characterList.querySelectorAll('[data-field="tag"]');
      if (rows.length) rows[rows.length - 1].select();
    });
    const onCharacterEdit = (event) => {
      if (!event.target.closest("[data-field]")) return;
      readCharactersFromList();
      persistGenSettings();
      updatePromptCheck();
    };
    els.characterList.addEventListener("input", onCharacterEdit);
    els.characterList.addEventListener("change", (event) => {
      onCharacterEdit(event);
      renderCharacters(); // refresh thumbnail, default-tag list and cleaned tag text
    });
    els.characterList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-character]");
      if (!button) return;
      readCharactersFromList();
      config.characters = (config.characters || []).filter((character) => character.id !== button.dataset.removeCharacter);
      renderCharacters();
      persistGenSettings();
      updatePromptCheck();
    });
    els.referenceFolderSelect.addEventListener("change", () => {
      persistGenSettings();
      handleAction(loadReferenceImages);
    });
    els.loadReferencesBtn.addEventListener("click", () => handleAction(loadReferenceImages));
    els.videoLength.addEventListener("change", () => updatePromptCheck());
    els.genStartBtn.addEventListener("click", () => handleAction(startGenerator));
    els.genResumeBtn.addEventListener("click", () => handleAction(resumeGenerator));
    els.genStopBtn.addEventListener("click", () => {
      state.gen.stopRequested = true;
      logLine("Stop requested. Images already generating will still be saved.");
      els.genStopBtn.disabled = true;
    });
    els.genClearBtn.addEventListener("click", clearGenRun);
    els.downloadImagesBtn.addEventListener("click", () => handleAction(() => downloadFolderImages(false)));
    els.resumeImagesBtn.addEventListener("click", () => handleAction(() => downloadFolderImages(true)));
    els.copyPromptGuideBtn.addEventListener("click", () => handleAction(copyPromptGuide));
    els.genBody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-use-character]");
      if (!button || state.gen.running) return;
      useImageAsCharacter(button.dataset.useCharacter, button.dataset.thumb);
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
    applyTheme(savedUi.theme || "videoexpress");
    if (savedUi.aspect) config.aspect = savedUi.aspect;
    if (savedUi.videoLength) config.videoLength = clampVideoLength(savedUi.videoLength);
    if (typeof savedUi.mode === "string") config.mode = savedUi.mode;
    if (typeof savedUi.imageType === "string") config.imageType = savedUi.imageType;
    if (savedUi.imageConcurrency) config.imageConcurrency = Math.min(8, Math.max(1, Number(savedUi.imageConcurrency) || 3));
    ["enhanceImagePrompt", "enhanceVideoPrompt", "renameOutputs", "moveVideosToFolder", "autoSession"].forEach((key) => {
      if (typeof savedUi[key] === "boolean") config[key] = savedUi[key];
    });
    ["imagePrompts", "videoPrompts", "defaultCharacterTag"].forEach((key) => {
      if (typeof savedUi[key] === "string") config[key] = savedUi[key];
    });
    if (Array.isArray(savedUi.characters)) {
      config.characters = savedUi.characters
        .filter((character) => character && character.tag)
        .map((character) => ({ ...character, id: character.id || createCharacterId() }));
    } else if (savedUi.characterMode === "reference" && savedUi.referenceMediaId) {
      // 0.9.6 settings: one reference used on every line -> a character used by default.
      config.characters = [{ id: createCharacterId(), tag: "hero", description: "", mediaId: String(savedUi.referenceMediaId) }];
      config.defaultCharacterTag = "hero";
    }
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
    els.imageType.value = config.imageType;
    els.imageConcurrency.value = String(config.imageConcurrency);
    els.enhanceImagePrompt.checked = config.enhanceImagePrompt;
    els.enhanceVideoPrompt.checked = config.enhanceVideoPrompt;
    if (els.autoSession) els.autoSession.checked = Boolean(config.autoSession);
    els.renameOutputs.checked = config.renameOutputs;
    els.moveVideos.checked = config.moveVideosToFolder;
    els.imagePrompts.value = config.imagePrompts;
    els.videoPrompts.value = config.videoPrompts;
    renderCharacters();
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
    setMode(config.mode);
    renderGenRun();
    renderSelectedFiles();
    renderVideos();
    updateButtonStates();
    await refreshFolders();
    if (savedUi.referenceFolderId) els.referenceFolderSelect.value = String(savedUi.referenceFolderId);
    if ((config.characters || []).some((character) => character.mediaId) && els.referenceFolderSelect.value) {
      loadReferenceImages().catch((error) => logLine(`Could not load reference images: ${error.message}`));
    }
    updatePromptCheck();
    renderQueue();
    updateSessionPreview();
    await pollStatuses();
    if (state.gen.run && getGenCounts(state.gen.run).unfinished > 0) {
      logLine("The last Generate run has unfinished lines. Press Resume in Generate to continue.");
    }
    // auto-expiry: only locally created sessions, runs hourly + on visibility
    try { await checkExpiredSessions(); } catch (e) { console.warn("[VE] expiry check failed", e); }
    setInterval(() => {
      checkExpiredSessions().catch(e => console.warn("[VE] expiry check failed", e));
    }, 6 * 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkExpiredSessions().catch(()=>{}); });
    setInterval(() => {
      pollStatuses()
        .then(() => (state.gen.running ? null : pollGenRun()))
        .catch((error) => console.warn("Status poll failed", error));
    }, config.pollIntervalMs);
    logLine("Manager ready.");
  }

  bootstrap().catch((error) => {
    console.error("VideoExpress manager bootstrap failed.", error);
    alert(`VideoExpress manager failed to start.\n\n${error.message || error}`);
  });
})();
