/**
 * kimi.you EPUB reader
 * ---------------------------------------------------------------------------
 * A small, static reading room built on epub.js.
 *
 * Everything happens locally: the file is read with File.arrayBuffer(), parsed
 * in the browser, and never sent anywhere. localStorage keeps global reading
 * settings plus a CFI and progress percentage for each book identifier.
 *
 * The code is intentionally split into small functions so it can be extended:
 *   - storage helpers          readStorage / writeStorage / removeStorage
 *   - book opening             openBook / validateEpubArchive / mountBook
 *   - rendition behaviour      handleRelocated / turnPage / toggleControls
 *   - navigation               loadToc / renderToc / jumpToHref
 *   - settings                 applySettings / buildReadingCSS
 *   - drawers                  openDrawer / closeDrawer
 */

"use strict";

/* --------------------------------------------------------------------------
   Constants
   -------------------------------------------------------------------------- */

const SETTINGS_KEY = "kimi.reader.settings.v1";
const LAST_BOOK_KEY = "kimi.reader.last-book.v1";
const POSITION_PREFIX = "kimi.reader.position.v1.";

const DEFAULT_SETTINGS = Object.freeze({
  theme: "sepia",
  fontSize: 100,
  fontFamily: "serif",
  lineHeight: 1.6,
  margin: 3,
});

const MARGIN_STEPS = [16, 28, 42, 60, 84];
const MARGIN_LABELS = ["Narrow", "Snug", "Normal", "Roomy", "Wide"];

const FONT_STACKS = {
  serif:
    '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif',
  sans:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  dyslexic:
    '"OpenDyslexic", "Comic Sans MS", "Trebuchet MS", sans-serif',
};

const LIBRARY_ERROR =
  "The EPUB engine could not be loaded. Check your connection, reload the page, and try again.";

/* --------------------------------------------------------------------------
   State and DOM
   -------------------------------------------------------------------------- */

const state = {
  settings: { ...DEFAULT_SETTINGS },
  book: null,
  rendition: null,
  meta: null,
  bookKey: null,
  currentLocation: null,
  currentCfi: null,
  percentage: 0,
  locationsReady: false,
  busy: false,
  libsReady: false,
  controlsHidden: false,
  activeDrawer: null,
  drawerTrigger: null,
  openToken: 0,
  positionDirty: false,
  saveTimer: null,
  resizeTimer: null,
  scrimTimer: null,
  toastTimer: null,
  suppressClickUntil: 0,
};

let dom = {};

function cacheDom() {
  dom = {
    readerApp: document.getElementById("reader-app"),
    readerShell: document.getElementById("reader-shell"),
    readerBar: document.getElementById("reader-bar"),
    readerPager: document.getElementById("reader-pager"),
    readerViewport: document.getElementById("reader-viewport"),
    readerHelp: document.getElementById("reader-help"),
    viewer: document.getElementById("viewer"),
    readerEmpty: document.getElementById("reader-empty"),
    readerHero: document.querySelector(".reader-hero"),

    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("file-input"),
    error: document.getElementById("error"),
    privacyNote: document.getElementById("privacy-note"),

    continueCard: document.getElementById("continue-card"),
    continueTitle: document.getElementById("continue-title"),
    continueMeta: document.getElementById("continue-meta"),
    continueOpen: document.getElementById("continue-open"),
    continueDismiss: document.getElementById("continue-dismiss"),

    bookTitle: document.getElementById("book-title"),
    bookAuthor: document.getElementById("book-author"),
    tocToggle: document.getElementById("toc-toggle"),
    settingsToggle: document.getElementById("settings-toggle"),
    closeBook: document.getElementById("close-book"),
    prevPage: document.getElementById("prev-page"),
    nextPage: document.getElementById("next-page"),
    edgePrev: document.getElementById("edge-prev"),
    edgeNext: document.getElementById("edge-next"),
    progress: document.getElementById("reader-progress"),
    progressBar: document.getElementById("progress-bar"),
    progressText: document.getElementById("progress-text"),
    loading: document.getElementById("reader-loading"),
    loadingText: document.getElementById("loading-text"),

    tocDrawer: document.getElementById("toc-drawer"),
    settingsDrawer: document.getElementById("settings-drawer"),
    tocList: document.getElementById("toc-list"),
    tocEmpty: document.getElementById("toc-empty"),
    drawerScrim: document.getElementById("drawer-scrim"),
    settingsForm: document.getElementById("settings-form"),
    settingsReset: document.getElementById("settings-reset"),
    fontSize: document.getElementById("font-size"),
    fontSizeValue: document.getElementById("font-size-value"),
    lineHeight: document.getElementById("line-height"),
    lineHeightValue: document.getElementById("line-height-value"),
    margin: document.getElementById("margin"),
    marginValue: document.getElementById("margin-value"),

    toast: document.getElementById("toast"),
    dropOverlay: document.getElementById("drop-overlay"),
  };
}

/* --------------------------------------------------------------------------
   localStorage helpers — every access is guarded.
   -------------------------------------------------------------------------- */

function readStorage(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    return false;
  }
}

function removeStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    // Storage can be unavailable in private modes; persistence is optional.
  }
}

/* --------------------------------------------------------------------------
   Settings
   -------------------------------------------------------------------------- */

function sanitizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };

  if (!raw || typeof raw !== "object") {
    return settings;
  }

  if (["light", "sepia", "dark"].includes(raw.theme)) {
    settings.theme = raw.theme;
  }
  if (["serif", "sans", "dyslexic"].includes(raw.fontFamily)) {
    settings.fontFamily = raw.fontFamily;
  }

  const fontSize = Number(raw.fontSize);
  if (Number.isFinite(fontSize) && fontSize >= 80 && fontSize <= 160) {
    settings.fontSize = Math.round(fontSize / 5) * 5;
  }

  const lineHeight = Number(raw.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight >= 1.3 && lineHeight <= 2) {
    settings.lineHeight = Math.round(lineHeight * 100) / 100;
  }

  const margin = Number(raw.margin);
  if (Number.isFinite(margin) && margin >= 1 && margin <= 5) {
    settings.margin = Math.round(margin);
  }

  return settings;
}

function loadSettings() {
  state.settings = sanitizeSettings(readStorage(SETTINGS_KEY, null));
}

function saveSettings() {
  writeStorage(SETTINGS_KEY, state.settings);
}

/** Fill the drawer controls from state.settings. */
function syncSettingsUI() {
  const { settings } = state;

  dom.settingsForm
    .querySelectorAll('input[name="reader-theme"]')
    .forEach((input) => {
      input.checked = input.value === settings.theme;
    });

  dom.settingsForm
    .querySelectorAll('input[name="reader-font"]')
    .forEach((input) => {
      input.checked = input.value === settings.fontFamily;
    });

  dom.fontSize.value = String(settings.fontSize);
  dom.fontSizeValue.textContent = `${settings.fontSize}%`;

  dom.lineHeight.value = String(settings.lineHeight);
  dom.lineHeightValue.textContent = String(settings.lineHeight);

  dom.margin.value = String(settings.margin);
  dom.marginValue.textContent = MARGIN_LABELS[settings.margin - 1];
}

/** Margin setting is applied to the viewer inset, not the page chrome. */
function applyReaderMargins() {
  if (!dom.readerShell) {
    return;
  }

  const base = MARGIN_STEPS[state.settings.margin - 1] || MARGIN_STEPS[2];
  const width = window.innerWidth;
  const scale = width <= 640 ? 0.55 : width <= 1000 ? 0.78 : 1;
  const px = Math.max(10, Math.round(base * scale));

  dom.readerShell.style.setProperty("--reader-margin", `${px}px`);
}

/** Apply settings live to the stage and the current ebook document. */
function applySettings({ persist = true, resize = true } = {}) {
  dom.readerShell.dataset.readTheme = state.settings.theme;
  applyReaderMargins();
  syncSettingsUI();

  if (persist) {
    saveSettings();
  }

  if (state.rendition) {
    applyContentTheme();
    if (resize) {
      scheduleResize(140);
    }
  }
}

function onSettingsInput(event) {
  const target = event.target;

  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  if (target.name === "reader-theme") {
    state.settings.theme = target.value;
  } else if (target.name === "reader-font") {
    state.settings.fontFamily = target.value;
  } else if (target.id === "font-size") {
    state.settings.fontSize = Number(target.value);
  } else if (target.id === "line-height") {
    state.settings.lineHeight =
      Math.round(Number(target.value) * 100) / 100;
  } else if (target.id === "margin") {
    state.settings.margin = Number(target.value);
  } else {
    return;
  }

  applySettings();
}

/* --------------------------------------------------------------------------
   Reading theme — injected into every epub.js content document
   -------------------------------------------------------------------------- */

function buildReadingCSS() {
  const computed = window.getComputedStyle(dom.readerShell);
  const read = (name, fallback) =>
    computed.getPropertyValue(name).trim() || fallback;

  const bg = read("--reading-bg", "#efe3c8");
  const ink = read("--reading-ink", "#3a3023");
  const link = read("--reading-link", "#6d4a23");
  const selection = read("--reading-selection", "rgba(109, 74, 35, 0.18)");
  const font = FONT_STACKS[state.settings.fontFamily] || FONT_STACKS.serif;
  const fontSize = state.settings.fontSize;
  const lineHeight = state.settings.lineHeight;
  const colorScheme = state.settings.theme === "dark" ? "dark" : "light";

  return `
    @font-face {
      font-family: "OpenDyslexic";
      font-style: normal;
      font-weight: 400;
      font-display: swap;
      src: url("https://cdn.jsdelivr.net/npm/@fontsource/opendyslexic@5.3.0/files/opendyslexic-latin-400-normal.woff2") format("woff2");
    }
    @font-face {
      font-family: "OpenDyslexic";
      font-style: normal;
      font-weight: 700;
      font-display: swap;
      src: url("https://cdn.jsdelivr.net/npm/@fontsource/opendyslexic@5.3.0/files/opendyslexic-latin-700-normal.woff2") format("woff2");
    }

    html {
      background: ${bg} !important;
      color-scheme: ${colorScheme};
    }

    body {
      background: ${bg} !important;
      color: ${ink} !important;
      font-family: ${font} !important;
      font-size: ${fontSize}% !important;
      line-height: ${lineHeight} !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    body p,
    body li,
    body dl,
    body dd,
    body dt,
    body blockquote,
    body figcaption,
    body td,
    body th,
    body div,
    body span,
    body h1,
    body h2,
    body h3,
    body h4,
    body h5,
    body h6 {
      font-family: ${font} !important;
    }

    body p,
    body li,
    body dd,
    body blockquote,
    body td,
    body th {
      line-height: ${lineHeight} !important;
    }

    body h1,
    body h2,
    body h3,
    body h4,
    body h5,
    body h6 {
      color: ${ink} !important;
      line-height: 1.2 !important;
    }

    body p,
    body div,
    body li,
    body dd,
    body dt,
    body blockquote,
    body td,
    body th {
      color: ${ink} !important;
    }

    body a {
      color: ${link} !important;
      text-decoration-color: ${link} !important;
    }

    body blockquote {
      border-color: ${link} !important;
    }

    body hr {
      border-color: ${link} !important;
    }

    body img,
    body svg,
    body video {
      max-width: 100% !important;
      height: auto !important;
    }

    body pre,
    body code,
    body kbd,
    body samp {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
    }

    ::selection {
      background: ${selection} !important;
      color: ${ink} !important;
    }

    :focus-visible {
      outline: 2px solid ${link} !important;
      outline-offset: 2px !important;
    }

    /*
     * Some books (Standard Ebooks among them) hide a duplicate heading by
     * moving it far off-canvas: position:absolute; left:-999em. epub.js
     * measures the section with a Range over the whole body, so that stray
     * heading inflates the measured width to tens of thousands of pixels and
     * the book appears to have dozens of blank pages. clampOffscreenNodes()
     * tags those nodes; this rule keeps them accessible but puts them back
     * inside the page.
     */
    .kimi-offscreen-clipped {
      position: absolute !important;
      left: 0 !important;
      top: auto !important;
      display: block !important;
      width: 1px !important;
      height: 1px !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      clip-path: inset(50%) !important;
      white-space: nowrap !important;
    }
  `;
}

/**
 * Tags nodes that a book has pushed off the left of the page (a common way to
 * hide a duplicate heading). Their text stays in the accessibility tree, but
 * they no longer distort epub.js's range-based text measurement.
 */
function clampOffscreenNodes(doc) {
  const win = doc?.defaultView;
  if (!win) {
    return;
  }

  let nodes;
  try {
    nodes = doc.querySelectorAll("body *");
  } catch (error) {
    return;
  }

  nodes.forEach((node) => {
    const style = win.getComputedStyle(node);

    if (style.display === "none" || style.visibility === "hidden") {
      return;
    }

    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    // Entirely off the left edge by a wide margin: a hiding hack, not layout.
    if (rect.right < -400) {
      node.classList.add("kimi-offscreen-clipped");
    }
  });
}

function injectContentStyles(contents) {
  if (!contents || !contents.document) {
    return;
  }

  const doc = contents.document;

  try {
    let style = doc.getElementById("kimi-reader-theme");

    if (!style) {
      style = doc.createElement("style");
      style.id = "kimi-reader-theme";
      (doc.head || doc.documentElement).appendChild(style);
    }

    const css = buildReadingCSS();
    if (style.textContent !== css) {
      style.textContent = css;
    }

    clampOffscreenNodes(doc);
  } catch (error) {
    // A particularly locked-down book document can refuse style injection.
  }

  bindContentEvents(contents);
}

function applyContentTheme() {
  if (!state.rendition) {
    return;
  }

  let contents = [];
  try {
    contents = state.rendition.getContents() || [];
  } catch (error) {
    contents = [];
  }

  contents.forEach(injectContentStyles);
}

/* --------------------------------------------------------------------------
   Basic utilities
   -------------------------------------------------------------------------- */

function nextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean).join(", ");
  }

  if (value && typeof value === "object") {
    return normalizeText(
      value["@value"] ?? value.value ?? value.name ?? value.label ?? ""
    );
  }

  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** FNV-1a keeps localStorage keys short and stable. */
function hashString(input) {
  let hash = 2166136261;
  const value = String(input);

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function basename(href) {
  try {
    return decodeURIComponent(String(href).split("#")[0].split("/").pop() || "");
  } catch (error) {
    return String(href).split("#")[0].split("/").pop() || "";
  }
}

function showToast(message, { error = false, duration = 3400 } = {}) {
  if (!dom.toast) {
    return;
  }

  dom.toast.textContent = message;
  dom.toast.classList.toggle("is-error", Boolean(error));
  dom.toast.classList.add("is-visible");

  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove("is-visible");
  }, duration);
}

function showEmptyError(message) {
  if (!dom.error) {
    return;
  }

  dom.error.textContent = message;
  dom.error.hidden = false;
  dom.error.focus({ preventScroll: false });
}

function clearEmptyError() {
  if (!dom.error) {
    return;
  }

  dom.error.textContent = "";
  dom.error.hidden = true;
}

function setInert(element, inert) {
  if (!element) {
    return;
  }

  if (inert) {
    element.setAttribute("inert", "");
  } else {
    element.removeAttribute("inert");
  }
}

function setChromeEnabled(enabled) {
  if (dom.tocToggle) {
    dom.tocToggle.disabled = !enabled;
  }
  if (dom.settingsToggle) {
    dom.settingsToggle.disabled = !enabled;
  }
}

/* --------------------------------------------------------------------------
   Book metadata and storage records
   -------------------------------------------------------------------------- */

function getBookMeta(book, file) {
  const metadata = book?.packaging?.metadata || {};
  const fallbackTitle = String(file.name || "Untitled")
    .replace(/\.epub$/i, "")
    .trim();

  const title = normalizeText(metadata.title) || fallbackTitle || "Untitled";
  const author = normalizeText(metadata.creator) || "Unknown author";
  const identifier =
    normalizeText(metadata.identifier) || `${title}::${author}`;

  return {
    title,
    author,
    identifier,
    // The raw identifier is kept in every saved record; the key is a stable,
    // compact hash derived from it.
    key: `id-${hashString(identifier)}`,
  };
}

function positionKey(bookKey) {
  return `${POSITION_PREFIX}${bookKey}`;
}

function readPosition(bookKey) {
  const record = readStorage(positionKey(bookKey), null);

  if (
    !record ||
    typeof record !== "object" ||
    typeof record.cfi !== "string" ||
    !record.cfi.startsWith("epubcfi(")
  ) {
    return null;
  }

  return record;
}

function readLastBook() {
  const record = readStorage(LAST_BOOK_KEY, null);

  if (
    !record ||
    typeof record !== "object" ||
    typeof record.title !== "string" ||
    !record.title.trim()
  ) {
    return null;
  }

  return record;
}

/** Debounced position write, so page turns don't hammer localStorage. */
function schedulePositionSave() {
  state.positionDirty = true;
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(savePositionNow, 260);
}

function savePositionNow() {
  window.clearTimeout(state.saveTimer);

  if (!state.book || !state.meta || !state.currentCfi) {
    return;
  }

  const percentage = clamp(Math.round(state.percentage), 0, 100);
  const record = {
    key: state.bookKey,
    identifier: state.meta.identifier,
    title: state.meta.title,
    author: state.meta.author,
    cfi: state.currentCfi,
    percentage,
    updated: Date.now(),
  };

  writeStorage(positionKey(state.bookKey), record);
  writeStorage(LAST_BOOK_KEY, {
    key: state.bookKey,
    identifier: state.meta.identifier,
    title: state.meta.title,
    author: state.meta.author,
    percentage,
    updated: record.updated,
  });

  state.positionDirty = false;
}

function flushPosition() {
  if (state.positionDirty) {
    savePositionNow();
  }
}

/* --------------------------------------------------------------------------
   Continue reading hint
   -------------------------------------------------------------------------- */

function renderContinueCard() {
  const last = readLastBook();

  if (!last) {
    dom.continueCard.hidden = true;
    return;
  }

  const percentage = Number(last.percentage);
  const progressText = Number.isFinite(percentage)
    ? `${clamp(Math.round(percentage), 0, 100)}%`
    : "your last page";
  const author = last.author ? ` by ${last.author}` : "";

  dom.continueTitle.textContent = `“${last.title}”`;
  dom.continueMeta.textContent = `You left off at ${progressText}${author}. Re-open the same EPUB file to resume at the saved position.`;
  dom.continueCard.hidden = false;
}

/* --------------------------------------------------------------------------
   File type validation
   -------------------------------------------------------------------------- */

function looksLikeZip(buffer) {
  if (!buffer || buffer.byteLength < 4) {
    return false;
  }

  const header = new Uint8Array(buffer, 0, 4);
  return (
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    ((header[2] === 0x03 && header[3] === 0x04) ||
      (header[2] === 0x05 && header[3] === 0x06) ||
      (header[2] === 0x07 && header[3] === 0x08))
  );
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Check the ZIP shape before handing the buffer to epub.js. */
async function validateEpubArchive(buffer) {
  if (!buffer || buffer.byteLength === 0) {
    throw codedError("EMPTY_FILE", "This file is empty.");
  }

  if (!looksLikeZip(buffer)) {
    throw codedError("NOT_ZIP", "This file is not a ZIP archive.");
  }

  let zip;
  try {
    zip = await window.JSZip.loadAsync(buffer);
  } catch (error) {
    throw codedError("BAD_ZIP", "The ZIP archive could not be read.");
  }

  const container = zip.file("META-INF/container.xml");
  if (!container) {
    throw codedError(
      "NOT_EPUB",
      "The archive is missing META-INF/container.xml."
    );
  }

  const mimetypeFile = zip.file("mimetype");
  if (mimetypeFile) {
    let mimetype = "";
    try {
      mimetype = (await mimetypeFile.async("string")).trim();
    } catch (error) {
      mimetype = "";
    }

    if (mimetype && mimetype !== "application/epub+zip") {
      throw codedError("NOT_EPUB", "The archive is not labelled as EPUB.");
    }
  }
}

function describeOpenError(error, file) {
  const code = error?.code || "";
  const raw = String(error?.message || error || "");
  const lower = raw.toLowerCase();

  if (code === "EMPTY_FILE") {
    return "That file is empty. Choose a DRM-free EPUB with readable content.";
  }

  if (code === "NOT_ZIP" || code === "BAD_ZIP") {
    return `“${file.name}” isn’t a valid EPUB. The file may be damaged or renamed from another format. DRM-free EPUB files only.`;
  }

  if (code === "NOT_EPUB") {
    return `“${file.name}” is a ZIP archive, but it isn’t an EPUB. Choose a DRM-free EPUB file.`;
  }

  if (code === "NO_CONTENT") {
    return "This EPUB has no readable sections. It may be damaged. DRM-free EPUB files only.";
  }

  if (/drm|encrypt|decrypt|rights|no key|locked/i.test(lower)) {
    return "This EPUB appears to be encrypted or DRM-protected. This reader only opens DRM-free EPUB files.";
  }

  if (
    code === "BAD_ZIP" ||
    /zip|central directory|end of data|invalid|corrupt|damaged|parse|xml/i.test(
      lower
    )
  ) {
    return "This EPUB couldn’t be opened. The file may be damaged or corrupted. DRM-free EPUB files only.";
  }

  return "This EPUB couldn’t be opened. It may be damaged or use DRM. DRM-free EPUB files only.";
}

/* --------------------------------------------------------------------------
   Opening and mounting a book
   -------------------------------------------------------------------------- */

function setBusy(busy) {
  state.busy = busy;
  const disabled = busy || !state.libsReady;

  if (dom.dropzone) {
    dom.dropzone.disabled = disabled;
    dom.dropzone.setAttribute("aria-busy", busy ? "true" : "false");
  }
  if (dom.fileInput) {
    dom.fileInput.disabled = disabled;
  }
  if (dom.continueOpen) {
    dom.continueOpen.disabled = disabled;
  }
}

function revealReader() {
  const wasHidden = dom.readerApp.hidden;

  dom.readerEmpty.hidden = true;
  dom.readerApp.hidden = false;
  document.body.classList.add("is-reading");

  if (!state.book) {
    dom.bookTitle.textContent = "Opening book…";
    dom.bookAuthor.textContent = "";
    updateProgress(0);
    setNavDisabled(true, true);
    setChromeEnabled(false);
  }

  if (wasHidden) {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    dom.readerApp.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "start",
    });
  }
}

function showLoading(message) {
  dom.loadingText.textContent = message;
  dom.loading.hidden = false;
}

function hideLoading() {
  dom.loading.hidden = true;
}

async function openBook(file) {
  if (!state.libsReady) {
    showEmptyError(LIBRARY_ERROR);
    return;
  }

  if (state.busy) {
    return;
  }

  clearEmptyError();

  if (!file || typeof file.name !== "string") {
    return;
  }

  if (!/\.epub$/i.test(file.name)) {
    showEmptyError(
      `“${file.name}” isn’t an EPUB. Choose a file that ends in .epub. DRM-free EPUB files only.`
    );
    return;
  }

  if (file.size === 0) {
    showEmptyError(
      "That file is empty. Choose a DRM-free EPUB with readable content."
    );
    return;
  }

  const token = ++state.openToken;
  const hadBook = Boolean(state.book);
  let candidate = null;
  let mounting = false;

  setBusy(true);

  try {
    if (!hadBook) {
      revealReader();
    } else {
      document.body.classList.add("is-reading");
    }
    showLoading("Opening the book…");

    const buffer = await file.arrayBuffer();
    await validateEpubArchive(buffer);

    if (token !== state.openToken) {
      return;
    }

    candidate = window.ePub(buffer);
    await candidate.ready;

    if (token !== state.openToken) {
      // The reader was closed while the book was parsing. Throw so the catch
      // block destroys the orphaned book, then returns quietly.
      throw codedError("CANCELLED", "Cancelled");
    }

    if (!candidate.spine || !candidate.spine.length) {
      throw codedError(
        "NO_CONTENT",
        "This EPUB does not contain any reading sections."
      );
    }

    const meta = getBookMeta(candidate, file);
    const saved = readPosition(meta.key);

    showLoading("Setting the type…");

    mounting = true;
    await mountBook(candidate, meta, saved);
    mounting = false;
    candidate = null;

    if (token !== state.openToken) {
      return;
    }

    if (saved?.cfi) {
      const percent = Number.isFinite(Number(saved.percentage))
        ? `${clamp(Math.round(Number(saved.percentage)), 0, 100)}%`
        : "your last page";
      showToast(`Resumed “${meta.title}” at ${percent}.`);
    } else {
      showToast(`Opened “${meta.title}”.`, { duration: 2400 });
    }
  } catch (error) {
    if (candidate) {
      try {
        candidate.destroy();
      } catch (destroyError) {
        // Already destroyed by epub.js.
      }
      candidate = null;
    }

    if (token !== state.openToken) {
      return;
    }

    const message = describeOpenError(error, file);

    if (mounting) {
      disposeCurrentBook();
      resetReaderUI();
      setBusy(false);
      showEmptyError(message);
      return;
    }

    if (state.book) {
      hideLoading();
      setBusy(false);
      showToast(message, { error: true, duration: 6500 });
      return;
    }

    resetReaderUI();
    setBusy(false);
    showEmptyError(message);
    return;
  } finally {
    if (token === state.openToken) {
      setBusy(false);
    }
  }
}

/**
 * Attach the new book to the rendition and display it. The previous book is
 * released only once the new one has parsed successfully.
 */
async function mountBook(book, meta, saved) {
  disposeCurrentBook();

  state.book = book;
  state.meta = meta;
  state.bookKey = meta.key;
  state.currentLocation = null;
  state.currentCfi = null;
  state.percentage = 0;
  state.locationsReady = false;
  state.positionDirty = false;

  dom.bookTitle.textContent = meta.title;
  dom.bookAuthor.textContent = meta.author;
  document.title = `${meta.title} — kimi.you`;
  dom.tocList.replaceChildren();
  dom.tocEmpty.hidden = true;
  dom.readerShell.classList.remove("controls-hidden");
  restoreControls();
  updateProgress(0);
  setNavDisabled(true, true);

  await nextFrame();

  const rendition = book.renderTo(dom.viewer, {
    width: "100%",
    height: "100%",
    flow: "paginated",
    spread: "auto",
    minSpreadWidth: 900,
    allowScriptedContent: false,
  });

  state.rendition = rendition;
  setChromeEnabled(true);

  rendition.hooks.content.register((contents) => {
    injectContentStyles(contents);
  });

  rendition.on("rendered", (section, view) => {
    if (view?.contents) {
      injectContentStyles(view.contents);
    }
  });

  rendition.on("relocated", (location) => {
    if (state.book === book) {
      handleRelocated(location);
    }
  });

  rendition.on("displayError", () => {
    if (state.book !== book) {
      return;
    }
    showToast(
      "A page could not be displayed. The EPUB may be damaged or encrypted. DRM-free EPUB files only.",
      { error: true, duration: 6000 }
    );
  });

  const savedCfi = saved?.cfi || null;
  let resumed = false;

  try {
    if (savedCfi) {
      await rendition.display(savedCfi);
      resumed = true;
    } else {
      await rendition.display();
    }
  } catch (error) {
    if (savedCfi) {
      showToast(
        "The saved position could not be restored. Starting from the beginning."
      );
      await rendition.display();
    } else {
      throw error;
    }
  }

  hideLoading();
  updateProgressFromCurrentLocation();

  // These can take a moment; don't block the first page on them.
  loadToc(book);
  generateLocations(book);

  if (resumed && saved) {
    schedulePositionSave();
  }
}

function disposeCurrentBook() {
  const book = state.book;
  const rendition = state.rendition;

  state.book = null;
  state.rendition = null;
  state.currentLocation = null;
  state.currentCfi = null;
  state.percentage = 0;
  state.locationsReady = false;

  if (rendition) {
    try {
      rendition.destroy();
    } catch (error) {
      // Rendition may already be detached.
    }
  }

  if (book) {
    try {
      book.destroy();
    } catch (error) {
      // Book may already be destroyed.
    }
  }

  if (dom.viewer) {
    dom.viewer.replaceChildren();
  }
}

function resetReaderUI() {
  closeDrawer({ restoreFocus: false });
  flushPosition();
  disposeCurrentBook();

  state.controlsHidden = false;
  state.activeDrawer = null;
  state.drawerTrigger = null;
  state.meta = null;
  state.bookKey = null;
  state.positionDirty = false;

  document.body.classList.remove("is-reading");
  dom.readerApp.hidden = true;
  dom.readerEmpty.hidden = false;
  dom.readerShell.classList.remove("controls-hidden");
  dom.loading.hidden = true;
  dom.toast.classList.remove("is-visible");

  restoreControls();
  setChromeEnabled(false);
  setNavDisabled(true, true);
  updateProgress(0);

  dom.bookTitle.textContent = "Opening book…";
  dom.bookAuthor.textContent = "";
  dom.tocList.replaceChildren();
  dom.tocEmpty.hidden = true;
  document.title = "Reader — kimi.you";

  if (dom.fileInput) {
    dom.fileInput.value = "";
  }
}

function closeBook() {
  state.openToken += 1;

  flushPosition();
  disposeCurrentBook();
  resetReaderUI();
  setBusy(false);
  renderContinueCard();

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  dom.readerHero.scrollIntoView({
    behavior: reduce ? "auto" : "smooth",
    block: "start",
  });

  if (!dom.dropzone.disabled) {
    dom.dropzone.focus({ preventScroll: true });
  }
}

/* --------------------------------------------------------------------------
   Rendition: progress, navigation, page turning
   -------------------------------------------------------------------------- */

function percentageFromLocation(location) {
  if (!location || !location.start) {
    return 0;
  }

  const cfi = location.start.cfi;

  if (
    state.locationsReady &&
    state.book?.locations?.length?.() > 0 &&
    cfi
  ) {
    try {
      const value = state.book.locations.percentageFromCfi(cfi);
      if (value !== null && Number.isFinite(value)) {
        return clamp(value * 100, 0, 100);
      }
    } catch (error) {
      // Fall through to the approximation below.
    }
  }

  if (state.locationsReady && Number.isFinite(location.start.percentage)) {
    return clamp(location.start.percentage * 100, 0, 100);
  }

  const total = state.book?.spine?.length || 0;
  const index = Number(location.start.index) || 0;

  if (total > 0) {
    return clamp(((index + 0.5) / total) * 100, 0, 100);
  }

  return 0;
}

function updateProgress(percent) {
  const value = clamp(Math.round(percent), 0, 100);

  dom.progressBar.style.width = `${value}%`;
  dom.progressText.textContent = `${value}%`;
  dom.progress.setAttribute("aria-valuenow", String(value));
  dom.progress.setAttribute("aria-valuetext", `${value}% read`);
}

function updateProgressFromCurrentLocation() {
  if (state.currentLocation) {
    updateProgress(percentageFromLocation(state.currentLocation));
  } else {
    updateProgress(0);
  }
}

function handleRelocated(location) {
  if (!location || !location.start) {
    return;
  }

  state.currentLocation = location;
  state.currentCfi = location.start.cfi;
  state.percentage = percentageFromLocation(location);

  updateProgress(state.percentage);
  markCurrentToc(location.start.href);
  setNavDisabled(Boolean(location.atStart), Boolean(location.atEnd));
  schedulePositionSave();
}

function setNavDisabled(atStart, atEnd) {
  dom.prevPage.disabled = Boolean(atStart);
  dom.edgePrev.disabled = Boolean(atStart);
  dom.nextPage.disabled = Boolean(atEnd);
  dom.edgeNext.disabled = Boolean(atEnd);
}

async function turnPage(direction) {
  if (!state.rendition || state.busy || isDrawerOpen()) {
    return;
  }

  if (direction > 0 && dom.nextPage.disabled) {
    return;
  }
  if (direction < 0 && dom.prevPage.disabled) {
    return;
  }

  try {
    if (direction > 0) {
      await state.rendition.next();
    } else {
      await state.rendition.prev();
    }
  } catch (error) {
    showToast("That page could not be turned.", { error: true });
  }
}

function setControlsHidden(hidden, { announce = true } = {}) {
  if (!state.book) {
    return;
  }

  state.controlsHidden = hidden;
  dom.readerShell.classList.toggle("controls-hidden", hidden);

  setInert(dom.readerBar, hidden);
  setInert(dom.readerPager, hidden);

  if (hidden) {
    dom.readerBar.setAttribute("aria-hidden", "true");
    dom.readerPager.setAttribute("aria-hidden", "true");
  } else {
    dom.readerBar.removeAttribute("aria-hidden");
    dom.readerPager.removeAttribute("aria-hidden");
  }

  if (announce) {
    showToast(
      hidden
        ? "Controls hidden. Tap the center or press H to show them."
        : "Controls shown.",
      { duration: hidden ? 2600 : 1600 }
    );
  }

  // The viewport changes height as the rows collapse; repaginate afterwards.
  scheduleResize(320);
}

function toggleControls() {
  if (!state.book || isDrawerOpen()) {
    return;
  }
  setControlsHidden(!state.controlsHidden);
}

function restoreControls() {
  setInert(dom.readerBar, false);
  setInert(dom.readerPager, false);
  dom.readerBar.removeAttribute("aria-hidden");
  dom.readerPager.removeAttribute("aria-hidden");
}

/* --------------------------------------------------------------------------
   Locations and percentage
   -------------------------------------------------------------------------- */

async function generateLocations(book) {
  try {
    await book.locations.generate(1600);

    if (state.book !== book) {
      return;
    }

    state.locationsReady = book.locations.length() > 0;

    if (state.currentLocation) {
      state.percentage = percentageFromLocation(state.currentLocation);
      updateProgress(state.percentage);
      schedulePositionSave();
    }
  } catch (error) {
    if (state.book === book) {
      state.locationsReady = false;
    }
  }
}

/* --------------------------------------------------------------------------
   Table of contents
   -------------------------------------------------------------------------- */

async function loadToc(book) {
  try {
    const navigation = await book.loaded.navigation;

    if (state.book !== book) {
      return;
    }

    renderToc(navigation?.toc || []);
  } catch (error) {
    if (state.book === book) {
      renderToc([]);
    }
  }
}

function renderToc(items) {
  dom.tocList.replaceChildren();

  if (!Array.isArray(items) || items.length === 0) {
    dom.tocEmpty.hidden = false;
    return;
  }

  dom.tocEmpty.hidden = true;

  const buildList = (nodes, list, depth) => {
    nodes.forEach((item) => {
      if (!item) {
        return;
      }

      const li = document.createElement("li");
      const label =
        normalizeText(item.label || item.title) || "Untitled section";
      const href = typeof item.href === "string" ? item.href : "";

      if (href) {
        const link = document.createElement("a");
        link.className = "toc-link";
        link.href = "#";
        link.textContent = label;
        link.dataset.href = href;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          jumpToHref(href);
        });
        li.append(link);
      } else {
        const span = document.createElement("span");
        span.className = "toc-link";
        span.textContent = label;
        li.append(span);
      }

      const subitems = item.subitems || item.children || [];
      if (Array.isArray(subitems) && subitems.length > 0 && depth < 8) {
        const sublist = document.createElement("ol");
        buildList(subitems, sublist, depth + 1);
        li.append(sublist);
      }

      list.append(li);
    });
  };

  const root = document.createElement("ol");
  buildList(items, root, 0);
  dom.tocList.append(root);

  markCurrentToc(state.currentLocation?.start?.href);
}

function jumpToHref(href) {
  closeDrawer();

  if (!state.rendition || !href) {
    return;
  }

  state.rendition.display(href).catch(() => {
    showToast("That chapter could not be opened.", { error: true });
  });
}

function markCurrentToc(href) {
  if (!href) {
    return;
  }

  const currentFile = basename(href);
  const links = dom.tocList.querySelectorAll(".toc-link[data-href]");

  links.forEach((link) => {
    const isCurrent = basename(link.dataset.href) === currentFile;

    if (isCurrent) {
      link.setAttribute("aria-current", "location");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

/* --------------------------------------------------------------------------
   Drawers
   -------------------------------------------------------------------------- */

function isDrawerOpen() {
  return Boolean(state.activeDrawer);
}

function openDrawer(name, trigger) {
  if (!state.book || !state.rendition || state.busy) {
    return;
  }

  const drawer = name === "toc" ? dom.tocDrawer : dom.settingsDrawer;

  if (state.activeDrawer === drawer) {
    closeDrawer();
    return;
  }

  closeDrawer({ restoreFocus: false });

  state.activeDrawer = drawer;
  state.drawerTrigger = trigger;

  drawer.removeAttribute("aria-hidden");
  setInert(drawer, false);
  drawer.classList.add("is-open");

  dom.drawerScrim.hidden = false;
  document.body.classList.add("drawer-open");

  if (trigger) {
    trigger.setAttribute("aria-expanded", "true");
  }

  window.requestAnimationFrame(() => {
    if (state.activeDrawer === drawer) {
      dom.drawerScrim.classList.add("is-open");
      const closeButton = drawer.querySelector(".drawer-close");
      closeButton?.focus({ preventScroll: true });
    }
  });
}

function closeDrawer({ restoreFocus = true } = {}) {
  const drawer = state.activeDrawer;

  if (!drawer) {
    return;
  }

  const trigger = state.drawerTrigger;
  state.activeDrawer = null;
  state.drawerTrigger = null;

  if (restoreFocus && trigger) {
    trigger.focus({ preventScroll: true });
  }

  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  setInert(drawer, true);

  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");
  }

  dom.drawerScrim.classList.remove("is-open");
  document.body.classList.remove("drawer-open");

  window.clearTimeout(state.scrimTimer);
  state.scrimTimer = window.setTimeout(() => {
    if (!state.activeDrawer) {
      dom.drawerScrim.hidden = true;
    }
  }, 320);
}

function trapDrawerFocus(event) {
  if (event.key !== "Tab" || !state.activeDrawer) {
    return;
  }

  const focusable = Array.from(
    state.activeDrawer.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.offsetParent !== null);

  if (focusable.length === 0) {
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !state.activeDrawer.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/* --------------------------------------------------------------------------
   Keyboard, swipe, click zones, and content events
   -------------------------------------------------------------------------- */

function isFormField(target) {
  // Duck-typing avoids cross-realm instanceof failures for events coming from
  // the epub.js iframe.
  if (!target || typeof target.closest !== "function") {
    return false;
  }

  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']")
  );
}

function handleKeydown(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  if (event.key === "Escape") {
    if (isDrawerOpen()) {
      event.preventDefault();
      closeDrawer();
      return;
    }

    if (state.controlsHidden) {
      event.preventDefault();
      setControlsHidden(false);
    }
    return;
  }

  if (isFormField(event.target) || isDrawerOpen() || !state.book) {
    return;
  }

  if (event.key === "h" || event.key === "H") {
    event.preventDefault();
    toggleControls();
    return;
  }

  if (event.key === "ArrowLeft" || event.key === "PageUp") {
    event.preventDefault();
    turnPage(-1);
    return;
  }

  if (event.key === "ArrowRight" || event.key === "PageDown") {
    event.preventDefault();
    turnPage(1);
  }
}

function handleContentClick(event, doc) {
  if (
    Date.now() < state.suppressClickUntil ||
    isDrawerOpen() ||
    !state.book
  ) {
    return;
  }

  const target = event.target;

  // Events inside the epub.js iframe come from another JavaScript realm, so
  // use duck-typing rather than instanceof Element here.
  if (
    target &&
    typeof target.closest === "function" &&
    target.closest("a, button, input, textarea, select, [contenteditable='true']")
  ) {
    return;
  }

  try {
    const selection = doc.defaultView?.getSelection?.();
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      return;
    }
  } catch (error) {
    // Some webkit builds disallow selection access inside the frame.
  }

  // In paginated mode epub.js lays the whole section out in columns, so the
  // document's clientWidth can be several screens wide. The body width is the
  // visible column; measuring against it keeps the left/centre/right zones
  // aligned with what the reader actually sees.
  const width =
    doc.body?.getBoundingClientRect().width ||
    doc.documentElement?.clientWidth ||
    1;
  const x = event.clientX;

  if (x < width * 0.16) {
    turnPage(-1);
  } else if (x > width * 0.84) {
    turnPage(1);
  } else {
    toggleControls();
  }
}

function bindContentEvents(contents) {
  const doc = contents?.document;

  if (!doc || doc.__kimiReaderBound) {
    return;
  }

  doc.__kimiReaderBound = true;
  doc.addEventListener("click", (event) => handleContentClick(event, doc));
  doc.addEventListener("keydown", handleKeydown);
  bindSwipe(doc);
}

function bindSwipe(target) {
  let start = null;

  target.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        start = null;
        return;
      }

      const touch = event.touches[0];
      start = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
    },
    { passive: true }
  );

  target.addEventListener(
    "touchcancel",
    () => {
      start = null;
    },
    { passive: true }
  );

  target.addEventListener(
    "touchend",
    (event) => {
      if (!start) {
        return;
      }

      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const elapsed = Date.now() - start.time;
      start = null;

      if (elapsed > 900) {
        return;
      }

      if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.25) {
        return;
      }

      state.suppressClickUntil = Date.now() + 450;
      turnPage(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );
}

/* --------------------------------------------------------------------------
   Resizing
   -------------------------------------------------------------------------- */

function scheduleResize(delay = 90) {
  window.clearTimeout(state.resizeTimer);

  state.resizeTimer = window.setTimeout(() => {
    if (!state.rendition) {
      return;
    }

    const rect = dom.viewer.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) {
      return;
    }

    try {
      // Let epub.js re-measure its own stage. Passing explicit pixel sizes
      // can compound column widths when a spread is in use.
      state.rendition.resize();
    } catch (error) {
      // A resize during teardown can race the rendition; safe to ignore.
    }
  }, delay);
}

/* --------------------------------------------------------------------------
   Event wiring
   -------------------------------------------------------------------------- */

function bindEmptyState() {
  dom.dropzone.addEventListener("click", () => {
    if (!state.busy && state.libsReady) {
      dom.fileInput.click();
    }
  });

  dom.fileInput.addEventListener("change", () => {
    const file = dom.fileInput.files?.[0];
    openBook(file);
    dom.fileInput.value = "";
  });

  dom.continueOpen.addEventListener("click", () => {
    if (!state.busy && state.libsReady) {
      dom.fileInput.click();
    }
  });

  dom.continueDismiss.addEventListener("click", () => {
    removeStorage(LAST_BOOK_KEY);
    dom.continueCard.hidden = true;
    showToast("Continue hint dismissed. Saved positions are kept.");
  });
}

function bindReaderChrome() {
  dom.tocToggle.addEventListener("click", () => {
    openDrawer("toc", dom.tocToggle);
  });

  dom.settingsToggle.addEventListener("click", () => {
    openDrawer("settings", dom.settingsToggle);
  });

  dom.closeBook.addEventListener("click", closeBook);
  dom.prevPage.addEventListener("click", () => turnPage(-1));
  dom.nextPage.addEventListener("click", () => turnPage(1));
  dom.edgePrev.addEventListener("click", () => turnPage(-1));
  dom.edgeNext.addEventListener("click", () => turnPage(1));

  dom.readerViewport.addEventListener("click", (event) => {
    if (Date.now() < state.suppressClickUntil) {
      return;
    }

    if (
      event.target instanceof Element &&
      event.target.closest("button")
    ) {
      return;
    }

    if (isDrawerOpen() || state.busy || !state.book) {
      return;
    }

    toggleControls();
  });

  bindSwipe(dom.readerViewport);
}

function bindDrawers() {
  dom.drawerScrim.addEventListener("click", () => closeDrawer());

  document.querySelectorAll("[data-close-drawer]").forEach((button) => {
    button.addEventListener("click", () => closeDrawer());
  });

  [dom.tocDrawer, dom.settingsDrawer].forEach((drawer) => {
    drawer.addEventListener("keydown", trapDrawerFocus);
  });

  dom.settingsForm.addEventListener("input", onSettingsInput);
  dom.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  dom.settingsReset.addEventListener("click", () => {
    state.settings = { ...DEFAULT_SETTINGS };
    applySettings();
    showToast("Reading settings reset.");
  });
}

function bindKeyboard() {
  document.addEventListener("keydown", handleKeydown);
}

function bindDragAndDrop() {
  let dragDepth = 0;

  const hasFiles = (event) => {
    const types = event.dataTransfer?.types;
    return Boolean(types && Array.prototype.includes.call(types, "Files"));
  };

  const setDragging = (dragging) => {
    document.body.classList.toggle("is-dragging", dragging);
  };

  const resetDrag = () => {
    dragDepth = 0;
    setDragging(false);
  };

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    setDragging(true);
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      setDragging(false);
    }
  });

  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) {
      return;
    }

    event.preventDefault();
    resetDrag();

    const file = event.dataTransfer?.files?.[0];
    if (file) {
      openBook(file);
    }
  });

  window.addEventListener("dragend", resetDrag);
  window.addEventListener("blur", resetDrag);
}

function bindResize() {
  window.addEventListener("resize", () => {
    applyReaderMargins();
    scheduleResize(140);
  });

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => {
      scheduleResize(110);
    });
    observer.observe(dom.viewer);
  }
}

/* --------------------------------------------------------------------------
   Start
   -------------------------------------------------------------------------- */

function init() {
  cacheDom();

  state.libsReady = Boolean(window.ePub && window.JSZip);
  loadSettings();
  applySettings({ persist: false, resize: false });
  renderContinueCard();

  bindEmptyState();
  bindReaderChrome();
  bindDrawers();
  bindKeyboard();
  bindDragAndDrop();
  bindResize();

  // The hidden file input is operated by the labelled drop zone.
  dom.fileInput.tabIndex = -1;
  setChromeEnabled(false);
  setBusy(false);

  if (!state.libsReady) {
    showEmptyError(LIBRARY_ERROR);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
