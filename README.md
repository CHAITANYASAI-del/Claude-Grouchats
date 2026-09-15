# Claude Groupchats

**Real-time, multiplayer Claude.** Share any Claude session with a friend from a Chrome extension — they open a link (no install), watch the whole conversation stream live, and send prompts that land inside *your* real Claude. Works on **Claude Code** and regular **Claude chat**. Free, always-on, instant.

```
Owner (Chrome extension, on claude.ai) ──► Cloudflare Worker + Durable Object ──► Friend (web viewer, any browser)
        reads Claude's own data                stateful relay + history                live transcript + send box
```

---

## Table of contents

- [What it does](#what-it-does)
- [Highlights](#highlights)
- [Architecture](#architecture)
  - [Components](#components)
  - [Runtime topology](#runtime-topology)
- [How capture works (the hard part)](#how-capture-works-the-hard-part)
  - [Claude Code — events API](#claude-code--events-api)
  - [Regular Claude chat — conversations API](#regular-claude-chat--conversations-api)
  - [DOM scrape — last-resort fallback](#dom-scrape--last-resort-fallback)
  - [Single-source-of-truth rule](#single-source-of-truth-rule)
- [Injection (friend → your Claude)](#injection-friend--your-claude)
- [Session identity](#session-identity)
- [WebSocket protocol](#websocket-protocol)
- [The viewer](#the-viewer)
- [Repository layout](#repository-layout)
- [Running it](#running-it)
- [Limitations](#limitations)
- [Fonts & licensing](#fonts--licensing)

---

## What it does

1. The **owner** installs the Chrome extension and opens Claude (Code or chat).
2. Clicking **Share** creates a session and gives a link + QR.
3. A **friend** opens the link in any browser — no extension needed — enters a name, and sees the **full conversation history**, then every new message **live**.
4. The friend can **type prompts**; they're injected into the owner's real Claude as `[Name]: …`, Claude responds, and the response **mirrors back** to everyone.

## Highlights

- ⚡ **Near-instant sync** — ~0.5s during an active exchange (adaptive polling)
- 🎯 **Authoritative ordering & roles** — reads Claude's own data, never guesses who said what
- 🚫 **Zero duplicates** — every message keyed by a stable id
- 📄 **Full fidelity** — tables, headings, lists, and code render exactly like Claude
- 📥 **Complete** — every real message captured, tool-plumbing filtered out
- 🔒 **Stable** — one writer per surface; no flickering or reverting mid-chat
- 🎨 **Claude-native look** — Anthropic Sans/Serif + the official Claude symbol
- 💬 **Both surfaces** — Claude Code *and* regular Claude chat
- ♾️ **Free & no-sleep** — Cloudflare Durable Objects, no credit card

---

## Architecture

### Components

| Component | Tech | Role |
|---|---|---|
| **Extension** (`extension/`) | Chrome MV3 — background service worker + content script + popup | Owner side. Reads the conversation from Claude's own APIs, opens the WebSocket, injects friend prompts. |
| **Relay** (`backend/worker.js`) | Cloudflare Worker + **Durable Object** (WebSocket Hibernation) | One `SessionRoom` DO per session token. Holds live sockets + persisted history; fans messages out. |
| **Viewer** (`backend/public/viewer.html`) | Single static HTML/JS page, served by the Worker | Friend side. WebSocket client that renders the transcript (keyed reconcile) and sends prompts. |

**Why Durable Objects:** the only option that is *instant* (native WebSockets), *free forever*, *never sleeps* (Hibernation keeps sockets alive with idle time unbilled), and needs *no credit card*. One DO per session token gives strong consistency and a natural per-room boundary; history persists in DO storage so it survives hibernation.

### Runtime topology

```
   OWNER (claude.ai / Claude Code tab)                 FRIEND (any browser)
 +--------------------------------------+            +--------------------------+
 | content.js                           |            | viewer.html              |
 |  • read transcript from Claude API   |            |  • keyed reconcile render |
 |  • poll adaptively (~0.45–1.8s)      |            |  • send prompts           |
 |  • inject friend prompts             |            +------------+-------------+
 +------------------+-------------------+                          | WSS
                    | chrome.runtime                               |
 +------------------+-------------------+          WSS             |
 | background.js (service worker)       |------------+            |
 |  • WebSocket owner-extension         |            v            v
 +--------------------------------------+   +-------------------------------------+
                                            | Cloudflare Worker (router)          |
                                            |   /ws -> idFromName(token) -> DO     |
                                            |   /api/sessions/* , /join/:token     |
                                            |  +-------------------------------+   |
                                            |  | Durable Object  SessionRoom    |  |
                                            |  |  • Hibernation socket set      |  |
                                            |  |  • history[] in DO storage     |  |
                                            |  |  • fan-out + injection routing |  |
                                            |  +-------------------------------+   |
                                            +-------------------------------------+
```

---

## How capture works (the hard part)

claude.ai exposes no public API and virtualizes its DOM. The breakthrough is that the content script runs **inside claude.ai as the logged-in user**, so it can call Claude's **own internal APIs** with the page's cookies. Each message therefore arrives with a **stable id, an authoritative role, and raw markdown** — no scraping, no guessing.

The extension detects the surface and picks the right reader.

### Claude Code — events API

Claude Code sessions (URL `claude.ai/code/session_…`) are read from:

```
GET /v1/code/sessions/<session_id>/events?limit=500
Header:  anthropic-version: 2023-06-01      ← REQUIRED (400 without it)
```

Response is `{ data: [ …events… ], next_cursor }`. Only two `event_type`s are chat messages — `"user"` and `"assistant"`; everything else (`system`, `env_manager_log`, `control_request/response`, `tool_use`/`tool_result`, `thinking`, …) is internal plumbing and is skipped.

Text extraction is shape-tolerant (a deep harvest of text-bearing blocks), because the two roles nest text differently:

- **User prompt:** `payload.message.content` is a **plain string** (e.g. `"hi"`, or `"[Chey]: hi"` for a friend).
- **Assistant reply:** `payload.message.content` is an **array of blocks**; the visible answer is the `{ type: "text", text }` blocks (thinking / tool blocks are ignored).

Each message keeps its `event_id` (dedup), `created_at` (ordering), and role → **owner / friend / Claude** attribution is exact.

### Regular Claude chat — conversations API

Normal chats (`claude.ai/chat/<uuid>`) use:

```
GET /api/organizations/<org>/chat_conversations/<uuid>?tree=True&rendering_mode=messages
```

`chat_messages[]` carry `sender` (`human`/`assistant`), `uuid`, `created_at`, and text/content — mapped the same way.

### DOM scrape — last-resort fallback

A legacy scroll-and-scrape of the rendered DOM exists only as a fallback for states the APIs don't cover (e.g. logged-out shapes on a plain chat). It produces **flat, structureless text**, so it is used sparingly and **never on Claude Code**.

### Single-source-of-truth rule

On Claude Code the events reader is the **only** writer. The DOM scrape *and* the DOM live-capture are fully disabled there. This is deliberate: when two writers (reader + scrape) both pushed history, the stored transcript **flipped** between the clean markdown version and a flat scraped version every few seconds. One writer = stable, complete, correctly-formatted transcript.

Sync cadence is **adaptive**: ~0.45s while an exchange is active (someone just sent, or Claude is streaming), relaxing to ~1.8s when idle. A content-hash guard means it only pushes when something actually changed.

---

## Injection (friend → your Claude)

When a friend sends a prompt, the Worker forwards it to the owner extension, which types it into the Claude composer as `[Name]: <text>` and submits it (guarded so the extension doesn't re-capture its own injection). It then appears in the transcript attributed to that friend, and Claude's reply flows back to everyone through the normal capture path.

## Session identity

The session token is derived **deterministically from the Claude session/conversation id** (the `session_…` in a Claude Code URL, or the chat UUID), sanitized to `[A-Za-z0-9]`. Same conversation ⇒ same token ⇒ same Durable Object ⇒ **persistent history + remembered participants** across time and re-shares. The token is sanitized identically on the server (`/ws`) and in the viewer, so a copy-pasted link with a stray character still resolves to the right room.

## WebSocket protocol

Roles on connect: `owner-extension` or `viewer` (query params `?token&role`).

| Message | From → To | Effect |
|---|---|---|
| `owner_history` | ext → DO | Replace stored history with the authoritative reader snapshot; broadcast to viewers |
| `owner_sent_message` | ext → DO | Store + broadcast an owner prompt (non-code surfaces) |
| `owner_claude_response` | ext → DO | Store + broadcast a Claude reply (non-code surfaces) |
| `viewer_prompt` | viewer → DO | Store, broadcast to all, and forward as `viewer_prompt_pending` to the extension for injection |
| `history` | DO → viewer | Full ordered transcript on connect / re-sync |

The reader snapshot is the source of truth for ordering; the server does not re-sort by synthetic timestamps.

## The viewer

- **Keyed reconcile renderer** — the transcript is diffed, never wiped: messages are keyed by id so updates land in place (no flicker), duplicates collapse, and the reader's authoritative list replaces transient live copies. Scroll position is preserved unless the viewer is pinned to the live edge.
- **Rendering** — Claude replies render markdown (marked.js) → real tables, headings, lists, code. Owner/friend prompts are plain bubbles.
- **Positioning** — `assistant` → left white card (Claude), `human` → right (owner), `[Name]:` → right, labelled with the friend's name.
- **Typography** — Claude responses in **Anthropic Sans** (Text cut, 400 body / 600 emphasis + headings), prompts in **Helvetica**, headers/wordmark in **Anthropic Serif** (Display cut). Self-hosted WOFF2 via `@font-face` with absolute `/fonts/…` paths (relative paths would resolve under `/join/` and the Worker would return HTML there).

## Repository layout

```
extension/            Chrome MV3 extension (the owner side)
  manifest.json
  background.js        service worker: session + WebSocket + relay
  content.js           surface detection, Claude API readers, injection, sync loop
  popup.html/.css/.js  share UI (QR + link)
  qrcode.js            QR generation
  assets/  icons/      popup art + extension icons

backend/              Cloudflare Worker + viewer
  worker.js            router + SessionRoom Durable Object
  wrangler.toml        deploy config (DO binding, static assets)
  public/
    viewer.html        the friend-facing web app
    fonts/             (Anthropic fonts NOT committed — see fonts/README.md)
```

## Running it

**Backend (Cloudflare):**
```bash
cd backend
npx wrangler deploy      # deploys to <name>.<subdomain>.workers.dev
```

**Extension (Chrome):**
1. Set `SERVER_URL` in `extension/background.js` to your deployed Worker URL.
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `extension/`.
3. Open Claude, click **Share**, send the link.

(For public distribution, upload a zip of `extension/` to the Chrome Web Store.)

## Limitations

- Depends on Claude's **internal, undocumented** APIs — if Anthropic changes them, the readers need updates.
- Relative-timestamp precision is coarse where only "N hours ago" is available.
- DO history is scoped per deployed Worker.
- The events reader currently fetches one 500-event page (ample for typical sessions; very long sessions would need cursor pagination).

## Fonts & licensing

The Claude-accurate typefaces are **Anthropic Sans** and **Anthropic Serif** — **Anthropic's proprietary fonts**. They are **not included** in this repository. The viewer falls back to Helvetica/Georgia without them; to reproduce the exact look, supply the WOFF2 files as described in [`backend/public/fonts/README.md`](backend/public/fonts/README.md). Using Anthropic's fonts and brand marks is the deployer's responsibility.

---

*Claude Groupchats is an independent, third-party tool and is not affiliated with or endorsed by Anthropic.*
