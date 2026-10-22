import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The extension ships classic scripts that hang themselves off globalThis, so the
// suite can load every file into one sandbox exactly the way importScripts does.
const sandbox = { console, crypto, btoa, TextEncoder };
sandbox.globalThis = sandbox;
["extract.js", "store.js", "lib/toposConfig.js", "lib/toposAuth.js", "lib/toposIngest.js", "lib/updateCheck.js"].forEach((file) => {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox);
});

const Extract = sandbox.ChatGPTShadowExtract;
const Store = sandbox.ChatGPTShadowStore;
const ToposConfig = sandbox.ChatGPTShadowToposConfig;
const ToposAuth = sandbox.ChatGPTShadowToposAuth;
const ToposIngest = sandbox.ChatGPTShadowToposIngest;
const UpdateCheck = sandbox.ChatGPTShadowUpdateCheck;

function el(attrs = {}, children = [], text = "") {
  const node = {
    attrs,
    children,
    innerText: text,
    textContent: text,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const visit = (current) => {
        if (matchesSelector(current, selector)) matches.push(current);
        (current.children || []).forEach(visit);
      };
      (this.children || []).forEach(visit);
      return matches;
    },
  };
  if (!text && children.length) {
    Object.defineProperty(node, "innerText", {
      get() {
        return children.map((child) => child.innerText || "").join("\n").trim();
      },
    });
  }
  return node;
}

function matchesSelector(node, selector) {
  if (selector === ".markdown") return Boolean(node.attrs.class && node.attrs.class.includes("markdown"));
  if (selector === ".whitespace-pre-wrap") {
    return Boolean(node.attrs.class && node.attrs.class.includes("whitespace-pre-wrap"));
  }
  if (selector === "[data-message-content]") return node.getAttribute("data-message-content") != null;
  if (selector === "[data-message-author-role]") return Boolean(node.getAttribute("data-message-author-role"));
  if (selector === '[data-testid="stop-button"]') return node.getAttribute("data-testid") === "stop-button";
  if (selector.startsWith("nav ")) return false;
  return false;
}

function fakeDoc(messages, extras = []) {
  const nodes = messages.map((message) =>
    el({ "data-message-author-role": message.role, "data-message-id": message.id }, [
      el({ class: message.role === "assistant" ? "markdown" : "whitespace-pre-wrap" }, [], message.content),
    ])
  );
  const root = el({}, [...nodes, ...extras]);
  root.title = "Plan a trip - ChatGPT";
  root.ownerDocument = root;
  const collect = (selector) => {
    const found = [];
    const walk = (current) => {
      if (matchesSelector(current, selector)) found.push(current);
      (current.children || []).forEach(walk);
    };
    walk(root);
    return found;
  };
  root.querySelectorAll = (selector) =>
    selector === "[data-message-author-role]" ? nodes : collect(selector);
  root.querySelector = (selector) => root.querySelectorAll(selector)[0] || null;
  return root;
}

test("reads thread id from chatgpt and gpt project urls", () => {
  assert.equal(
    Extract.conversationIdFromUrl("https://chatgpt.com/c/11111111-2222-3333-4444-555555555555"),
    "11111111-2222-3333-4444-555555555555"
  );
  assert.equal(
    Extract.conversationIdFromUrl("https://chatgpt.com/g/g-xyz/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  );
  assert.equal(
    Extract.conversationIdFromUrl("https://chatgpt.com/share/69a0aec2-1cfc-8007-a2a2-d1909bafec82"),
    "69a0aec2-1cfc-8007-a2a2-d1909bafec82"
  );
  assert.equal(Extract.conversationIdFromUrl("https://chatgpt.com/"), "");
});

test("strips ChatGPT from the document title", () => {
  assert.equal(Extract.conversationTitleFromPageTitle("Plan a trip - ChatGPT"), "Plan a trip");
  assert.equal(Extract.conversationTitleFromPageTitle("ChatGPT"), "ChatGPT");
});

test("extracts user and assistant text and skips system", () => {
  const doc = fakeDoc([
    { role: "user", id: "u1", content: "Hello there" },
    { role: "assistant", id: "a1", content: "Hi — how can I help?" },
    { role: "system", id: "s1", content: "hidden" },
  ]);
  const rows = Extract.extractMessages(doc);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].role, "user");
  assert.equal(rows[0].content, "Hello there");
  assert.equal(rows[1].role, "assistant");
  assert.equal(rows[1].id, "a1");
});

test("detects streaming via the stop button", () => {
  const idle = fakeDoc([]);
  const streaming = fakeDoc([], [el({ "data-testid": "stop-button" })]);
  assert.equal(Extract.isStreaming(idle), false);
  assert.equal(Extract.isStreaming(streaming), true);
});

test("exported records include id, thread_id, role, content, and created_at", () => {
  const record = Extract.toV1Record("thread-1", { id: "msg-1", role: "user", content: "Hello", index: 0 }, 1700000000);
  assert.equal(record.id, "msg-1");
  assert.equal(record.thread_id, "thread-1");
  assert.equal(record.role, "user");
  assert.equal(record.content, "Hello");
  assert.equal(record.created_at, 1700000000);
});

test("upsert replaces streaming content for the same id", () => {
  let state = Store.emptyState();
  state = Store.upsert(state, { id: "t1", title: "Draft", url: "https://chatgpt.com/c/t1" }, [
    { id: "a1", role: "assistant", content: "Hel", index: 1 },
  ]);
  state = Store.upsert(state, { id: "t1", title: "Draft", url: "https://chatgpt.com/c/t1" }, [
    { id: "a1", role: "assistant", content: "Hello world", index: 1 },
  ]);
  assert.equal(state.messages.t1.length, 1);
  assert.equal(state.messages.t1[0].content, "Hello world");
  assert.equal(state.index.t1.messageCount, 1);
});

test("remaps pending thread ids when the url appears", () => {
  let state = Store.emptyState();
  state = Store.upsert(state, { id: "pending:1", title: "New chat" }, [
    { id: "u1", role: "user", content: "Hi", index: 0 },
  ]);
  state = Store.remapThread(state, "pending:1", "real-id");
  assert.equal(state.messages["real-id"][0].thread_id, "real-id");
  assert.equal(state.index["real-id"].title, "New chat");
  assert.equal(state.messages["pending:1"], undefined);
});

function h(tag, attrs = {}, kids = []) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs,
    className: attrs.class || "",
    children: kids.filter((kid) => kid.nodeType === 1),
    childNodes: kids,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (current) => {
        if (current.nodeType === 1 && tagMatches(current, selector)) found.push(current);
        (current.childNodes || []).forEach(walk);
      };
      (this.childNodes || []).forEach(walk);
      return found;
    },
    get textContent() {
      return kids.map((kid) => kid.textContent || "").join("");
    },
    get innerText() {
      return this.textContent;
    },
  };
  return node;
}

function t(text) {
  return { nodeType: 3, textContent: text, nodeValue: text };
}

function tagMatches(node, selector) {
  if (selector.startsWith(".")) return classNameHas(node, selector.slice(1));
  const attrSel = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
  if (attrSel) {
    const value = node.getAttribute(attrSel[1]);
    return attrSel[2] == null ? value != null : value === attrSel[2];
  }
  return String(node.tagName || "").toLowerCase() === selector.toLowerCase();
}

function classNameHas(node, name) {
  const cls = `${node.getAttribute("class") || ""} ${node.className || ""}`;
  return cls.split(/\s+/).includes(name);
}

test("converts ChatGPT HTML into markdown structure", () => {
  const tree = h("div", { class: "markdown" }, [
    h("h2", {}, [t("Buyer value")]),
    h("p", {}, [t("Why should the organization "), h("strong", {}, [t("pay")]), t("?")]),
    h("ul", {}, [h("li", {}, [t("Donor newsletters")]), h("li", {}, [t("Grant reports")])]),
    h("table", {}, [
      h("thead", {}, [h("tr", {}, [h("th", {}, [t("Layer")]), h("th", {}, [t("Question")])])]),
      h("tbody", {}, [h("tr", {}, [h("td", {}, [t("Buyer")]), h("td", {}, [t("Why pay?")])])]),
    ]),
    h("pre", {}, [h("code", { class: "language-js" }, [t("const x = 1;")])]),
    h("button", {}, [t("Edit")]),
  ]);
  const md = Extract.htmlToMarkdown(tree);
  assert.match(md, /^## Buyer value/m);
  assert.match(md, /\*\*pay\*\*/);
  assert.match(md, /^- Donor newsletters/m);
  assert.match(md, /\| Layer \| Question \|/);
  assert.match(md, /\| Buyer \| Why pay\? \|/);
  assert.match(md, /```js\nconst x = 1;\n```/);
  assert.doesNotMatch(md, /Edit/);
});

test("skips thinking placeholders", () => {
  assert.equal(Extract.isPlaceholderMessage("request-placeholder-request-abc-0", "Thinking"), true);
  const doc = fakeDoc([
    { role: "assistant", id: "request-placeholder-request-abc-0", content: "Thinking" },
    { role: "assistant", id: "a1", content: "Here is the answer." },
  ]);
  const rows = Extract.extractMessages(doc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "Here is the answer.");
});

test("renders stored markdown for the popup", () => {
  const html = Extract.renderMarkdown(
    "## Title\n\nUse **bold** and `code`.\n\n- one\n- two\n\n| Layer | Question |\n| --- | --- |\n| Buyer | Why pay? |\n\n```js\nconst x = 1;\n```"
  );
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<th>Layer<\/th>/);
  assert.match(html, /<td>Buyer<\/td>/);
  assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
  assert.doesNotMatch(html, /^<p><h2>/);
});

test("jsonl export is one v1 record per line", () => {
  let state = Store.emptyState();
  state = Store.upsert(state, { id: "t1", title: "A" }, [
    { id: "u1", role: "user", content: "Hello", index: 0 },
    { id: "a1", role: "assistant", content: "Hi", index: 1 },
  ]);
  const lines = Store.toJsonl(state)
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  lines.forEach((row) => {
    assert.ok(row.id && row.thread_id && row.role && row.content);
    assert.equal(typeof row.created_at, "number");
  });
});

// ---------------------------------------------------------------------------
// Topos write path. Every fixture id below is synthetic.
// ---------------------------------------------------------------------------

// The store runs inside a vm sandbox, so values it returns carry that realm's
// prototypes. Copy them into this realm before a strict deep comparison.
const list = (value) => Array.from(value);
const plain = (value) => ({ ...value });

const AUTO = { includeDerived: false, since: 0, skipStreaming: true };
const HISTORY = { includeDerived: true, since: 0, skipStreaming: true };

function seed(threadId, rows, conversation = {}) {
  return Store.upsert(Store.emptyState(), { id: threadId, title: "Sample thread", ...conversation }, rows);
}

test("never sends a row whose thread id is still pending, and releases it after the remap", () => {
  let state = seed("pending:1700000000", [
    { id: "msg-0001", role: "user", content: "sample question", index: 0, created_at: 1700000000 },
    { id: "msg-0002", role: "assistant", content: "sample answer", index: 1, created_at: 1700000001 },
  ]);

  const held = Store.syncScan(state, HISTORY);
  assert.equal(held.records.length, 0);
  assert.equal(held.held.pending, 2);

  state = Store.remapThread(state, "pending:1700000000", "conv-0001");
  const released = Store.syncScan(state, HISTORY);
  assert.equal(released.records.length, 2);
  assert.equal(released.held.pending, 0);
  assert.deepEqual(
    list(released.records.map((row) => row.thread_id)),
    ["conv-0001", "conv-0001"]
  );
});

test("a row filed under a real thread but still carrying a pending thread_id is held", () => {
  const state = {
    enabled: true,
    index: { "conv-0002": { id: "conv-0002", streaming: false } },
    messages: {
      "conv-0002": [
        { id: "msg-0003", thread_id: "pending:1700000002", role: "user", content: "sample", created_at: 1700000002 },
      ],
    },
  };
  const scan = Store.syncScan(state, HISTORY);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.held.pending, 1);
});

test("content-hash ids are excluded from the automatic send and allowed in a history submit", () => {
  const state = seed("conv-0003", [
    { id: "msg-0004", role: "user", content: "sample question", index: 0, created_at: 1700000000 },
    { id: "", role: "assistant", content: "sample answer", index: 1, created_at: 1700000001 },
  ]);

  const rows = state.messages["conv-0003"];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id_source, "dom");
  assert.equal(rows[1].id_source, "derived");
  assert.ok(rows[1].id.startsWith(Store.DERIVED_ID_PREFIX));

  const auto = Store.syncScan(state, AUTO);
  assert.deepEqual(
    list(auto.records.map((row) => row.id)),
    ["msg-0004"]
  );
  assert.equal(auto.held.derived, 1);

  const history = Store.syncScan(state, HISTORY);
  assert.equal(history.records.length, 2);
  assert.equal(history.held.derived, 0);
});

test("a legacy row with no id_source is still recognised as a content-hash id", () => {
  const state = {
    enabled: true,
    index: { "conv-0004": { id: "conv-0004", streaming: false } },
    messages: {
      "conv-0004": [
        { id: "shadow:conv-0004:assistant:1:deadbeef", thread_id: "conv-0004", role: "assistant", content: "sample", created_at: 1700000000 },
      ],
    },
  };
  assert.equal(Store.isDerivedRow(state.messages["conv-0004"][0]), true);
  assert.equal(Store.syncScan(state, AUTO).held.derived, 1);
  assert.equal(Store.syncScan(state, HISTORY).records.length, 1);
});

test("holds every row in a thread whose reply is still streaming", () => {
  const streaming = seed(
    "conv-0005",
    [{ id: "msg-0005", role: "assistant", content: "partial sam", index: 0, created_at: 1700000000 }],
    { streaming: true }
  );
  assert.equal(Store.syncScan(streaming, HISTORY).records.length, 0);
  assert.equal(Store.syncScan(streaming, HISTORY).held.streaming, 1);

  const settled = Store.upsert(streaming, { id: "conv-0005", streaming: false }, [
    { id: "msg-0005", role: "assistant", content: "partial sample answer", index: 0, created_at: 1700000000 },
  ]);
  assert.equal(Store.syncScan(settled, HISTORY).records.length, 1);
});

test("the synced marker stops a second send", () => {
  let state = seed("conv-0006", [
    { id: "msg-0006", role: "user", content: "sample question", index: 0, created_at: 1700000000 },
    { id: "msg-0007", role: "assistant", content: "sample answer", index: 1, created_at: 1700000001 },
  ]);

  const first = Store.selectUnsynced(state, HISTORY);
  assert.equal(first.length, 2);

  state = Store.markSynced(state, first, 1700000100);
  const second = Store.syncScan(state, HISTORY);
  assert.equal(second.records.length, 0);
  assert.equal(second.synced, 2);
  assert.equal(state.messages["conv-0006"][0].synced_at, 1700000100);

  // A newly captured row in the same thread still goes out.
  state = Store.upsert(state, { id: "conv-0006" }, [
    { id: "msg-0008", role: "user", content: "second sample question", index: 2, created_at: 1700000200 },
  ]);
  assert.deepEqual(
    list(Store.selectUnsynced(state, HISTORY).map((row) => row.id)),
    ["msg-0008"]
  );
});

test("editing a row after it was sent clears the marker so the new text goes out", () => {
  let state = seed("conv-0007", [
    { id: "msg-0009", role: "assistant", content: "sample answer", index: 0, created_at: 1700000000 },
  ]);
  state = Store.markSynced(state, Store.selectUnsynced(state, HISTORY), 1700000100);
  assert.equal(Store.selectUnsynced(state, HISTORY).length, 0);

  state = Store.upsert(state, { id: "conv-0007" }, [
    { id: "msg-0009", role: "assistant", content: "sample answer, revised", index: 0, created_at: 1700000000 },
  ]);
  assert.equal(state.messages["conv-0007"][0].synced_at, undefined);
  assert.deepEqual(
    list(Store.selectUnsynced(state, HISTORY).map((row) => row.content)),
    ["sample answer, revised"]
  );
});

test("markSynced skips a row whose text moved on while the batch was in flight", () => {
  let state = seed("conv-0008", [
    { id: "msg-0010", role: "assistant", content: "sample ans", index: 0, created_at: 1700000000 },
  ]);
  const inFlight = Store.selectUnsynced(state, HISTORY);
  state = Store.upsert(state, { id: "conv-0008" }, [
    { id: "msg-0010", role: "assistant", content: "sample answer", index: 0, created_at: 1700000000 },
  ]);
  state = Store.markSynced(state, inFlight, 1700000100);
  assert.equal(state.messages["conv-0008"][0].synced_at, undefined);
  assert.equal(Store.selectUnsynced(state, HISTORY).length, 1);
});

test("the automatic send ignores rows captured before the connection baseline", () => {
  const state = seed("conv-0009", [
    { id: "msg-0011", role: "user", content: "older sample", index: 0, created_at: 1700000000 },
    // created_at has one-second resolution, so a row stamped in the connection
    // second counts as backlog rather than being sent on a coin flip.
    { id: "msg-0012", role: "user", content: "same second sample", index: 1, created_at: 1700005000 },
    { id: "msg-0013", role: "user", content: "newer sample", index: 2, created_at: 1700009999 },
  ]);
  const auto = Store.syncScan(state, { includeDerived: false, since: 1700005000, skipStreaming: true });
  assert.deepEqual(
    list(auto.records.map((row) => row.id)),
    ["msg-0013"]
  );
  assert.equal(auto.held.beforeBaseline, 2);
  // The history submit is the only path for the backlog.
  assert.equal(Store.countUnsynced(state, HISTORY), 3);
});

test("batches cap at 200 records", () => {
  const rows = [];
  for (let i = 0; i < 450; i += 1) {
    rows.push({
      id: `msg-${String(i).padStart(4, "0")}`,
      role: i % 2 ? "assistant" : "user",
      content: `sample line ${i}`,
      index: i,
      created_at: 1700000000 + i,
    });
  }
  const state = seed("conv-0010", rows);
  const records = Store.selectUnsynced(state, HISTORY);
  assert.equal(records.length, 450);

  const batches = Store.chunkRecords(records, ToposConfig.MAX_BATCH);
  assert.deepEqual(
    list(batches.map((batch) => batch.length)),
    [200, 200, 50]
  );
  assert.equal(batches.flat().length, records.length);
  // A caller asking for more than the cap still gets the cap.
  assert.deepEqual(
    list(Store.chunkRecords(records, 1000).map((batch) => batch.length)),
    [200, 200, 50]
  );
  assert.equal(ToposConfig.MAX_BATCH, 200);
});

test("records sent to Topos carry the same frozen field set as the JSONL export", () => {
  const state = seed("conv-0011", [
    { id: "msg-0013", role: "user", content: "sample question", index: 0, created_at: 1700000000 },
  ]);
  const wire = Store.selectUnsynced(state, HISTORY)[0];
  const exported = JSON.parse(Store.toJsonl(state).split("\n")[0]);
  assert.deepEqual(list(Object.keys(wire)), ["id", "thread_id", "role", "content", "created_at", "_metadata"]);
  assert.deepEqual(plain(wire._metadata), { conversation_title: "Sample thread" });
  // Compared as sent: JSON, so the sandbox's object prototypes do not count.
  assert.deepEqual(JSON.parse(JSON.stringify(wire)), exported);
  // Sync bookkeeping never reaches the wire or the export file.
  assert.equal("synced_at" in wire, false);
  assert.equal("id_source" in wire, false);
});

test("a placeholder title never reaches the wire, and the thread's latest title does", () => {
  const row = { id: "msg-0015", role: "user", content: "sample question", index: 0, created_at: 1700000000 };
  for (const title of ["New chat", "ChatGPT", "Untitled", "  "]) {
    const wire = Store.selectUnsynced(seed("conv-0013", [row], { title }), HISTORY)[0];
    assert.equal("_metadata" in wire, false, title);
  }
  // ChatGPT names a thread after its first reply; rows sent after that carry the name.
  let state = seed("conv-0014", [row], { title: "New chat" });
  state = Store.upsert(state, { id: "conv-0014", title: "Retention charts" }, []);
  assert.equal(Store.selectUnsynced(state, HISTORY)[0]._metadata.conversation_title, "Retention charts");
});

test("the ingest idempotency key is stable per batch and moves when content changes", () => {
  const batch = [
    { id: "msg-0014", thread_id: "conv-0012", role: "user", content: "sample question", created_at: 1700000000 },
  ];
  const edited = [{ ...batch[0], content: "sample question, revised" }];
  assert.equal(ToposIngest.idempotencyKey(batch), ToposIngest.idempotencyKey(batch.map((row) => ({ ...row }))));
  assert.notEqual(ToposIngest.idempotencyKey(batch), ToposIngest.idempotencyKey(edited));
});

test("the connect flow is configured for this extension", () => {
  assert.equal(ToposConfig.APP_ID, "chatgpt-shadow-extension");
  assert.equal(ToposConfig.SOURCE_ID, "chatgpt_ui_conversation");
  assert.equal(ToposConfig.SCOPES, "ai_conversations:write");
  assert.equal(ToposConfig.controlPlaneUrl().endsWith("/"), false);
});

test("pkce pairs are S256 and url safe", async () => {
  const pair = await ToposAuth.createPkcePair();
  assert.equal(pair.codeChallengeMethod, "S256");
  assert.equal(pair.codeVerifier.length, 64);
  assert.match(pair.codeVerifier, /^[A-Za-z0-9\-._~]+$/);
  assert.equal(pair.codeChallenge.length, 43);
  assert.match(pair.codeChallenge, /^[A-Za-z0-9\-_]+$/);
  const other = await ToposAuth.createPkcePair();
  assert.notEqual(pair.codeVerifier, other.codeVerifier);
});

test("update check: version comparison is numeric and segment-aware", () => {
  assert.equal(UpdateCheck.isNewer("0.1.0", "0.2.0"), true);
  assert.equal(UpdateCheck.isNewer("0.1.0", "0.1.0"), false);
  assert.equal(UpdateCheck.isNewer("0.2.0", "0.1.9"), false, "0.2.0 is newer than 0.1.9");
  assert.equal(UpdateCheck.isNewer("1.0", "1.0.1"), true, "a longer newer version wins");
  assert.equal(UpdateCheck.isNewer("1.10.0", "1.9.0"), false, "10 > 9 numerically, not lexically");
});

test("update check: a failed fetch never throws and reports the current version", async () => {
  const savedFetch = sandbox.fetch;
  sandbox.fetch = async () => {
    throw new Error("offline");
  };
  try {
    const result = await UpdateCheck.check("0.1.0");
    assert.equal(result.current, "0.1.0");
    assert.equal(result.updateAvailable, undefined);
    assert.ok(result.error, "an error is reported rather than thrown");
  } finally {
    sandbox.fetch = savedFetch;
  }
});

test("update check: a newer remote manifest is flagged", async () => {
  const savedFetch = sandbox.fetch;
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ version: "0.5.0" }) });
  try {
    const result = await UpdateCheck.check("0.1.0");
    assert.equal(result.updateAvailable, true);
    assert.equal(result.latest, "0.5.0");
  } finally {
    sandbox.fetch = savedFetch;
  }
});

// Shape of the ChatGPT front end that shipped late September 2026, taken from a
// live page: no data-message-author-role; one search unit per message, its key
// ending in the role, wrapping a div that carries the message and local chat ids.
function unitDoc(turns, { turnState = "complete", conversationId = "local-chatgpt:aaaa1111-2222" } = {}) {
  const units = [];
  turns.forEach((turn, i) => {
    units.push(
      h("div", { "data-chatgpt-search-unit-key": `fallback-turn-${i}:0:user`, "data-chatgpt-search-message-ids": turn.userId }, [
        h("div", { "data-user-message-bubble": "" }, [
          h("div", { class: "whitespace-pre-wrap" }, [t(turn.user)]),
          h("button", {}, [t("Edit")]),
        ]),
      ])
    );
    units.push(
      h("div", { "data-talvt-turn-state": turnState }, [
        h("div", {
          "data-chatgpt-search-unit-key": `fallback-turn-${i}:2:assistant`,
          "data-chatgpt-search-message-ids": `${turn.assistantId} ${turn.assistantId}`,
        }, [
          h("div", {
            "data-chatgpt-selection-conversation-id": conversationId,
            "data-chatgpt-selection-message-id": turn.assistantId,
          }, [
            h("div", { "data-markdown-text-style": "assistant-message" }, [
              h("p", {}, [t("Answer: "), h("strong", {}, [t(turn.assistant)])]),
            ]),
          ]),
        ]),
      ])
    );
  });
  const root = h("main", {}, units);
  root.ownerDocument = root;
  root.title = "Grant plan - ChatGPT";
  return root;
}

test("extracts messages from the search-unit layout", () => {
  const doc = unitDoc([
    { userId: "u1", user: "What should the grant cover?", assistantId: "a1", assistant: "staffing" },
    { userId: "u2", user: "And the timeline?", assistantId: "a2", assistant: "two years" },
  ]);
  const rows = Extract.extractMessages(doc);
  assert.deepEqual(
    Array.from(rows, (row) => [row.role, row.id, row.content]),
    [
      ["user", "u1", "What should the grant cover?"],
      ["assistant", "a1", "Answer: **staffing**"],
      ["user", "u2", "And the timeline?"],
      ["assistant", "a2", "Answer: **two years**"],
    ]
  );
  assert.deepEqual([...Extract.localConversationIdsOnPage(doc)], ["local-chatgpt:aaaa1111-2222"]);
});

test("turn state marks an unfinished reply as streaming, and only that", () => {
  const turn = [{ userId: "u1", user: "Hi", assistantId: "a1", assistant: "Hello" }];
  assert.equal(Extract.isStreaming(unitDoc(turn)), false);
  assert.equal(Extract.isStreaming(unitDoc(turn, { turnState: "streaming" })), true);
  // An unknown state must not hold the thread forever.
  assert.equal(Extract.isStreaming(unitDoc(turn, { turnState: "idle" })), false);
});

test("a local-chatgpt url is a placeholder, not a conversation id", () => {
  const href = "https://chatgpt.com/c/local-chatgpt%3Abbbb0000-0000-4000-8000-000000000000";
  assert.equal(Extract.conversationIdFromUrl(href), "");
  assert.equal(Extract.localConversationIdFromUrl(href), "local-chatgpt:bbbb0000-0000-4000-8000-000000000000");
  assert.equal(
    Extract.localConversationIdFromUrl("https://chatgpt.com/g/g-p-abc123-project/c/11112222-3333-4444-5555-666677778888"),
    ""
  );
  assert.equal(
    Extract.conversationIdFromUrl("https://chatgpt.com/g/g-p-abc123-project/c/11112222-3333-4444-5555-666677778888?model=x"),
    "11112222-3333-4444-5555-666677778888"
  );
});

test("a local-chatgpt thread is held until it is remapped to the server id", () => {
  let state = Store.emptyState();
  state = Store.upsert(state, { id: "pending:local-chatgpt:70a1" }, [
    { id: "u1", role: "user", content: "Hi", index: 0 },
  ]);
  assert.equal(Store.syncScan(state, { includeDerived: true }).held.pending, 1);
  state = Store.remapThread(state, "pending:local-chatgpt:70a1", "server-id-1");
  assert.equal(Store.syncScan(state, { includeDerived: true }).records.length, 1);
});

// ---------------------------------------------------------------------------
// One thread per message id, whitespace-only recaptures, and the one-time repair.
// Every fixture id below is synthetic.
// ---------------------------------------------------------------------------

const REPAIR_ONLY = { includeDerived: true, since: 0, skipStreaming: true, repair: "only" };
const HISTORY_ALL = { ...HISTORY, repair: "include" };
const json = (value) => JSON.parse(JSON.stringify(value));
const ids = (rows) => list((rows || []).map((row) => row.id));

function stored(messages, index = {}) {
  const idx = { ...index };
  Object.keys(messages).forEach((key) => {
    if (!idx[key]) idx[key] = { id: key, title: "Sample thread", messageCount: messages[key].length, streaming: false };
  });
  return { enabled: true, index: idx, messages };
}

test("a message id stored under one chat is not copied into another", () => {
  let state = seed("conv-0101", [
    { id: "msg-0101", role: "user", content: "sample question", index: 0, created_at: 1700000000 },
  ]);
  state = Store.markSynced(state, Store.selectUnsynced(state, HISTORY), 1700000100);
  state = Store.upsert(state, { id: "conv-0102", title: "Other thread" }, [
    { id: "msg-0101", role: "user", content: "sample question", index: 0, created_at: 1700000200 },
    { id: "msg-0102", role: "assistant", content: "sample answer", index: 1, created_at: 1700000201 },
  ]);
  assert.deepEqual(ids(state.messages["conv-0102"]), ["msg-0102"]);
  const home = state.messages["conv-0101"][0];
  assert.equal(home.thread_id, "conv-0101");
  assert.equal(home.synced_at, 1700000100);
  assert.deepEqual(ids(Store.syncScan(state, HISTORY).records), ["msg-0102"]);
});

test("a /share/ copy does not re-home stored messages", () => {
  let state = seed("conv-0103", [
    { id: "msg-0103", role: "user", content: "sample question", index: 0, created_at: 1700000000 },
  ]);
  state = Store.markSynced(state, Store.selectUnsynced(state, HISTORY), 1700000100);
  state = Store.upsert(state, { id: "share-0103", url: "https://chatgpt.com/share/share-0103" }, [
    { id: "msg-0103", role: "user", content: "sample question", index: 0, created_at: 1700000300 },
  ]);
  assert.equal(state.messages["share-0103"], undefined);
  assert.equal(state.index["share-0103"], undefined);
  assert.equal(Store.selectUnsynced(state, HISTORY_ALL).length, 0);
});

test("whitespace-only recapture is not an edit and keeps the stored bytes", () => {
  const original = "Hello  world\n\n- x";
  let state = seed("conv-0104", [{ id: "msg-0104", role: "assistant", content: original, index: 0, created_at: 1700000000 }]);
  state = Store.markSynced(state, Store.selectUnsynced(state, HISTORY), 1700000100);
  const before = state.messages["conv-0104"][0];
  state = Store.upsert(state, { id: "conv-0104" }, [
    { id: "msg-0104", role: "assistant", content: " Hello world\n- x ", index: 0, created_at: 1700000000 },
  ]);
  const after = state.messages["conv-0104"][0];
  assert.equal(after.synced_at, 1700000100);
  assert.equal(after.content, original);
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(Store.selectUnsynced(state, HISTORY).length, 0);
  // NBSP and the other Unicode spaces count as whitespace too.
  assert.equal(Store.normalizeForCompare("a  b\t\r\n"), "a b");
  assert.equal(Store.normalizeForCompare(undefined), "");
});

test("a real edit with whitespace noise still resends, stored as captured", () => {
  let state = seed("conv-0105", [{ id: "msg-0105", role: "assistant", content: "Hello  world", index: 0, created_at: 1700000000 }]);
  state = Store.markSynced(state, Store.selectUnsynced(state, HISTORY), 1700000100);
  state = Store.upsert(state, { id: "conv-0105" }, [
    { id: "msg-0105", role: "assistant", content: " Hello brave world ", index: 0, created_at: 1700000000 },
  ]);
  const row = state.messages["conv-0105"][0];
  assert.equal(row.synced_at, undefined);
  assert.equal(row.content, " Hello brave world ");
  assert.deepEqual(list(Store.selectUnsynced(state, HISTORY).map((r) => r.content)), [" Hello brave world "]);
});

test("upsert never rewrites a stored real thread_id", () => {
  let state = stored({
    "conv-0106": [{ id: "msg-0106", thread_id: "conv-0106", role: "user", content: "sample", created_at: 1700000000, synced_at: 1700000001 }],
  });
  state = Store.upsert(state, { id: "conv-0106" }, [
    { id: "msg-0106", role: "user", content: "sample, revised", index: 0, created_at: 1700000000 },
  ]);
  assert.equal(state.messages["conv-0106"][0].thread_id, "conv-0106");
  assert.equal(state.messages["conv-0106"][0].synced_at, undefined);

  // A row under a real key still carrying a pending thread_id resolves to the key.
  let pendingCarried = stored({
    "conv-0107": [{ id: "msg-0107", thread_id: "pending:1700000002", role: "user", content: "sample", created_at: 1700000002 }],
  });
  assert.equal(Store.syncScan(pendingCarried, HISTORY).held.pending, 1);
  pendingCarried = Store.upsert(pendingCarried, { id: "conv-0107" }, [
    { id: "msg-0107", role: "user", content: "sample", index: 0, created_at: 1700000002 },
  ]);
  assert.equal(pendingCarried.messages["conv-0107"][0].thread_id, "conv-0107");
});

test("a parked pending row moves to the real thread when it is captured there, keeping its fields", () => {
  let state = seed("pending:1700000300", [
    { id: "msg-0108", role: "user", content: "sample question", index: 0, created_at: 1700000300 },
  ]);
  state = Store.upsert(state, { id: "conv-0108" }, [
    { id: "msg-0108", role: "user", content: "sample question", index: 0, created_at: 1700000999 },
  ]);
  assert.equal(state.messages["pending:1700000300"], undefined);
  assert.equal(state.index["pending:1700000300"], undefined);
  const row = state.messages["conv-0108"][0];
  assert.equal(row.thread_id, "conv-0108");
  assert.equal(row.created_at, 1700000300);
  // And a pending thread never takes an id a real thread already holds.
  state = Store.upsert(state, { id: "pending:1700000400" }, [
    { id: "msg-0108", role: "user", content: "sample question", index: 0, created_at: 1700000400 },
  ]);
  assert.equal(state.messages["pending:1700000400"], undefined);
});

test("remap carries only ids on the page", () => {
  let state = stored({
    "conv-0110": [{ id: "msg-0001", thread_id: "conv-0110", role: "user", content: "stored", created_at: 1700000000, synced_at: 1700000001 }],
    "pending:1700000000": [
      { id: "msg-0001", thread_id: "pending:1700000000", role: "user", content: "stored", created_at: 1700000005 },
      { id: "msg-0008", thread_id: "pending:1700000000", role: "user", content: "stale", created_at: 1700000006 },
      { id: "msg-0009", thread_id: "pending:1700000000", role: "user", content: "on page", created_at: 1700000007 },
    ],
  });
  state = Store.remapThread(state, "pending:1700000000", "conv-0111", { ids: ["msg-0009"] });
  assert.deepEqual(ids(state.messages["conv-0111"]), ["msg-0009"]);
  assert.equal(state.messages["conv-0111"][0].thread_id, "conv-0111");
  assert.deepEqual(ids(state.messages["pending:1700000000"]), ["msg-0008"]);
  assert.equal(state.index["pending:1700000000"].messageCount, 1);
  // The tab forgets the placeholder after the remap: the row left behind is
  // listed as belonging to no chat, not as waiting for an id.
  assert.equal(state.index["pending:1700000000"].unassigned, true);
  assert.equal(state.messages["conv-0110"][0].synced_at, 1700000001);
  const scan = Store.syncScan(state, HISTORY_ALL);
  assert.equal(scan.held.pending, 0);
  assert.equal(scan.held.unassigned, 1);
  assert.deepEqual(ids(scan.records), ["msg-0009"]);
});

test("remap without ids moves every row except copies of stored rows", () => {
  let state = stored({
    "conv-0112": [{ id: "msg-0112", thread_id: "conv-0112", role: "user", content: "stored", created_at: 1700000000 }],
    "pending:1700000010": [
      { id: "msg-0112", thread_id: "pending:1700000010", role: "user", content: "stored", created_at: 1700000010 },
      { id: "msg-0113", thread_id: "pending:1700000010", role: "user", content: "new", created_at: 1700000011 },
    ],
  });
  state = Store.remapThread(state, "pending:1700000010", "conv-0113");
  assert.deepEqual(ids(state.messages["conv-0113"]), ["msg-0113"]);
  assert.deepEqual(ids(state.messages["conv-0112"]), ["msg-0112"]);
  assert.equal(state.messages["pending:1700000010"], undefined);
  assert.equal(state.index["pending:1700000010"], undefined);
});

test("repair removes the wrong copy and marks the home row when the wrong copy was sent last", () => {
  const state = stored({
    "conv-A": [{ id: "msg-0001", thread_id: "conv-A", role: "assistant", content: "x y", created_at: 100, synced_at: 200 }],
    "conv-B": [{ id: "msg-0001", thread_id: "conv-B", role: "assistant", content: "x  y", created_at: 300, synced_at: 400 }],
  });
  const result = Store.repairThreadIds(state);
  assert.equal(result.repaired, 1);
  assert.equal(result.removed, 1);
  const next = result.state;
  assert.equal(next.messages["conv-B"], undefined);
  assert.equal(next.index["conv-B"], undefined);
  const home = next.messages["conv-A"][0];
  assert.equal(home.thread_id, "conv-A");
  assert.equal(home.synced_at, undefined);
  assert.equal(home.repair, "thread_id");
  // Same updated_at: the home keeps its own bytes; the wire carries the node's.
  assert.equal(home.content, "x y");
  assert.equal(home.repair_content, "x  y");
  assert.equal(next.index["conv-A"].messageCount, 1);
  // The removed copy and its chat's index entry are kept in the archive.
  assert.equal(result.archive["conv-B"].meta.title, "Sample thread");
  assert.deepEqual(json(result.archive["conv-B"].rows.map((row) => [row.id, row.content, row.archived, row.home])), [
    ["msg-0001", "x  y", "copy", "conv-A"],
  ]);
  // Held on the automatic path, sent only by the repair-only scan.
  const auto = Store.syncScan(next, AUTO);
  assert.equal(auto.held.repair, 1);
  assert.equal(auto.records.length, 0);
  assert.deepEqual(json(Store.syncScan(next, REPAIR_ONLY).records), [
    { id: "msg-0001", thread_id: "conv-A", role: "assistant", content: "x  y", created_at: 100, _metadata: { conversation_title: "Sample thread" } },
  ]);
  // The input is untouched.
  assert.equal(state.messages["conv-B"].length, 1);
  assert.equal(state.messages["conv-A"][0].synced_at, 200);
});

test("repair leaves the home row alone when it was sent after the wrong copy", () => {
  const state = stored({
    "conv-A": [{ id: "msg-0002", thread_id: "conv-A", role: "user", content: "sample", created_at: 100, synced_at: 500 }],
    "conv-B": [{ id: "msg-0002", thread_id: "conv-B", role: "user", content: "sample", created_at: 300, synced_at: 400 }],
  });
  const result = Store.repairThreadIds(state);
  assert.equal(result.repaired, 0);
  assert.equal(result.removed, 1);
  assert.equal(result.state.messages["conv-B"], undefined);
  const home = result.state.messages["conv-A"][0];
  assert.equal(home.synced_at, 500);
  assert.equal("repair" in home, false);
  // The first send may have been conv-B's, so the node may file it under conv-B
  // while its latest thread_id says conv-A: counted, not resent.
  assert.equal(result.nodeSide, 1);
  assert.equal(home.node_thread, "conv-B");
  assert.equal(home.thread_id, "conv-A");
  assert.deepEqual(json(Store.nodeSideCounts(result.state)), { total: 1, mismatch: 1 });
});

test("repair leaves an unsent wrong copy's home row to the normal send", () => {
  const state = stored({
    "conv-A": [{ id: "msg-0003", thread_id: "conv-A", role: "user", content: "sample", created_at: 100, synced_at: 150 }],
    "conv-B": [{ id: "msg-0003", thread_id: "conv-B", role: "user", content: "sample", created_at: 300 }],
  });
  const result = Store.repairThreadIds(state);
  assert.equal(result.repaired, 0);
  assert.equal(result.removed, 1);
  assert.equal(result.state.messages["conv-A"][0].synced_at, 150);
});

test("repair tie-break is deterministic", () => {
  // Equal created_at: the earlier synced_at is home.
  let result = Store.repairThreadIds(stored({
    "conv-B": [{ id: "msg-0004", thread_id: "conv-B", role: "user", content: "b", created_at: 100, synced_at: 300 }],
    "conv-A": [{ id: "msg-0004", thread_id: "conv-A", role: "user", content: "a", created_at: 100, synced_at: 200 }],
  }));
  assert.deepEqual(Object.keys(result.state.messages), ["conv-A"]);
  assert.equal(result.repaired, 1);
  assert.equal(result.state.messages["conv-A"][0].content, "a");
  assert.equal(result.state.messages["conv-A"][0].repair_content, "b");

  // Equal created_at, one unsynced: the synced copy is home.
  result = Store.repairThreadIds(stored({
    "conv-A": [{ id: "msg-0005", thread_id: "conv-A", role: "user", content: "a", created_at: 100 }],
    "conv-B": [{ id: "msg-0005", thread_id: "conv-B", role: "user", content: "b", created_at: 100, synced_at: 300 }],
  }));
  assert.deepEqual(Object.keys(result.state.messages), ["conv-B"]);
  assert.equal(result.repaired, 0);

  // Equal again: the lexically lower key is home, and an equal synced_at resends (>=).
  result = Store.repairThreadIds(stored({
    "conv-B": [{ id: "msg-0006", thread_id: "conv-B", role: "user", content: "b", created_at: 100, synced_at: 300 }],
    "conv-A": [{ id: "msg-0006", thread_id: "conv-A", role: "user", content: "a", created_at: 100, synced_at: 300 }],
  }));
  assert.deepEqual(Object.keys(result.state.messages), ["conv-A"]);
  assert.equal(result.repaired, 1);
  assert.equal(result.state.messages["conv-A"][0].repair, "thread_id");
});

test("repair is idempotent", () => {
  const state = stored({
    "conv-A": [
      { id: "msg-0007", thread_id: "conv-A", role: "user", content: "x", created_at: 100, synced_at: 200 },
      { id: "msg-0008", thread_id: "conv-Z", role: "user", content: "y", created_at: 101, synced_at: 201 },
    ],
    "conv-B": [{ id: "msg-0007", thread_id: "conv-B", role: "user", content: "x", created_at: 300, synced_at: 400 }],
    "pending:1700000000": [{ id: "msg-0007", thread_id: "pending:1700000000", role: "user", content: "x", created_at: 50 }],
  });
  const first = Store.repairThreadIds(state);
  assert.equal(first.repaired, 1);
  assert.equal(first.removed, 2);
  assert.equal(first.nodeSide, 1);
  const second = Store.repairThreadIds(first.state);
  assert.equal(second.repaired, 0);
  assert.equal(second.removed, 0);
  assert.equal(second.nodeSide, 0);
  assert.deepEqual(json(second.archive), {});
  assert.deepEqual(json(second.state), json(first.state));
  // Folding the same run into the archive twice adds nothing.
  const once = Store.mergeArchive({}, first.archive);
  assert.deepEqual(json(Store.mergeArchive(once, first.archive)), json(once));
});

test("repair leaves a sent row whose thread_id disagrees with its key where the node files it", () => {
  // Sent only under conv-Z, so the node files it under conv-Z with thread_id
  // conv-Z: consistent. A resend under conv-A would split it, so it is not marked.
  const result = Store.repairThreadIds(stored({
    "conv-A": [
      { id: "msg-0009", thread_id: "conv-Z", role: "user", content: "sent", created_at: 100, synced_at: 200 },
      { id: "msg-0010", thread_id: "conv-Z", role: "user", content: "unsent", created_at: 101 },
    ],
  }));
  assert.equal(result.repaired, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.nodeSide, 1);
  const [sent, unsent] = result.state.messages["conv-A"];
  assert.equal(sent.thread_id, "conv-Z");
  assert.equal(sent.node_thread, "conv-Z");
  assert.equal("repair" in sent, false);
  assert.equal(sent.synced_at, 200);
  assert.equal(unsent.thread_id, "conv-A");
  assert.equal("repair" in unsent, false);
  assert.deepEqual(json(Store.nodeSideCounts(result.state)), { total: 1, mismatch: 0 });
  assert.deepEqual(ids(Store.syncScan(result.state, REPAIR_ONLY).records), []);
  assert.deepEqual(ids(Store.syncScan(result.state, HISTORY_ALL).records), ["msg-0010"]);
  // Idempotent.
  assert.equal(Store.repairThreadIds(result.state).state, result.state);
});

test("repair drops pending duplicates and still never sends pending rows", () => {
  const result = Store.repairThreadIds(stored({
    "pending:1700000001": [
      { id: "msg-0011", thread_id: "pending:1700000001", role: "user", content: "dup", created_at: 50 },
      { id: "msg-0012", thread_id: "pending:1700000001", role: "user", content: "only here", created_at: 51 },
    ],
    "conv-A": [{ id: "msg-0011", thread_id: "conv-A", role: "user", content: "dup", created_at: 100, synced_at: 200 }],
  }));
  assert.equal(result.removed, 1);
  assert.equal(result.repaired, 0);
  assert.deepEqual(ids(result.state.messages["pending:1700000001"]), ["msg-0012"]);
  assert.equal(result.state.messages["conv-A"][0].synced_at, 200);
  const scan = Store.syncScan(result.state, HISTORY_ALL);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.held.pending, 1);
  // Copies only under pending keys are not touched by the repair.
  const pendingOnly = stored({
    "pending:1": [{ id: "msg-0013", thread_id: "pending:1", role: "user", content: "p", created_at: 1 }],
    "pending:2": [{ id: "msg-0013", thread_id: "pending:2", role: "user", content: "p", created_at: 2 }],
  });
  assert.equal(Store.repairThreadIds(pendingOnly).removed, 0);
});

test("markSynced clears the repair flag", () => {
  let state = Store.repairThreadIds(stored({
    "conv-A": [{ id: "msg-0014", thread_id: "conv-A", role: "user", content: "x", created_at: 100, synced_at: 200 }],
    "conv-B": [{ id: "msg-0014", thread_id: "conv-B", role: "user", content: "x", created_at: 300, synced_at: 400 }],
  })).state;
  const batch = Store.syncScan(state, REPAIR_ONLY).records;
  assert.equal(batch.length, 1);
  state = Store.markSynced(state, batch, 1700000500);
  const row = state.messages["conv-A"][0];
  assert.equal(row.synced_at, 1700000500);
  assert.equal("repair" in row, false);
  assert.equal(Store.syncScan(state, REPAIR_ONLY).records.length, 0);
});

test("Send history includes corrections; the repair-only scan skips everything else", () => {
  const state = Store.repairThreadIds(stored({
    "conv-A": [
      { id: "msg-0015", thread_id: "conv-A", role: "user", content: "x", created_at: 100, synced_at: 200 },
      { id: "msg-0016", thread_id: "conv-A", role: "user", content: "new", created_at: 101 },
    ],
    "conv-B": [{ id: "msg-0015", thread_id: "conv-B", role: "user", content: "x", created_at: 300, synced_at: 400 }],
  })).state;
  assert.deepEqual(ids(Store.syncScan(state, HISTORY_ALL).records), ["msg-0015", "msg-0016"]);
  // Default (no repair option) holds the correction.
  const plainHistory = Store.syncScan(state, HISTORY);
  assert.deepEqual(ids(plainHistory.records), ["msg-0016"]);
  assert.equal(plainHistory.held.repair, 1);
  assert.deepEqual(ids(Store.syncScan(state, REPAIR_ONLY).records), ["msg-0015"]);
});

test("repair flag never reaches the wire or the export", () => {
  const state = Store.repairThreadIds(stored(
    {
      "conv-A": [{ id: "msg-0017", thread_id: "conv-A", role: "user", content: "x", created_at: 100, synced_at: 200 }],
      "conv-B": [{ id: "msg-0017", thread_id: "conv-B", role: "user", content: "x", created_at: 300, synced_at: 400 }],
    },
    { "conv-A": { id: "conv-A", title: "New chat", messageCount: 1 } }
  )).state;
  const record = Store.syncScan(state, REPAIR_ONLY).records[0];
  assert.deepEqual(list(Object.keys(record)), ["id", "thread_id", "role", "content", "created_at"]);
  Store.toJsonl(state)
    .split("\n")
    .forEach((line) => {
      const row = JSON.parse(line);
      assert.equal("repair" in row, false);
      assert.equal("synced_at" in row, false);
      assert.equal("id_source" in row, false);
    });
});

test("the ingest idempotency key moves when only thread_id changes", () => {
  const sent = [{ id: "msg-0018", thread_id: "conv-A", role: "user", content: "sample", created_at: 1700000000 }];
  const corrected = [{ ...sent[0], thread_id: "conv-B" }];
  assert.notEqual(ToposIngest.idempotencyKey(sent), ToposIngest.idempotencyKey(corrected));
  assert.equal(ToposIngest.idempotencyKey(sent), ToposIngest.idempotencyKey(sent.map((row) => ({ ...row }))));
});

test("content script remap ids match the ids the store filed the page under", () => {
  const pendingId = "pending:1700000020";
  const page = [
    { id: "msg-0019", role: "user", content: "sample question", index: 0 },
    { id: "", role: "assistant", content: "sample answer", index: 1 },
  ];
  let state = Store.upsert(Store.emptyState(), { id: pendingId }, page);
  const onPage = page.map((row) => Extract.toV1Record(pendingId, row, 0).id).filter(Boolean);
  state = Store.remapThread(state, pendingId, "conv-0120", { ids: onPage });
  assert.equal(state.messages[pendingId], undefined);
  assert.equal(state.messages["conv-0120"].length, 2);
});

// ---------------------------------------------------------------------------
// Review fixes: the repair marks only rows the node files under the home chat,
// keeps what it removes, and the capture path cannot pick the wrong first home.
// Every fixture id below is synthetic.
// ---------------------------------------------------------------------------

test("repair does not mark a row whose home copy was never sent and a wrong copy was", () => {
  // The node got only conv-B's copy: it files the row under conv-B with thread_id
  // conv-B, which is consistent. A resend under conv-A would split it.
  const result = Store.repairThreadIds(stored({
    "conv-A": [{ id: "msg-0201", thread_id: "conv-A", role: "user", content: "home text", created_at: 100, updated_at: 100 }],
    "conv-B": [{ id: "msg-0201", thread_id: "conv-B", role: "user", content: "node text", created_at: 300, updated_at: 300, synced_at: 400 }],
  }));
  assert.equal(result.repaired, 0);
  assert.equal(result.removed, 1);
  assert.equal(result.nodeSide, 1);
  const home = result.state.messages["conv-A"][0];
  assert.equal("repair" in home, false);
  // The home mirrors what the node holds, so no path sends it under conv-A.
  assert.equal(home.synced_at, 400);
  assert.equal(home.content, "node text");
  assert.equal(home.thread_id, "conv-B");
  assert.equal(home.node_thread, "conv-B");
  for (const options of [AUTO, HISTORY_ALL, REPAIR_ONLY]) {
    assert.deepEqual(ids(Store.syncScan(result.state, options).records), []);
  }
  assert.deepEqual(json(Store.nodeSideCounts(result.state)), { total: 1, mismatch: 0 });
  // The home's own text and the removed copy are both in the archive.
  assert.deepEqual(json(result.archive["conv-A"].rows.map((row) => [row.content, row.archived])), [["home text", "replaced"]]);
  assert.deepEqual(json(result.archive["conv-B"].rows.map((row) => [row.content, row.archived])), [["node text", "copy"]]);
  // A later edit goes out under the chat the node already names, never conv-A.
  let state = Store.upsert(result.state, { id: "conv-A" }, [
    { id: "msg-0201", role: "user", content: "edited text", index: 0, created_at: 100 },
  ]);
  assert.deepEqual(json(Store.syncScan(state, HISTORY_ALL).records.map((r) => [r.id, r.thread_id])), [["msg-0201", "conv-B"]]);
  assert.equal(Store.repairThreadIds(result.state).state, result.state);
});

test("repair does not mark a row a wrong copy reached first, even when another wrong copy went last", () => {
  // Sends in order: conv-B (200), conv-A home (300), conv-C (400). The node files
  // it under conv-B; a resend under conv-A would still disagree with conv-B.
  const result = Store.repairThreadIds(stored({
    "conv-A": [{ id: "msg-0202", thread_id: "conv-A", role: "user", content: "a", created_at: 100, synced_at: 300 }],
    "conv-B": [{ id: "msg-0202", thread_id: "conv-B", role: "user", content: "b", created_at: 150, synced_at: 200 }],
    "conv-C": [{ id: "msg-0202", thread_id: "conv-C", role: "user", content: "c", created_at: 160, synced_at: 400 }],
  }));
  assert.equal(result.repaired, 0);
  assert.equal(result.removed, 2);
  assert.equal(result.nodeSide, 1);
  const home = result.state.messages["conv-A"][0];
  assert.equal("repair" in home, false);
  assert.equal(home.node_thread, "conv-B");
  assert.equal(home.thread_id, "conv-C");
  assert.equal(home.synced_at, 400);
  assert.deepEqual(json(Store.nodeSideCounts(result.state)), { total: 1, mismatch: 1 });
  assert.deepEqual(ids(Store.syncScan(result.state, REPAIR_ONLY).records), []);
  assert.deepEqual(ids(Store.syncScan(result.state, HISTORY_ALL).records), []);
});

test("repair marks a row only when the home went first; a wrong copy sent before and after still blocks it", () => {
  // Home first (100), wrong copies at 200 and 300: the node files it under conv-A.
  const marked = Store.repairThreadIds(stored({
    "conv-A": [{ id: "msg-0203", thread_id: "conv-A", role: "user", content: "a", created_at: 100, synced_at: 100 }],
    "conv-B": [{ id: "msg-0203", thread_id: "conv-B", role: "user", content: "b", created_at: 150, synced_at: 200 }],
    "conv-C": [{ id: "msg-0203", thread_id: "conv-C", role: "user", content: "c", created_at: 160, synced_at: 300 }],
  }));
  assert.equal(marked.repaired, 1);
  assert.equal(marked.nodeSide, 0);
  assert.deepEqual(json(Store.syncScan(marked.state, REPAIR_ONLY).records.map((r) => [r.thread_id, r.content])), [["conv-A", "c"]]);
});

test("a correction carries the node's text; newer home text is kept locally and follows it", () => {
  let state = Store.repairThreadIds(stored({
    "conv-A": [{ id: "msg-0204", thread_id: "conv-A", role: "assistant", content: "newer edited text", created_at: 100, updated_at: 600, synced_at: 200 }],
    "conv-B": [{ id: "msg-0204", thread_id: "conv-B", role: "assistant", content: "old text", created_at: 300, updated_at: 300, synced_at: 400 }],
  })).state;
  const home = state.messages["conv-A"][0];
  assert.equal(home.content, "newer edited text");
  const batch = Store.syncScan(state, REPAIR_ONLY).records;
  assert.deepEqual(json(batch.map((r) => [r.thread_id, r.content])), [["conv-A", "old text"]]);
  state = Store.markSynced(state, batch, 700);
  const after = state.messages["conv-A"][0];
  assert.equal("repair" in after, false);
  assert.equal("repair_content" in after, false);
  // The correction landed; the newer local text has not, so it is still unsent.
  assert.equal(after.synced_at, undefined);
  assert.deepEqual(json(Store.syncScan(state, HISTORY_ALL).records.map((r) => [r.thread_id, r.content])), [
    ["conv-A", "newer edited text"],
  ]);
});

test("a correction takes the most recently updated copy's text when that is the wrong copy", () => {
  const result = Store.repairThreadIds(stored({
    "conv-A": [{ id: "msg-0205", thread_id: "conv-A", role: "assistant", content: "first text", created_at: 100, updated_at: 100, synced_at: 200 }],
    "conv-B": [{ id: "msg-0205", thread_id: "conv-B", role: "assistant", content: "newest text", created_at: 300, updated_at: 700, synced_at: 400 }],
  }));
  let state = result.state;
  assert.equal(state.messages["conv-A"][0].content, "newest text");
  // The home's replaced bytes are archived.
  assert.deepEqual(json(result.archive["conv-A"].rows.map((row) => [row.content, row.archived])), [["first text", "replaced"]]);
  const batch = Store.syncScan(state, REPAIR_ONLY).records;
  state = Store.markSynced(state, batch, 800);
  assert.equal(state.messages["conv-A"][0].synced_at, 800);
  assert.deepEqual(ids(Store.syncScan(state, HISTORY_ALL).records), []);
});

test("a real edit on a row waiting for a correction is held with it and goes out after it", () => {
  let state = Store.repairThreadIds(stored({
    "conv-A": [{ id: "msg-0206", thread_id: "conv-A", role: "user", content: "x", created_at: 100, synced_at: 200 }],
    "conv-B": [{ id: "msg-0206", thread_id: "conv-B", role: "user", content: "x", created_at: 300, synced_at: 400 }],
  })).state;
  state = Store.upsert(state, { id: "conv-A" }, [
    { id: "msg-0206", role: "user", content: "a real new edit", index: 0, created_at: 100 },
  ]);
  const auto = Store.syncScan(state, AUTO);
  assert.equal(auto.records.length, 0);
  assert.equal(auto.held.repair, 1);
  // The correction still changes only thread_id.
  const batch = Store.syncScan(state, REPAIR_ONLY).records;
  assert.deepEqual(json(batch.map((r) => r.content)), ["x"]);
  state = Store.markSynced(state, batch, 500);
  assert.deepEqual(json(Store.syncScan(state, AUTO).records.map((r) => [r.thread_id, r.content])), [
    ["conv-A", "a real new edit"],
  ]);
});

test("a derived id hashes the collapsed text, so a whitespace variant is the same row", () => {
  let state = Store.upsert(Store.emptyState(), { id: "conv-0207" }, [
    { id: "", role: "assistant", content: "Hello  world", index: 0, created_at: 100 },
  ]);
  state = Store.upsert(state, { id: "conv-0207" }, [
    { id: "", role: "assistant", content: "Hello world", index: 0, created_at: 100 },
  ]);
  assert.equal(state.messages["conv-0207"].length, 1);
  assert.equal(state.messages["conv-0207"][0].content, "Hello  world");
  assert.equal(Extract.collapseWhitespace(" a   b\n"), Store.normalizeForCompare(" a   b\n"));
});

test("a derived row stored under its pre-0.2.3 id keeps that id when the same text is seen again", () => {
  const message = { id: "", role: "assistant", content: "Hello  world", index: 0 };
  const legacy = Extract.legacyMessageId("conv-0208", message);
  assert.notEqual(legacy, Extract.stableMessageId("conv-0208", message));
  let state = stored({
    "conv-0208": [{ id: legacy, thread_id: "conv-0208", role: "assistant", content: "Hello  world", created_at: 100, synced_at: 150 }],
  });
  state = Store.upsert(state, { id: "conv-0208" }, [{ ...message, created_at: 100 }]);
  assert.deepEqual(ids(state.messages["conv-0208"]), [legacy]);
  assert.equal(state.messages["conv-0208"][0].synced_at, 150);
  // The remap id list carries both forms.
  assert.deepEqual(list(Extract.pageRecordIds("conv-0208", [message, { id: "msg-0208", role: "user", content: "q", index: 1 }])), [
    Extract.stableMessageId("conv-0208", message),
    legacy,
    "msg-0208",
  ]);
});

test("a copy parked under a local chat moves into a real chat only when the page carries that local id", () => {
  const parked = () =>
    seed("pending:local-chatgpt:L1", [{ id: "msg-0209", role: "user", content: "sample", index: 0, created_at: 100 }]);
  // The URL names conv-B, but nothing ties the page to the local chat: the row
  // stays parked and is not filed under conv-B either.
  let state = Store.upsert(parked(), { id: "conv-B" }, [
    { id: "msg-0209", role: "user", content: "sample", index: 0, created_at: 200 },
  ]);
  assert.deepEqual(ids(state.messages["pending:local-chatgpt:L1"]), ["msg-0209"]);
  assert.equal(state.messages["conv-B"], undefined);
  assert.equal(Store.syncScan(state, HISTORY_ALL).records.length, 0);
  // The page still carries the local id: it is that chat, and the row moves.
  state = Store.upsert(parked(), { id: "conv-B", localIds: ["local-chatgpt:L1"] }, [
    { id: "msg-0209", role: "user", content: "sample", index: 0, created_at: 200 },
  ]);
  assert.equal(state.messages["pending:local-chatgpt:L1"], undefined);
  assert.deepEqual(json(state.messages["conv-B"].map((row) => [row.id, row.thread_id, row.created_at])), [["msg-0209", "conv-B", 100]]);
});

test("a row a remap left behind moves into a real chat if it is seen there later", () => {
  let state = stored({
    "pending:1": [
      { id: "msg-0210", thread_id: "pending:1", role: "user", content: "left", created_at: 1 },
      { id: "msg-0211", thread_id: "pending:1", role: "user", content: "moved", created_at: 2 },
    ],
  });
  state = Store.remapThread(state, "pending:1", "conv-B", { ids: ["msg-0211"] });
  assert.equal(state.index["pending:1"].unassigned, true);
  assert.equal(Store.syncScan(state, HISTORY_ALL).held.unassigned, 1);
  state = Store.upsert(state, { id: "conv-C" }, [{ id: "msg-0210", role: "user", content: "left", index: 0 }]);
  assert.equal(state.messages["pending:1"], undefined);
  assert.equal(state.index["pending:1"], undefined);
  assert.deepEqual(ids(state.messages["conv-C"]), ["msg-0210"]);
});

test("messages whose markup names another saved chat than the URL are dropped", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const rows = [
    { id: "m1", conversationId: A },
    { id: "m2", conversationId: B.toUpperCase() },
    { id: "m3", conversationId: "local-chatgpt:cccc" },
    { id: "m4", conversationId: "" },
  ];
  assert.deepEqual(list(Extract.messagesForUrl(rows, `https://chatgpt.com/c/${B}`).map((r) => r.id)), ["m2", "m3", "m4"]);
  // No saved id in the URL, or a /share/ page: nothing is dropped.
  assert.equal(Extract.messagesForUrl(rows, "https://chatgpt.com/").length, 4);
  assert.equal(Extract.messagesForUrl(rows, `https://chatgpt.com/share/${B}`).length, 4);
  // Extraction records the id the markup carries.
  const doc = unitDoc([{ userId: "u1", user: "q", assistantId: "a1", assistant: "x" }]);
  const extracted = Extract.extractMessages(doc);
  assert.deepEqual(list(extracted.map((r) => r.conversationId)), ["", "local-chatgpt:aaaa1111-2222"]);
});

// ---------------------------------------------------------------------------
// Wiring: content.js and background.js run in their own sandboxes against stub
// browser APIs, so the messages they exchange are what the tests read.
// ---------------------------------------------------------------------------

function contentHarness(href, page) {
  let now = 1_000_000;
  let seq = 0;
  let pollAt = Infinity;
  let poll = () => {};
  let onMutate = () => {};
  const timers = [];
  const sent = [];
  const view = { page };
  const chip = { dataset: {}, textContent: "" };
  const location = {
    href,
    get pathname() {
      return new URL(this.href).pathname;
    },
  };
  const document = {
    documentElement: { appendChild() {} },
    getElementById: () => chip,
    createElement: () => chip,
    querySelectorAll: (selector) => view.page.querySelectorAll(selector),
    querySelector: (selector) => view.page.querySelector(selector),
    get title() {
      return view.page.title;
    },
  };
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const box = {
    console,
    URL,
    Date: FakeDate,
    location,
    document,
    MutationObserver: class {
      constructor(callback) {
        onMutate = callback;
      }
      observe() {}
      disconnect() {}
    },
    setInterval(fn, ms) {
      poll = fn;
      pollAt = now + ms;
    },
    window: {
      setTimeout(fn, ms) {
        seq += 1;
        timers.push({ fn, at: now + (ms || 0), id: seq });
        return seq;
      },
      clearTimeout(id) {
        const at = timers.findIndex((timer) => timer.id === id);
        if (at >= 0) timers.splice(at, 1);
      },
      addEventListener() {},
    },
    chrome: {
      runtime: {
        id: "test-extension",
        lastError: undefined,
        sendMessage(payload, callback) {
          sent.push(JSON.parse(JSON.stringify(payload)));
          if (callback) callback();
        },
      },
      storage: {
        local: { get: (defaults, callback) => callback({ ...defaults }), set() {}, remove() {} },
        onChanged: { addListener() {} },
      },
    },
  };
  box.globalThis = box;
  vm.runInNewContext(fs.readFileSync(path.join(root, "extract.js"), "utf8"), box);
  vm.runInNewContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), box);
  return {
    sent,
    location,
    view,
    mutate: () => onMutate(),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        const pollDue = pollAt <= end ? pollAt : Infinity;
        if (!due && pollDue === Infinity) break;
        if (due && due.at <= pollDue) {
          now = Math.max(now, due.at);
          timers.splice(timers.indexOf(due), 1);
          due.fn();
        } else {
          now = pollDue;
          pollAt += 800;
          poll();
        }
      }
      now = end;
    },
  };
}

const UUID_A = "aaaaaaaa-1111-4111-8111-000000000001";
const UUID_B = "bbbbbbbb-2222-4222-8222-000000000002";

test("content script: a remap carries the ids the store filed the page under, derived ids included", () => {
  const page = unitDoc([{ userId: "", user: "sample question", assistantId: "msg-0301", assistant: "sample" }], { conversationId: "" });
  const tab = contentHarness("https://chatgpt.com/", page);
  tab.advance(3000);
  const first = tab.sent.filter((m) => m.type === "shadow.upsert");
  assert.equal(first.length, 1);
  const pendingId = first[0].conversation.id;
  assert.ok(pendingId.startsWith("pending:"));

  tab.location.href = `https://chatgpt.com/c/${UUID_A}`;
  tab.mutate();
  tab.advance(3000);
  const remap = tab.sent.find((m) => m.type === "shadow.remap");
  assert.ok(remap, "a remap is sent once the URL names the chat");
  assert.equal(remap.fromId, pendingId);
  assert.equal(remap.toId, UUID_A);
  assert.deepEqual(remap.ids, list(Extract.pageRecordIds(pendingId, Extract.extractMessages(page))));
  assert.ok(remap.ids.some((id) => id.startsWith("shadow:")));

  // Played through the store in order, every row on the page moves.
  let state = Store.emptyState();
  tab.sent.forEach((m) => {
    if (m.type === "shadow.upsert") state = Store.upsert(state, m.conversation, m.messages);
    if (m.type === "shadow.remap") state = Store.remapThread(state, m.fromId, m.toId, { ids: m.ids });
  });
  assert.equal(state.messages[pendingId], undefined);
  assert.ok(state.messages[UUID_A].length >= 2);
});

test("content script: the page is not read against a URL that just changed", () => {
  const pageA = unitDoc([{ userId: "msg-0302", user: "first chat", assistantId: "msg-0303", assistant: "a" }], { conversationId: "" });
  const tab = contentHarness(`https://chatgpt.com/c/${UUID_A}`, pageA);
  tab.advance(3000);
  assert.deepEqual(tab.sent.filter((m) => m.type === "shadow.upsert").map((m) => m.conversation.id), [UUID_A]);

  // The URL moves to chat B while the page still shows chat A for a moment.
  tab.location.href = `https://chatgpt.com/c/${UUID_B}`;
  tab.mutate();
  tab.advance(1000);
  tab.view.page = unitDoc([{ userId: "msg-0304", user: "second chat", assistantId: "msg-0305", assistant: "b" }], { conversationId: "" });
  tab.mutate();
  tab.advance(3000);
  const underB = tab.sent.filter((m) => m.type === "shadow.upsert" && m.conversation.id === UUID_B);
  assert.ok(underB.length >= 1);
  underB.forEach((m) => assert.deepEqual(m.messages.map((row) => row.id), ["msg-0304", "msg-0305"]));
});

test("content script: messages the markup files under another saved chat are never sent under this URL", () => {
  // The page has rendered chat A while the URL still names chat B, for longer
  // than the settle window.
  const page = unitDoc([{ userId: "msg-0306", user: "first chat", assistantId: "msg-0307", assistant: "a" }], { conversationId: UUID_A });
  const tab = contentHarness(`https://chatgpt.com/c/${UUID_B}`, page);
  tab.advance(5000);
  tab.sent
    .filter((m) => m.type === "shadow.upsert")
    .forEach((m) => assert.equal(m.messages.some((row) => row.id === "msg-0307"), false));
});

function backgroundHarness(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  const listeners = { installed: [], startup: [], message: [] };
  const copy = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const box = {
    console,
    crypto,
    btoa,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    importScripts() {},
    fetch: async () => {
      throw new Error("no network in tests");
    },
    chrome: {
      storage: {
        local: {
          async get(defaults) {
            const out = {};
            Object.keys(defaults).forEach((key) => {
              out[key] = key in data ? copy(data[key]) : defaults[key];
            });
            return out;
          },
          async set(values) {
            Object.assign(data, copy(values));
          },
          async remove(keys) {
            [].concat(keys).forEach((key) => delete data[key]);
          },
        },
        onChanged: { addListener() {} },
      },
      runtime: {
        id: "test-extension",
        lastError: undefined,
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
        onStartup: { addListener: (fn) => listeners.startup.push(fn) },
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        sendMessage(_payload, callback) {
          if (callback) callback();
        },
        getURL: (file) => `chrome-extension://test-extension/${file}`,
      },
      action: { async setBadgeBackgroundColor() {}, async setBadgeText() {} },
    },
  };
  box.globalThis = box;
  ["extract.js", "store.js", "lib/toposConfig.js", "lib/toposAuth.js", "lib/toposIngest.js", "background.js"].forEach((file) => {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), box);
  });
  const send = (message) =>
    new Promise((resolve) => {
      const keepOpen = listeners.message[0](message, {}, resolve);
      if (keepOpen !== true) resolve(undefined);
    });
  // setEnabled queues behind every earlier store write, so it doubles as a barrier.
  const settle = () => send({ type: "shadow.setEnabled", enabled: true });
  return { data, listeners, send, settle };
}

test("background: install and startup run the repair, and the archive is written and kept", async () => {
  const bg = backgroundHarness({
    cs_index: {
      "conv-A": { id: "conv-A", title: "Sample thread", messageCount: 1 },
      "conv-B": { id: "conv-B", title: "Other thread", messageCount: 1 },
    },
    cs_messages: {
      "conv-A": [{ id: "msg-0308", thread_id: "conv-A", role: "user", content: "x", created_at: 100, synced_at: 200 }],
      "conv-B": [{ id: "msg-0308", thread_id: "conv-B", role: "user", content: "x", created_at: 300, synced_at: 400 }],
    },
  });
  assert.equal(bg.listeners.installed.length, 1);
  assert.equal(bg.listeners.startup.length, 1);
  bg.listeners.installed[0]();
  await bg.settle();
  assert.equal(bg.data.cs_messages["conv-B"], undefined);
  assert.equal(bg.data.cs_messages["conv-A"][0].repair, "thread_id");
  assert.equal(bg.data.cs_repair_archive["conv-B"].meta.title, "Other thread");
  assert.deepEqual(bg.data.cs_repair_archive["conv-B"].rows.map((row) => row.id), ["msg-0308"]);
  assert.deepEqual(
    { ...bg.data.cs_repair_receipt, at: 0 },
    { repaired: 1, removed: 1, nodeSide: 0, nodeSideMismatch: 0, at: 0 }
  );
  const status = await bg.send({ type: "topos.status" });
  assert.equal(status.repairQueued, 1);
  assert.deepEqual(json(status.nodeSide), { total: 0, mismatch: 0 });

  // A second run (browser start) changes nothing; ordinary writes keep the archive.
  const archived = JSON.stringify(bg.data.cs_repair_archive);
  bg.listeners.startup[0]();
  await bg.settle();
  await bg.send({ type: "shadow.upsert", conversation: { id: "conv-C" }, messages: [{ id: "msg-0309", role: "user", content: "y", index: 0 }] });
  assert.equal(JSON.stringify(bg.data.cs_repair_archive), archived);

  // Clear deletes every local copy, the archive included.
  await bg.send({ type: "shadow.clear" });
  assert.equal(bg.data.cs_repair_archive, undefined);
  assert.deepEqual(bg.data.cs_messages, {});
});

test("background: browser start alone runs the repair", async () => {
  const bg = backgroundHarness({
    cs_messages: {
      "conv-A": [{ id: "msg-0312", thread_id: "conv-A", role: "user", content: "x", created_at: 100, synced_at: 200 }],
      "conv-B": [{ id: "msg-0312", thread_id: "conv-B", role: "user", content: "x", created_at: 300, synced_at: 400 }],
    },
  });
  bg.listeners.startup[0]();
  await bg.settle();
  assert.equal(bg.data.cs_messages["conv-B"], undefined);
  assert.equal(bg.data.cs_repair_receipt.repaired, 1);
});

test("background: a remap message moves only the ids it names", async () => {
  const bg = backgroundHarness({
    cs_index: { "pending:1": { id: "pending:1", title: "New chat", messageCount: 2 } },
    cs_messages: {
      "pending:1": [
        { id: "msg-0310", thread_id: "pending:1", role: "user", content: "on page", created_at: 1 },
        { id: "msg-0311", thread_id: "pending:1", role: "user", content: "stale", created_at: 2 },
      ],
    },
  });
  await bg.send({ type: "shadow.remap", fromId: "pending:1", toId: "conv-D", ids: ["msg-0310"] });
  assert.deepEqual(bg.data.cs_messages["conv-D"].map((row) => row.id), ["msg-0310"]);
  assert.deepEqual(bg.data.cs_messages["pending:1"].map((row) => row.id), ["msg-0311"]);
  assert.equal(bg.data.cs_index["pending:1"].unassigned, true);
});
