// POST records to {CP}/v1/ingestion/app_ingest.
//
// Ported from the Dialogues browser-history extension (lib/toposIngest.js) into
// the classic-script style this repo uses. The caller owns the token lifecycle:
// this module reports auth_expired, it does not clear storage itself.
const ChatGPTShadowToposIngest = (() => {
  const CFG = ChatGPTShadowToposConfig;
  const KEYS = CFG.KEYS;

  function hash32(text) {
    const value = String(text || "");
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * Deterministic per-batch key: the same batch resent after a timeout carries the
   * same key, while an edited message (same id, new content) carries a new one.
   */
  function idempotencyKey(records) {
    const rows = Array.isArray(records) ? records : [];
    let ids = "";
    let bodies = "";
    rows.forEach((row) => {
      ids += `${(row && row.id) || ""} `;
      bodies += `${(row && row.content) || ""} `;
    });
    return `chatgpt-shadow-${rows.length}-${hash32(ids)}-${hash32(bodies)}`;
  }

  function isEngineResponseTimeout(status, bodyText) {
    if (status !== 504) return false;
    return String(bodyText || "").toLowerCase().includes("engine response timeout");
  }

  /**
   * Result contract:
   *   { ok: true, queued }                                     200 / 202 - safe to mark synced
   *   { ok: false, reason: "not_connected" }
   *   { ok: false, reason: "auth_expired", status }            401 / 403 - caller drops the token
   *   { ok: false, reason: "unavailable", retryable: true }    502 / 503 / 504 - keep the token, retry
   *   { ok: false, reason: "server_error", retryable: true }
   *   { ok: false, reason: "network_error", retryable: true }
   */
  async function send(records) {
    const rows = Array.isArray(records) ? records : [];
    if (!rows.length) return { ok: true, queued: false, empty: true };
    if (rows.length > CFG.MAX_BATCH) {
      return { ok: false, reason: "batch_too_large", message: `Batch of ${rows.length} exceeds ${CFG.MAX_BATCH}` };
    }
    const stored = await chrome.storage.local.get({
      [KEYS.token]: "",
      [KEYS.resourceId]: "",
      [KEYS.controlPlaneUrl]: "",
    });
    const token = String(stored[KEYS.token] || "");
    const resourceId = String(stored[KEYS.resourceId] || "");
    const base = String(stored[KEYS.controlPlaneUrl] || CFG.controlPlaneUrl()).replace(/\/$/, "");
    if (!token || !resourceId) return { ok: false, reason: "not_connected" };

    try {
      const response = await fetch(`${base}/v1/ingestion/app_ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey(rows),
        },
        body: JSON.stringify({ resource_id: resourceId, source_id: CFG.SOURCE_ID, records: rows }),
      });

      if (response.status === 401 || response.status === 403) {
        const body = await response.text().catch(() => "");
        return { ok: false, reason: "auth_expired", status: response.status, body };
      }

      // 202: the node is offline and the Control Plane queued the write. Success.
      if (response.status === 202) {
        const body = await response.json().catch(() => ({}));
        return { ok: true, queued: true, status: 202, writeId: (body && body.write_id) || null };
      }

      // Node slow or unreachable. The write may still land, so keep the token and
      // let the next run resend; app_ingest collapses a resend of the same id.
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        const body = await response.text().catch(() => "");
        return {
          ok: false,
          reason: "unavailable",
          retryable: true,
          inFlight: isEngineResponseTimeout(response.status, body),
          status: response.status,
          body,
        };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { ok: false, reason: "server_error", retryable: true, status: response.status, body };
      }

      return { ok: true, queued: false, status: response.status };
    } catch (err) {
      return { ok: false, reason: "network_error", retryable: true, message: (err && err.message) || String(err) };
    }
  }

  return { send, idempotencyKey };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowToposIngest = ChatGPTShadowToposIngest;
}
