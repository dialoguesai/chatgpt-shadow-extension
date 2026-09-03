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
["extract.js", "store.js", "lib/toposConfig.js", "lib/toposAuth.js", "lib/toposIngest.js"].forEach((file) => {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox);
});

const Extract = sandbox.ChatGPTShadowExtract;
const Store = sandbox.ChatGPTShadowStore;
const ToposConfig = sandbox.ChatGPTShadowToposConfig;
const ToposAuth = sandbox.ChatGPTShadowToposAuth;
const ToposIngest = sandbox.ChatGPTShadowToposIngest;

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
  assert.deepEqual(list(Object.keys(wire)), ["id", "thread_id", "role", "content", "created_at"]);
  assert.deepEqual(plain(wire), exported);
  // Sync bookkeeping never reaches the wire or the export file.
  assert.equal("synced_at" in wire, false);
  assert.equal("id_source" in wire, false);
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
