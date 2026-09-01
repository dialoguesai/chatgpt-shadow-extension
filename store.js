const ChatGPTShadowStore = (() => {
  const KEYS = {
    enabled: "cs_enabled",
    index: "cs_index",
    messages: "cs_messages",
  };

  function emptyState() {
    return { enabled: true, index: {}, messages: {} };
  }

  function normalizeState(raw) {
    const state = emptyState();
    if (!raw || typeof raw !== "object") return state;
    state.enabled = raw[KEYS.enabled] !== false;
    state.index = isPlain(raw[KEYS.index]) ? raw[KEYS.index] : {};
    state.messages = isPlain(raw[KEYS.messages]) ? raw[KEYS.messages] : {};
    return state;
  }

  function isPlain(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function upsert(state, conversation, incoming) {
    const next = {
      enabled: state.enabled,
      index: { ...state.index },
      messages: { ...state.messages },
    };
    const threadId = conversation.id;
    if (!threadId) return next;

    const existing = Array.isArray(next.messages[threadId]) ? next.messages[threadId].slice() : [];
    const byId = new Map(existing.map((row) => [row.id, row]));
    const now = Math.floor(Date.now() / 1000);

    incoming.forEach((message) => {
      const record = ChatGPTShadowExtract.toV1Record(threadId, message, message.created_at);
      const prev = byId.get(record.id);
      if (prev) {
        byId.set(record.id, {
          ...prev,
          content: record.content,
          role: record.role,
          thread_id: threadId,
          updated_at: now,
        });
        return;
      }
      byId.set(record.id, {
        ...record,
        created_at: record.created_at || now,
        updated_at: now,
      });
    });

    const rows = Array.from(byId.values());
    next.messages[threadId] = rows;
    next.index[threadId] = {
      id: threadId,
      title: conversation.title || (next.index[threadId] && next.index[threadId].title) || "Untitled",
      url: conversation.url || (next.index[threadId] && next.index[threadId].url) || "",
      createdAt: (next.index[threadId] && next.index[threadId].createdAt) || Date.now(),
      updatedAt: Date.now(),
      messageCount: rows.length,
      streaming: Boolean(conversation.streaming),
    };
    return next;
  }

  function remapThread(state, fromId, toId) {
    if (!fromId || !toId || fromId === toId) return state;
    const next = {
      enabled: state.enabled,
      index: { ...state.index },
      messages: { ...state.messages },
    };
    const fromRows = Array.isArray(next.messages[fromId]) ? next.messages[fromId] : [];
    const toRows = Array.isArray(next.messages[toId]) ? next.messages[toId] : [];
    const merged = [...toRows];
    const seen = new Set(toRows.map((row) => row.id));
    fromRows.forEach((row) => {
      const moved = { ...row, thread_id: toId };
      if (seen.has(moved.id)) return;
      seen.add(moved.id);
      merged.push(moved);
    });
    next.messages[toId] = merged;
    delete next.messages[fromId];
    const fromMeta = next.index[fromId] || {};
    const toMeta = next.index[toId] || {};
    next.index[toId] = {
      ...fromMeta,
      ...toMeta,
      id: toId,
      title: toMeta.title || fromMeta.title || "Untitled",
      url: toMeta.url || fromMeta.url || "",
      createdAt: Math.min(fromMeta.createdAt || Date.now(), toMeta.createdAt || Date.now()),
      updatedAt: Date.now(),
      messageCount: merged.length,
    };
    delete next.index[fromId];
    return next;
  }

  function listConversations(state) {
    return Object.values(state.index || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function messageCount(state) {
    return Object.values(state.messages || {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
  }

  function toJsonl(state, threadId) {
    const ids = threadId ? [threadId] : Object.keys(state.messages || {});
    const lines = [];
    ids.forEach((id) => {
      const rows = state.messages[id] || [];
      rows.forEach((row) => {
        lines.push(
          JSON.stringify({
            id: row.id,
            thread_id: row.thread_id || id,
            role: row.role,
            content: row.content,
            created_at: row.created_at,
          })
        );
      });
    });
    return lines.join("\n");
  }

  function serialize(state) {
    return {
      [KEYS.enabled]: state.enabled !== false,
      [KEYS.index]: state.index || {},
      [KEYS.messages]: state.messages || {},
    };
  }

  return {
    KEYS,
    emptyState,
    normalizeState,
    upsert,
    remapThread,
    listConversations,
    messageCount,
    toJsonl,
    serialize,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowStore = ChatGPTShadowStore;
}
