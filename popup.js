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
const toposState = document.getElementById("toposState");
const toposDetail = document.getElementById("toposDetail");
const toposConnect = document.getElementById("toposConnect");
const toposDisconnect = document.getElementById("toposDisconnect");
const toposSendHistory = document.getElementById("toposSendHistory");
const toposProgress = document.getElementById("toposProgress");
const toposReceipt = document.getElementById("toposReceipt");

let state = { enabled: true, conversations: [], messages: {}, messageCount: 0 };
let topos = null;
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

toposConnect.addEventListener("click", () => {
  // Chrome tears this popup down when the sign-in window takes focus, so the
  // background worker owns the flow and the result is read back from storage.
  toposProgress.hidden = false;
  toposProgress.classList.remove("err");
  toposProgress.textContent = "Opening sign-in… keep this window open if it stays visible.";
  toposConnect.disabled = true;
  chrome.runtime.sendMessage({ type: "topos.connect" }, (result) => {
    void chrome.runtime.lastError;
    toposConnect.disabled = false;
    if (result && result.ok === false && result.error) {
      toposProgress.hidden = false;
      toposProgress.classList.add("err");
      toposProgress.textContent = result.error;
    } else {
      toposProgress.hidden = true;
    }
    refreshTopos();
  });
});

toposDisconnect.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "topos.disconnect" }, (status) => {
    void chrome.runtime.lastError;
    topos = status || null;
    toposProgress.hidden = true;
    toposReceipt.hidden = true;
    renderTopos();
  });
});

toposSendHistory.addEventListener("click", () => {
  const queued = (topos && topos.queued) || 0;
  if (!queued) return;
  if (!window.confirm(`Send ${queued} stored message${queued === 1 ? "" : "s"} to your Topos?`)) return;
  toposSendHistory.disabled = true;
  toposProgress.hidden = false;
  toposProgress.classList.remove("err");
  toposProgress.textContent = `Sending 0 of ${queued}…`;
  chrome.runtime.sendMessage({ type: "topos.submitHistory" }, (receipt) => {
    void chrome.runtime.lastError;
    toposSendHistory.disabled = false;
    if (receipt) showReceipt(receipt);
    refreshTopos();
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") return undefined;
  if (message.type === "topos.progress") {
    toposProgress.hidden = false;
    toposProgress.classList.remove("err");
    toposProgress.textContent = `Sending ${message.done} of ${message.total}… (batch ${message.batch} of ${message.batches})`;
    return undefined;
  }
  if (message.type === "topos.done") {
    showReceipt(message.receipt);
    refreshTopos();
    return undefined;
  }
  if (message.type === "topos.changed") {
    refreshTopos();
  }
  return undefined;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.cs_index || changes.cs_messages || changes.cs_enabled) refresh();
  if (Object.keys(changes).some((key) => key.startsWith("cs_topos"))) refreshTopos();
});

refresh();
refreshTopos();

function refresh() {
  chrome.runtime.sendMessage({ type: "shadow.state" }, (next) => {
    if (!next) return;
    state = next;
    render();
  });
}

function refreshTopos() {
  chrome.runtime.sendMessage({ type: "topos.status" }, (next) => {
    void chrome.runtime.lastError;
    if (!next) return;
    topos = next;
    renderTopos();
  });
}

function showReceipt(receipt) {
  if (!receipt) return;
  toposProgress.hidden = true;
  toposReceipt.hidden = false;
  toposReceipt.classList.toggle("err", Boolean(receipt.error));
  if (!receipt.total) {
    toposReceipt.textContent = "Nothing waiting to send.";
    return;
  }
  const parts = [];
  if (receipt.landed) parts.push(`${receipt.landed} written to your node`);
  if (receipt.queued) parts.push(`${receipt.queued} queued for your node (it is offline)`);
  if (receipt.failed) parts.push(`${receipt.failed} still waiting here`);
  toposReceipt.textContent = `${parts.join(" · ") || "Nothing sent"}.${receipt.error ? ` ${receipt.error}` : ""}`;
}

function renderTopos() {
  if (!topos) return;
  const connected = Boolean(topos.connected);
  toposConnect.hidden = connected;
  toposDisconnect.hidden = !connected;
  toposSendHistory.hidden = !connected;
  toposSendHistory.disabled = !topos.queued || Boolean(topos.syncing);
  toposSendHistory.textContent = topos.queued ? `Send history (${topos.queued})` : "Send history";

  if (topos.expired) {
    toposState.textContent = "Reconnect";
    toposState.dataset.state = "err";
    toposConnect.textContent = "Reconnect";
  } else if (connected && topos.engineWarning) {
    toposState.textContent = "Node offline";
    toposState.dataset.state = "warn";
  } else if (connected) {
    toposState.textContent = "Connected";
    toposState.dataset.state = "on";
  } else {
    toposState.textContent = "Not connected";
    toposState.dataset.state = "";
    toposConnect.textContent = "Connect";
  }

  if (topos.expired) {
    toposDetail.textContent = "Your Topos connection expired. Nothing is being sent. Connect again to resume.";
  } else if (!connected) {
    toposDetail.textContent =
      "Capture stays in this browser. Connect an account to sync new messages to your own Topos.";
  } else {
    const held = topos.held || {};
    const waiting = [];
    if (held.streaming) waiting.push(`${held.streaming} in a reply still being written`);
    if (held.pending) waiting.push(`${held.pending} in a chat with no id yet`);
    const backlog = topos.queued
      ? `${topos.queued} stored message${topos.queued === 1 ? "" : "s"} can still be sent with Send history.`
      : "Nothing is waiting to be sent.";
    toposDetail.textContent =
      `New messages sync automatically. ${backlog}` + (waiting.length ? ` Holding ${waiting.join(" and ")}.` : "");
  }

  if (topos.lastError && !connected) {
    toposProgress.hidden = false;
    toposProgress.classList.add("err");
    toposProgress.textContent = topos.lastError;
  }
  if (topos.receipt && toposReceipt.hidden) showReceipt(topos.receipt);
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
