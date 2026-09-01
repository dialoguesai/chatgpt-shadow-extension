importScripts("extract.js", "store.js");

let writeQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  refreshBadge();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;

  if (message.type === "shadow.upsert") {
    applyChange((state) => {
      if (message.enabled === false || state.enabled === false) return state;
      return ChatGPTShadowStore.upsert(state, message.conversation || {}, message.messages || []);
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "shadow.remap") {
    applyChange((state) => ChatGPTShadowStore.remapThread(state, message.fromId, message.toId)).then(() =>
      sendResponse({ ok: true })
    );
    return true;
  }

  if (message.type === "shadow.state") {
    readState().then((state) => {
      sendResponse({
        enabled: state.enabled,
        conversations: ChatGPTShadowStore.listConversations(state),
        messages: state.messages,
        messageCount: ChatGPTShadowStore.messageCount(state),
      });
    });
    return true;
  }

  if (message.type === "shadow.setEnabled") {
    applyChange((state) => ({ ...state, enabled: message.enabled !== false })).then((state) =>
      sendResponse({ ok: true, enabled: state.enabled })
    );
    return true;
  }

  if (message.type === "shadow.clear") {
    applyChange(() => ChatGPTShadowStore.emptyState()).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "shadow.export") {
    readState().then((state) => {
      sendResponse({ ok: true, jsonl: ChatGPTShadowStore.toJsonl(state, message.threadId) });
    });
    return true;
  }

  return undefined;
});

async function readState() {
  const raw = await chrome.storage.local.get({
    [ChatGPTShadowStore.KEYS.enabled]: true,
    [ChatGPTShadowStore.KEYS.index]: {},
    [ChatGPTShadowStore.KEYS.messages]: {},
  });
  return ChatGPTShadowStore.normalizeState(raw);
}

function applyChange(mutator) {
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      const next = mutator(await readState());
      await chrome.storage.local.set(ChatGPTShadowStore.serialize(next));
      await refreshBadge(next);
      return next;
    });
  return writeQueue;
}

async function refreshBadge(state) {
  const current = state || (await readState());
  const count = ChatGPTShadowStore.messageCount(current);
  const text = current.enabled === false ? "off" : count > 999 ? "999+" : count ? String(count) : "";
  await chrome.action.setBadgeBackgroundColor({ color: current.enabled === false ? "#888888" : "#444444" });
  await chrome.action.setBadgeText({ text });
}
