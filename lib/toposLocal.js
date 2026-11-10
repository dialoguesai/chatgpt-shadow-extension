// The local Topos connection: a node on this computer, no account.
//
// The person enrols this extension once in their own terminal
// (`topos-node pushers add …`, see ChatGPTShadowToposConfig.enrollCommand) and
// pastes the key it prints. This module asks the node what that key is good for,
// stores it when the node accepts it, and forgets it when the node stops
// accepting it. Sending lives in lib/toposIngest.js. Runs in the service worker,
// like the account flow in lib/toposAuth.js.
//
// The key is a secret. It travels in the Authorization header of a request to a
// loopback address and nowhere else: never a URL, a log line or an error message.
const ChatGPTShadowToposLocal = (() => {
  const CFG = ChatGPTShadowToposConfig;
  const KEYS = CFG.KEYS;

  /** Printable, no spaces: safe to put in a header as it stands. */
  const KEY_SHAPE = /^tpw_[\x21-\x7e]+$/;

  /** Whatever a node or the browser says back, the key never rides along in it. */
  function scrub(text, key) {
    const value = String(text || "");
    return key ? value.split(key).join("[key]") : value;
  }

  /**
   * The node's own words from a refusal body. It answers either
   * {"detail": "…"} / {"detail": {"error", "message"}} or {"error", "message"}.
   */
  function nodeWords(bodyText, key) {
    const text = String(bodyText || "").trim();
    let said = "";
    try {
      const body = text ? JSON.parse(text) : null;
      const detail = body && body.detail;
      if (typeof detail === "string") said = detail;
      else if (detail && typeof detail === "object") said = detail.message || detail.error || "";
      if (!said && body && typeof body === "object") said = body.message || body.error || "";
    } catch (_err) {
      said = text;
    }
    return scrub(String(said || "").slice(0, 400), key);
  }

  /**
   * Ask the node what a key may write: GET {node}/local-pushers/me.
   * Resolves { url, app, sources } only when the node accepts the key and this
   * extension's source is among the ones it may write. Throws with the reason
   * otherwise. Nothing is stored here.
   */
  async function probe(url, key) {
    const address = CFG.localNodeUrl(url);
    if (!address.ok) throw new Error(address.error);
    const secret = String(key || "").trim();
    if (!KEY_SHAPE.test(secret)) {
      throw new Error(
        `That does not look like the key. It starts with ${CFG.LOCAL_KEY_PREFIX} and the command shows it once.`
      );
    }
    let response;
    try {
      response = await fetch(`${address.url}/local-pushers/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
      });
    } catch (_err) {
      throw new Error(`No Topos answered at ${address.url}. Check that it is running on this computer.`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const error = new Error(
        `The Topos on this computer did not accept the key (${response.status}): ` +
          (nodeWords(text, secret) || `HTTP ${response.status}`)
      );
      error.status = response.status;
      throw error;
    }
    let me = null;
    try {
      me = text ? JSON.parse(text) : null;
    } catch (_err) {
      me = null;
    }
    const sources = Array.isArray(me && me.sources) ? me.sources.map((name) => String(name)) : [];
    if (!sources.includes(CFG.SOURCE_ID)) {
      throw new Error(
        `That key may not write ChatGPT chats (${CFG.SOURCE_ID}). ` +
          "Run the command exactly as shown and paste the new key."
      );
    }
    return { url: address.url, app: String((me && me.app) || ""), sources };
  }

  /** Check the key with the node, then store it. Sending starts from this moment on. */
  async function connect({ key, url } = {}) {
    const checked = await probe(url, key);
    const baselineAt = Math.floor(Date.now() / 1000);
    await chrome.storage.local.set({
      [KEYS.localKey]: String(key).trim(),
      [KEYS.localUrl]: checked.url,
      [KEYS.baselineAt]: baselineAt,
      [KEYS.expired]: false,
    });
    await chrome.storage.local.remove([KEYS.engineWarning, KEYS.lastError, KEYS.localRefusal]);
    return { connected: true, baselineAt, url: checked.url };
  }

  /** What the popup may know. The key itself is never returned. */
  async function read() {
    const stored = await chrome.storage.local.get({
      [KEYS.localKey]: "",
      [KEYS.localUrl]: "",
      [KEYS.expired]: false,
      [KEYS.localRefusal]: null,
    });
    const address = CFG.localNodeUrl(stored[KEYS.localUrl]);
    return {
      hasKey: Boolean(stored[KEYS.localKey]),
      url: address.ok ? address.url : CFG.DEFAULT_LOCAL_URL,
      expired: stored[KEYS.expired] === "local",
      refusal: stored[KEYS.localRefusal] || null,
    };
  }

  /** 401 from the node: the key is dead. Drop it so nothing else is attempted with it. */
  async function markExpired() {
    await chrome.storage.local.remove([KEYS.localKey, KEYS.localRefusal]);
    await chrome.storage.local.set({ [KEYS.expired]: "local" });
  }

  /**
   * The node answered a batch with a final "no" (403: not allowed by the owner;
   * 400/404/413/422: a batch it will never take). Remember what it said, so the
   * automatic path stops and the popup can show it.
   */
  async function markRefused(result) {
    await chrome.storage.local.set({
      [KEYS.localRefusal]: {
        reason: String((result && result.reason) || "refused"),
        status: Number((result && result.status) || 0),
        message: String((result && result.message) || ""),
        at: Date.now(),
      },
    });
  }

  async function clearRefusal() {
    await chrome.storage.local.remove([KEYS.localRefusal]);
  }

  return { probe, connect, read, markExpired, markRefused, clearRefusal, nodeWords, scrub };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowToposLocal = ChatGPTShadowToposLocal;
}
