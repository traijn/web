/**
 * kimi.you — reusable in-page chat
 * ---------------------------------------------------------------------------
 * createChat(container, options) builds a small, self-contained conversation
 * panel. It deliberately knows nothing about models.html: pass it a WebLLM
 * engine, or a `complete` function, and it will stream a reply.
 *
 *   const chat = createChat(element, { engine });
 *   chat.setEngine(nextEngine);
 *   chat.setModelName("Qwen2 0.5B");
 *
 * The component uses the site's existing type, colour, and button styles.
 * Its markup is plain, readable HTML with live regions for screen readers.
 */

const DEFAULT_SUGGESTIONS = [
  "Explain WebGPU in two sentences.",
  "Write a haiku about a quiet morning.",
  "Draft a friendly reply to a dinner invitation.",
];

const DEFAULT_SYSTEM_PROMPT =
  "You are a concise, friendly assistant. Answer in plain language.";

const DEFAULT_NOTE =
  "Runs on your device. Nothing you type leaves your browser.";

let chatCounter = 0;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function describeGenerationError(error) {
  const raw = String(error?.message || error || "").trim();
  const lower = raw.toLowerCase();

  if (
    /out of memory|\boom\b|gpu buffer|buffer allocation|allocation failed|not enough memory|device (was )?lost/.test(
      lower,
    )
  ) {
    return {
      title: "Out of memory",
      message:
        "The browser ran out of memory while writing this reply. Close other tabs, or switch to a smaller model, then try again.",
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

/**
 * @param {HTMLElement} container
 * @param {{
 *   engine?: object | null,
 *   complete?: ((request: {
 *     messages: Array<{role: string, content: string}>,
 *     systemPrompt: string,
 *     signal?: AbortSignal,
 *     onToken?: (text: string) => void,
 *   }) => Promise<string | void>) | null,
 *   systemPrompt?: string,
 *   suggestions?: string[],
 *   emptyText?: string,
 *   note?: string,
 *   assistantName?: string,
 *   title?: string,
 *   maxTokens?: number,
 *   temperature?: number,
 *   formatError?: (error: unknown) => {title?: string, message?: string, detail?: string},
 * }} [options]
 */
export function createChat(container, options = {}) {
  if (!(container instanceof Element)) {
    throw new TypeError(
      "createChat(container, options): container must be a valid element.",
    );
  }

  const uid = `chat-${++chatCounter}`;
  const settings = {
    engine: options.engine || null,
    complete:
      typeof options.complete === "function" ? options.complete : null,
    systemPrompt:
      typeof options.systemPrompt === "string"
        ? options.systemPrompt
        : DEFAULT_SYSTEM_PROMPT,
    suggestions:
      Array.isArray(options.suggestions) && options.suggestions.length
        ? options.suggestions.slice(0, 3)
        : DEFAULT_SUGGESTIONS,
    emptyText:
      typeof options.emptyText === "string" && options.emptyText.trim()
        ? options.emptyText.trim()
        : "Nothing here yet. Ask a question, or start with one of these:",
    note: typeof options.note === "string" ? options.note : DEFAULT_NOTE,
    assistantName: options.assistantName || "Model",
    title: options.title || "Conversation",
    maxTokens: Number.isFinite(options.maxTokens) ? options.maxTokens : 512,
    temperature: Number.isFinite(options.temperature)
      ? options.temperature
      : 0.7,
    formatError:
      typeof options.formatError === "function"
        ? options.formatError
        : describeGenerationError,
  };

  const state = {
    history: [],
    generating: false,
    abortRequested: false,
    controller: null,
    runId: 0,
    destroyed: false,
  };

  const suggestions = settings.suggestions
    .map(
      (suggestion) =>
        `<li><button type="button" class="chat-suggestion">${escapeHtml(suggestion)}</button></li>`,
    )
    .join("");

  container.classList.add("chat-host");
  container.innerHTML = `
    <section class="chat" aria-label="Chat">
      <header class="chat-head">
        <div class="chat-heading">
          <p class="chat-title">${escapeHtml(settings.title)}</p>
          <p class="chat-model" data-chat-model>${escapeHtml(settings.assistantName)}</p>
        </div>
        <button type="button" class="text-button" data-chat-new>New chat</button>
      </header>

      <details class="chat-system">
        <summary>System prompt</summary>
        <div class="chat-system-body">
          <label class="chat-field-label" for="${uid}-system">Custom instructions</label>
          <textarea id="${uid}-system" class="chat-system-input" rows="2" spellcheck="false"></textarea>
          <p class="chat-field-hint">Used with your next message. Clear the field for no system prompt.</p>
        </div>
      </details>

      <div class="chat-log" data-chat-log role="log" aria-live="polite" aria-label="Conversation messages" tabindex="0">
        <div class="chat-empty" data-chat-empty>
          <p>${escapeHtml(settings.emptyText)}</p>
          <ul class="chat-suggestions" aria-label="Suggested prompts">
            ${suggestions}
          </ul>
        </div>
      </div>

      <div class="chat-error" data-chat-error role="alert" hidden>
        <p class="chat-error-label" data-chat-error-label>Something went wrong</p>
        <p class="chat-error-text" data-chat-error-text></p>
        <p class="chat-error-detail" data-chat-error-detail hidden></p>
        <div class="chat-error-actions">
          <button type="button" class="text-button" data-chat-retry>Try again</button>
        </div>
      </div>

      <form class="chat-form" data-chat-form>
        <label class="visually-hidden" for="${uid}-input">Message</label>
        <textarea id="${uid}-input" class="chat-input" data-chat-input rows="1" placeholder="Ask something…" enterkeyhint="send"></textarea>
        <div class="chat-form-actions">
          <button type="submit" class="button chat-send" data-chat-send>Send</button>
          <button type="button" class="button button-secondary chat-stop" data-chat-stop hidden>Stop</button>
        </div>
      </form>

      <p class="chat-note">${escapeHtml(settings.note)}</p>
    </section>
  `;

  const dom = {
    root: container.querySelector(".chat"),
    log: container.querySelector("[data-chat-log]"),
    empty: container.querySelector("[data-chat-empty]"),
    form: container.querySelector("[data-chat-form]"),
    input: container.querySelector("[data-chat-input]"),
    send: container.querySelector("[data-chat-send]"),
    stop: container.querySelector("[data-chat-stop]"),
    newChat: container.querySelector("[data-chat-new]"),
    system: container.querySelector(`#${uid}-system`),
    model: container.querySelector("[data-chat-model]"),
    error: container.querySelector("[data-chat-error]"),
    errorLabel: container.querySelector("[data-chat-error-label]"),
    errorText: container.querySelector("[data-chat-error-text]"),
    errorDetail: container.querySelector("[data-chat-error-detail]"),
    retry: container.querySelector("[data-chat-retry]"),
  };

  dom.system.value = settings.systemPrompt;
  dom.model.textContent = settings.assistantName;

  /* ------------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------------ */

  function autosize() {
    dom.input.style.height = "auto";
    dom.input.style.height = `${Math.min(dom.input.scrollHeight, 160)}px`;
  }

  function scrollToBottom(force = false) {
    if (!dom.log) {
      return;
    }

    const nearBottom =
      dom.log.scrollHeight - dom.log.scrollTop - dom.log.clientHeight < 96;

    if (force || nearBottom) {
      dom.log.scrollTop = dom.log.scrollHeight;
    }
  }

  function setGenerating(value) {
    state.generating = value;
    dom.send.hidden = false;
    dom.send.disabled = value;
    dom.stop.hidden = !value;
    dom.stop.disabled = false;
    dom.stop.textContent = "Stop";
    dom.log.setAttribute("aria-busy", value ? "true" : "false");
  }

  function hideError() {
    dom.error.hidden = true;
    dom.errorText.textContent = "";
    dom.errorDetail.textContent = "";
    dom.errorDetail.hidden = true;
    dom.retry.hidden = false;
  }

  function showError(info, canRetry = true) {
    const title =
      info && typeof info === "object" && info.title
        ? info.title
        : "Something went wrong";
    const message =
      info && typeof info === "object"
        ? info.message || ""
        : String(info || "");
    const detail =
      info && typeof info === "object" && info.detail ? info.detail : "";

    dom.errorLabel.textContent = title;
    dom.errorText.textContent = message;
    dom.errorDetail.textContent = detail;
    dom.errorDetail.hidden = !detail;
    dom.retry.hidden = !canRetry;
    dom.error.hidden = false;
  }

  function appendMessage(role, label, text) {
    const article = document.createElement("article");
    article.className = `chat-message chat-message-${role}`;
    article.dataset.role = role;

    const heading = document.createElement("p");
    heading.className = "chat-message-label";
    heading.textContent = label;

    const body = document.createElement("div");
    body.className = "chat-message-body";
    body.textContent = text || "";

    article.append(heading, body);
    dom.log.appendChild(article);
    return { article, body };
  }

  function appendNote(article, text) {
    const note = document.createElement("p");
    note.className = "chat-message-note";
    note.textContent = text;
    article.appendChild(note);
  }

  function buildMessages() {
    const messages = [];
    const system = dom.system.value.trim();

    if (system) {
      messages.push({ role: "system", content: system });
    }

    return messages.concat(
      state.history.map(({ role, content }) => ({ role, content })),
    );
  }

  function removeLastAssistant() {
    const last = state.history[state.history.length - 1];

    if (!last || last.role !== "assistant") {
      return;
    }

    state.history.pop();

    const messages = dom.log.querySelectorAll(".chat-message");
    const node = messages[messages.length - 1];

    if (node && node.dataset.role === "assistant") {
      node.remove();
    }
  }

  /* ------------------------------------------------------------------------
     Generation
     ------------------------------------------------------------------------ */

  async function runAssistant() {
    if (state.destroyed || state.generating) {
      return;
    }

    const engine = settings.engine;

    if (!engine && !settings.complete) {
      showError(
        {
          title: "Model not ready",
          message: "Load a model before sending a message.",
        },
        false,
      );
      return;
    }

    const messages = buildMessages();

    if (!messages.some((message) => message.role === "user")) {
      return;
    }

    hideError();

    const runId = ++state.runId;
    state.abortRequested = false;
    state.controller =
      typeof AbortController === "function" ? new AbortController() : null;
    setGenerating(true);
    dom.empty.hidden = true;

    const entry = { role: "assistant", content: "" };
    state.history.push(entry);

    const { article, body } = appendMessage(
      "assistant",
      settings.assistantName,
      "",
    );
    body.setAttribute("aria-busy", "true");

    const textNode = document.createTextNode("");
    body.appendChild(textNode);

    const appendToken = (token) => {
      if (typeof token !== "string" || !token) {
        return;
      }

      entry.content += token;
      textNode.appendData(token);
      scrollToBottom();
    };

    let failure = null;

    try {
      if (engine) {
        const stream = await engine.chat.completions.create({
          messages,
          stream: true,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
        });

        for await (const chunk of stream) {
          if (
            state.destroyed ||
            state.abortRequested ||
            runId !== state.runId
          ) {
            break;
          }

          const delta = chunk?.choices?.[0]?.delta?.content;

          if (typeof delta === "string") {
            appendToken(delta);
          }
        }
      } else {
        const result = await settings.complete({
          messages,
          systemPrompt: dom.system.value.trim(),
          signal: state.controller?.signal,
          onToken: (token) => {
            if (
              !state.destroyed &&
              !state.abortRequested &&
              runId === state.runId
            ) {
              appendToken(token);
            }
          },
        });

        if (
          typeof result === "string" &&
          !entry.content &&
          !state.abortRequested &&
          runId === state.runId
        ) {
          appendToken(result);
        }
      }
    } catch (error) {
      failure = error;
    }

    // A reset or a newer run has taken over. Leave its interface alone.
    if (state.destroyed || runId !== state.runId) {
      return;
    }

    const wasAborted = state.abortRequested;

    state.generating = false;
    state.abortRequested = false;
    state.controller = null;
    setGenerating(false);
    body.removeAttribute("aria-busy");

    if (failure && !wasAborted) {
      if (!entry.content.trim()) {
        state.history.pop();
        article.remove();
      } else {
        appendNote(article, "The reply stopped early.");
      }

      const info = settings.formatError(failure) || {};
      showError(info, true);
      dom.input.focus({ preventScroll: true });
      return;
    }

    if (!entry.content.trim()) {
      state.history.pop();
      article.remove();

      if (!wasAborted) {
        showError(
          {
            title: "Empty reply",
            message: "The model returned nothing. Try again.",
          },
          true,
        );
      }

      dom.input.focus({ preventScroll: true });
      return;
    }

    if (wasAborted) {
      appendNote(article, "Stopped.");
    }

    scrollToBottom();
    dom.input.focus({ preventScroll: true });
  }

  function sendMessage(text) {
    hideError();
    state.history.push({ role: "user", content: text });
    appendMessage("user", "You", text);
    dom.empty.hidden = true;
    dom.input.value = "";
    autosize();
    scrollToBottom(true);
    runAssistant();
  }

  /* ------------------------------------------------------------------------
     Public actions
     ------------------------------------------------------------------------ */

  async function stop() {
    if (!state.generating) {
      return;
    }

    state.abortRequested = true;
    dom.stop.disabled = true;
    dom.stop.textContent = "Stopping…";

    try {
      state.controller?.abort();
    } catch (error) {
      // Some browsers reject an already-settled signal; nothing to do.
    }

    try {
      await settings.engine?.interruptGenerate?.();
    } catch (error) {
      // The stream will settle on its own if interruption is unsupported.
    }
  }

  async function reset() {
    state.runId += 1;
    state.abortRequested = true;

    try {
      state.controller?.abort();
    } catch (error) {
      // Ignore an already-aborted request.
    }

    try {
      await settings.engine?.interruptGenerate?.();
    } catch (error) {
      // A stopped engine needs no further interruption.
    }

    state.generating = false;
    state.abortRequested = false;
    state.controller = null;
    state.history = [];

    dom.log.querySelectorAll(".chat-message").forEach((node) => node.remove());
    dom.empty.hidden = false;
    dom.input.value = "";
    dom.input.style.height = "auto";
    hideError();
    setGenerating(false);

    try {
      await settings.engine?.resetChat?.();
    } catch (error) {
      // Not every engine implementation exposes resetChat.
    }

    autosize();
    dom.input.focus({ preventScroll: true });
  }

  function retry() {
    if (state.generating) {
      return;
    }

    hideError();
    removeLastAssistant();

    if (!state.history.some((message) => message.role === "user")) {
      showError(
        {
          title: "Nothing to retry",
          message: "Send a message first, then try again.",
        },
        false,
      );
      return;
    }

    runAssistant();
  }

  function setEngine(nextEngine) {
    settings.engine = nextEngine || null;
  }

  function setModelName(name) {
    settings.assistantName = name || "Model";
    dom.model.textContent = settings.assistantName;
  }

  function focus(focusOptions) {
    dom.input.focus(focusOptions);
  }

  function destroy() {
    state.destroyed = true;
    state.runId += 1;
    state.abortRequested = true;

    try {
      state.controller?.abort();
    } catch (error) {
      // Ignore an already-aborted request.
    }

    try {
      settings.engine?.interruptGenerate?.();
    } catch (error) {
      // The engine may already be unloaded.
    }

    container.replaceChildren();
    container.classList.remove("chat-host");
  }

  /* ------------------------------------------------------------------------
     Events
     ------------------------------------------------------------------------ */

  dom.form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (state.generating) {
      return;
    }

    const text = dom.input.value.trim();

    if (text) {
      sendMessage(text);
    }
  });

  dom.input.addEventListener("input", autosize);

  dom.input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.generating) {
      event.preventDefault();
      void stop();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    // Do not send while an IME is composing (Japanese, Chinese, etc.).
    if (event.isComposing || event.keyCode === 229) {
      return;
    }

    event.preventDefault();

    if (!state.generating) {
      dom.form.requestSubmit();
    }
  });

  dom.stop.addEventListener("click", () => {
    void stop();
  });

  dom.retry.addEventListener("click", retry);

  dom.newChat.addEventListener("click", () => {
    void reset();
  });

  dom.empty.addEventListener("click", (event) => {
    const button = event.target.closest(".chat-suggestion");

    if (!button || state.generating) {
      return;
    }

    const text = button.textContent.trim();

    if (text) {
      sendMessage(text);
    }
  });

  autosize();

  return {
    element: dom.root,
    setEngine,
    setModelName,
    reset,
    stop,
    retry,
    focus,
    destroy,
    isGenerating: () => state.generating,
    getHistory: () => state.history.map((message) => ({ ...message })),
  };
}
