importScripts(
  "extract.js",
  "store.js",
  "lib/toposConfig.js",
  "lib/toposAuth.js",
  "lib/toposLocal.js",
  "lib/toposIngest.js"
);

const ToposConfig = ChatGPTShadowToposConfig;
const ToposAuth = ChatGPTShadowToposAuth;
const ToposLocal = ChatGPTShadowToposLocal;
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

const REPAIR_RECEIPT_KEY = "cs_repair_receipt";

chrome.runtime.onInstalled.addListener(() => {
  repairStore().finally(() => refreshBadge());
});

chrome.runtime.onStartup.addListener(() => {
  repairStore().finally(() => refreshBadge());
});

/**
 * Move copies of a message filed under a second chat into the local archive, and
 * mark the rows whose correction the node still needs. Idempotent, so it runs on
 * every install and startup. Nothing is sent from here: corrections wait for Fix
 * chat links. The archive is written before the store, so an interrupted run
 * never loses a copy. The receipt holds counts only.
 */
function repairStore() {
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      const state = await readState();
      const result = ChatGPTShadowStore.repairThreadIds(state);
      if (result.state === state) return;
      const archiveKey = ChatGPTShadowStore.KEYS.archive;
      const stored = await chrome.storage.local.get({ [archiveKey]: {} });
      await chrome.storage.local.set({
        [archiveKey]: ChatGPTShadowStore.mergeArchive(stored[archiveKey], result.archive),
      });
      await chrome.storage.local.set(ChatGPTShadowStore.serialize(result.state));
      const nodeSide = ChatGPTShadowStore.nodeSideCounts(result.state);
      await chrome.storage.local.set({
        [REPAIR_RECEIPT_KEY]: {
          repaired: result.repaired,
          removed: result.removed,
          nodeSide: nodeSide.total,
          nodeSideMismatch: nodeSide.mismatch,
          at: Date.now(),
        },
      });
    });
  return writeQueue.catch(() => {});
}

// The content script sets cs_extract_miss while a chat is open but nothing on it
// reads as a message, so a ChatGPT markup change shows on the badge, not just in-page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.cs_extract_miss) refreshBadge();
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
    applyChange((state) =>
      ChatGPTShadowStore.remapThread(state, message.fromId, message.toId, {
        ids: Array.isArray(message.ids) ? message.ids : undefined,
      })
    ).then(() => {
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
    // Clear deletes every local copy, the repair archive included.
    applyChange(() => ChatGPTShadowStore.emptyState())
      .then(() => chrome.storage.local.remove([ChatGPTShadowStore.KEYS.archive, REPAIR_RECEIPT_KEY]))
      .then(() => sendResponse({ ok: true }));
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

  // The key arrives from the popup and goes straight to storage once the node
  // accepts it. It is never logged and never sent back.
  if (message.type === "topos.localConnect") {
    toposLocalConnect(message.key, message.url).then(sendResponse);
    return true;
  }

  // Forgets the account token and the local key alike: Disconnect stops all sending.
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

  // User-initiated only. Resends just the rows whose thread id was corrected.
  if (message.type === "topos.submitRepair") {
    queueSync("repair").then(sendResponse);
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
    [TOPOS_KEYS.localRefusal]: null,
    cs_extract_miss: null,
  });
  if (stored[TOPOS_KEYS.expired]) {
    await chrome.action.setBadgeBackgroundColor({ color: "#c00000" });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  if (stored[TOPOS_KEYS.engineWarning] || stored[TOPOS_KEYS.localRefusal]) {
    await chrome.action.setBadgeBackgroundColor({ color: "#dd9900" });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  if (stored.cs_extract_miss && current.enabled !== false) {
    await chrome.action.setBadgeBackgroundColor({ color: "#dd9900" });
    await chrome.action.setBadgeText({ text: "?" });
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
  // account was attached or the local key was accepted. Anything older is backlog
  // for the history button.
  // Thread-id corrections rewrite rows the node already holds: never automatic.
  return { includeDerived: false, since: auth.baselineAt || 0, skipStreaming: true, repair: "hold" };
}

function historyOptions() {
  return { includeDerived: true, since: 0, skipStreaming: true, repair: "include" };
}

function repairOptions() {
  return { includeDerived: true, since: 0, skipStreaming: true, repair: "only" };
}

function optionsFor(mode, auth) {
  if (mode === "history") return historyOptions();
  if (mode === "repair") return repairOptions();
  return autoOptions(auth);
}

/**
 * The account state, plus where sends go now. `connected` is true for either
 * target: a local key (which wins) or an account token. Never carries the key.
 */
async function readConnection() {
  const auth = await ToposAuth.read();
  const local = await ToposLocal.read();
  const where = await ToposIngest.target();
  return {
    ...auth,
    connected: where.mode !== "none",
    target: where.mode,
    accountConnected: auth.connected,
    localUrl: local.url,
    localExpired: local.expired,
    localRefusal: where.mode === "local" ? local.refusal : null,
  };
}

async function toposStatus() {
  const auth = await readConnection();
  const state = await readState();
  const history = ChatGPTShadowStore.syncScan(state, historyOptions());
  const auto = ChatGPTShadowStore.syncScan(state, autoOptions(auth));
  const repair = ChatGPTShadowStore.syncScan(state, repairOptions());
  return {
    connected: auth.connected,
    // "local": a Topos on this computer. "account": through the Control Plane. "none".
    target: auth.target,
    accountConnected: auth.accountConnected,
    localUrl: auth.localUrl,
    localExpired: auth.localExpired,
    localRefusal: auth.localRefusal,
    expired: auth.expired,
    engineWarning: auth.engineWarning,
    connecting: connectRunning,
    syncing: syncRunning,
    controlPlaneUrl: auth.controlPlaneUrl,
    baselineAt: auth.baselineAt,
    queued: history.records.length,
    queuedNew: auto.records.length,
    repairQueued: repair.records.length,
    // Counts only: rows the node files under a chat the extension cannot correct.
    nodeSide: ChatGPTShadowStore.nodeSideCounts(state),
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
 * Local Topos, no account: check the pasted key with the node on this computer
 * and store it only when the node accepts it. The error is the node's own
 * refusal, or why nothing answered; it never contains the key.
 */
async function toposLocalConnect(key, url) {
  if (connectRunning) return { ok: false, error: "A connection attempt is already open." };
  connectRunning = true;
  try {
    await ToposLocal.connect({ key, url });
    sendFailureStreak = 0;
    nextAutoSyncAt = 0;
    await refreshBadge();
    const status = await toposStatus();
    broadcast({ type: "topos.changed" });
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
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

/** The same failures in the words of a node that is on this computer. */
function describeLocalFailure(result) {
  // The node's own words, closed with a full stop when it left one out.
  const words = String(result.message || "").trim();
  const said = words ? `: ${words}${/[.!?]$/.test(words) ? "" : "."}` : ".";
  if (result.reason === "auth_expired") {
    return "The Topos on this computer no longer accepts this extension's key. Run the topos-node pushers add command again and paste the new key.";
  }
  if (result.reason === "refused") {
    return `The Topos on this computer refused these messages (HTTP ${result.status})${said} Nothing more is sent on its own.`;
  }
  if (result.reason === "rejected") {
    return `The Topos on this computer could not take these messages (HTTP ${result.status})${said} Nothing more is sent on its own.`;
  }
  if (result.reason === "network_error") {
    return "The Topos on this computer did not answer. Is it running? Unsent records stay queued here.";
  }
  if (result.reason === "unavailable") {
    return `The Topos on this computer is not ready (HTTP ${result.status}). Unsent records stay queued here.`;
  }
  return "Send failed.";
}

function describeFailure(result) {
  if (!result) return "Send failed.";
  if (result.target === "local") return describeLocalFailure(result);
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
 * mode "repair"  only the thread-id corrections, user-initiated only
 */
async function runSync(mode) {
  const auth = await readConnection();
  if (!auth.connected) return { mode, skipped: "not_connected", total: 0, landed: 0, queued: 0, failed: 0 };

  // The local node gave a final "no" to the last batch. Nothing goes on its own
  // until the person acts: a send they start themselves, a new key, or Disconnect.
  if (mode === "auto" && auth.localRefusal) {
    return { mode, skipped: "refused", total: 0, landed: 0, queued: 0, failed: 0 };
  }

  // No baseline on record means the automatic path has no way to tell a new
  // message from the backlog. Stamp one now and send nothing this round, so a
  // stored history can never leave without the button.
  if (mode === "auto" && !auth.baselineAt) {
    await chrome.storage.local.set({ [TOPOS_KEYS.baselineAt]: Math.floor(Date.now() / 1000) });
    return { mode, skipped: "baseline_set", total: 0, landed: 0, queued: 0, failed: 0 };
  }

  const state = await readState();
  const scan = ChatGPTShadowStore.syncScan(state, optionsFor(mode, auth));
  const total = scan.records.length;
  if (!total) return { mode, total: 0, landed: 0, queued: 0, failed: 0, held: scan.held };

  const batches = ChatGPTShadowStore.chunkRecords(scan.records, ToposConfig.MAX_BATCH);
  let landed = 0;
  let queued = 0;
  // Local node only: records it answered it could not read. They are not resent.
  let unread = 0;
  let refusalOpen = Boolean(auth.localRefusal);
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
        const skipped = result.unread || 0;
        unread += skipped;
        if (result.queued) queued += batch.length;
        else landed += batch.length - skipped;
        // The node answered, so lift any backoff a previous failure put in place.
        nextAutoSyncAt = 0;
        if (refusalOpen) {
          refusalOpen = false;
          await ToposLocal.clearRefusal();
          await refreshBadge();
        }
        if (sendFailureStreak) {
          sendFailureStreak = 0;
          await setEngineWarning(false);
        }
        continue;
      }
      error = describeFailure(result);
      if (result.reason === "auth_expired") {
        // The dead credential is dropped, the local key or the account token.
        if (result.target === "local") await ToposLocal.markExpired();
        else await ToposAuth.markExpired();
        await refreshBadge();
      } else if (result.final) {
        // The local node said no for good. Not a connection problem, so no backoff
        // and no streak: the records stay here and the automatic path stops.
        await ToposLocal.markRefused(result);
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
    failed: total - landed - queued - unread,
    ...(unread ? { unread } : {}),
    error,
    at: Date.now(),
  };
  await chrome.storage.local.set({ [TOPOS_KEYS.receipt]: receipt });
  broadcast({ type: "topos.done", receipt });
  return receipt;
}
