const ChatGPTShadowStore = (() => {
  const KEYS = {
    enabled: "cs_enabled",
    index: "cs_index",
    messages: "cs_messages",
  };

  /** A thread id we invented because the URL had none yet. Never leaves the machine. */
  const PENDING_THREAD_PREFIX = "pending:";

  /** A message id we derived from a content hash because the DOM carried none. */
  const DERIVED_ID_PREFIX = "shadow:";

  /** Hard cap on records per outbound request. */
  const MAX_BATCH = 200;

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
      // "dom" means the id is ChatGPT's own message id. "derived" means stableMessageId
      // fell back to a content hash, so the id changes when the text changes.
      const idSource = message.id ? "dom" : "derived";
      const prev = byId.get(record.id);
      if (prev) {
        const contentChanged = prev.content !== record.content;
        const merged = {
          ...prev,
          content: record.content,
          role: record.role,
          thread_id: threadId,
          id_source: prev.id_source || idSource,
          updated_at: now,
        };
        // Text moved on after the row was sent: drop the marker so the new text is
        // resent. app_ingest keys on the record id, so the resend collapses.
        if (contentChanged) delete merged.synced_at;
        byId.set(record.id, merged);
        return;
      }
      byId.set(record.id, {
        ...record,
        id_source: idSource,
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

  /**
   * The one record shape this extension emits. The JSONL export and the Topos
   * write path share it so they cannot drift; the field set is frozen.
   */
  function toWireRecord(row, threadId) {
    return {
      id: row.id,
      thread_id: row.thread_id || threadId,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
    };
  }

  function toJsonl(state, threadId) {
    const ids = threadId ? [threadId] : Object.keys(state.messages || {});
    const lines = [];
    ids.forEach((id) => {
      const rows = state.messages[id] || [];
      rows.forEach((row) => {
        lines.push(JSON.stringify(toWireRecord(row, id)));
      });
    });
    return lines.join("\n");
  }

  function isPendingThreadId(threadId) {
    return String(threadId || "").startsWith(PENDING_THREAD_PREFIX);
  }

  /** True when the row's id came from a content hash rather than from ChatGPT. */
  function isDerivedRow(row) {
    if (!row) return false;
    if (typeof row === "string") return row.startsWith(DERIVED_ID_PREFIX);
    if (row.id_source) return row.id_source === "derived";
    return String(row.id || "").startsWith(DERIVED_ID_PREFIX);
  }

  function isThreadStreaming(state, threadId) {
    const meta = (state.index || {})[threadId];
    return Boolean(meta && meta.streaming);
  }

  /**
   * Walk the store and split rows into "safe to send now" and "held, and why".
   *
   * options.includeDerived  send rows whose id is a content hash (history submit only)
   * options.since           only rows first seen at or after this unix second
   * options.skipStreaming   hold rows in a thread whose reply is still streaming
   */
  function syncScan(state, options) {
    const opts = options || {};
    const includeDerived = opts.includeDerived === true;
    const since = Number.isFinite(opts.since) ? opts.since : 0;
    const skipStreaming = opts.skipStreaming !== false;

    const records = [];
    const held = { pending: 0, streaming: 0, derived: 0, beforeBaseline: 0 };
    let synced = 0;

    Object.keys(state.messages || {}).forEach((threadId) => {
      const rows = Array.isArray(state.messages[threadId]) ? state.messages[threadId] : [];
      const streaming = skipStreaming && isThreadStreaming(state, threadId);
      rows.forEach((row) => {
        if (!row || !row.id) return;
        if (row.synced_at) {
          synced += 1;
          return;
        }
        // Rule 1: a pending: thread id is a local placeholder. Sending it would
        // strand records under an id that never becomes real, so hold the row
        // until remapThread merges it into the conversation id from the URL.
        if (isPendingThreadId(threadId) || isPendingThreadId(row.thread_id)) {
          held.pending += 1;
          return;
        }
        // Rule 2: a streaming reply is still being written. Wait for it to settle.
        if (streaming) {
          held.streaming += 1;
          return;
        }
        // Rule 3: a content-hash id changes identity when the text is edited, so
        // it would double-write. Automatic send skips it; history submit may take it.
        if (!includeDerived && isDerivedRow(row)) {
          held.derived += 1;
          return;
        }
        // created_at has one-second resolution, so a row stamped in the same second
        // as the connection is treated as backlog rather than risk sending it.
        if (since && Number(row.created_at || 0) <= since) {
          held.beforeBaseline += 1;
          return;
        }
        records.push(toWireRecord(row, threadId));
      });
    });

    records.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    return { records, held, synced };
  }

  function selectUnsynced(state, options) {
    return syncScan(state, options).records;
  }

  function countUnsynced(state, options) {
    return syncScan(state, options).records.length;
  }

  function chunkRecords(records, size) {
    const limit = Number.isFinite(size) && size > 0 ? Math.min(size, MAX_BATCH) : MAX_BATCH;
    const rows = Array.isArray(records) ? records : [];
    const batches = [];
    for (let i = 0; i < rows.length; i += limit) {
      batches.push(rows.slice(i, i + limit));
    }
    return batches;
  }

  /**
   * Rule 4: stamp synced_at so a row is never sent twice. A row whose text moved
   * on since the send is left alone, so the newer text goes out on the next run.
   */
  function markSynced(state, records, syncedAt) {
    const stamp = Number.isFinite(syncedAt) ? syncedAt : Math.floor(Date.now() / 1000);
    const wanted = new Map();
    (Array.isArray(records) ? records : []).forEach((record) => {
      if (!record || !record.id) return;
      wanted.set(`${record.thread_id || ""}\u0000${record.id}`, record.content);
    });
    const next = {
      enabled: state.enabled,
      index: { ...state.index },
      messages: { ...state.messages },
    };
    if (!wanted.size) return next;
    Object.keys(next.messages).forEach((threadId) => {
      const rows = next.messages[threadId];
      if (!Array.isArray(rows)) return;
      let changed = false;
      const updated = rows.map((row) => {
        if (!row || !row.id) return row;
        const key = `${row.thread_id || threadId}\u0000${row.id}`;
        if (!wanted.has(key)) return row;
        if (wanted.get(key) !== row.content) return row;
        changed = true;
        return { ...row, synced_at: stamp };
      });
      if (changed) next.messages[threadId] = updated;
    });
    return next;
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
    PENDING_THREAD_PREFIX,
    DERIVED_ID_PREFIX,
    MAX_BATCH,
    emptyState,
    normalizeState,
    upsert,
    remapThread,
    listConversations,
    messageCount,
    toWireRecord,
    toJsonl,
    isPendingThreadId,
    isDerivedRow,
    isThreadStreaming,
    syncScan,
    selectUnsynced,
    countUnsynced,
    chunkRecords,
    markSynced,
    serialize,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowStore = ChatGPTShadowStore;
}
