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
  Capture is local by default: the copy lives in extension storage on this machine.<br />
  Nothing leaves the browser unless you connect a Topos account.
</p>

---

## Why use it

ChatGPT already holds a large share of working memory, but that text leaves the browser only through a slow official export or by pasting. ChatGPT Shadow copies visible turns into local storage while you chat, then lets you inspect, pause, and export them.

| You get | What it means |
|--------|----------------|
| **Live capture** | New user and assistant turns appear in the popup without a reload. |
| **Open a past thread** | Opening an existing chat stores every visible turn, deduped by message id. |
| **Local by default** | Data stays in `chrome.storage.local`. No analytics, and no network call of any kind until you connect an account. |
| **Optional Topos sync** | Connect your own Topos and messages captured from then on are sent as they settle. Anything captured before you connected is sent only when you press **Send history**. |
| **Export JSONL** | One file per conversation, or everything at once. The same file imports into Topos. |
| **Pause and clear** | Uncheck **Capture chats** to stop writing. **Clear** deletes the local copy. |

This is a standalone browser extension. Connecting is optional and off until you do it; the Topos Control Plane is the only network destination it ever contacts.

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
                                                         ↘  Topos (only once connected)
```

1. A content script watches `[data-message-author-role]` on `chatgpt.com` and `chat.openai.com`.
2. Streaming assistant turns update the same message id until the reply settles.
3. The thread id comes from `/c/<id>` in the URL. A pending id is remapped when the URL appears.
4. The background worker is the only writer of `chrome.storage.local`, and the only sender.
5. The popup reflects storage changes live.

---

## Send to Topos

Optional. Nothing below happens until you press **Connect**.

1. Open the popup and press **Connect** under **Topos**. A Control Plane sign-in window opens, you approve the request, and the extension stores an attach token for your own Topos in `chrome.storage.local`.
2. From that moment, each message captured is sent once its reply settles.
3. Everything captured *before* you connected stays local until you press **Send history**. The button shows the count first, sends in batches of at most 200 records, and reports how many were written and how many were queued for a node that is currently offline.
4. **Disconnect** deletes the token and stops all sending. Your local copy is untouched.

Records are sent to `POST /v1/ingestion/app_ingest` with the same five fields as the JSONL export. A record is keyed on its message id, so a resend replaces rather than duplicates.

Three kinds of message are never sent automatically:

| Held | Why |
|------|-----|
| A chat with no conversation id yet | The thread id is a local `pending:` placeholder. Sending it would file records under an id that never becomes real. Released once the URL supplies the real id. |
| A message with no id in the page | The id had to be derived from a content hash, so it changes when the message is edited and would write twice. It goes only through **Send history**. |
| A reply still streaming | Sent once the reply settles, so the stored text is the final text. |

If a send fails because your node is slow or unreachable, the records stay queued in the extension and go out on a later attempt. If the token is rejected, it is deleted, the toolbar badge turns red, and nothing more is sent until you connect again.

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

This field set is frozen: the exported file and the records sent to Topos are built by the same function, so a file import and a sync produce the same rows.

---

## Storage

Data lives in `chrome.storage.local` under `cs_index` and `cs_messages`. That is extension storage, not the ChatGPT page’s `localStorage`. The extension requests `unlimitedStorage` so long threads are not silently dropped at 10MB.

Connection state lives beside it under `cs_topos_*`, including the attach token. **Disconnect** removes every one of those keys.

---

## Privacy

- Capture can be paused. The local store can be cleared in one click.
- Until you connect an account, the extension makes no network calls of its own. It reads the ChatGPT page in the tab you already opened and writes to `chrome.storage.local`.
- Connecting is explicit, per install, and reversible. The attach token is stored in `chrome.storage.local` on this machine; it is not put in `chrome.storage.sync`, so it does not travel to your other browser profiles.
- Once connected, messages captured from then on are sent to your own Topos. Messages captured before you connected are sent only when you press **Send history**. See the held table above for what is never sent automatically.
- **Disconnect** deletes the token and stops all sending. It does not delete the local copy; **Clear** does that.
- No remote code. No analytics. No writes to the ChatGPT origin store. The Control Plane is the only host contacted, and only after you connect.

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
| Red **!** on the toolbar icon | The attach token was rejected and has been deleted. Open the popup and press **Reconnect**. |
| Amber **!** on the toolbar icon | Your node did not answer the last few sends. Records stay queued in the extension; nothing was lost. |
| **Send history** count never reaches zero | Some rows are held on purpose. The popup line under **Topos** says how many, and the held table above says why. |
| Debug logging | `chrome://extensions` → **ChatGPT Shadow** → **Service worker** → Console. |

---

## For developers

| Item | Value |
|------|--------|
| Manifest | V3 |
| Capture | `content.js` |
| Selectors and markdown | `extract.js` |
| Local store, and the rules for what may be sent | `store.js` |
| Background writer and sender | `background.js` |
| Connection constants | `lib/toposConfig.js` |
| PKCE attach flow | `lib/toposAuth.js` |
| `app_ingest` client | `lib/toposIngest.js` |
| Tests | `tests/shadow.test.mjs` |

Every file is a classic script that assigns itself to `globalThis`; the service worker loads them with `importScripts` and the test suite loads the same files into one `vm` sandbox. There is no bundler and no ES module in the extension.

Selectors stay in `extract.js` so a ChatGPT redesign is a one-file patch. The decision about which stored rows may leave the machine lives in one function, `ChatGPTShadowStore.syncScan`. Icons can be regenerated with `python3 scripts/make-icons.py`.

---

## License

Copyright 2026 Dialogues and contributors.

Licensed under the [Apache License, Version 2.0](LICENSE).

---

## Version

**0.1.0** — ChatGPT Shadow (Manifest V3)
