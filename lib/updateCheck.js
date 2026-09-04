/**
 * Is a newer build of this extension available?
 *
 * This is loaded unpacked from a Git checkout, so there is no Web Store
 * auto-update. The honest substitute: compare the version this install is
 * running against the version on the repo's main branch, and tell the person
 * when main is ahead so they can pull and reload.
 *
 * The comparison is pure and lives apart from the fetch so it can be tested
 * without a network. The fetch reads the same manifest.json the extension is
 * built from — the one source that cannot disagree with what actually ships.
 */
const ChatGPTShadowUpdateCheck = (() => {
  // Raw manifest on the default branch. Cache-busted per check so a reload
  // reflects a just-pushed version instead of a CDN copy minutes stale.
  const MANIFEST_URL =
    "https://raw.githubusercontent.com/dialoguesai/chatgpt-shadow-extension/main/manifest.json";
  const REPO_URL = "https://github.com/dialoguesai/chatgpt-shadow-extension";

  /** Split a dotted version into numbers; non-numeric or missing parts read as 0. */
  function parts(version) {
    return String(version || "")
      .trim()
      .split(".")
      .map((n) => {
        const v = parseInt(n, 10);
        return Number.isFinite(v) ? v : 0;
      });
  }

  /** -1 if a<b, 0 if equal, 1 if a>b. Compares as many segments as the longer has. */
  function compareVersions(a, b) {
    const pa = parts(a);
    const pb = parts(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      const da = pa[i] || 0;
      const db = pb[i] || 0;
      if (da < db) return -1;
      if (da > db) return 1;
    }
    return 0;
  }

  /** True when `latest` is strictly newer than `current`. */
  function isNewer(current, latest) {
    return compareVersions(current, latest) < 0;
  }

  /**
   * Returns { current, latest, updateAvailable, repoUrl } or, on any failure,
   * { current, error }. Never throws — an update check must not break the popup.
   */
  async function check(currentVersion) {
    const current = String(currentVersion || "").trim();
    try {
      const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) return { current, error: `HTTP ${response.status}` };
      const remote = await response.json();
      const latest = String((remote && remote.version) || "").trim();
      if (!latest) return { current, error: "no version in remote manifest" };
      return { current, latest, updateAvailable: isNewer(current, latest), repoUrl: REPO_URL };
    } catch (err) {
      return { current, error: (err && err.message) || "update check failed" };
    }
  }

  return { MANIFEST_URL, REPO_URL, parts, compareVersions, isNewer, check };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowUpdateCheck = ChatGPTShadowUpdateCheck;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = ChatGPTShadowUpdateCheck;
}
