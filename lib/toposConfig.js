// Topos connection constants for ChatGPT Shadow.
//
// Classic script (no ES modules): background.js is a classic service worker that
// loads this with importScripts, matching extract.js / store.js. The popup loads
// it too, for the local Topos command and the address check.
const ChatGPTShadowToposConfig = (() => {
  /** Control Plane host. Same host the Dialogues browser-history extension uses. */
  const CONTROL_PLANE_URL = "https://cp.logu3s.com";

  /** Registered app id for this extension. */
  const APP_ID = "chatgpt-shadow-extension";

  /** Ingestion source id for records written by this extension. */
  const SOURCE_ID = "chatgpt_ui_conversation";

  /** Scopes asked for at /connect. */
  const SCOPES = "ai_conversations:write";

  /** Hard cap on records per app_ingest request. */
  const MAX_BATCH = 200;

  /** Back off this long after a failed send before the automatic path tries again. */
  const RETRY_BACKOFF_MS = 60_000;

  /** chrome.storage.local keys. Local, not sync: the token and the local key stay on this machine. */
  const KEYS = {
    token: "cs_topos_token",
    resourceId: "cs_topos_resource_id",
    controlPlaneUrl: "cs_topos_cp_url",
    baselineAt: "cs_topos_baseline_at",
    // true: the account token was rejected. "local": the local node turned the key away.
    expired: "cs_topos_expired",
    engineWarning: "cs_topos_engine_warning",
    receipt: "cs_topos_receipt",
    lastError: "cs_topos_last_error",
    pkce: "cs_topos_pkce",
    registerKey: "cs_topos_register_key",
    // Local Topos (no account): the key `topos-node pushers add` printed, where the
    // node listens, and the node's last final "no" to a batch (see toposLocal.js).
    localKey: "cs_topos_local_key",
    localUrl: "cs_topos_local_url",
    localRefusal: "cs_topos_local_refusal",
  };

  /** Every topos key, for change listeners and disconnect. */
  const ALL_KEYS = Object.keys(KEYS).map((name) => KEYS[name]);

  function controlPlaneUrl() {
    return CONTROL_PLANE_URL.replace(/\/$/, "");
  }

  // ------------------------------------------------ local Topos (no account) ---

  /** Where a Topos node on this computer listens unless the person says otherwise. */
  const DEFAULT_LOCAL_URL = "http://127.0.0.1:8676";

  /** Every key `topos-node pushers add` prints starts with this. */
  const LOCAL_KEY_PREFIX = "tpw_";

  /**
   * The whole address must be this computer and nothing more: plain http, one of
   * the two loopback names, a port. Matched as written, not parsed, so a path,
   * a query, credentials or a look-alike host cannot ride along.
   */
  const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})\/?$/i;

  const LOOPBACK_ERROR =
    "The address must be on this computer: http://127.0.0.1:<port> or http://localhost:<port>.";

  /**
   * Check a node address. Empty means the default.
   *   { ok: true, url }      normalised: lower case, no trailing slash
   *   { ok: false, error }   anything that is not a loopback address
   */
  function localNodeUrl(input) {
    const text = String(input == null ? "" : input).trim();
    if (!text) return { ok: true, url: DEFAULT_LOCAL_URL };
    const match = LOOPBACK_URL.exec(text);
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65535) return { ok: false, error: LOOPBACK_ERROR };
    return { ok: true, url: `http://${match[1].toLowerCase()}:${port}` };
  }

  /**
   * The command the person runs once in their own terminal. The node answers only
   * the exact origin named here, so it carries this install's id, never a pattern.
   */
  function enrollCommand(extensionId) {
    return `topos-node pushers add ${APP_ID} --sources ${SOURCE_ID} --origin chrome-extension://${extensionId}`;
  }

  return {
    CONTROL_PLANE_URL,
    APP_ID,
    SOURCE_ID,
    SCOPES,
    MAX_BATCH,
    RETRY_BACKOFF_MS,
    KEYS,
    ALL_KEYS,
    controlPlaneUrl,
    DEFAULT_LOCAL_URL,
    LOCAL_KEY_PREFIX,
    localNodeUrl,
    enrollCommand,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowToposConfig = ChatGPTShadowToposConfig;
}
