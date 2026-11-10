<p align="center">
  <img src="icons/icon-128.png" alt="ChatGPT Shadow" width="96" height="96" />
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
  No chat leaves the browser unless you connect a Topos: through an account, or a node on this computer with no account.
</p>

---

## Why use it

ChatGPT already holds a large share of working memory, but that text leaves the browser only through a slow official export or by pasting. ChatGPT Shadow copies visible turns into local storage while you chat, then lets you inspect, pause, and export them.

| You get | What it means |
|--------|----------------|
| **Live capture** | New user and assistant turns appear in the popup without a reload. |
| **Open a past thread** | Opening an existing chat stores every visible turn, deduped by message id. |
| **Local by default** | Data stays in `chrome.storage.local`. No analytics, and no chat is sent anywhere until you connect a Topos. |
| **Optional Topos sync** | Connect your own Topos and messages captured from then on are sent as they settle. Anything captured before you connected is sent only when you press **Send history**. |
| **No account needed** | A Topos running on this computer can take your chats directly. See [Local first](#local-first-a-topos-with-no-account). |
| **Export JSONL** | One file per conversation, or everything at once. The same file imports into Topos. |
| **Pause and clear** | Uncheck **Capture chats** to stop writing. **Clear** deletes the local copy. |

This is a standalone browser extension. Connecting is optional and off until you do it. Chats are only ever sent to the Topos you connected: the Topos Control Plane when you connect an account, or an address on this computer (`http://127.0.0.1:8676` unless you change it) when you connect a local Topos. The one other request the extension makes is a version check: opening the popup reads this repository's `manifest.json` from GitHub, and that request carries nothing from your chats.

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

Records are sent to `POST /v1/ingestion/app_ingest` in the same shape as the JSONL export. A record is keyed on its message id, so a resend replaces rather than duplicates.

Five kinds of message are never sent automatically:

| Held | Why |
|------|-----|
| A chat with no conversation id yet | The thread id is a local `pending:` placeholder. Sending it would file records under an id that never becomes real. Released once the URL supplies the real id. |
| A message with no id in the page | The id had to be derived from a content hash, so it changes when the message is edited and would write twice. It goes only through **Send history**. |
| A reply still streaming | Sent once the reply settles, so the stored text is the final text. |
| A correction for a message filed under the wrong chat | Sent only by **Fix chat links** (or **Send history**). It rewrites a row your node already holds, so it never goes on its own. An edit to such a message waits with it: the correction carries the text your node already holds, and the edited text goes out on the next send after it. |
| A message a chat with no id yet left behind | When a new chat gets its real id, only the messages on the page move into it. Others captured under the same placeholder (from a page seen earlier) stay in the extension, are listed as *not in a chat*, and are never sent. One of them moves into a real chat if it is seen there later. |

Two rules decide what counts as a new or changed message:

- **One message id belongs to one chat, the first one it was captured in.** The same message seen under another URL (a `/share/` copy, a branched chat, or the page still showing the previous chat while the URL has moved on) is ignored, so it is never sent under a second chat. A chat with no id yet only takes the messages on the page when its real id appears, and a message held for one new chat moves into a real chat only when the page still carries that new chat's id. Because the first chat wins, the page is read against the URL only once the URL has held still for 1.5 seconds, and a message whose markup names a different saved chat than the URL is skipped (not on `/share/` pages).
- **Whitespace-only recaptures are not edits.** Text is compared with runs of whitespace collapsed, and stored exactly as captured. A recapture that differs only in spacing or line breaks keeps the stored text and is not resent; any other change is. This holds for messages without an id in the page too: their derived id is a hash of the collapsed text. Versions before 0.2.3 hashed the raw text; a stored row with such an id keeps it when the same text is captured again.

Versions before 0.2.3 could file a message under a second chat. On install and on browser start the extension takes those copies out of the store and keeps them on this machine in a separate archive (`cs_repair_archive`: never sent, not in the popup or the export, deleted by **Clear**). What happens next depends on what your node holds. The node files a message under the chat of its first send and never moves it; the chat id inside the record follows the latest send.

- The right chat was sent first and a wrong one last: the extension queues one correction for that message. The popup shows **Fix chat links (N)**; pressing it resends those messages with the right chat id and the text your node already holds. If the extension holds newer text for one of them, that text goes out on the next send after the correction.
- A wrong chat may have been sent first (or the right chat was never sent): resending under the right chat would leave the record disagreeing with where the node files it, so nothing is queued. The extension records which chat the node files it under and stops sending that message under any other chat. The popup counts these messages; correcting them needs a change on the node.

If a send fails because your node is slow or unreachable, the records stay queued in the extension and go out on a later attempt. If the token is rejected, it is deleted, the toolbar badge turns red, and nothing more is sent until you connect again.

---

## Local first: a Topos with no account

Optional, and separate from the account path above, which is unchanged. A Topos node running on this computer (topos-node 1.5.46 or later) can take your chats directly: no Dialogues account, and no Control Plane in between.

```text
  ChatGPT page  →  Extension  →  http://127.0.0.1:8676  (your Topos node, on this computer)
```

1. **Load the extension** (see [Install from GitHub](#install-from-github)), open the popup, and open **Local Topos (no account)** under **Topos**.
2. **Run the command it shows in your own terminal**, and say yes when Topos asks. The command is filled in for this install; **Copy** copies it. It looks like

   ```bash
   topos-node pushers add chatgpt-shadow-extension --sources chatgpt_ui_conversation --origin chrome-extension://<this extension's id>
   ```

   Topos then shows a key, once.
3. **Paste the key** into **Key** and press **Connect local Topos**. The extension asks the node what the key may write, and saves it only if the node accepts it for ChatGPT chats. If the node says no, the popup shows the node's own words and nothing is saved.

From then on it behaves like an account connection. Messages captured after you connected are sent as they settle; earlier ones go only when you press **Send history**; the held table and the two rules above apply the same way. Each batch carries an id that stays the same when it is resent, so a retry writes nothing twice.

What leaves the browser in this mode: your chats go to one address, your node's, on this computer. That address is `http://127.0.0.1:8676` unless you change it under **Address**, and only `http://127.0.0.1:<port>` or `http://localhost:<port>` is accepted. No chat leaves the computer, and no Dialogues server is contacted. The key is kept in `chrome.storage.local` on this machine and is sent only to that address.

- **A local key wins.** If an account is connected as well, chats go only to the node on this computer while the key is saved.
- **Disconnect** forgets the key (and any account connection) and stops all sending. Your captured chats stay in the extension. To switch the extension off on the Topos side as well, run `topos-node pushers disconnect chatgpt-shadow-extension`.
- **If the node stops accepting the key** (you disconnected the extension there, or a different node now answers), the key is deleted, the toolbar badge turns red, and nothing is sent until you run the command again and paste the new key. An account you connected earlier is not used in its place.
- **If the node says no to a batch**, the popup shows what it said and nothing more is sent on its own. Press **Send history** to try again, or run the command again and paste the new key.
- **If the node is not running**, the records stay queued in the extension and go out on a later attempt.

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
  "created_at": 1700000000,
  "_metadata": { "conversation_title": "the chat's title" }
}
```

Assistant `content` is markdown, not flattened text. `created_at` is a Unix timestamp in seconds.

`_metadata.conversation_title` is the chat's title as ChatGPT shows it in the sidebar. It is left out until ChatGPT has named the chat ("New chat" and similar placeholders are never sent), so the first turns of a new chat may carry none. Topos keeps the latest title it receives for each chat.

The five turn fields are frozen: the exported file and the records sent to Topos are built by the same function, so a file import and a sync produce the same rows.

---

## Storage

Data lives in `chrome.storage.local` under `cs_index` and `cs_messages`. That is extension storage, not the ChatGPT page’s `localStorage`. The extension requests `unlimitedStorage` so long threads are not silently dropped at 10MB.

Connection state lives beside it under `cs_topos_*`, including the attach token or the local key. **Disconnect** removes every one of those keys.

---

## Privacy

- Capture can be paused. The local store can be cleared in one click.
- Until you connect a Topos, no chat is sent anywhere. The extension reads the ChatGPT page in the tab you already opened and writes to `chrome.storage.local`.
- Opening the popup checks for a newer version by reading this repository's `manifest.json` from GitHub. That request carries nothing from your chats.
- Connecting is explicit, per install, and reversible. The attach token, or the local key, is stored in `chrome.storage.local` on this machine; it is not put in `chrome.storage.sync`, so it does not travel to your other browser profiles.
- With a local Topos, chats are sent to an address on this computer and nowhere else. See [Local first](#local-first-a-topos-with-no-account).
- Once connected, messages captured from then on are sent to your own Topos. Messages captured before you connected are sent only when you press **Send history**. See the held table above for what is never sent automatically.
- **Disconnect** deletes the token and the local key and stops all sending. It does not delete the local copy; **Clear** does that.
- No remote code. No analytics. No writes to the ChatGPT origin store. Chats go to one place, and only after you connect it: the Control Plane for an account, or an address on this computer for a local Topos.

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
| Red **!** on the toolbar icon | The attach token was rejected and has been deleted. Open the popup and press **Reconnect**. With a local Topos: the node no longer accepts the key; run the command under **Local Topos** again and paste the new key. |
| Amber **!** on the toolbar icon | Your node did not answer the last few sends. Records stay queued in the extension; nothing was lost. With a local Topos it can also mean the node said no to a batch; the popup shows what it said. |
| **No Topos answered** when connecting a local Topos | Check that Topos is running on this computer, and that **Address** matches where it listens. |
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
| Local Topos key: check, store, forget | `lib/toposLocal.js` |
| Where a send goes, and the two senders (`app_ingest`, the local node) | `lib/toposIngest.js` |
| Tests | `tests/shadow.test.mjs` |

Every file is a classic script that assigns itself to `globalThis`; the service worker loads them with `importScripts` and the test suite loads the same files into one `vm` sandbox. There is no bundler and no ES module in the extension.

Selectors stay in `extract.js` so a ChatGPT redesign is a one-file patch. The decision about which stored rows may leave the machine lives in one function, `ChatGPTShadowStore.syncScan`. Full app artwork, with the white outer margin removed and the dark rounded tile retained, is preserved in `icons/icon-source.png`; transparent browser-toolbar artwork is in `icons/toolbar-source.png`. The manifest uses `icon-*` for extension listings and `toolbar-*` for the installed toolbar button. Install Pillow (`python3 -m pip install Pillow`), then run `python3 scripts/make-icons.py` to regenerate both sets at 16, 32, 48, and 128 px.

---

## License

Copyright 2026 Dialogues and contributors.

Licensed under the [Apache License, Version 2.0](LICENSE).

---

## Version

**0.2.3** — ChatGPT Shadow (Manifest V3). One chat per message id, whitespace-only recaptures are not edits, and **Fix chat links** for messages earlier versions filed under the wrong chat.
