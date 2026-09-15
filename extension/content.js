/**
 * content.js — injected into claude.ai / claude.ai/code
 *
 * FIXED:
 * 1. Scrape existing history on connect → send to server → friend sees full chat
 * 2. isInjecting flag → prevent re-capturing injected friend messages as owner msgs
 * 3. Broader response selectors for claude.ai/code DOM
 */

let responseObserver = null;
let responseDebounce = null;   // global — cleared on every new startResponseCapture call
let responseIdleTimeout = null; // disconnect safety net — reset on every mutation, not fixed-from-start

// Wraps chrome.runtime.sendMessage so that reloading the extension while this
// tab is still open (which orphans the content script — chrome.runtime calls
// then throw "Extension context invalidated") fails loudly ONCE with a clear
// instruction, instead of silently breaking every subsequent send with no
// visible sign of why nothing is working anymore.
let contextInvalidatedWarned = false;
function safeSendMessage(msg, callback) {
  try {
    if (!chrome.runtime?.id) throw new Error('Extension context invalidated');
    chrome.runtime.sendMessage(msg, callback);
  } catch (e) {
    if (!contextInvalidatedWarned) {
      contextInvalidatedWarned = true;
      console.warn('%c[SS] Extension was reloaded — this tab is disconnected from it. Reload THIS claude.ai tab to reconnect sharing.', 'font-weight:bold;font-size:13px;color:#F87171;');
    }
  }
}
let isConnected = false;
let isInjecting = false;
let lastOwnerMsg = '';
let captureBuffer = '';
// Streaming-cursor state per node source: `count` = index of the "frontier"
// node that may still be evolving (multi-stage tool use, e.g. a "Figuring…"
// status that later gets replaced by the real answer); everything before it
// is already finalized. `lastText` = what we last sent for that frontier
// node, so we resend only when its text actually changes. Two independent
// trackers because .font-claude-response and [data-testid="ai-turn-content"]
// are different node sets (the latter is a fallback for content that doesn't
// render as the former, e.g. claude.ai's canned opening greeting).
const mdStream = { count: 0, lastText: '' };
const aiTurnStream = { count: 0, lastText: '' };

// Re-sync bookkeeping so a brand-new conversation (owner shares, then types)
// and any missed live event still converge on the friend's screen.
let resyncUrl = location.href;
let resyncTimers = [];

// Collapse claude.ai's double-render at the SOURCE so we never transmit
// "Hi!Hi!" or a "preview…full" glued reply — belt-and-suspenders with the
// same cleanup on the server. Handles: whole-string "AA"; an opening chunk
// repeated back-to-back ("Hi!Hi! rest" → "Hi! rest"); and a truncated preview
// (usually ending "…") glued before the full copy.
function collapseDoubled(raw) {
  let s = String(raw || '').trim();
  if (s.length < 2) return s;
  if (s.length % 2 === 0) {
    const h = s.length / 2;
    if (s.slice(0, h) === s.slice(h)) return s.slice(0, h).trim();
  }
  for (let k = Math.floor(s.length / 2); k >= 1; k--) {
    if (s.slice(0, k) === s.slice(k, 2 * k)) return (s.slice(0, k) + s.slice(2 * k)).trim();
  }
  const head = s.slice(0, 40);
  if (head.length === 40) {
    const idx = s.indexOf(head, 1);
    if (idx > 0) {
      const first = s.slice(0, idx), second = s.slice(idx).trim();
      if (/(\.\.\.|…)\s*$/.test(first) || second.length >= first.length) return second;
    }
  }
  return s;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
  const check = setInterval(() => {
    if (document.querySelector('button, textarea, [contenteditable]')) {
      clearInterval(check);
      injectShareButton();
      watchOwnerMessages();
      // If a session is ALREADY active (e.g. tab was reloaded after sharing
      // started), the content script missed ext_session_ready — so ask the
      // background for current status and sync history immediately.
      safeSendMessage({ type: 'get_status' }, (status) => {
        if (chrome.runtime.lastError) return;
        if (status && status.isConnected) {
          setSharing(true);
          sendHistoryToServer();
        }
      });
    }
  }, 600);
}

// ── Share Button ──────────────────────────────────────────────────────────────

function injectShareButton() {
  if (document.getElementById('ss-share-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'ss-share-btn';
  btn.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
    </svg>
    <span id="ss-btn-label">Share</span>
  `;
  btn.style.cssText = `
    position:fixed; top:12px; right:16px; z-index:9999;
    display:flex; align-items:center; gap:6px;
    background:#1E293B; border:1px solid #334155; color:#F1F5F9;
    padding:7px 14px; border-radius:8px; cursor:pointer;
    font-size:13px; font-weight:600; font-family:-apple-system,sans-serif;
    box-shadow:0 2px 8px rgba(0,0,0,0.3); transition:all 0.15s;
  `;
  btn.onclick = () => safeSendMessage({ type: 'open_popup' });
  document.body.appendChild(btn);
}

function setSharing(active) {
  isConnected = active;
  if (active) startResync(); else stopResync();
  const btn = document.getElementById('ss-share-btn');
  const lbl = document.getElementById('ss-btn-label');
  if (!btn) return;
  if (active) {
    btn.style.background = '#14532D';
    btn.style.borderColor = '#4ADE80';
    btn.style.color = '#4ADE80';
    if (lbl) lbl.textContent = 'Sharing';
  } else {
    btn.style.background = '#1E293B';
    btn.style.borderColor = '#334155';
    btn.style.color = '#F1F5F9';
    if (lbl) lbl.textContent = 'Share';
  }
}

// ── API SYNC — the authoritative capture path ────────────────────────────────
//
// Instead of scraping the (virtualized, frequently-reclassed) DOM and guessing
// who said what, we read claude.ai's OWN conversation data from its private
// API using the page's logged-in session (same-origin fetch → cookies ride
// along). Every message arrives with a stable UUID, a real sender
// (human/assistant), raw markdown, and a timestamp. That gives us:
//   • exact dedup (by UUID, not string matching)
//   • correct positioning (sender is authoritative — no owner/claude guessing)
//   • perfect formatting (raw markdown → the viewer renders tables/code)
//   • immunity to claude.ai class renames (there are no selectors here)
// The DOM scrape (sendHistoryToServer) stays as an automatic fallback for any
// state the API doesn't cover (e.g. an unexpected response shape).

let cachedOrgId = null;
let lastSyncHash = '';
let apiSyncFailStreak = 0;

function getConversationId() {
  const m = location.pathname.match(/\/(?:chat|chats)\/([0-9a-fA-F-]{16,})/) ||
            location.pathname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

async function getOrgId() {
  if (cachedOrgId) return cachedOrgId;
  try {
    const r = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const orgs = await r.json();
    if (Array.isArray(orgs) && orgs.length) {
      // Prefer an org that actually has chat capability; else the first.
      const chatty = orgs.find(o => (o.capabilities || []).some(c => /chat|claude/i.test(c)));
      cachedOrgId = (chatty || orgs[0]).uuid;
    }
  } catch {}
  return cachedOrgId;
}

function apiMessageText(m) {
  if (typeof m.text === 'string' && m.text.trim()) return m.text.trim();
  const parts = [];
  for (const b of (m.content || [])) {
    if (typeof b?.text === 'string' && b.text.trim()) parts.push(b.text.trim());
  }
  return parts.join('\n\n').trim();
}

// Returns normalized messages [{type, role, name?, content, uuid, timestamp}]
// in true conversation order, or null if the API path isn't usable right now.
async function fetchConversationViaApi() {
  const conv = getConversationId();
  if (!conv) return null;
  const org = await getOrgId();
  if (!org) return null;
  let data;
  try {
    const url = `/api/organizations/${org}/chat_conversations/${conv}` +
                `?tree=True&rendering_mode=messages&render_all_tools=false`;
    const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    data = await r.json();
  } catch { return null; }

  const raw = data?.chat_messages || [];
  const out = [];
  for (const m of raw) {
    const text = apiMessageText(m);
    if (!text || isJunkText(text)) continue;
    const ts = m.created_at || m.updated_at || undefined;
    if (m.sender === 'assistant') {
      out.push({ type: 'claude_text', role: 'claude', content: collapseDoubled(text), uuid: m.uuid, timestamp: ts });
    } else {
      // Human turn — but an injected FRIEND prompt is "[Name]: …". Attribute it
      // to that friend so it renders on their side with their name.
      const fm = text.match(/^\[([^\]]{1,40})\]:\s*([\s\S]*)$/);
      if (fm) out.push({ type: 'prompt_sent', role: 'viewer', name: fm[1].trim(), content: fm[2].trim(), uuid: m.uuid, timestamp: ts });
      else out.push({ type: 'prompt_sent', role: 'owner', content: text, uuid: m.uuid, timestamp: ts });
    }
  }
  return { messages: out, name: (data?.name || '').trim() };
}

// ── Claude Code reader ───────────────────────────────────────────────────────
// Claude Code (the agentic coding surface) is a DIFFERENT product from regular
// Claude chat: its transcript lives at /v1/code/sessions/<id>/events and needs
// the `anthropic-version` header. Events carry an authoritative event_type
// ("user" | "assistant"), a stable event_id, a created_at, and a payload with
// the raw markdown — so we get correct roles, exact dedup, perfect formatting,
// and every message, with zero DOM scraping.
const CC_HEADERS = { accept: 'application/json', 'anthropic-version': '2023-06-01' };

function getCodeSessionId() {
  const m = location.href.match(/session_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

// Pull the human-readable markdown out of an event payload. Claude Code's event
// shape isn't documented, so rather than assume a path we DEEP-HARVEST every
// text-bearing block anywhere in the payload — collecting `{type:'text', text}`
// blocks (and bare `{text}` on message-ish nodes) while deliberately skipping
// tool_use / tool_result / thinking noise. Robust to whatever nesting is used.
function harvestTextBlocks(node, depth, acc) {
  if (node == null || depth > 8) return;
  if (Array.isArray(node)) { for (const x of node) harvestTextBlocks(x, depth + 1, acc); return; }
  if (typeof node !== 'object') return;
  const type = node.type;
  // Skip obvious non-prose blocks entirely.
  if (type === 'tool_use' || type === 'tool_result' || type === 'thinking' || type === 'image') return;
  if (typeof node.text === 'string' && node.text.trim() && (type === 'text' || type === undefined)) {
    acc.push(node.text);
  }
  // User prompts store their text as a plain STRING under `content`
  // (e.g. message.content = "hi" or "[Chey]: Hi") rather than a text block.
  const contentIsString = typeof node.content === 'string';
  if (contentIsString && node.content.trim()) {
    acc.push(node.content);
  }
  for (const k in node) {
    if (k === 'text' || k === 'type') continue;
    // Skip re-walking a string `content` we already captured, but DO recurse
    // into an array/object `content` (assistant text blocks live there).
    if (k === 'content' && contentIsString) continue;
    harvestTextBlocks(node[k], depth + 1, acc);
  }
}
function extractCCText(payload) {
  if (!payload) return '';
  // Fast paths for the common shapes first.
  if (typeof payload.text === 'string' && payload.text.trim()) return payload.text.trim();
  const acc = [];
  harvestTextBlocks(payload, 0, acc);
  // De-dup consecutive identical blocks (defensive) and join as markdown.
  const parts = [];
  for (const t of acc) { const s = String(t).trim(); if (s && s !== parts[parts.length - 1]) parts.push(s); }
  return parts.join('\n\n').trim();
}

async function fetchClaudeCodeTranscript() {
  const sid = getCodeSessionId();
  if (!sid) return null;
  let d;
  try {
    const r = await fetch(`/v1/code/sessions/${sid}/events?limit=500`, { credentials: 'include', headers: CC_HEADERS });
    if (!r.ok) return null;
    d = await r.json();
  } catch { return null; }

  const events = d?.data || d?.events || [];
  const out = [];
  for (const e of events) {
    const role = e.event_type || e.type;
    if (role !== 'user' && role !== 'assistant') continue;    // skip plumbing
    const text = extractCCText(e.payload);
    if (!text || isJunkText(text)) continue;
    const ts = e.created_at || undefined;
    const id = e.event_id || e.id;
    if (role === 'assistant') {
      out.push({ type: 'claude_text', role: 'claude', content: collapseDoubled(text), uuid: id, timestamp: ts });
    } else {
      const fm = text.match(/^\[([^\]]{1,40})\]:\s*([\s\S]*)$/);
      if (fm) out.push({ type: 'prompt_sent', role: 'viewer', name: fm[1].trim(), content: fm[2].trim(), uuid: id, timestamp: ts });
      else out.push({ type: 'prompt_sent', role: 'owner', content: text, uuid: id, timestamp: ts });
    }
  }
  // Order strictly by time so the transcript is chronological regardless of
  // how the events endpoint returns them.
  out.sort((a, b) => (Date.parse(a.timestamp || 0) || 0) - (Date.parse(b.timestamp || 0) || 0));

  // Self-diagnostic: if there were message events but we extracted nothing, the
  // payload shape differs from what extractCCText expects — log one raw sample
  // so it's obvious what to map, instead of silently showing an empty chat.
  const msgEvents = events.filter(e => e.event_type === 'user' || e.event_type === 'assistant');
  if (msgEvents.length && !out.length) {
    console.log('[SS] CC: could not extract text — raw payload sample:',
      JSON.stringify(msgEvents[0]?.payload || {}).slice(0, 500));
  } else {
    console.log('[SS] CC transcript:', out.length, 'msgs from', events.length, 'events');
  }
  return { messages: out, name: getSessionName() };
}

// Read the authoritative transcript for whatever surface is open: Claude Code
// first (if this is a code session), then regular Claude chat.
async function readAuthoritative() {
  if (getCodeSessionId()) {
    const cc = await fetchClaudeCodeTranscript();
    if (cc && cc.messages.length) return cc;
  }
  return fetchConversationViaApi();
}

// Poll the current conversation. Because it always reads whatever chat is open
// RIGHT NOW, switching chats and brand-new conversations are handled for free —
// no URL-change bookkeeping needed. Only pushes when something actually changed
// (hash guard), so it isn't chatty.
async function apiSyncTick() {
  if (!isConnected) return;
  const isCode = !!getCodeSessionId();
  const res = await readAuthoritative();
  if (!res || !res.messages.length) {
    // On Claude Code the DOM scrape produces FLAT, structureless text (its DOM
    // doesn't match our selectors) — never fall back to it there, or we'd
    // replace good markdown with a flat paragraph. Just wait for the next tick.
    if (isCode) { console.log('[SS] CC reader returned nothing this tick — not falling back to flat scrape'); return; }
    // Regular chat: DOM scrape is an acceptable fallback for a few ticks.
    if (++apiSyncFailStreak <= 3) sendHistoryToServer();
    return;
  }
  apiSyncFailStreak = 0;
  const name = res.name || getSessionName();
  const hash = res.messages.map(m => (m.uuid || '') + ':' + (m.content || '').length).join('|') + '#' + name;
  if (hash === lastSyncHash) return;   // nothing changed since last push
  lastSyncHash = hash;
  bumpFast();                          // something moved — stay snappy
  console.log('[SS] api sync ->', res.messages.length, 'messages | name:', name);
  safeSendMessage({ type: 'send_history', messages: res.messages, name });
}

// Adaptive cadence: ~450ms while an exchange is active (someone just sent, or
// Claude is streaming), relaxing to ~1.8s when idle — instant feel without
// hammering the API when nothing's happening.
let syncTimer = null;
let fastUntil = 0;
function bumpFast() { fastUntil = Date.now() + 9000; }
function scheduleNextSync() {
  clearTimeout(syncTimer);
  const interval = Date.now() < fastUntil ? 450 : 1800;
  syncTimer = setTimeout(async () => {
    await apiSyncTick();
    if (isConnected) scheduleNextSync();
  }, interval);
}
function startResync() {
  stopResync();
  lastSyncHash = '';
  apiSyncFailStreak = 0;
  bumpFast();
  apiSyncTick();          // immediate first sync
  scheduleNextSync();
}
function stopResync() {
  clearTimeout(syncTimer);
  syncTimer = null;
  resyncTimers.forEach(t => { clearTimeout(t); clearInterval(t); });
  resyncTimers = [];
}

// ── FIX 1: Scrape full history from DOM ───────────────────────────────────────

let historyLoading = false;

async function sendHistoryToServer() {
  // On Claude Code, the DOM scrape produces FLAT, structureless text that would
  // clobber the authoritative markdown from the events reader. Every path that
  // wants to (re)send history there must go through the reader instead — never
  // the scrape. (This is what caused the DO to flip between clean and flat.)
  if (getCodeSessionId()) {
    lastSyncHash = '';        // force the next tick to resend
    return apiSyncTick();
  }
  if (historyLoading) return;
  historyLoading = true;

  // Show loading state on the Share button
  const lbl = document.getElementById('ss-btn-label');
  const prevLabel = lbl ? lbl.textContent : '';
  if (lbl) lbl.textContent = 'Loading history…';

  try {
    // Retry the scrape until the conversation actually loads — defeats the
    // race where sharing fires before claude.ai finishes rendering the chat.
    let messages = await scrapeHistoryWithScroll();
    for (let t = 0; messages.length === 0 && t < 5; t++) {
      console.log('[SS] scrape empty, retrying…', t + 1);
      await sleep(1500);
      messages = await scrapeHistoryWithScroll();
    }
    const name = getSessionName();
    console.log('[SS] sending', messages.length, 'messages | name:', name);
    safeSendMessage({ type: 'send_history', messages, name });
  } catch (e) {
    console.warn('[SS] history error:', e);
  } finally {
    if (lbl) lbl.textContent = prevLabel || 'Sharing';
    historyLoading = false;
  }
}

// Grab the current claude.ai session title (e.g. "Perfection check")
function getSessionName() {
  const skip = /^(claude|claude code|new session|research preview|share|sharing|sharing live|chat|routines|dispatch|customize|more|recents|beta|pro|accept edits|sonnet|opus|haiku|tools|tool|settings|search|history|projects|project|files|file|terminal|preview|extensions|extension|low|medium|high|effort|invite|copy|link|scan|join)$/i;
  const looksLikeMessage = (t) =>
    /you said|show message|\[|\]|[?!.]$/i.test(t) || t.includes('\n') || t.length > 50;

  // document.title is the SPA's own declared page title — far more reliable
  // than scanning nav/toolbar DOM nodes (which can pick up panel labels like
  // "Tools"). Try it first.
  const title = (document.title || '').replace(/\s*[-–|]\s*Claude.*$/i, '').trim();
  if (title && title.length >= 2 && !skip.test(title) && !looksLikeMessage(title)) {
    return title;
  }

  // Fallback: look for a breadcrumb-style "project / session" pattern in the
  // top bar and take the LAST segment (the actual chat name), not just any
  // short top-bar label.
  const crumbs = [...document.querySelectorAll('header, nav, [class*="breadcrumb"]')]
    .map(el => (el.innerText || '').trim())
    .find(t => t.includes('/') && t.length < 120);
  if (crumbs) {
    const last = crumbs.split('/').pop().trim();
    if (last && last.length >= 2 && !skip.test(last) && !looksLikeMessage(last)) return last;
  }

  // Last resort: a single short top-bar text node, filtered hard against
  // known chrome/panel labels.
  const candidates = [...document.querySelectorAll('header *, [class*="title"], h1, h2')]
    .filter(el => {
      if (el.children.length !== 0) return false;
      const r = el.getBoundingClientRect();
      if (r.top > 120 || r.width === 0) return false;
      const t = (el.innerText || '').trim();
      return t && t.length >= 3 && t.length < 50;
    });
  for (const el of candidates) {
    const t = (el.innerText || '').trim();
    if (isJunkText(t) || skip.test(t) || looksLikeMessage(t)) continue;
    return t;
  }
  return 'Shared session';
}

// Junk filter — reject UI chrome, timestamps, session markers
function isJunkText(text) {
  if (!text || text.length < 1) return true;
  if (/^\d+\s*(s|m|h|d)(\s+ago)?$/i.test(text)) return true;   // "0s", "22m ago", "14m ago"
  if (/^just now$/i.test(text)) return true;
  if (/^(Resumed session|Initialized session|Resume session)/i.test(text)) return true;
  if (/^(Accept edits|Sonnet|Opus|Haiku|Effort:|Type \/|Low|Medium|High)/i.test(text)) return true;
  if (/^(Copy|Edit|Retry|Share|Stop)$/i.test(text)) return true;
  return false;
}

// Find the scrollable conversation container
function findScroller() {
  // Method 1: walk up from a turn to find an overflow-scroll ancestor
  const turn = document.querySelector('.standard-markdown, .epitaxy-chat-size');
  if (turn) {
    let el = turn.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 50) {
        return el;
      }
      el = el.parentElement;
    }
  }

  // Method 2: scan all elements in main for the biggest scrollable one
  const main = document.querySelector('main') || document.body;
  let best = null, bestH = 0;
  for (const el of main.querySelectorAll('*')) {
    const style = window.getComputedStyle(el);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 50 &&
        el.scrollHeight > bestH) {
      best = el; bestH = el.scrollHeight;
    }
  }
  return best;
}

// Strip a trailing relative-time token — both abbreviated ("47m ago", "0s")
// and full-word ("11 hours ago", "27 minutes ago") forms.
function stripTimestamp(text) {
  return text
    .replace(/\n*\s*\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)(\s+ago)?\s*$/i, '')
    .replace(/\n*\s*just now\s*$/i, '')
    // Absolute clock time (e.g. "4:03 PM") from the hover-only action bar —
    // usually stripped by textWithoutActionBar already, kept here as a
    // defensive fallback in case it renders somewhere else in the turn.
    .replace(/\n*\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i, '')
    .trim();
}

// Strip Claude's leading "Thought for Ns" / "Thought for Nm Ns" extended-
// thinking summary line — the user wants only the finalized answer relayed,
// not the internal thinking recap. Safe as a plain text pattern (no DOM
// dependency) since it's a fixed, predictable label Claude always uses.
function stripThoughtSummary(text) {
  return text.replace(/^\s*Thought for\s+(\d+\s*m\s*)?\d+\s*s\s*\n*/i, '');
}

// Parse a line that is PURELY a relative-time token ("11 hours ago", "27m",
// "just now", "0s") into an absolute epoch-ms. Returns null if the line isn't
// a pure timestamp (so message content never yields a false positive).
function parseTimestampLine(line) {
  const t = (line || '').toLowerCase().trim();
  if (t === 'just now' || t === 'now') return Date.now();
  let m;
  if ((m = t.match(/^(\d+)\s*(s|sec|secs|second|seconds)(\s+ago)?$/))) return Date.now() - (+m[1]) * 1000;
  if ((m = t.match(/^(\d+)\s*(m|min|mins|minute|minutes)(\s+ago)?$/))) return Date.now() - (+m[1]) * 60000;
  if ((m = t.match(/^(\d+)\s*(h|hr|hrs|hour|hours)(\s+ago)?$/))) return Date.now() - (+m[1]) * 3600000;
  if ((m = t.match(/^(\d+)\s*(d|day|days)(\s+ago)?$/))) return Date.now() - (+m[1]) * 86400000;
  return null;
}

// Find claude.ai's per-message relative timestamp inside a turn (it sits on the
// last line or two). Returns an ISO string, or undefined if none found.
function getTurnTimestamp(turnText) {
  const lines = (turnText || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const ms = parseTimestampLine(lines[i]);
    if (ms) return new Date(ms).toISOString();
  }
  return undefined;
}

// Strip claude.ai accessibility/UI chrome from a user message bubble,
// e.g. leading "You said:" and trailing "Show message actions" / "Copy".
function cleanUserText(text) {
  return text
    .replace(/^\s*You said:\s*/i, '')
    .replace(/\n?\s*(Show message actions|Copy|Edit|Retry|Edit message)\s*$/i, '')
    .trim();
}

// The role="article" turn wrapper also contains the hover-reveal action bar
// (copy/edit/retry icons + an absolute-time label) — it sits at opacity:0,
// not display:none, so .innerText still reads it: icon-font glyphs show up
// as "tofu" box characters and a stray "4:03 PM"-style timestamp gets
// appended to the message text. Strip it out of a clone before reading text,
// so scrapes are stable (and dedup against previous scrapes correctly)
// instead of differing run to run based on hover state.
function textWithoutActionBar(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('[data-message-action-bar], button, svg, [role="button"], [role="toolbar"], [role="menu"]').forEach(e => e.remove());
  return clone.innerText || '';
}

// claude.ai renders each user message TWICE in the DOM (a visible copy + a
// "[Name]: …" accessibility copy). innerText concatenates both, so we get
// "Hello\nHello" or "Hello\n[Praharsha]: Hello". Collapse that to a single
// message and extract the sender name. Handles single- or multi-line messages.
function collapseDoubleRender(text) {
  // Pull the sender name from the first "[Name]:" occurrence, then strip every
  // "[Name]:" / "[Owner]:" / "[Friend]:" prefix from the text.
  let name = null;
  const nameMatch = text.match(/\[([^\]]{1,40})\]:/);
  if (nameMatch) name = nameMatch[1].trim();
  const cleaned = text.replace(/\[[^\]]{1,40}\]:\s*/g, '');

  let lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);

  // If the lines split cleanly into two identical halves, it's the double
  // render — keep just the first half (works for multi-line messages too).
  if (lines.length >= 2 && lines.length % 2 === 0) {
    const half = lines.length / 2;
    if (lines.slice(0, half).join('') === lines.slice(half).join('')) {
      lines = lines.slice(0, half);
    }
  }
  // Also collapse any consecutive identical lines (belt-and-suspenders).
  const dedup = [];
  for (const l of lines) if (dedup[dedup.length - 1] !== l) dedup.push(l);

  return { name, content: dedup.join('\n').trim() };
}

// Collect currently-visible turns, deduped by ELEMENT (not content) so that
// genuinely repeated messages ("hi", "Hey!") are all preserved, while the same
// DOM node isn't captured twice across scroll steps.
// Normalized signature for a message — used to identify the SAME message
// re-seen across scroll steps (dedup) vs a genuinely repeated one far away.
function msgSignature(msg, absY) {
  const norm = (msg.content || '').replace(/^\[[^\]]{1,40}\]:\s*/i, '').trim().slice(0, 120);
  // Bucket the absolute Y position into 40px bands. A given message's absolute
  // position is constant while scrolling, so it always maps to the same band
  // (→ deduped). A genuine duplicate elsewhere sits in a different band (→ kept).
  return msg.role + '::' + norm + '::' + Math.round(absY / 40);
}

// Capture every currently-visible turn into `map`, keyed by position+content so
// the same message seen at multiple scroll offsets is stored once, at its true
// vertical position. Order is recovered by sorting on absY afterwards.
function collectVisibleTurns(scroller, map) {
  const baseTop = scroller ? scroller.scrollTop : (window.scrollY || 0);
  // Primary: each turn (user AND assistant alike) is wrapped in
  // role="article" aria-label="Message N of M" — an accessibility attribute,
  // which is far more stable across claude.ai frontend rebuilds than its
  // Tailwind class names (which have already renamed twice: "group/msg" ->
  // "group/message-row", and ".epitaxy-markdown" -> ".standard-markdown").
  // Fallbacks kept in case a future build drops the ARIA attribute instead.
  let turns = [...document.querySelectorAll('[role="article"]')];
  if (turns.length === 0) {
    turns = [...document.querySelectorAll('[class*="group/msg"], [class*="group/message-row"]'), ...document.querySelectorAll('.standard-markdown')];
  }
  if (turns.length === 0) turns = [...document.querySelectorAll('.epitaxy-markdown')];

  for (const turn of turns) {
    if (!isVisible(turn)) continue;

    const isClaudeBlock = turn.classList && (turn.classList.contains('font-claude-response') || turn.classList.contains('standard-markdown') || turn.classList.contains('epitaxy-markdown'));
    // .font-claude-response is the OUTER wrapper for a Claude turn — it
    // contains .standard-markdown (plain prose) as just one piece, alongside
    // sibling divs for tables/tool-use widgets that live outside it. Grabbing
    // only .standard-markdown was silently dropping tables and search/tool
    // content that renders next to it. querySelector returns the first (i.e.
    // outermost, since it's the ancestor) match in document order.
    const md = isClaudeBlock ? turn : turn.querySelector('.font-claude-response, .standard-markdown, .epitaxy-markdown');

    // Parse claude.ai's own relative timestamp for this turn (for display).
    const wrapper = turn.closest('[role="article"], [class*="group/msg"], [class*="group/message-row"]') || turn;
    const timestamp = getTurnTimestamp(wrapper.innerText || '');

    let msg;
    if (md) {
      const text = collapseDoubled(stripThoughtSummary(stripTimestamp((md.innerText || '').trim())));
      if (!text || isJunkText(text)) continue;
      msg = { type: 'claude_text', role: 'claude', content: text, html: cleanHtml(md), timestamp };
    } else {
      if (turn.querySelector('.font-claude-response, .standard-markdown, .epitaxy-markdown')) continue;
      let text = cleanUserText(stripTimestamp(textWithoutActionBar(turn).trim()));
      if (isJunkText(text) || text.length < 1 || text.length > 3000) continue;
      const { name, content } = collapseDoubleRender(text);
      if (!content) continue;
      msg = name
        ? { type: 'prompt_sent', role: 'viewer', name, content, html: '', timestamp }
        : { type: 'prompt_sent', role: 'owner', content, html: '', timestamp };
    }

    // Absolute vertical position within the scroll content (stable per message).
    const absY = Math.round((md || turn).getBoundingClientRect().top + baseTop);
    const key = msgSignature(msg, absY);
    if (!map.has(key)) map.set(key, { absY, msg });
  }
}

// Scroll through whole conversation to defeat virtualization + lazy-loading,
// then return messages in true top-to-bottom order.
async function scrapeHistoryWithScroll() {
  const map = new Map();

  // WAIT for the conversation to render (async after a tab reload).
  for (let i = 0; i < 50; i++) {
    if (document.querySelector('[role="article"], [class*="group/msg"], [class*="group/message-row"], .font-claude-response, .standard-markdown, .epitaxy-markdown')) break;
    await sleep(200);
  }

  const scroller = findScroller();
  const finish = () => [...map.values()].sort((a, b) => a.absY - b.absY).map(x => x.msg);

  if (!scroller) {
    collectVisibleTurns(null, map);
    return finish();
  }

  const originalScroll = scroller.scrollTop;

  // PHASE 1: repeatedly jump to top to force-load ALL older (lazy) messages.
  let prevHeight = -1, stable = 0;
  for (let i = 0; i < 80; i++) {
    scroller.scrollTop = 0;
    await sleep(550);
    const h = scroller.scrollHeight;
    if (h === prevHeight) { if (++stable >= 3) break; } else { stable = 0; }
    prevHeight = h;
  }

  // PHASE 2: walk top→bottom with generous overlap + settle time so no
  // virtualized window is skipped. Capture at every step.
  scroller.scrollTop = 0;
  await sleep(400);
  collectVisibleTurns(scroller, map);
  for (let i = 0; i < 300; i++) {
    const atBottom = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 5;
    collectVisibleTurns(scroller, map);
    if (atBottom) break;
    scroller.scrollTop += Math.floor(scroller.clientHeight * 0.5); // 50% overlap
    await sleep(320);
  }
  // A couple of extra captures at the very bottom to catch late-rendered tail.
  await sleep(300); collectVisibleTurns(scroller, map);
  await sleep(300); collectVisibleTurns(scroller, map);

  scroller.scrollTop = originalScroll;
  return finish();
}

// Simple synchronous scrape (visible only) — used as fallback
function scrapeHistory() {
  const map = new Map();
  collectVisibleTurns(findScroller(), map);
  return [...map.values()].sort((a, b) => a.absY - b.absY).map(x => x.msg);
}

function findConversationRoot() {
  const candidates = [
    document.querySelector('main [role="log"]'),
    document.querySelector('main [data-testid="conversation"]'),
    document.querySelector('main'),
  ];
  for (const el of candidates) {
    if (el && isVisible(el)) return el;
  }
  return null;
}

// ── FIX 2: Watch owner's outgoing messages (with injection guard) ──────────────

function watchOwnerMessages() {
  document.addEventListener('click', handleSendClick, true);
  document.addEventListener('keydown', handleSendKeydown, true);

  // Watch DOM for newly appeared messages
  const obs = new MutationObserver(() => {
    // On Claude Code the authoritative events reader captures everything —
    // owner sends, friend prompts, and Claude replies — so skip the DOM
    // capture entirely there to avoid flat single-message flashes.
    if (getCodeSessionId()) { captureBuffer = ''; return; }
    if (captureBuffer && !isInjecting) {
      const text = captureBuffer;
      captureBuffer = '';
      if (text && text !== lastOwnerMsg && !isJunkText(text)) {
        lastOwnerMsg = text;
        console.log('[SS] owner_sent_message ->', text.slice(0, 60));
        safeSendMessage({ type: 'owner_sent_message', content: text });
        // Capture response — but ONLY if not already capturing (friend injection starts its own)
        if (!isInjecting) {
          setTimeout(() => startResponseCapture(), 400);
        }
      } else {
        console.log('[SS] owner capture buffer dropped (dup/junk):', JSON.stringify(text.slice(0, 60)));
      }
    }
  });
  // Watch document.body, NOT main — this observer is set up once at page
  // load and never re-queried. If claude.ai ever swaps out <main> wholesale
  // (a client-side re-render, common over a long session), an observer
  // pinned to the old <main> reference goes stale and silently stops firing
  // forever, even though captureBuffer keeps getting set correctly. body is
  // never wholesale-replaced by client-side routing, so this can't go stale
  // the same way, and subtree:true still catches everything inside it.
  obs.observe(document.body, { childList: true, subtree: true });
}

function handleSendClick(e) {
  if (isInjecting) return;  // FIX 2: ignore clicks we triggered
  const btn = e.target.closest('button');
  if (!btn) return;
  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
  if (label.includes('send') || isSendButton(btn)) {
    captureBuffer = getInputText();
    if (typeof bumpFast === 'function') bumpFast();
    console.log('[SS] send-click detected, buffer:', JSON.stringify(captureBuffer.slice(0, 60)));
  }
}

function handleSendKeydown(e) {
  if (isInjecting) return;  // FIX 2: ignore keydowns we triggered
  if (e.key === 'Enter' && !e.shiftKey) {
    const input = findInput();
    if (input && (document.activeElement === input || input.contains(document.activeElement))) {
      captureBuffer = getInputText();
      if (typeof bumpFast === 'function') bumpFast();
      console.log('[SS] enter-key send detected, buffer:', JSON.stringify(captureBuffer.slice(0, 60)));
    }
  }
}

function isSendButton(btn) {
  const input = findInput();
  if (!input) return false;
  const ir = input.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  return Math.abs(ir.bottom - br.bottom) < 120 && br.right > ir.right - 80;
}

function getInputText() {
  const input = findInput();
  if (!input) return '';
  return (input.innerText || input.textContent || input.value || '').trim();
}

// ── FIX 2: Inject friend prompt with isInjecting guard ───────────────────────

async function injectPrompt(text, sender) {
  const labeled = `[${sender}]: ${text}`;
  isInjecting = true;  // FIX 2: block owner-capture during injection

  try {
    let input = findInput();
    if (!input) {
      for (let i = 0; i < 15; i++) {
        await sleep(200);
        input = findInput();
        if (input) break;
      }
    }
    if (!input) { console.warn('[SS] No input found'); return false; }

    input.click();
    input.focus();
    await sleep(150);

    // Clear + insert
    if (input.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, labeled);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      input.focus();
      document.execCommand('selectAll', false, null);
      await sleep(40);
      document.execCommand('delete', false, null);
      await sleep(40);
      document.execCommand('insertText', false, labeled);
    }

    await sleep(200);

    // Submit
    const sent = tryClickSend();
    if (!sent) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', keyCode: 13, bubbles: true, cancelable: true
      }));
    }

    await sleep(300);
    // Start capture AFTER injection settles — snapshot current last user msg
    setTimeout(() => startResponseCapture(), 200);
    safeSendMessage({ type: 'prompt_injected', content: labeled });
    return true;
  } finally {
    // FIX 2: re-enable owner capture after injection completes. Only needs to
    // outlast the synchronous send click/keydown dispatched above — a long
    // lockout here was swallowing genuine owner messages typed shortly after
    // a friend's message got injected (they'd click send, handleSendClick
    // would see isInjecting still true, and silently never capture it).
    setTimeout(() => { isInjecting = false; }, 400);
  }
}

// ── FIX 3: Find input — claude.ai/code specific selectors ────────────────────

function findInput() {
  const selectors = [
    // Claude Code web — "Type / for commands"
    'div[contenteditable="true"][data-placeholder*="command"]',
    'div[contenteditable="true"][placeholder*="command"]',
    '.cm-content[contenteditable="true"]',   // CodeMirror (claude.ai/code)
    // General contenteditable
    '.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
    // Textarea
    'textarea[data-testid]',
    'textarea[placeholder]',
    'textarea',
  ];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (isVisible(el) && !el.closest('[aria-hidden]') && !el.closest('[style*="display: none"]')) {
        return el;
      }
    }
  }
  return null;
}

function tryClickSend() {
  const selectors = [
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[aria-label="Send"]',
    'button[type="submit"]',
  ];
  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled && isVisible(btn)) { btn.click(); return true; }
  }
  // Find button near input
  const input = findInput();
  if (input) {
    const parent = input.closest('form') || input.parentElement?.parentElement?.parentElement;
    if (parent) {
      for (const btn of parent.querySelectorAll('button')) {
        if (!btn.disabled && isVisible(btn)) { btn.click(); return true; }
      }
    }
  }
  return false;
}

// Relay from a live node list against a streaming-cursor state ({count,
// lastText}). Nodes before `state.count` are already finalized. If a NEWER
// node has appeared after the current frontier, the frontier node can no
// longer change — finalize it (send if its settled text differs from what
// was last sent) and advance. The node AT the frontier may still be
// mid-stream (e.g. Claude shows "Figuring…" then replaces it with the real
// answer) — resend it whenever its text changes, without ever disconnecting
// the observer, so a later-arriving real answer isn't missed.
function relayStreamingNodes(nodes, state) {
  // Claude Code replies are captured authoritatively by the events reader; the
  // DOM stream here would only add flat, duplicate copies. Never relay there.
  if (getCodeSessionId()) return false;
  let sentAny = false;

  while (nodes.length > state.count + 1) {
    const node = nodes[state.count];
    const text = collapseDoubled(stripThoughtSummary((node.innerText || '').trim()));
    if (text && !isJunkText(text) && text !== state.lastText) {
      console.log('[SS] claude_response (final) ->', text.slice(0, 60));
      safeSendMessage({ type: 'claude_response', content: text, html: cleanHtml(node) });
      sentAny = true;
    }
    state.count += 1;
    state.lastText = '';
  }

  if (nodes.length === state.count + 1) {
    const node = nodes[state.count];
    const text = collapseDoubled(stripThoughtSummary((node.innerText || '').trim()));
    if (text && !isJunkText(text) && text !== state.lastText) {
      console.log('[SS] claude_response (update) ->', text.slice(0, 60));
      safeSendMessage({ type: 'claude_response', content: text, html: cleanHtml(node) });
      state.lastText = text;
      sentAny = true;
    }
  }

  return sentAny;
}

// ── Response capture — uses the real .standard-markdown selector ─────────────

function startResponseCapture() {
  if (responseObserver) { responseObserver.disconnect(); responseObserver = null; }
  clearTimeout(responseDebounce);
  responseDebounce = null;
  clearTimeout(responseIdleTimeout);

  const main = document.querySelector('main') || document.body;

  // Safety net so this doesn't watch forever if the page is truly abandoned —
  // but reset on every mutation (below), not fixed from when it started, so
  // a long multi-stage research response (which can genuinely take several
  // minutes) doesn't get cut off mid-way and leave a transient status like
  // "Pondering…" stuck forever. Only disconnects after real idle time.
  function armIdleTimeout() {
    clearTimeout(responseIdleTimeout);
    responseIdleTimeout = setTimeout(() => {
      responseObserver?.disconnect();
      responseObserver = null;
      clearTimeout(responseDebounce);
    }, 15 * 60 * 1000);
  }

  responseObserver = new MutationObserver(() => {
    armIdleTimeout();
    if (typeof bumpFast === 'function') bumpFast();   // Claude is streaming — sync fast
    clearTimeout(responseDebounce);
    // First capture of a new frontier node stays fast (2s) for normal replies.
    // Once we've already sent something for the CURRENT frontier, require a
    // longer quiet period before resending an update — a real streaming
    // reply has brief pauses that would otherwise get relayed as multiple
    // growing partial bubbles instead of one final one. Multi-stage tool use
    // (the case this whole mechanism exists for) has much longer gaps than
    // 4s anyway, so this doesn't reintroduce the "stuck" bug.
    const alreadySentFrontier = mdStream.lastText !== '' || aiTurnStream.lastText !== '';
    responseDebounce = setTimeout(() => {
      // Primary: .font-claude-response is the OUTER wrapper for a whole
      // Claude turn — tables and tool-use/search-result widgets render as
      // siblings alongside .standard-markdown inside it, so capturing only
      // .standard-markdown was silently dropping that richer content.
      // NOTE: .font-claude-response is an ANCESTOR of .standard-markdown, so
      // these must stay as a fallback chain, never combined in one query —
      // combining them would match both per turn and send every reply twice.
      let mds = [...document.querySelectorAll('.font-claude-response')];
      if (mds.length === 0) mds = [...document.querySelectorAll('.standard-markdown, .epitaxy-markdown')];

      if (mds.length > 0) {
        relayStreamingNodes(mds, mdStream);
        return;
      }

      // Fallback: cited/grounded answers (source-pill replies like web-search
      // results) and claude.ai's canned opening greeting don't render inside
      // .font-claude-response at all. Try the broader ai-turn container
      // instead, tracked with its own independent streaming cursor.
      const aiTurns = [...document.querySelectorAll('[data-testid="ai-turn-content"]')];
      if (aiTurns.length === 0) { console.log('[SS] response capture: no .font-claude-response/.standard-markdown/ai-turn-content nodes'); return; }
      relayStreamingNodes(aiTurns, aiTurnStream);
    }, alreadySentFrontier ? 4000 : 2000);
  });

  // Deliberately never disconnects on its own after a send — Claude responses
  // can arrive in multiple stages (tool use / research), so this keeps
  // watching until the next startResponseCapture() reset or genuine idle time.
  responseObserver.observe(main, { childList: true, subtree: true, characterData: true });
  armIdleTimeout();
}

/**
 * Extract rendered HTML + plain text AFTER the last user message.
 * Returns { html, text } so viewer can render rich formatting.
 */
function extractResponseAfter(lastUserEl) {
  if (!lastUserEl) return extractFallbackResponse();

  // Find the parent container of the user message
  let userContainer = lastUserEl;
  while (userContainer.parentElement && userContainer.parentElement !== document.querySelector('main') && userContainer.parentElement !== document.body) {
    userContainer = userContainer.parentElement;
  }

  // Collect everything after the user turn until next user message
  const htmlParts = [];
  const textParts = [];
  let sibling = userContainer.nextElementSibling;
  let foundAny = false;

  while (sibling) {
    // Stop if we hit another user message
    if (sibling.querySelector('[class*="user-message"]') ||
        sibling.querySelector('[class*="user-turn"]') ||
        sibling.matches('[class*="user-message"]')) {
      break;
    }

    const text = (sibling.innerText || '').trim();
    if (text && text.length > 0) {
      textParts.push(text);
      htmlParts.push(cleanHtml(sibling));
      foundAny = true;
    }
    sibling = sibling.nextElementSibling;
  }

  // If nothing found, try the main conversation area
  if (!foundAny) {
    return extractFallbackResponse();
  }

  return {
    text: textParts.join('\n\n').trim(),
    html: htmlParts.join(''),
  };
}

function extractFallbackResponse() {
  // Try to get the last AI response directly
  const aiTurns = document.querySelectorAll('[data-testid="ai-turn-content"]');
  if (aiTurns.length) {
    const last = aiTurns[aiTurns.length - 1];
    return { text: (last.innerText || '').trim(), html: cleanHtml(last) };
  }
  const userMsgs = [
    ...document.querySelectorAll('[data-testid="user-message"]'),
    ...document.querySelectorAll('[class*="user-message"]'),
  ];
  if (!userMsgs.length) return { text: '', html: '' };
  return extractResponseAfter(userMsgs[userMsgs.length - 1]);
}

/**
 * Clone element, keep ONLY semantic content tags, strip everything else.
 * Whitelist approach — if it's not a content element, remove it.
 */
function cleanHtml(el) {
  const clone = el.cloneNode(true);

  // Remove ALL non-content elements aggressively
  const trash = [
    'button', 'svg', 'img', 'video', 'audio', 'iframe',
    'input', 'select', 'textarea', 'form', 'nav', 'aside',
    '[role="button"]', '[role="toolbar"]', '[role="menu"]',
    '[data-testid*="action"]', '[data-testid*="button"]',
    '[data-testid*="copy"]', '[data-testid*="feedback"]',
  ];
  clone.querySelectorAll(trash.join(',')).forEach(e => e.remove());

  // Remove any element whose text is ONLY metadata like "just now", "0s", "1m"
  clone.querySelectorAll('span, div').forEach(e => {
    const t = (e.innerText || e.textContent || '').trim();
    if (/^(\d+s|\d+m|\d+h|just now|copy|edit|retry|like|dislike)$/i.test(t)) {
      e.remove();
    }
  });

  // Keep only semantic content — rebuild clean HTML
  const allowed = new Set(['p','h1','h2','h3','h4','h5','h6',
    'ul','ol','li','table','thead','tbody','tr','th','td',
    'code','pre','strong','b','em','i','a','br','hr',
    'blockquote','span','div','mark']);

  // Strip all attributes except href on <a> and lang on <pre>/<code>
  clone.querySelectorAll('*').forEach(e => {
    if (!allowed.has(e.tagName.toLowerCase())) {
      // Unwrap — keep children, remove the tag
      e.replaceWith(...e.childNodes);
      return;
    }
    const keep = {};
    if (e.tagName === 'A' && e.getAttribute('href')) keep.href = e.getAttribute('href');
    // Remove all attributes
    while (e.attributes.length > 0) e.removeAttribute(e.attributes[0].name);
    // Re-add kept ones
    Object.entries(keep).forEach(([k, v]) => e.setAttribute(k, v));
  });

  return clone.innerHTML || '';
}

// ── Listen from background ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'inject_prompt') {
    injectPrompt(msg.content, msg.sender || 'Friend')
      .then(ok => sendResponse({ ok }));
    return true;
  }
  if (msg.type === 'ext_session_ready') {
    setSharing(true);
    sendHistoryToServer();
  }
  if (msg.type === 'ext_disconnected') {
    setSharing(false);
  }
  if (msg.type === 'get_history') {
    sendHistoryToServer();
    sendResponse({ ok: true });
    return true;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

boot();
