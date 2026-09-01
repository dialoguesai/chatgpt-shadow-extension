<p align="center">
  <img src="icons/icon-48.png" alt="ChatGPT Shadow" width="96" height="96" />
</p>

<h1 align="center">ChatGPT Shadow</h1>

<p align="center">
  <strong>Keep a local copy of ChatGPT web chats as they happen.</strong>
</p>

<p align="center">
  <a href="https://github.com/dialoguesai/chatgpt-shadow-extension">GitHub</a>
  ·
  Chrome · Arc · Edge (Chromium)
  ·
  Manifest V3
</p>

<p align="center">
  User turns and assistant replies are captured from the page, including a past thread when you open it.<br />
  Nothing is sent to a network. The copy lives in extension storage on this machine.
</p>

---

## Why use it

ChatGPT already holds a large share of working memory, but that text leaves the browser only through a slow official export or by pasting. ChatGPT Shadow copies visible turns into local storage while you chat, then lets you inspect, pause, and export them.

| You get | What it means |
|--------|----------------|
| **Live capture** | New user and assistant turns appear in the popup without a reload. |
| **Open a past thread** | Opening an existing chat stores every visible turn, deduped by message id. |
| **Local only** | Data stays in `chrome.storage.local`. No account. No analytics. No phone-home. |
| **Export JSONL** | One file per conversation, or everything at once. |
| **Pause and clear** | Uncheck **Capture chats** to stop writing. **Clear** deletes the local copy. |

This is a standalone browser extension. It does not upload chats or talk to any other Dialogues product.

---

## Install from GitHub

```bash
git clone https://github.com/dialoguesai/chatgpt-shadow-extension.git
cd chatgpt-shadow-extension
```

Load the unpacked folder in Chromium:

### Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the cloned folder (the directory that contains `manifest.json`)

### Arc

1. Open **Extensions** → **Manage extensions**, or go to `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the cloned folder

### Edge

Same steps at `edge://extensions`.

Reload the unpacked extension after updates. Reload ChatGPT so already-open tabs pick up the new content script.

> **Chrome Web Store:** A store listing may use a fixed extension ID; install steps will match the store page when published.

---

## Use

1. Open [chatgpt.com](https://chatgpt.com) and send a message, or open an existing chat.
2. A small **Shadow on** chip appears in the corner of the page.
3. Click the extension icon. Turns are shown as **You** (right) and **ChatGPT** (left), with ChatGPT markdown rendered.
4. **Export JSONL** downloads one record per turn.
5. Uncheck **Capture chats** to pause. **Clear** deletes the local copy.

Revisit a thread to replace any older flattened copies after you update the extension.

---

## How it works

```text
  ChatGPT page  →  Content script  →  Extension storage  →  Popup / JSONL export
```

1. A content script watches `[data-message-author-role]` on `chatgpt.com` and `chat.openai.com`.
2. Streaming assistant turns update the same message id until the reply settles.
3. The thread id comes from `/c/<id>` in the URL. A pending id is remapped when the URL appears.
4. The background worker is the only writer of `chrome.storage.local`.
5. The popup reflects storage changes live.

---

## What it captures

- Hosts: `chatgpt.com`, `chat.openai.com` (including `/c/...` threads and `/share/...` copies)
- Visible user and assistant text
- Live streaming replies (one record per turn, updated until the reply settles)
- Any past conversation you open in the tab

It does not crawl the sidebar history, and it does not store images, files, or voice.

---

## Export format

Each JSONL line is one turn:

```json
{
  "id": "message-id",
  "thread_id": "conversation-id",
  "role": "user",
  "content": "markdown or plain text",
  "created_at": 1700000000
}
```

Assistant `content` is markdown, not flattened text. `created_at` is a Unix timestamp in seconds.

---

## Storage

Data lives in `chrome.storage.local` under `cs_index` and `cs_messages`. That is extension storage, not the ChatGPT page’s `localStorage`. The extension requests `unlimitedStorage` so long threads are not silently dropped at 10MB.

---

## Privacy

- Capture can be paused. The local store can be cleared in one click.
- The extension makes no network calls of its own. It only reads the ChatGPT page in the tab you already opened.
- No remote code. No analytics. No writes to the ChatGPT origin store.

---

## Tests

```bash
node --test tests/shadow.test.mjs
```

---

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| Chip says off / nothing captured | Check **Capture chats** in the popup. Reload the ChatGPT tab after updating the extension. |
| Old thread missing turns | Open the thread so visible messages can be copied. Sidebar history is not crawled. |
| Export is empty | Capture at least one turn, or reopen a thread, then export again. |
| Selectors miss messages after a ChatGPT redesign | Update `extract.js`, then reload the extension and the tab. |
| Debug logging | `chrome://extensions` → **ChatGPT Shadow** → **Service worker** → Console. |

---

## For developers

| Item | Value |
|------|--------|
| Manifest | V3 |
| Capture | `content.js` |
| Selectors and markdown | `extract.js` |
| Local store | `store.js` |
| Background writer | `background.js` |
| Tests | `tests/shadow.test.mjs` |

Selectors stay in `extract.js` so a ChatGPT redesign is a one-file patch. Icons can be regenerated with `python3 scripts/make-icons.py`.

---

## License

Copyright 2026 Dialogues and contributors.

Licensed under the [Apache License, Version 2.0](LICENSE).

---

## Version

**0.1.0** — ChatGPT Shadow (Manifest V3)
