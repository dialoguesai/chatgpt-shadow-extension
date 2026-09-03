// Topos connection constants for ChatGPT Shadow.
//
// Classic script (no ES modules): background.js is a classic service worker that
// loads this with importScripts, matching extract.js / store.js.
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

  /** chrome.storage.local keys. Local, not sync: the token stays on this machine. */
  const KEYS = {
    token: "cs_topos_token",
    resourceId: "cs_topos_resource_id",
    controlPlaneUrl: "cs_topos_cp_url",
    baselineAt: "cs_topos_baseline_at",
    expired: "cs_topos_expired",
    engineWarning: "cs_topos_engine_warning",
    receipt: "cs_topos_receipt",
    lastError: "cs_topos_last_error",
    pkce: "cs_topos_pkce",
    registerKey: "cs_topos_register_key",
  };

  /** Every topos key, for change listeners and disconnect. */
  const ALL_KEYS = Object.keys(KEYS).map((name) => KEYS[name]);

  function controlPlaneUrl() {
    return CONTROL_PLANE_URL.replace(/\/$/, "");
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
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowToposConfig = ChatGPTShadowToposConfig;
}
