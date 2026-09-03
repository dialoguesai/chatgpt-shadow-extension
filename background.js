importScripts("extract.js", "store.js", "lib/toposConfig.js", "lib/toposAuth.js", "lib/toposIngest.js");

const ToposConfig = ChatGPTShadowToposConfig;
const ToposAuth = ChatGPTShadowToposAuth;
const ToposIngest = ChatGPTShadowToposIngest;
const TOPOS_KEYS = ToposConfig.KEYS;

let writeQueue = Promise.resolve();
let syncQueue = Promise.resolve();
let syncRunning = false;
let connectRunning = false;
let sendFailureStreak = 0;
let autoSyncPending = false;
let autoSyncDirty = false;
/** Set after a failed send so the automatic path does not hammer a slow node. */
let nextAutoSyncAt = 0;

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
    }).then(() => {
      sendResponse({ ok: true });
      scheduleAutoSync();
    });
    return true;
  }

  if (message.type === "shadow.remap") {
    applyChange((state) => ChatGPTShadowStore.remapThread(state, message.fromId, message.toId)).then(() => {
      sendResponse({ ok: true });
      // The pending: rows just became addressable under the real conversation id.
      scheduleAutoSync();
    });
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

  if (message.type === "topos.status") {
    toposStatus().then(sendResponse);
    return true;
  }

  if (message.type === "topos.connect") {
    toposConnect().then(sendResponse);
    return true;
  }

  if (message.type === "topos.disconnect") {
    ToposAuth.disconnect()
      .then(() => refreshBadge())
      .then(() => toposStatus())
      .then(sendResponse);
    return true;
  }

  // User-initiated only. Sends every unsynced row, including content-hash ids.
  if (message.type === "topos.submitHistory") {
    queueSync("history").then(sendResponse);
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
  const stored = await chrome.storage.local.get({
    [TOPOS_KEYS.expired]: false,
    [TOPOS_KEYS.engineWarning]: false,
  });
  if (stored[TOPOS_KEYS.expired]) {
    await chrome.action.setBadgeBackgroundColor({ color: "#c00000" });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  if (stored[TOPOS_KEYS.engineWarning]) {
    await chrome.action.setBadgeBackgroundColor({ color: "#dd9900" });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  const count = ChatGPTShadowStore.messageCount(current);
  const text = current.enabled === false ? "off" : count > 999 ? "999+" : count ? String(count) : "";
  await chrome.action.setBadgeBackgroundColor({ color: current.enabled === false ? "#888888" : "#444444" });
  await chrome.action.setBadgeText({ text });
}

// --------------------------------------------------------------- topos ---

function broadcast(payload) {
  try {
    chrome.runtime.sendMessage(payload, () => {
      // No popup open is the normal case.
      void chrome.runtime.lastError;
    });
  } catch (_err) {
    // Popup closed mid-send.
  }
}

function autoOptions(auth) {
  // Automatic path: real message ids only, and only what was captured after the
  // account was attached. Anything older is backlog for the history button.
  return { includeDerived: false, since: auth.baselineAt || 0, skipStreaming: true };
}

function historyOptions() {
  return { includeDerived: true, since: 0, skipStreaming: true };
}

async function toposStatus() {
  const auth = await ToposAuth.read();
  const state = await readState();
  const history = ChatGPTShadowStore.syncScan(state, historyOptions());
  const auto = ChatGPTShadowStore.syncScan(state, autoOptions(auth));
  return {
    connected: auth.connected,
    expired: auth.expired,
    engineWarning: auth.engineWarning,
    connecting: connectRunning,
    syncing: syncRunning,
    controlPlaneUrl: auth.controlPlaneUrl,
    baselineAt: auth.baselineAt,
    queued: history.records.length,
    queuedNew: auto.records.length,
    held: history.held,
    synced: history.synced,
    receipt: auth.receipt,
    lastError: auth.lastError,
  };
}

async function toposConnect() {
  if (connectRunning) return { ok: false, error: "A connection attempt is already open." };
  connectRunning = true;
  try {
    await ToposAuth.connect();
    await refreshBadge();
    const status = await toposStatus();
    broadcast({ type: "topos.changed" });
    return { ok: true, status };
  } catch (err) {
    const error = (err && err.message) || String(err);
    await chrome.storage.local.set({ [TOPOS_KEYS.lastError]: error });
    broadcast({ type: "topos.changed" });
    return { ok: false, error };
  } finally {
    connectRunning = false;
  }
}

/**
 * One automatic run at a time. Captures that arrive mid-run set a dirty flag so a
 * settled reply is never left behind waiting for the next message.
 */
function scheduleAutoSync() {
  if (Date.now() < nextAutoSyncAt) return;
  if (autoSyncPending) {
    autoSyncDirty = true;
    return;
  }
  autoSyncPending = true;
  autoSyncDirty = false;
  queueSync("auto")
    .catch(() => {})
    .then(() => {
      autoSyncPending = false;
      if (!autoSyncDirty) return;
      autoSyncDirty = false;
      scheduleAutoSync();
    });
}

function queueSync(mode) {
  syncQueue = syncQueue.catch(() => {}).then(() => runSync(mode));
  return syncQueue;
}

async function setEngineWarning(show) {
  if (show) {
    await chrome.storage.local.set({ [TOPOS_KEYS.engineWarning]: true });
  } else {
    await chrome.storage.local.remove([TOPOS_KEYS.engineWarning]);
  }
  await refreshBadge();
}

function describeFailure(result) {
  if (!result) return "Send failed.";
  if (result.reason === "auth_expired") return "Topos rejected the token. Connect again.";
  if (result.reason === "unavailable") {
    return result.inFlight
      ? "Your node is still processing an earlier write. Unsent records stay queued here."
      : `Your node is not reachable right now (HTTP ${result.status}). Unsent records stay queued here.`;
  }
  if (result.reason === "network_error") return "No network connection to the Control Plane.";
  if (result.reason === "server_error") return `Control Plane error (HTTP ${result.status}).`;
  if (result.reason === "batch_too_large") return result.message || "Batch too large.";
  return "Send failed.";
}

/**
 * mode "auto"    new messages captured since the account was attached
 * mode "history" everything unsynced, user-initiated only
 */
async function runSync(mode) {
  const auth = await ToposAuth.read();
  if (!auth.connected) return { mode, skipped: "not_connected", total: 0, landed: 0, queued: 0, failed: 0 };

  // No baseline on record means the automatic path has no way to tell a new
  // message from the backlog. Stamp one now and send nothing this round, so a
  // stored history can never leave without the button.
  if (mode === "auto" && !auth.baselineAt) {
    await chrome.storage.local.set({ [TOPOS_KEYS.baselineAt]: Math.floor(Date.now() / 1000) });
    return { mode, skipped: "baseline_set", total: 0, landed: 0, queued: 0, failed: 0 };
  }

  const state = await readState();
  const scan = ChatGPTShadowStore.syncScan(state, mode === "history" ? historyOptions() : autoOptions(auth));
  const total = scan.records.length;
  if (!total) return { mode, total: 0, landed: 0, queued: 0, failed: 0, held: scan.held };

  const batches = ChatGPTShadowStore.chunkRecords(scan.records, ToposConfig.MAX_BATCH);
  let landed = 0;
  let queued = 0;
  let error = "";
  syncRunning = true;
  try {
    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      broadcast({ type: "topos.progress", mode, done: landed + queued, total, batch: i + 1, batches: batches.length });
      const result = await ToposIngest.send(batch);
      if (result.ok) {
        await applyChange((current) =>
          ChatGPTShadowStore.markSynced(current, batch, Math.floor(Date.now() / 1000))
        );
        if (result.queued) queued += batch.length;
        else landed += batch.length;
        // The node answered, so lift any backoff a previous failure put in place.
        nextAutoSyncAt = 0;
        if (sendFailureStreak) {
          sendFailureStreak = 0;
          await setEngineWarning(false);
        }
        continue;
      }
      error = describeFailure(result);
      if (result.reason === "auth_expired") {
        await ToposAuth.markExpired();
        await refreshBadge();
      } else {
        sendFailureStreak += 1;
        nextAutoSyncAt = Date.now() + ToposConfig.RETRY_BACKOFF_MS;
        // One-off races happen; only warn once the node is really not answering.
        if (sendFailureStreak >= 3) await setEngineWarning(true);
      }
      break;
    }
  } finally {
    syncRunning = false;
  }

  const receipt = {
    mode,
    total,
    landed,
    queued,
    failed: total - landed - queued,
    error,
    at: Date.now(),
  };
  await chrome.storage.local.set({ [TOPOS_KEYS.receipt]: receipt });
  broadcast({ type: "topos.done", receipt });
  return receipt;
}
