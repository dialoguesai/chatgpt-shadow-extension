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
  // Matches ChatGPTShadowStore.PENDING_THREAD_PREFIX: rows under it are held, not sent.
  const PENDING_PREFIX = "pending:";
  let lastUrlLocalId = "";
  // True while a conversation is open but nothing on it reads as a message —
  // what a ChatGPT markup change looks like. Mirrored to storage for the badge.
  let extractMiss = false;
  // ChatGPT renders the thread a beat after the URL settles; wait this long
  // before calling an empty conversation a miss.
  const MISS_GRACE_MS = 4000;
  let pageSeenAt = Date.now();

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
      pageSeenAt = Date.now();
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
    noteExtractHealth(extracted.length);
    paintChip(extracted.length);
    if (!enabled || !extracted.length) return;

    const urlId = ChatGPTShadowExtract.conversationIdFromUrl(location.href);
    const urlLocalId = ChatGPTShadowExtract.localConversationIdFromUrl(location.href);
    if (urlId && pendingThreadId) {
      // Only fold the placeholder into this conversation when it is provably the
      // same chat: an anonymous pending id (the old behaviour), the messages still
      // carry its local id, or the URL went straight from its local form to this one.
      // Otherwise the person navigated away and the rows stay under their own id.
      const pendingLocal = pendingThreadId.slice(PENDING_PREFIX.length);
      const sameChat =
        !pendingLocal.startsWith("local-chatgpt:") ||
        pendingLocal === lastUrlLocalId ||
        ChatGPTShadowExtract.localConversationIdsOnPage(document).includes(pendingLocal);
      if (sameChat) send({ type: "shadow.remap", fromId: pendingThreadId, toId: urlId });
      pendingThreadId = "";
    }
    if (!urlId) {
      if (urlLocalId) {
        const next = `${PENDING_PREFIX}${urlLocalId}`;
        // A new chat typed at chatgpt.com/ first, then given its local URL.
        if (pendingThreadId && !pendingThreadId.startsWith(`${PENDING_PREFIX}local-chatgpt:`)) {
          send({ type: "shadow.remap", fromId: pendingThreadId, toId: next });
        }
        pendingThreadId = next;
      } else if (!pendingThreadId) {
        pendingThreadId = `${PENDING_PREFIX}${Date.now()}`;
      }
    }
    lastUrlLocalId = urlLocalId;
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

  function noteExtractHealth(count) {
    const onConversation = Boolean(
      ChatGPTShadowExtract.conversationIdFromUrl(location.href) ||
        ChatGPTShadowExtract.localConversationIdFromUrl(location.href)
    );
    let miss = onConversation && count === 0;
    if (miss && Date.now() - pageSeenAt < MISS_GRACE_MS) {
      // Too early to judge; look again once the grace period has passed.
      window.setTimeout(scheduleScan, MISS_GRACE_MS);
      miss = false;
    }
    if (miss === extractMiss) return;
    extractMiss = miss;
    if (contextLost || !chrome.runtime?.id) return;
    try {
      if (miss) chrome.storage.local.set({ cs_extract_miss: { at: Date.now(), path: location.pathname } });
      else chrome.storage.local.remove("cs_extract_miss");
    } catch {
      // Orphaned script; send() will mark it on the next capture.
    }
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
    if (enabled && extractMiss) {
      // A chat is open and nothing reads as a message: ChatGPT changed its markup.
      chip.textContent = "Shadow \u00b7 can't read this chat";
      chip.dataset.state = "warn";
      return;
    }
    const label = enabled ? "Shadow on" : "Shadow paused";
    const count = Number.isFinite(visibleCount) ? ` · ${visibleCount} on page` : "";
    chip.textContent = `${label}${count}`;
    chip.dataset.state = enabled ? "on" : "off";
  }
})();
