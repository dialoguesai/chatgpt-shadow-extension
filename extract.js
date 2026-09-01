const ChatGPTShadowExtract = (() => {
  const ROLE_SELECTOR = "[data-message-author-role]";
  const STOP_BUTTON = '[data-testid="stop-button"]';
  const THREAD_RE = /\/(?:c|share)\/([a-z0-9-]+)/i;
  const SKIP_TAGS = new Set(["button", "svg", "script", "style", "noscript", "nav", "input", "textarea"]);

  function conversationIdFromUrl(href) {
    const match = String(href || "").match(THREAD_RE);
    return match ? match[1] : "";
  }

  function conversationTitleFromPageTitle(title) {
    const raw = String(title || "").trim();
    if (!raw) return "Untitled";
    return raw.replace(/\s+[-–|]\s+ChatGPT\s*$/i, "").trim() || "Untitled";
  }

  function extractTitle(root) {
    const doc = root.ownerDocument || root;
    const current =
      doc.querySelector('nav a[aria-current="page"]') ||
      doc.querySelector('nav a[data-active="true"]') ||
      doc.querySelector('a[href*="/c/"][aria-current="page"]');
    const labeled = current && (current.getAttribute("title") || textOf(current));
    if (labeled && labeled.trim()) return labeled.trim();
    return conversationTitleFromPageTitle(doc.title);
  }

  function textOf(node) {
    if (!node) return "";
    const value = node.innerText != null ? node.innerText : node.textContent;
    return String(value || "").replace(/\u00a0/g, " ").trim();
  }

  function childList(node) {
    if (!node) return [];
    if (node.childNodes && node.childNodes.length != null) return Array.from(node.childNodes);
    return Array.isArray(node.children) ? node.children : [];
  }

  function tagName(node) {
    return String((node && node.tagName) || "").toLowerCase();
  }

  function attr(node, name) {
    if (!node) return "";
    if (typeof node.getAttribute === "function") return node.getAttribute(name) || "";
    return (node.attrs && node.attrs[name]) || "";
  }

  function classNameOf(node) {
    return `${attr(node, "class")} ${node && node.className ? node.className : ""}`.toLowerCase();
  }

  function shouldSkip(node) {
    const tag = tagName(node);
    if (SKIP_TAGS.has(tag)) return true;
    const testid = attr(node, "data-testid").toLowerCase();
    if (/(copy|action|edit|good-response|bad-response|feedback)/.test(testid)) return true;
    const cls = classNameOf(node);
    if (/\b(sr-only|visually-hidden)\b/.test(cls)) return true;
    return false;
  }

  function isPlaceholderMessage(id, content) {
    const key = String(id || "");
    if (key.startsWith("request-placeholder") || key.includes("placeholder-request")) return true;
    return /^(thinking|thought|searching|working)\.?$/i.test(String(content || "").trim());
  }

  function cleanChrome(text) {
    return String(text || "")
      .replace(/^\s*(You said|ChatGPT said|Assistant said)\s*/i, "")
      .replace(/\n?(Copy|Edit|Good response|Bad response)\s*$/gim, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function htmlToMarkdown(root) {
    if (!root) return "";
    const out = convertBlocks(root).replace(/\n{3,}/g, "\n\n").trim();
    return out;
  }

  function convertBlocks(node) {
    return childList(node).map((child) => convertNode(child)).join("").replace(/[ \t]+\n/g, "\n");
  }

  function convertNode(node) {
    if (!node) return "";
    if (node.nodeType === 3) return collapseInline(node.textContent || "");
    if (node.nodeType && node.nodeType !== 1) return "";
    if (shouldSkip(node)) return "";

    const tag = tagName(node);
    if (!tag) return convertBlocks(node);

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      return `\n\n${"#".repeat(level)} ${inline(node).trim()}\n\n`;
    }
    if (tag === "p") return `\n\n${inline(node).trim()}\n\n`;
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";
    if (tag === "blockquote") {
      const body = inline(node).trim();
      return `\n\n${body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    }
    if (tag === "pre") return `\n\n${fencedCode(node)}\n\n`;
    if (tag === "ul") return `\n\n${listItems(node, false)}\n\n`;
    if (tag === "ol") return `\n\n${listItems(node, true)}\n\n`;
    if (tag === "table") return `\n\n${tableToMarkdown(node)}\n\n`;
    if (tag === "li" || tag === "thead" || tag === "tbody" || tag === "tr" || tag === "td" || tag === "th") {
      return convertBlocks(node);
    }
    return convertBlocks(node);
  }

  function inline(node) {
    return childList(node)
      .map((child) => convertInline(child))
      .join("")
      .replace(/\s+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ");
  }

  function convertInline(node) {
    if (!node) return "";
    if (node.nodeType === 3) return collapseInline(node.textContent || "");
    if (node.nodeType && node.nodeType !== 1) return "";
    if (shouldSkip(node)) return "";

    const tag = tagName(node);
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return `**${inline(node).trim()}**`;
    if (tag === "em" || tag === "i") return `*${inline(node).trim()}*`;
    if (tag === "code") return `\`${plainText(node).replace(/`/g, "\\`")}\``;
    if (tag === "a") {
      const href = attr(node, "href");
      const label = inline(node).trim() || href;
      return href ? `[${label}](${href})` : label;
    }
    if (tag === "pre") return fencedCode(node);
    return inline(node);
  }

  function collapseInline(text) {
    return String(text || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
  }

  function plainText(node) {
    return String((node && (node.textContent || node.innerText)) || "").replace(/\u00a0/g, " ");
  }

  function fencedCode(node) {
    const code = node.querySelector ? node.querySelector("code") : null;
    const target = code || node;
    const cls = classNameOf(target);
    const langMatch = cls.match(/language-([a-z0-9_+-]+)/i);
    const lang = langMatch ? langMatch[1] : "";
    const body = plainText(target).replace(/\n$/, "");
    return `\`\`\`${lang}\n${body}\n\`\`\``;
  }

  function listItems(node, ordered) {
    const items = childList(node).filter((child) => tagName(child) === "li");
    return items
      .map((item, index) => {
        const marker = ordered ? `${index + 1}. ` : "- ";
        const body = inline(item).trim().replace(/\n/g, "\n  ");
        return `${marker}${body}`;
      })
      .join("\n");
  }

  function tableToMarkdown(node) {
    const rows = [];
    const walk = (current) => {
      if (tagName(current) === "tr") {
        const cells = childList(current)
          .filter((child) => tagName(child) === "th" || tagName(child) === "td")
          .map((cell) => inline(cell).trim().replace(/\|/g, "\\|"));
        if (cells.length) rows.push(cells);
        return;
      }
      childList(current).forEach(walk);
    };
    walk(node);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) => {
      const next = row.slice();
      while (next.length < width) next.push("");
      return next;
    });
    const header = padded[0];
    const divider = header.map(() => "---");
    const body = padded.slice(1);
    return [header, divider, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
  }

  function extractMessageText(el) {
    if (!el) return "";
    const markdown = el.querySelector && el.querySelector(".markdown");
    if (markdown) {
      const converted = htmlToMarkdown(markdown);
      return cleanChrome(converted || textOf(markdown));
    }
    const body =
      (el.querySelector && (el.querySelector(".whitespace-pre-wrap") || el.querySelector("[data-message-content]"))) ||
      el;
    return cleanChrome(textOf(body));
  }

  function isStreaming(root) {
    const doc = root.ownerDocument || root;
    return Boolean(doc.querySelector(STOP_BUTTON));
  }

  function extractMessages(root) {
    const nodes = root.querySelectorAll(ROLE_SELECTOR);
    const messages = [];
    nodes.forEach((el, index) => {
      const role = String(el.getAttribute("data-message-author-role") || "").toLowerCase();
      if (role !== "user" && role !== "assistant") return;
      const content = extractMessageText(el);
      const id = el.getAttribute("data-message-id") || "";
      if (!content || isPlaceholderMessage(id, content)) return;
      messages.push({
        id,
        role,
        content,
        index,
      });
    });
    return messages;
  }

  function stableMessageId(threadId, message) {
    if (message.id) return message.id;
    return `shadow:${threadId}:${message.role}:${message.index}:${hashText(message.content)}`;
  }

  function hashText(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function toV1Record(threadId, message, createdAt) {
    return {
      id: stableMessageId(threadId, message),
      thread_id: threadId,
      role: message.role,
      content: message.content,
      created_at: Number.isFinite(createdAt) ? createdAt : Math.floor(Date.now() / 1000),
    };
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inlineMarkdown(text) {
    const codes = [];
    let html = String(text || "").replace(/`([^`]+)`/g, (_, body) => {
      const token = `%%CODE${codes.length}%%`;
      codes.push(`<code>${escapeHtml(body)}</code>`);
      return token;
    });
    html = escapeHtml(html);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*(?!\s)([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    codes.forEach((snippet, index) => {
      html = html.replace(`%%CODE${index}%%`, snippet);
    });
    return html;
  }

  function splitTableCells(line) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function isTableDivider(line) {
    const cells = splitTableCells(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isTableRow(line) {
    return /^\s*\|.+\|\s*$/.test(line) || (/^\s*[^|].*\|/.test(line) && line.includes("|"));
  }

  function renderTable(lines, start) {
    if (!isTableRow(lines[start]) || !lines[start + 1] || !isTableDivider(lines[start + 1])) {
      return null;
    }
    const rows = [splitTableCells(lines[start])];
    let index = start + 2;
    while (index < lines.length && isTableRow(lines[index]) && !isTableDivider(lines[index])) {
      rows.push(splitTableCells(lines[index]));
      index += 1;
    }
    const head = rows[0]
      .map((cell) => `<th>${inlineMarkdown(cell)}</th>`)
      .join("");
    const body = rows
      .slice(1)
      .map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`)
      .join("");
    return {
      html: `<table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table>`,
      next: index,
    };
  }

  function isListLine(line, ordered) {
    return ordered ? /^\s*\d+\.\s+/.test(line) : /^\s*[-*]\s+/.test(line);
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^\s*```([a-z0-9_+-]*)\s*$/i);
      if (fence) {
        const body = [];
        index += 1;
        while (index < lines.length && !/^\s*```/.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
        blocks.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
        continue;
      }

      const table = renderTable(lines, index);
      if (table) {
        blocks.push(table.html);
        index = table.next;
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s*---+\s*$/.test(line)) {
        blocks.push("<hr>");
        index += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quoted = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quoted.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        blocks.push(`<blockquote>${quoted.map((row) => `<p>${inlineMarkdown(row)}</p>`).join("")}</blockquote>`);
        continue;
      }

      if (isListLine(line, false) || isListLine(line, true)) {
        const ordered = isListLine(line, true);
        const items = [];
        while (index < lines.length && isListLine(lines[index], ordered)) {
          items.push(`<li>${inlineMarkdown(lines[index].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ""))}</li>`);
          index += 1;
        }
        blocks.push(`${ordered ? "<ol>" : "<ul>"}${items.join("")}${ordered ? "</ol>" : "</ul>"}`);
        continue;
      }

      const para = [line];
      index += 1;
      while (
        index < lines.length &&
        lines[index].trim() &&
        !lines[index].match(/^\s*```/) &&
        !lines[index].match(/^\s*#{1,6}\s+/) &&
        !isListLine(lines[index], false) &&
        !isListLine(lines[index], true) &&
        !/^\s*>\s?/.test(lines[index]) &&
        !(isTableRow(lines[index]) && lines[index + 1] && isTableDivider(lines[index + 1]))
      ) {
        para.push(lines[index]);
        index += 1;
      }
      blocks.push(`<p>${para.map((row) => inlineMarkdown(row)).join("<br>")}</p>`);
    }

    return blocks.join("");
  }

  return {
    ROLE_SELECTOR,
    conversationIdFromUrl,
    conversationTitleFromPageTitle,
    extractTitle,
    extractMessageText,
    extractMessages,
    isStreaming,
    isPlaceholderMessage,
    htmlToMarkdown,
    renderMarkdown,
    stableMessageId,
    toV1Record,
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ChatGPTShadowExtract = ChatGPTShadowExtract;
}
