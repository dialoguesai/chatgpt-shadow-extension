// Grant Access (PKCE) attach flow for ChatGPT Shadow.
//
// Ported from the Dialogues browser-history extension (lib/pkce.js,
// lib/grantAccess.js, lib/registerRedirect.js) into the classic-script style
// this repo uses. Runs in the service worker, not the popup: launchWebAuthFlow
// takes focus and a popup would be torn down mid-flow.
const ChatGPTShadowToposAuth = (() => {
  const CFG = ChatGPTShadowToposConfig;
  const KEYS = CFG.KEYS;

  // ---------------------------------------------------------------- PKCE ---

  function randomVerifier(length = 64) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let out = "";
    for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  function base64UrlEncode(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function createPkcePair() {
    const codeVerifier = randomVerifier(64);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    return { codeVerifier, codeChallenge: base64UrlEncode(digest), codeChallengeMethod: "S256" };
  }

  // ------------------------------------------------------------ redirects ---

  function redirectUri() {
    if (chrome.identity && chrome.identity.getRedirectURL) return chrome.identity.getRedirectURL();
    return chrome.runtime.getURL("popup.html");
  }

  async function registerKey() {
    const stored = await chrome.storage.local.get({ [KEYS.registerKey]: "" });
    return String(stored[KEYS.registerKey] || "").trim();
  }

  /** POST {CP}/v1/apps/{app_id}/extension-install/redirects so /connect accepts this install. */
  async function registerInstallRedirects(controlPlaneUrl) {
    const base = String(controlPlaneUrl || CFG.controlPlaneUrl()).replace(/\/$/, "");
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const key = await registerKey();
    if (key) headers["X-Topos-Extension-Register-Key"] = key;
    const response = await fetch(`${base}/v1/apps/${CFG.APP_ID}/extension-install/redirects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ extension_id: chrome.runtime.id }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload && payload.detail;
      const detailText =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail)
            ? detail.map((row) => (row && (row.msg || row.message)) || "").filter(Boolean).join("; ")
            : "";
      const error = new Error(
        String(detailText || (payload && (payload.error_description || payload.error)) || `HTTP ${response.status}`)
      );
      error.status = response.status;
      throw error;
    }
    return {
      extensionId: chrome.runtime.id,
      redirectUris: (payload && payload.redirect_uris) || [],
      alreadyRegistered: Boolean(payload && payload.already_registered),
    };
  }

  // -------------------------------------------------------------- connect ---

  async function buildConnectUrl(controlPlaneUrl, options = {}) {
    const base = String(controlPlaneUrl || CFG.controlPlaneUrl()).replace(/\/$/, "");
    const { codeVerifier, codeChallenge, codeChallengeMethod } = await createPkcePair();
    const pendingState = `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const params = new URLSearchParams({
      app_id: CFG.APP_ID,
      redirect_uri: redirectUri(),
      source_id: CFG.SOURCE_ID,
      scopes: CFG.SCOPES,
      state: pendingState,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    });
    if (options.forceLogin !== false) params.set("force_login", "1");
    return { url: `${base}/connect?${params.toString()}`, pendingState, codeVerifier };
  }

  /**
   * Fail before opening the auth window when /connect would answer with JSON
   * (an unregistered redirect_uri, say). A real 302 to /connect-app shows up as
   * status 0 / opaqueredirect for an extension fetch — that is the good case.
   */
  async function preflightConnect(connectUrl) {
    let response;
    try {
      response = await fetch(connectUrl, { method: "GET", redirect: "manual" });
    } catch (err) {
      throw new Error((err && err.message) || "Could not reach the Control Plane");
    }
    if (response.status === 0 || response.type === "opaqueredirect") return;
    const location = response.headers.get("Location") || "";
    if (response.status >= 300 && response.status < 400) {
      if (location.includes("/connect-app") || location.includes("auth.dialogues.ai")) return;
    }
    const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
    if (contentType.includes("application/json") || response.status === 400 || response.status === 404) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(
        (payload && (payload.error_description || payload.error)) || `Connect preflight failed (${response.status})`
      );
    }
    if (response.ok || response.status >= 300) return;
    throw new Error(`Connect preflight failed (${response.status})`);
  }

  /** POST /connect/exchange. The authorization code expires 120 seconds after consent. */
  async function exchangeCode({ controlPlaneUrl, code, codeVerifier, stateFromUrl = "", expectedState = "" }) {
    const base = String(controlPlaneUrl || CFG.controlPlaneUrl()).replace(/\/$/, "");
    if (stateFromUrl && expectedState && stateFromUrl !== expectedState) {
      console.warn("[topos] connect state mismatch; continuing exchange");
    }
    const response = await fetch(`${base}/connect/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code, app_id: CFG.APP_ID, code_verifier: codeVerifier }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        (payload && (payload.error_description || payload.error)) || `Exchange failed (${response.status})`
      );
    }
    const token = String((payload && (payload.plugin_attach_token || payload.mcp_access_token)) || "").trim();
    const resourceId = String((payload && payload.resource_id) || "").trim();
    if (!token || !resourceId) throw new Error("Exchange did not return a token and resource id");
    return { token, resourceId };
  }

  function launchWebAuthFlow(url) {
    return new Promise((resolve, reject) => {
      if (!chrome.identity || !chrome.identity.launchWebAuthFlow) {
        reject(new Error("This browser did not expose chrome.identity"));
        return;
      }
      chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
        const failure = chrome.runtime.lastError;
        if (failure) {
          reject(new Error(failure.message || "Authorization was cancelled"));
          return;
        }
        if (!responseUrl) {
          reject(new Error("Authorization was cancelled"));
          return;
        }
        resolve(responseUrl);
      });
    });
  }

  /** Full attach: register redirects, consent, exchange, store token + resource id. */
  async function connect() {
    const base = CFG.controlPlaneUrl();
    await chrome.storage.local.remove([KEYS.lastError]);
    try {
      await registerInstallRedirects(base);
    } catch (err) {
      // An older Control Plane may not expose the endpoint, and the redirect may
      // already be registered. Let the preflight below be the real gate.
      console.warn("[topos] redirect registration:", (err && err.message) || err);
    }
    const { url, pendingState, codeVerifier } = await buildConnectUrl(base);
    await preflightConnect(url);
    await chrome.storage.local.set({ [KEYS.pkce]: { state: pendingState, at: Date.now() } });
    let responseUrl;
    try {
      responseUrl = await launchWebAuthFlow(url);
    } finally {
      await chrome.storage.local.remove([KEYS.pkce]);
    }
    const parsed = new URL(responseUrl);
    const error = (parsed.searchParams.get("error") || "").trim();
    if (error) throw new Error(error);
    const code = (parsed.searchParams.get("code") || "").trim();
    if (!code) throw new Error("No authorization code in the redirect");
    const { token, resourceId } = await exchangeCode({
      controlPlaneUrl: base,
      code,
      codeVerifier,
      stateFromUrl: parsed.searchParams.get("state") || "",
      expectedState: pendingState,
    });
    const baselineAt = Math.floor(Date.now() / 1000);
    await chrome.storage.local.set({
      [KEYS.token]: token,
      [KEYS.resourceId]: resourceId,
      [KEYS.controlPlaneUrl]: base,
      [KEYS.baselineAt]: baselineAt,
      [KEYS.expired]: false,
    });
    await chrome.storage.local.remove([KEYS.engineWarning, KEYS.lastError]);
    return { connected: true, baselineAt };
  }

  async function read() {
    const stored = await chrome.storage.local.get({
      [KEYS.token]: "",
      [KEYS.resourceId]: "",
      [KEYS.controlPlaneUrl]: "",
      [KEYS.baselineAt]: 0,
      [KEYS.expired]: false,
      [KEYS.engineWarning]: false,
      [KEYS.receipt]: null,
      [KEYS.lastError]: "",
    });
    const token = String(stored[KEYS.token] || "");
    const resourceId = String(stored[KEYS.resourceId] || "");
    return {
      connected: Boolean(token && resourceId),
      token,
      resourceId,
      controlPlaneUrl: String(stored[KEYS.controlPlaneUrl] || CFG.controlPlaneUrl()),
      baselineAt: Number(stored[KEYS.baselineAt] || 0),
      expired: Boolean(stored[KEYS.expired]),
      engineWarning: Boolean(stored[KEYS.engineWarning]),
      receipt: stored[KEYS.receipt] || null,
      lastError: String(stored[KEYS.lastError] || ""),
    };
  }

  /** 401/403 from app_ingest: drop the token so nothing else is attempted with it. */
  async function markExpired() {
    await chrome.storage.local.remove([KEYS.token, KEYS.resourceId]);
    await chrome.storage.local.set({ [KEYS.expired]: true });
  }

  async function disconnect() {
    await chrome.storage.local.remove(CFG.ALL_KEYS);
  }

  return {
    createPkcePair,
    redirectUri,
    registerInstallRedirects,
    buildConnectUrl,
    preflightConnect,
    exchangeCode,
    connect,
    disconnect,
    read,
    markExpired,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowToposAuth = ChatGPTShadowToposAuth;
}
