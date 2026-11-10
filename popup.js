const enabled = document.getElementById("enabled");
const status = document.getElementById("status");
const updateNotice = document.getElementById("updateNotice");
const extractNotice = document.getElementById("extractNotice");
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
const toposFixLinks = document.getElementById("toposFixLinks");
const toposProgress = document.getElementById("toposProgress");
const toposReceipt = document.getElementById("toposReceipt");
const localTopos = document.getElementById("localTopos");
const localNote = document.getElementById("localNote");
const localSetup = document.getElementById("localSetup");
const localCommand = document.getElementById("localCommand");
const localCopy = document.getElementById("localCopy");
const localKey = document.getElementById("localKey");
const localUrl = document.getElementById("localUrl");
const localConnect = document.getElementById("localConnect");
const localStatus = document.getElementById("localStatus");
const ToposConfig = ChatGPTShadowToposConfig;

let state = { enabled: true, conversations: [], messages: {}, messageCount: 0 };
let topos = null;
let selectedId = "";
let localOpened = false;
let localUrlShown = false;

// The node answers only the exact origin named when the person enrolled this
// extension, so the command carries this install's own id.
localCommand.textContent = ToposConfig.enrollCommand(chrome.runtime.id);
localKey.placeholder = `${ToposConfig.LOCAL_KEY_PREFIX}${ToposConfig.APP_ID}.…`;
localUrl.placeholder = ToposConfig.DEFAULT_LOCAL_URL;

enabled.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "shadow.setEnabled", enabled: enabled.checked }, refresh);
});

exportAll.addEventListener("click", () => downloadJsonl());
exportOne.addEventListener("click", () => downloadJsonl(selectedId));
let clearArmed = false;
let clearArmTimer = 0;
clearAll.addEventListener("click", () => {
  // Two-click confirm instead of window.confirm(), which would close the popup.
  // First click arms and relabels; a second click within a few seconds clears.
  if (!clearArmed) {
    clearArmed = true;
    const original = clearAll.textContent;
    clearAll.textContent = "Click again to clear";
    clearAll.classList.add("danger");
    window.clearTimeout(clearArmTimer);
    clearArmTimer = window.setTimeout(() => {
      clearArmed = false;
      clearAll.textContent = original;
      clearAll.classList.remove("danger");
    }, 4000);
    return;
  }
  window.clearTimeout(clearArmTimer);
  clearArmed = false;
  clearAll.classList.remove("danger");
  clearAll.textContent = "Clear";
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

localCopy.addEventListener("click", () => {
  const said = (text) => {
    localCopy.textContent = text;
    window.setTimeout(() => {
      localCopy.textContent = "Copy";
    }, 1500);
  };
  // Without clipboard access, leave the command selected so one keystroke copies it.
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(localCommand);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    said("Selected");
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(localCommand.textContent).then(() => said("Copied"), select);
  } else {
    select();
  }
});

function sayLocal(text, isError) {
  localStatus.hidden = !text;
  localStatus.classList.toggle("err", Boolean(isError));
  localStatus.textContent = text || "";
}

localConnect.addEventListener("click", () => {
  const key = localKey.value.trim();
  if (!key) {
    sayLocal("Paste the key the terminal showed.", true);
    return;
  }
  const address = ToposConfig.localNodeUrl(localUrl.value);
  if (!address.ok) {
    sayLocal(address.error, true);
    return;
  }
  // The background worker checks the key with the node and stores it; this
  // popup keeps no copy. The answer is the node's own words when it says no.
  localConnect.disabled = true;
  sayLocal("Checking the key with the Topos on this computer…");
  chrome.runtime.sendMessage({ type: "topos.localConnect", key, url: address.url }, (result) => {
    void chrome.runtime.lastError;
    localConnect.disabled = false;
    if (result && result.ok) {
      localKey.value = "";
      sayLocal("");
      toposProgress.hidden = true;
      toposReceipt.hidden = true;
    } else {
      sayLocal((result && result.error) || "Could not connect. Try again.", true);
    }
    refreshTopos();
  });
});

toposSendHistory.addEventListener("click", () => {
  const queued = (topos && topos.queued) || 0;
  if (!queued) {
    // Nothing to do, but say so — a dead button reads as broken.
    toposReceipt.hidden = false;
    toposReceipt.classList.remove("err");
    toposReceipt.textContent = "Nothing waiting to send. New messages sync on their own once you're connected.";
    return;
  }
  // No window.confirm(): a modal dialog steals focus, which closes the popup and
  // kills this handler before the send is ever queued — which read as "nothing
  // happened". Sending to your own node is not destructive, and the button
  // already names the count, so the click is the confirmation.
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

toposFixLinks.addEventListener("click", () => {
  const repairQueued = (topos && topos.repairQueued) || 0;
  if (!repairQueued) {
    toposReceipt.hidden = false;
    toposReceipt.classList.remove("err");
    toposReceipt.textContent = "No chat links need fixing.";
    return;
  }
  // Same no-confirm pattern as Send history: the count in the label is the
  // confirmation, and a modal would close the popup before the send is queued.
  toposFixLinks.disabled = true;
  toposProgress.hidden = false;
  toposProgress.classList.remove("err");
  toposProgress.textContent = `Sending 0 of ${repairQueued}…`;
  chrome.runtime.sendMessage({ type: "topos.submitRepair" }, (receipt) => {
    void chrome.runtime.lastError;
    toposFixLinks.disabled = false;
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
  if (changes.cs_extract_miss) refreshExtractNotice();
});

refresh();
refreshTopos();
refreshExtractNotice();

function refreshExtractNotice() {
  chrome.storage.local.get({ cs_extract_miss: null }, (stored) => {
    extractNotice.hidden = !stored.cs_extract_miss;
  });
}

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
  if (receipt.unread) parts.push(`${receipt.unread} your node could not read (not sent again)`);
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
  const repairQueued = topos.repairQueued || 0;
  toposFixLinks.hidden = !connected || !repairQueued;
  toposFixLinks.disabled = !repairQueued || Boolean(topos.syncing);
  toposFixLinks.textContent = repairQueued ? `Fix chat links (${repairQueued})` : "Fix chat links";

  const local = topos.target === "local";
  const refusal = local ? topos.localRefusal : null;

  if (topos.expired) {
    toposState.textContent = "Reconnect";
    toposState.dataset.state = "err";
    // A local key is replaced by pasting a new one below, not by signing in.
    toposConnect.textContent = topos.localExpired ? "Connect" : "Reconnect";
  } else if (connected && refusal) {
    toposState.textContent = "Refused";
    toposState.dataset.state = "warn";
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

  if (topos.expired && topos.localExpired) {
    toposDetail.textContent =
      "The Topos on this computer no longer accepts this extension's key. Nothing is being sent. " +
      "Run the command under Local Topos again and paste the new key.";
  } else if (topos.expired) {
    toposDetail.textContent = "Your Topos connection expired. Nothing is being sent. Connect again to resume.";
  } else if (!connected) {
    toposDetail.textContent =
      "Capture stays in this browser. Connect an account, or a Topos on this computer, to sync new messages to your own Topos.";
  } else if (refusal) {
    const words = String(refusal.message || "").trim();
    toposDetail.textContent =
      `The Topos on this computer said no to the last send (HTTP ${refusal.status})` +
      (words ? `: ${words}${/[.!?]$/.test(words) ? "" : "."}` : ".") +
      " Nothing more is sent on its own. Press Send history to try again, or run the command under Local Topos again and paste the new key.";
  } else {
    const held = topos.held || {};
    const waiting = [];
    if (held.streaming) waiting.push(`${held.streaming} in a reply still being written`);
    if (held.pending) waiting.push(`${held.pending} in a chat with no id yet`);
    if (held.unassigned) {
      waiting.push(`${held.unassigned} that belong${held.unassigned === 1 ? "s" : ""} to no chat and stay here`);
    }
    const backlog = topos.queued
      ? `${topos.queued} stored message${topos.queued === 1 ? "" : "s"} can still be sent with Send history.`
      : "Nothing is waiting to be sent.";
    const repairQueued = topos.repairQueued || 0;
    const repairLine = repairQueued
      ? ` ${repairQueued} message${repairQueued === 1 ? " was" : "s were"} filed under the wrong chat and will be corrected when you press Fix chat links.`
      : "";
    const nodeSide = (topos.nodeSide && topos.nodeSide.total) || 0;
    const nodeSideLine = nodeSide
      ? ` ${nodeSide} message${nodeSide === 1 ? " is" : "s are"} filed on your node under a chat this extension cannot correct; nothing is resent for ${nodeSide === 1 ? "it" : "them"}.`
      : "";
    toposDetail.textContent =
      (local ? "Sending to the Topos on this computer. " : "") +
      `New messages sync automatically. ${backlog}` +
      (waiting.length ? ` Holding ${waiting.join(" and ")}.` : "") +
      repairLine +
      nodeSideLine;
  }

  if (topos.lastError && !connected) {
    toposProgress.hidden = false;
    toposProgress.classList.add("err");
    toposProgress.textContent = topos.lastError;
  }
  if (topos.receipt && toposReceipt.hidden) showReceipt(topos.receipt);
  renderLocal();
}

function renderLocal() {
  const local = topos.target === "local";
  localSetup.hidden = local;
  localNote.hidden = !local;
  if (local) {
    localNote.textContent =
      `Connected to the Topos on this computer at ${topos.localUrl}. Chats are sent there and nowhere else.` +
      (topos.accountConnected ? " Your account is still connected, but it is not used while this key is saved." : "") +
      ` To switch this off on the Topos side as well, run: topos-node pushers disconnect ${ToposConfig.APP_ID}`;
  }
  // Show a changed address once; after that the field belongs to the person.
  if (!localUrlShown && topos.localUrl && topos.localUrl !== ToposConfig.DEFAULT_LOCAL_URL) {
    localUrl.value = topos.localUrl;
  }
  localUrlShown = true;
  // Open the section when it is the one in use or the one that needs attention.
  if (!localOpened && (local || topos.localExpired)) {
    localTopos.open = true;
    localOpened = true;
  }
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
    // Rows a remap left behind: kept locally, in no chat, never sent.
    button.querySelector(".row-title").textContent = convo.unassigned
      ? `${convo.title || "Untitled"} (not in a chat)`
      : convo.title || "Untitled";
    button.querySelector(".row-meta").textContent = `You ${tally.you} · ChatGPT ${tally.gpt}`;
    button.addEventListener("click", () => {
      selectedId = convo.id;
      render();
    });
    threads.appendChild(button);
  });

  if (!selectedId) {
    detail.hidden = true;
    return;
  }
  // A selected chat with no rows loaded still opens the pane and says so, rather
  // than leaving the click looking dead.
  const selectedRows = state.messages[selectedId];
  if (!selectedRows || selectedRows.length === 0) {
    detail.hidden = false;
    const picked = convos.find((row) => row.id === selectedId);
    detailTitle.textContent = (picked && picked.title) || "Conversation";
    messages.innerHTML = "";
    const note = document.createElement("p");
    note.className = "fine";
    note.textContent = "No messages stored for this chat yet. Open it in ChatGPT so it can be captured.";
    messages.appendChild(note);
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

function runUpdateCheck() {
  if (!updateNotice || typeof ChatGPTShadowUpdateCheck === "undefined") return;
  let current = "";
  try {
    current = chrome.runtime.getManifest().version;
  } catch {
    return;
  }
  ChatGPTShadowUpdateCheck.check(current).then((result) => {
    if (!result || !result.updateAvailable) return; // silent when current or on error
    updateNotice.hidden = false;
    updateNotice.textContent = `Update available: ${result.current} \u2192 ${result.latest}. `;
    const link = document.createElement("a");
    link.href = result.repoUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Get it";
    updateNotice.appendChild(link);
  });
}

runUpdateCheck();
