// Send records to the person's Topos. Two ways in, one at a time:
//
//   local    A node on this computer, no account. The person pasted the key that
//            `topos-node pushers add` printed (lib/toposLocal.js). Records go to
//            POST {node}/sources/{source}/ingest/batch on a loopback address,
//            with a write_id the node dedupes on.
//   account  POST {CP}/v1/ingestion/app_ingest. Ported from the Dialogues
//            browser-history extension (lib/toposIngest.js) into the
//            classic-script style this repo uses.
//
// A stored local key wins when both are present: it was put on this computer on
// purpose. On both paths the caller owns the credential lifecycle: this module
// reports auth_expired, it does not clear storage itself.
const ChatGPTShadowToposIngest = (() => {
  const CFG = ChatGPTShadowToposConfig;
  const Local = ChatGPTShadowToposLocal;
  const KEYS = CFG.KEYS;

  /** Answers from the local node that say this batch will never be taken as it is. */
  const LOCAL_REJECTED = [400, 404, 413, 422];

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
   * same key, while an edited message (same id, new content) carries a new one,
   * and so does a thread-id correction (same id and content, new thread_id): the
   * Control Plane answers a known key from its stored response without writing.
   * The local node gets the same value as its write_id and dedupes on it.
   */
  function idempotencyKey(records) {
    const rows = Array.isArray(records) ? records : [];
    let ids = "";
    let bodies = "";
    rows.forEach((row) => {
      ids += `${(row && row.thread_id) || ""}/${(row && row.id) || ""} `;
      bodies += `${(row && row.content) || ""} `;
    });
    return `chatgpt-shadow-${rows.length}-${hash32(ids)}-${hash32(bodies)}`;
  }

  function isEngineResponseTimeout(status, bodyText) {
    if (status !== 504) return false;
    return String(bodyText || "").toLowerCase().includes("engine response timeout");
  }

  /**
   * Where a send would go right now, credentials included. Internal: `target`
   * below is the same answer without the secrets.
   *   local    a local key is stored
   *   account  no local key; an account token and resource id are stored
   *   none     neither, or the local node turned the key away and the person has
   *            not acted yet (nothing falls back to an account on its own)
   */
  async function choose() {
    const stored = await chrome.storage.local.get({
      [KEYS.localKey]: "",
      [KEYS.localUrl]: "",
      [KEYS.expired]: false,
      [KEYS.token]: "",
      [KEYS.resourceId]: "",
      [KEYS.controlPlaneUrl]: "",
    });
    const key = String(stored[KEYS.localKey] || "");
    if (key) {
      const address = CFG.localNodeUrl(stored[KEYS.localUrl]);
      return { mode: "local", url: address.ok ? address.url : CFG.DEFAULT_LOCAL_URL, key };
    }
    if (stored[KEYS.expired] === "local") return { mode: "none" };
    const token = String(stored[KEYS.token] || "");
    const resourceId = String(stored[KEYS.resourceId] || "");
    const base = String(stored[KEYS.controlPlaneUrl] || CFG.controlPlaneUrl()).replace(/\/$/, "");
    if (token && resourceId) return { mode: "account", url: base, token, resourceId };
    return { mode: "none" };
  }

  /** { mode: "local" | "account" | "none", url }. Safe to show: no key, no token. */
  async function target() {
    const where = await choose();
    return { mode: where.mode, url: where.url || "" };
  }

  /**
   * Result contract (every result after the target is chosen carries
   * target: "local" | "account"):
   *   { ok: true, queued }                                     200 / 202 - safe to mark synced
   *   { ok: false, reason: "not_connected" }
   *   { ok: false, reason: "auth_expired", status }            caller drops the credential
   *                                                            account: 401 / 403   local: 401
   *   { ok: false, reason: "unavailable", retryable: true }    keep the credential, retry
   *                                                            account: 502 / 503 / 504
   *                                                            local: 409, 5xx, anything unlisted
   *   { ok: false, reason: "server_error", retryable: true }   account only
   *   { ok: false, reason: "network_error", retryable: true }
   * Local node only, final (not retried on its own):
   *   { ok: false, reason: "refused", final: true }            403 - the owner's allowlist says no
   *   { ok: false, reason: "rejected", final: true }           400 / 404 / 413 / 422 - a bad batch
   */
  async function send(records) {
    const rows = Array.isArray(records) ? records : [];
    if (!rows.length) return { ok: true, queued: false, empty: true };
    if (rows.length > CFG.MAX_BATCH) {
      return { ok: false, reason: "batch_too_large", message: `Batch of ${rows.length} exceeds ${CFG.MAX_BATCH}` };
    }
    const where = await choose();
    if (where.mode === "local") return sendLocal(where, rows);
    if (where.mode === "account") return sendAccount(where, rows);
    return { ok: false, reason: "not_connected" };
  }

  async function sendLocal(where, rows) {
    const writeId = idempotencyKey(rows);
    let response;
    try {
      response = await fetch(`${where.url}/sources/${encodeURIComponent(CFG.SOURCE_ID)}/ingest/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${where.key}`,
        },
        body: JSON.stringify({ records: rows, write_id: writeId }),
      });
    } catch (err) {
      return {
        ok: false,
        reason: "network_error",
        retryable: true,
        target: "local",
        message: Local.scrub((err && err.message) || String(err), where.key),
      };
    }
    const status = response.status;
    const text = await response.text().catch(() => "");

    if (response.ok) {
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_err) {
        body = null;
      }
      const deduplicated = Boolean(body && body.deduplicated === true);
      // One bad record never fails the batch: the node lists the ones it could not read.
      const errors = body && Array.isArray(body.errors) ? body.errors.length : 0;
      return {
        ok: true,
        queued: false,
        target: "local",
        status,
        writeId: (body && body.write_id) || writeId,
        deduplicated,
        unread: deduplicated ? 0 : Math.min(errors, rows.length),
      };
    }

    const message = Local.nodeWords(text, where.key);
    // The node no longer knows this key (disconnected there, or another node).
    if (status === 401) return { ok: false, reason: "auth_expired", target: "local", status, message };
    // Not a source the owner allowed this extension to write. A retry would not change that.
    if (status === 403) return { ok: false, reason: "refused", final: true, target: "local", status, message };
    // The batch itself is wrong; sending it again would be wrong again.
    if (LOCAL_REJECTED.includes(status)) {
      return { ok: false, reason: "rejected", final: true, target: "local", status, message };
    }
    // 409 (the node has no identity yet), 5xx, anything else: keep the key, retry later.
    return { ok: false, reason: "unavailable", retryable: true, target: "local", status, message };
  }

  async function sendAccount(where, rows) {
    try {
      const response = await fetch(`${where.url}/v1/ingestion/app_ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${where.token}`,
          "Idempotency-Key": idempotencyKey(rows),
        },
        body: JSON.stringify({ resource_id: where.resourceId, source_id: CFG.SOURCE_ID, records: rows }),
      });

      if (response.status === 401 || response.status === 403) {
        const body = await response.text().catch(() => "");
        return { ok: false, reason: "auth_expired", target: "account", status: response.status, body };
      }

      // 202: the node is offline and the Control Plane queued the write. Success.
      if (response.status === 202) {
        const body = await response.json().catch(() => ({}));
        return { ok: true, queued: true, target: "account", status: 202, writeId: (body && body.write_id) || null };
      }

      // Node slow or unreachable. The write may still land, so keep the token and
      // let the next run resend; app_ingest collapses a resend of the same id.
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        const body = await response.text().catch(() => "");
        return {
          ok: false,
          reason: "unavailable",
          retryable: true,
          target: "account",
          inFlight: isEngineResponseTimeout(response.status, body),
          status: response.status,
          body,
        };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { ok: false, reason: "server_error", retryable: true, target: "account", status: response.status, body };
      }

      return { ok: true, queued: false, target: "account", status: response.status };
    } catch (err) {
      return {
        ok: false,
        reason: "network_error",
        retryable: true,
        target: "account",
        message: (err && err.message) || String(err),
      };
    }
  }

  return { send, target, idempotencyKey };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowToposIngest = ChatGPTShadowToposIngest;
}
