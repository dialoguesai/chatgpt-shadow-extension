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

  /**
   * The text a row is compared on, never the text it is stored as. A re-extract
   * that differs only in whitespace (line breaks, NBSP, a trailing space) is the
   * same message, so it must not clear the synced marker and resend.
   */
  function normalizeForCompare(text) {
    return String(text ?? "").replace(/\s+/g, " ").trim();
  }

  /**
   * Where each message id already lives. One message id belongs to one chat:
   * the first real thread it was captured under. `real` maps an id to that key;
   * `pending` maps an id to every pending: key still holding a copy.
   */
  function homeOf(messages) {
    const real = new Map();
    const pending = new Map();
    Object.keys(messages || {}).forEach((key) => {
      const rows = messages[key];
      if (!Array.isArray(rows)) return;
      const isPending = isPendingThreadId(key);
      rows.forEach((row) => {
        if (!row || !row.id) return;
        if (isPending) {
          if (!pending.has(row.id)) pending.set(row.id, new Set());
          pending.get(row.id).add(key);
        } else if (!real.has(row.id)) {
          real.set(row.id, key);
        }
      });
    });
    return { real, pending };
  }

  /** Rewrite a thread's index count after rows left it; drop the thread once it is empty. */
  function settleThread(next, key, rows) {
    if (rows.length) {
      next.messages[key] = rows;
      if (next.index[key]) next.index[key] = { ...next.index[key], messageCount: rows.length };
      return;
    }
    delete next.messages[key];
    delete next.index[key];
  }

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
    const threadIsPending = isPendingThreadId(threadId);
    // Built once, from the store as it stood before this capture.
    const home = homeOf(next.messages);
    // pending: key -> ids that resolved under this real thread and leave it.
    const leaving = new Map();

    incoming.forEach((message) => {
      const record = ChatGPTShadowExtract.toV1Record(threadId, message, message.created_at);
      // "dom" means the id is ChatGPT's own message id. "derived" means stableMessageId
      // fell back to a content hash, so the id changes when the text changes.
      const idSource = message.id ? "dom" : "derived";
      let prev = byId.get(record.id);
      if (!prev) {
        const realHome = home.real.get(record.id);
        // One message id belongs to one chat. A copy of a stored message seen under
        // another URL (a navigation race, a /share/ copy, a branch) is ignored, so
        // it can never be sent under a second thread id.
        if (realHome && realHome !== threadId) return;
      }
      if (!threadIsPending && home.pending.has(record.id)) {
        // The id now resolves under a real thread: take the parked copy along
        // (keeping its fields) and leave no copy behind under the placeholder.
        home.pending.get(record.id).forEach((key) => {
          if (!prev) {
            const parked = (next.messages[key] || []).find((row) => row && row.id === record.id);
            if (parked) prev = parked;
          }
          if (!leaving.has(key)) leaving.set(key, new Set());
          leaving.get(key).add(record.id);
        });
      }
      if (prev) {
        const contentChanged = normalizeForCompare(prev.content) !== normalizeForCompare(record.content);
        const merged = {
          ...prev,
          // Stored bytes stay as captured. A whitespace-only recapture keeps the old
          // bytes, so the local copy stays equal to what the node last received.
          content: contentChanged ? record.content : prev.content,
          role: record.role,
          // A capture never moves a row off its real thread; only a pending id
          // resolves here.
          thread_id: prev.thread_id && !isPendingThreadId(prev.thread_id) ? prev.thread_id : threadId,
          id_source: prev.id_source || idSource,
          updated_at: contentChanged ? now : prev.updated_at || now,
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

    leaving.forEach((ids, key) => {
      const kept = (next.messages[key] || []).filter((row) => !(row && ids.has(row.id)));
      settleThread(next, key, kept);
    });

    const rows = Array.from(byId.values());
    // Every message on the page already belongs to another chat: file nothing here.
    if (!rows.length && !next.index[threadId]) return next;
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

  /**
   * Fold a placeholder thread into the id the URL now supplies.
   *
   * options.ids  move only these message ids (the ones on the page at remap time).
   *              Rows not on the page stay under fromId: still pending, never sent.
   * A row whose id is already stored under a real thread is a stale copy of that
   * stored row and is dropped, whatever ids says.
   */
  function remapThread(state, fromId, toId, options) {
    if (!fromId || !toId || fromId === toId) return state;
    const opts = options || {};
    const only = Array.isArray(opts.ids) ? new Set(opts.ids.filter(Boolean)) : null;
    const next = {
      enabled: state.enabled,
      index: { ...state.index },
      messages: { ...state.messages },
    };
    const home = homeOf(next.messages);
    const fromRows = Array.isArray(next.messages[fromId]) ? next.messages[fromId] : [];
    const toRows = Array.isArray(next.messages[toId]) ? next.messages[toId] : [];
    const merged = [...toRows];
    const stay = [];
    const seen = new Set(toRows.map((row) => row.id));
    fromRows.forEach((row) => {
      if (!row) return;
      // Already stored under a real thread (toId or a third one): this is a stale
      // copy of that stored row, so it neither moves nor stays parked.
      const realHome = home.real.get(row.id);
      if (realHome && realHome !== fromId) return;
      if (only && !only.has(row.id)) {
        stay.push(row);
        return;
      }
      const moved = { ...row, thread_id: toId };
      if (seen.has(moved.id)) return;
      seen.add(moved.id);
      merged.push(moved);
    });
    const fromMeta = next.index[fromId] || {};
    const toMeta = next.index[toId] || {};
    settleThread(next, fromId, stay);
    if (!merged.length && !next.index[toId]) return next;
    next.messages[toId] = merged;
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
    return next;
  }

  /**
   * One-time correction for stores written before one-thread-per-id held.
   *
   * For an id stored under more than one thread with at least one real thread,
   * the home is the real copy captured first (created_at asc, then synced_at asc
   * with unsynced last, then key asc). Every other copy is removed. When a
   * wrong-thread copy reached the node no earlier than the home copy, the node now
   * holds that copy's thread_id, so the home row is marked `repair` and loses its
   * synced marker; its content becomes the content the node holds, so the resend
   * changes only the thread_id. A row whose real thread_id disagrees with its key
   * takes the key, and is marked for resend if it was already sent.
   *
   * Pure and idempotent: no clock, and a second run changes nothing.
   */
  function repairThreadIds(state) {
    const source = state.messages || {};
    const locations = new Map();
    Object.keys(source).forEach((key) => {
      const rows = source[key];
      if (!Array.isArray(rows)) return;
      rows.forEach((row, position) => {
        if (!row || !row.id) return;
        if (!locations.has(row.id)) locations.set(row.id, []);
        locations.get(row.id).push({ key, row, position });
      });
    });

    const drop = new Map(); // key -> Set of positions to remove
    const replace = new Map(); // key -> Map position -> row
    let repaired = 0;
    let removed = 0;
    const markDrop = (loc) => {
      if (!drop.has(loc.key)) drop.set(loc.key, new Set());
      drop.get(loc.key).add(loc.position);
      removed += 1;
    };
    const markReplace = (loc, row) => {
      if (!replace.has(loc.key)) replace.set(loc.key, new Map());
      replace.get(loc.key).set(loc.position, row);
    };
    const syncedOrLast = (row) => (row.synced_at ? Number(row.synced_at) : Infinity);

    locations.forEach((locs) => {
      const reals = locs.filter((loc) => !isPendingThreadId(loc.key));
      if (locs.length < 2 || !reals.length) return;
      const homeLoc = reals.slice().sort((a, b) => {
        const created = Number(a.row.created_at || 0) - Number(b.row.created_at || 0);
        if (created) return created;
        const synced = syncedOrLast(a.row) - syncedOrLast(b.row);
        if (synced && !Number.isNaN(synced)) return synced;
        if (a.key !== b.key) return a.key < b.key ? -1 : 1;
        return a.position - b.position;
      })[0];
      const others = locs.filter((loc) => loc !== homeLoc);
      const sentElsewhere = others.filter((loc) => !isPendingThreadId(loc.key) && loc.row.synced_at);
      const homeSynced = homeLoc.row.synced_at;
      const wrongOnNode = sentElsewhere.some(
        (loc) => !homeSynced || Number(loc.row.synced_at) >= Number(homeSynced)
      );
      others.forEach(markDrop);
      if (wrongOnNode) {
        const latest = sentElsewhere
          .slice()
          .sort((a, b) => Number(b.row.synced_at) - Number(a.row.synced_at))[0];
        const fixed = { ...homeLoc.row, thread_id: homeLoc.key, content: latest.row.content, repair: "thread_id" };
        delete fixed.synced_at;
        markReplace(homeLoc, fixed);
        repaired += 1;
      }
    });

    // A surviving row whose real thread_id disagrees with the thread holding it.
    Object.keys(source).forEach((key) => {
      const rows = source[key];
      if (!Array.isArray(rows) || isPendingThreadId(key)) return;
      rows.forEach((row, position) => {
        if (!row || !row.id) return;
        if (drop.has(key) && drop.get(key).has(position)) return;
        const current = (replace.has(key) && replace.get(key).get(position)) || row;
        if (!current.thread_id || isPendingThreadId(current.thread_id) || current.thread_id === key) return;
        const fixed = { ...current, thread_id: key };
        if (current.synced_at) {
          delete fixed.synced_at;
          fixed.repair = "thread_id";
          if (!current.repair) repaired += 1;
        }
        markReplace({ key, position }, fixed);
      });
    });

    if (!drop.size && !replace.size) {
      return { state, repaired: 0, removed: 0 };
    }

    const next = {
      enabled: state.enabled,
      index: { ...state.index },
      messages: { ...source },
    };
    new Set([...drop.keys(), ...replace.keys()]).forEach((key) => {
      const gone = drop.get(key) || new Set();
      const swapped = replace.get(key) || new Map();
      const rows = source[key]
        .map((row, position) => (gone.has(position) ? null : swapped.get(position) || row))
        .filter(Boolean);
      settleThread(next, key, rows);
    });
    return { state: next, repaired, removed };
  }

  function listConversations(state) {
    return Object.values(state.index || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function messageCount(state) {
    return Object.values(state.messages || {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
  }

  // What the page shows before ChatGPT names a thread. Not a title, so never sent as one.
  const PLACEHOLDER_TITLES = new Set(["untitled", "new chat", "chatgpt"]);

  function conversationTitle(state, threadId) {
    const meta = (state.index || {})[threadId];
    const title = String((meta && meta.title) || "").trim();
    return title && !PLACEHOLDER_TITLES.has(title.toLowerCase()) ? title : "";
  }

  /**
   * The one record shape this extension emits. The JSONL export and the Topos
   * write path share it so they cannot drift. The v1 fields are frozen; the
   * thread's title rides in `_metadata.conversation_title`, the key the engine's
   * ChatGPT parser already passes through, and is absent while the thread has none.
   */
  function toWireRecord(row, threadId, title) {
    const record = {
      id: row.id,
      thread_id: row.thread_id || threadId,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
    };
    if (title) record._metadata = { conversation_title: title };
    return record;
  }

  function toJsonl(state, threadId) {
    const ids = threadId ? [threadId] : Object.keys(state.messages || {});
    const lines = [];
    ids.forEach((id) => {
      const rows = state.messages[id] || [];
      rows.forEach((row) => {
        lines.push(JSON.stringify(toWireRecord(row, id, conversationTitle(state, id))));
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
   * options.repair          "hold" (default): hold thread-id corrections;
   *                         "include": send them with everything else (Send history);
   *                         "only": send nothing but them (Fix chat links)
   */
  function syncScan(state, options) {
    const opts = options || {};
    const includeDerived = opts.includeDerived === true;
    const since = Number.isFinite(opts.since) ? opts.since : 0;
    const skipStreaming = opts.skipStreaming !== false;
    const repair = opts.repair === "include" || opts.repair === "only" ? opts.repair : "hold";

    const records = [];
    const held = { pending: 0, streaming: 0, derived: 0, beforeBaseline: 0, repair: 0 };
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
        // A thread-id correction rewrites a row the node already holds, so it goes
        // only when the person presses Fix chat links or Send history.
        if (repair === "only" && !row.repair) return;
        if (repair === "hold" && row.repair) {
          held.repair += 1;
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
        records.push(toWireRecord(row, threadId, conversationTitle(state, threadId)));
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
        const stamped = { ...row, synced_at: stamp };
        delete stamped.repair;
        return stamped;
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
    normalizeForCompare,
    homeOf,
    upsert,
    remapThread,
    repairThreadIds,
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
