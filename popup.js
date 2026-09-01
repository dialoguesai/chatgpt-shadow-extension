const enabled = document.getElementById("enabled");
const status = document.getElementById("status");
const threads = document.getElementById("threads");
const empty = document.getElementById("empty");
const detail = document.getElementById("detail");
const detailTitle = document.getElementById("detailTitle");
const messages = document.getElementById("messages");
const exportAll = document.getElementById("exportAll");
const exportOne = document.getElementById("exportOne");
const clearAll = document.getElementById("clearAll");

let state = { enabled: true, conversations: [], messages: {}, messageCount: 0 };
let selectedId = "";

enabled.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "shadow.setEnabled", enabled: enabled.checked }, refresh);
});

exportAll.addEventListener("click", () => downloadJsonl());
exportOne.addEventListener("click", () => downloadJsonl(selectedId));
clearAll.addEventListener("click", () => {
  if (!window.confirm("Delete every locally stored ChatGPT message?")) return;
  chrome.runtime.sendMessage({ type: "shadow.clear" }, () => {
    selectedId = "";
    refresh();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.cs_index || changes.cs_messages || changes.cs_enabled) refresh();
});

refresh();

function refresh() {
  chrome.runtime.sendMessage({ type: "shadow.state" }, (next) => {
    if (!next) return;
    state = next;
    render();
  });
}

function counts(rows) {
  return rows.reduce(
    (acc, row) => {
      if (row.role === "user") acc.you += 1;
      if (row.role === "assistant") acc.gpt += 1;
      return acc;
    },
    { you: 0, gpt: 0 }
  );
}

function render() {
  enabled.checked = state.enabled !== false;
  const convos = state.conversations || [];
  status.textContent =
    state.enabled === false
      ? `Paused · ${state.messageCount || 0} messages stored`
      : `${convos.length} chats · ${state.messageCount || 0} messages`;

  threads.innerHTML = "";
  empty.hidden = convos.length > 0;
  convos.forEach((convo) => {
    const rows = state.messages[convo.id] || [];
    const tally = counts(rows);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row" + (convo.id === selectedId ? " active" : "");
    button.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
    button.querySelector(".row-title").textContent = convo.title || "Untitled";
    button.querySelector(".row-meta").textContent = `You ${tally.you} · ChatGPT ${tally.gpt}`;
    button.addEventListener("click", () => {
      selectedId = convo.id;
      render();
    });
    threads.appendChild(button);
  });

  if (!selectedId || !state.messages[selectedId]) {
    detail.hidden = true;
    return;
  }
  const selected = convos.find((row) => row.id === selectedId);
  const rows = (state.messages[selectedId] || []).filter(
    (row) => !ChatGPTShadowExtract.isPlaceholderMessage(row.id, row.content)
  );
  detail.hidden = false;
  detailTitle.textContent = (selected && selected.title) || "Conversation";
  messages.innerHTML = "";
  rows.forEach((row) => {
    const you = row.role === "user";
    const turn = document.createElement("article");
    turn.className = "turn " + (you ? "you" : "gpt");
    const who = document.createElement("span");
    who.className = "who " + (you ? "you" : "gpt");
    who.textContent = you ? "You" : "ChatGPT";
    const bubble = document.createElement("div");
    bubble.className = "bubble md";
    bubble.innerHTML = ChatGPTShadowExtract.renderMarkdown(row.content);
    turn.appendChild(who);
    turn.appendChild(bubble);
    messages.appendChild(turn);
  });
}

function downloadJsonl(threadId) {
  chrome.runtime.sendMessage({ type: "shadow.export", threadId }, (result) => {
    const text = (result && result.jsonl) || "";
    const blob = new Blob([text ? text + "\n" : ""], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = threadId ? `chatgpt-shadow-${threadId}.jsonl` : "chatgpt-shadow.jsonl";
    a.click();
    URL.revokeObjectURL(url);
  });
}
