(() => {
  const DEBOUNCE_MS = 600;
  const NAV_POLL_MS = 800;

  let pendingThreadId = "";
  let lastHref = location.href;
  let debounceTimer = 0;
  let enabled = true;
  let lastFingerprint = "";

  chrome.storage.local.get({ cs_enabled: true }, (stored) => {
    enabled = stored.cs_enabled !== false;
    paintChip();
    scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.cs_enabled) return;
    enabled = changes.cs_enabled.newValue !== false;
    paintChip();
    if (enabled) scan();
  });

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  window.addEventListener("popstate", () => scheduleScan());
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastFingerprint = "";
      scheduleScan();
    }
  }, NAV_POLL_MS);

  scheduleScan();

  function scheduleScan() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(scan, DEBOUNCE_MS);
  }

  function scan() {
    if (/\/auth\//.test(location.pathname)) {
      paintChip();
      return;
    }

    const extracted = ChatGPTShadowExtract.extractMessages(document);
    paintChip(extracted.length);
    if (!enabled || !extracted.length) return;

    const urlId = ChatGPTShadowExtract.conversationIdFromUrl(location.href);
    if (urlId && pendingThreadId && pendingThreadId !== urlId) {
      send({ type: "shadow.remap", fromId: pendingThreadId, toId: urlId });
      pendingThreadId = "";
    }
    if (!urlId && !pendingThreadId) {
      pendingThreadId = `pending:${Date.now()}`;
    }
    const threadId = urlId || pendingThreadId;
    if (!threadId) return;

    const fingerprint = `${threadId}:${extracted.map((row) => `${row.id}:${row.content.length}`).join("|")}`;
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;

    send({
      type: "shadow.upsert",
      enabled: true,
      conversation: {
        id: threadId,
        title: ChatGPTShadowExtract.extractTitle(document),
        url: location.href,
        streaming: ChatGPTShadowExtract.isStreaming(document),
      },
      messages: extracted.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        index: row.index,
      })),
    });
  }

  function send(payload) {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage(payload, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension reload mid-page; next scan retries.
    }
  }

  function paintChip(visibleCount) {
    let chip = document.getElementById("cs-shadow-chip");
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "cs-shadow-chip";
      document.documentElement.appendChild(chip);
    }
    const label = enabled ? "Shadow on" : "Shadow paused";
    const count = Number.isFinite(visibleCount) ? ` · ${visibleCount} on page` : "";
    chip.textContent = `${label}${count}`;
    chip.dataset.state = enabled ? "on" : "off";
  }
})();
