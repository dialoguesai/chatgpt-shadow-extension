(() => {
  const DEBOUNCE_MS = 600;
  const NAV_POLL_MS = 800;

  let pendingThreadId = "";
  let lastHref = location.href;
  let debounceTimer = 0;
  let enabled = true;
  let lastFingerprint = "";
  // Set once the extension is reloaded out from under this injected script
  // ("Extension context invalidated"): it keeps running in the page but can no
  // longer reach the worker, so captures silently go nowhere until a tab reload.
  let contextLost = false;

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

    // The streaming flag is part of the fingerprint: the scan where a reply settles
    // is often identical in text, and the background only sends settled threads.
    const streaming = ChatGPTShadowExtract.isStreaming(document);
    const fingerprint = `${threadId}:${streaming ? 1 : 0}:${extracted
      .map((row) => `${row.id}:${row.content.length}`)
      .join("|")}`;
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;

    send({
      type: "shadow.upsert",
      enabled: true,
      conversation: {
        id: threadId,
        title: ChatGPTShadowExtract.extractTitle(document),
        url: location.href,
        streaming,
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
    // No runtime id means this injected script was orphaned by an extension
    // reload. It can never reach the worker again for the life of the page, so
    // stop pretending capture is live and ask the user to reload the tab.
    if (!chrome.runtime?.id) {
      markContextLost();
      return;
    }
    try {
      chrome.runtime.sendMessage(payload, () => {
        // "Extension context invalidated" surfaces here, not as a throw.
        if (chrome.runtime.lastError) markContextLost();
      });
    } catch {
      markContextLost();
    }
  }

  function markContextLost() {
    if (contextLost) return;
    contextLost = true;
    try {
      observer.disconnect();
    } catch {
      // Already gone.
    }
    paintChip();
  }

  function paintChip(visibleCount) {
    let chip = document.getElementById("cs-shadow-chip");
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "cs-shadow-chip";
      document.documentElement.appendChild(chip);
    }
    if (contextLost) {
      // The count would be a lie — those messages are reaching nothing.
      chip.textContent = "Shadow \u00b7 reload this tab";
      chip.dataset.state = "off";
      return;
    }
    const label = enabled ? "Shadow on" : "Shadow paused";
    const count = Number.isFinite(visibleCount) ? ` · ${visibleCount} on page` : "";
    chip.textContent = `${label}${count}`;
    chip.dataset.state = enabled ? "on" : "off";
  }
})();
