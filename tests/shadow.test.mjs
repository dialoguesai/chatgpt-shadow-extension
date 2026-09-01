import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(root, "extract.js"), "utf8"), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(root, "store.js"), "utf8"), sandbox);

const Extract = sandbox.ChatGPTShadowExtract;
const Store = sandbox.ChatGPTShadowStore;

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
