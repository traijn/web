/**
 * kimi.you — small models, loaded locally
 * ---------------------------------------------------------------------------
 * Everything here runs in the browser. This module owns four things:
 *
 *   - the model catalogue shown on models.html
 *   - WebGPU detection, so the page can fail gently
 *   - lazy loading of WebLLM from a pinned CDN URL
 *   - loading, unloading, and clearing model caches
 *
 * WebLLM is imported only when it is actually needed. That keeps the page
 * usable (and readable) even when the CDN, the GPU, or the network is not.
 */

export const WEBLLM_URL =
  "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.88/+esm";

/**
 * Sizes are approximate download totals, not memory use. The 3B model is
 * marked for desktop use because it needs a comfortable amount of GPU memory.
 */
export const MODELS = [
  {
    id: "Qwen2-0.5B-Instruct-q4f16_1-MLC",
    name: "Qwen2 0.5B",
    params: "0.5B",
    size: "~290 MB",
    note: "Quick drafts, short summaries, and one-line answers on modest hardware.",
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    desktopOnly: false,
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 1B",
    params: "1B",
    size: "~705 MB",
    note: "A steadier writer for rewrites, explanations, and everyday conversation.",
    license: "Llama 3.2 Community License",
    licenseUrl: "https://www.llama.com/llama3_2/license/",
    desktopOnly: false,
  },
  {
    id: "Qwen2-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen2 1.5B",
    params: "1.5B",
    size: "~880 MB",
    note: "Better reasoning and longer answers, still comfortable in a laptop browser.",
    license: "Apache-2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    desktopOnly: false,
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 3B",
    params: "3B",
    size: "~1.8 GB",
    note: "The strongest model here: careful explanations and longer conversations.",
    license: "Llama 3.2 Community License",
    licenseUrl: "https://www.llama.com/llama3_2/license/",
    desktopOnly: true,
  },
];

let webllmPromise = null;
let engine = null;
let loadedModelId = null;

const clamp01 = (value) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function getModel(modelId) {
  return MODELS.find((model) => model.id === modelId) || null;
}

/**
 * Import WebLLM once, and retry cleanly if the first attempt failed.
 */
export function loadWebLLM() {
  if (!webllmPromise) {
    webllmPromise = import(WEBLLM_URL).catch((error) => {
      webllmPromise = null;
      const wrapped = new Error(
        "The WebLLM library could not be downloaded. Check your connection and try again.",
      );
      wrapped.cause = error;
      throw wrapped;
    });
  }

  return webllmPromise;
}

/**
 * WebGPU is required by WebLLM. Missing support is a normal outcome, not an
 * error: return a message the page can show without breaking.
 */
export async function detectWebGPU() {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    return {
      supported: false,
      title: "WebGPU is not available",
      message:
        "This browser cannot run models in the page yet. WebGPU is available in recent versions of Chrome, Edge, and Safari; a desktop browser usually has the most room for them.",
    };
  }

  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return {
      supported: false,
      title: "A secure page is required",
      message:
        "WebGPU only runs on HTTPS or localhost. Open this page from its secure address and reload.",
    };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();

    if (!adapter) {
      return {
        supported: false,
        title: "No graphics adapter found",
        message:
          "WebGPU is present, but this device did not offer a compatible graphics adapter. Try another browser, update your graphics drivers, or use a different device.",
      };
    }

    return { supported: true, adapter };
  } catch (error) {
    return {
      supported: false,
      title: "WebGPU could not start",
      message:
        "The browser found WebGPU but could not open a graphics device. Reload the page, or try another browser.",
      detail: String(error?.message || error || ""),
    };
  }
}

export function getEngine() {
  return engine;
}

export function getLoadedModelId() {
  return loadedModelId;
}

export function isModelLoaded(modelId) {
  return Boolean(engine && loadedModelId === modelId);
}

/**
 * Download a model and keep its engine in memory. Only one model is held at a
 * time; loading another one releases the previous model first.
 *
 * @param {string} modelId
 * @param {(report: {progress: number, text: string}) => void} [onProgress]
 */
export async function loadModel(modelId, onProgress) {
  const model = getModel(modelId);

  if (!model) {
    throw new Error(`Unknown model: ${modelId}`);
  }

  const webllm = await loadWebLLM();

  await unloadModel();

  const progress = (report) => {
    if (typeof onProgress !== "function") {
      return;
    }

    onProgress({
      progress: clamp01(Number(report?.progress)),
      text:
        typeof report?.text === "string" && report.text.trim()
          ? report.text.trim()
          : "",
    });
  };

  const nextEngine = await webllm.CreateMLCEngine(modelId, {
    appConfig: webllm.prebuiltAppConfig,
    initProgressCallback: progress,
  });

  engine = nextEngine;
  loadedModelId = modelId;
  return nextEngine;
}

/**
 * Release the current model. Safe to call when nothing is loaded.
 */
export async function unloadModel() {
  const current = engine;

  engine = null;
  loadedModelId = null;

  if (!current) {
    return;
  }

  try {
    await current.unload();
  } catch (error) {
    // A disposed engine is not worth blocking the page over.
  }
}

/**
 * Check which of the four models are already stored on this device.
 * Returns a map of model id to boolean.
 */
export async function checkCachedModels() {
  const webllm = await loadWebLLM();
  const appConfig = webllm.prebuiltAppConfig;
  const cached = {};

  await Promise.all(
    MODELS.map(async (model) => {
      try {
        cached[model.id] = await webllm.hasModelInCache(model.id, appConfig);
      } catch (error) {
        cached[model.id] = false;
      }
    }),
  );

  return cached;
}

/**
 * Remove the downloaded files for the models on this page. Returns the number
 * of model records that were present and deleted.
 */
export async function clearModelCache() {
  const webllm = await loadWebLLM();
  const appConfig = webllm.prebuiltAppConfig;
  let cleared = 0;
  const failures = [];

  for (const model of MODELS) {
    try {
      if (await webllm.hasModelInCache(model.id, appConfig)) {
        await webllm.deleteModelAllInfoInCache(model.id, appConfig);
        cleared += 1;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length) {
    const error = new Error(
      "Some cached files could not be removed. Reload the page and try again.",
    );
    error.cause = failures[0];
    throw error;
  }

  return cleared;
}

/**
 * Turn a technical failure into something readable. The raw message is kept
 * as a short detail line so the page can still be useful when debugging.
 */
export function describeError(error, { phase = "load", model = null } = {}) {
  const raw = String(error?.message || error || "").trim();
  const lower = raw.toLowerCase();

  const memory =
    /out of memory|\boom\b|gpu buffer|buffer allocation|allocation failed|not enough memory|device (was )?lost|exceeds the (maximum|limit)/.test(
      lower,
    );
  const network =
    /failed to fetch|network|fetch failed|load failed|could not be downloaded|download failed|unable to download|\b404\b|ssl|certificate|integrity|timed out|timeout/.test(
      lower,
    );
  const graphics = /webgpu|adapter|requestadapter|navigator\.gpu/.test(lower);

  if (lower.includes("webllm library")) {
    return {
      title: "Library unavailable",
      message:
        raw ||
        "The WebLLM library could not be downloaded. Check your connection and reload the page.",
      detail: "",
    };
  }

  if (phase === "generation") {
    if (memory) {
      return {
        title: "Out of memory",
        message:
          "The browser ran out of memory while writing this reply. Close other tabs, load a smaller model, and try again.",
        detail: raw.slice(0, 280),
      };
    }

    return {
      title: "Reply interrupted",
      message:
        "The reply stopped unexpectedly. Your conversation is still here, so you can try again.",
      detail: raw.slice(0, 280),
    };
  }

  if (phase === "cache") {
    return {
      title: "Cache not cleared",
      message:
        "The downloaded files could not be removed. Reload the page and try again.",
      detail: raw.slice(0, 280),
    };
  }

  if (phase === "library") {
    return {
      title: "Library unavailable",
      message:
        "The WebLLM library could not be downloaded. Check your connection, then reload the page.",
      detail: raw.slice(0, 280),
    };
  }

  const label = model?.name ? model.name : "This model";

  if (memory) {
    return {
      title: "Not enough memory",
      message: `${label} needs more graphics memory than this browser could provide. Close other tabs, or try the 0.5B model.`,
      detail: raw.slice(0, 280),
    };
  }

  if (network) {
    return {
      title: "Download failed",
      message:
        "The model files could not be downloaded. Check your connection and try again — the files already saved will be reused.",
      detail: raw.slice(0, 280),
    };
  }

  if (graphics) {
    return {
      title: "Graphics device stopped",
      message:
        "The browser lost its WebGPU connection while loading. Reload the page and try again.",
      detail: raw.slice(0, 280),
    };
  }

  return {
    title: "Model did not load",
    message: `Something interrupted ${label}. Try again, or choose a smaller model.`,
    detail: raw.slice(0, 280),
  };
}
