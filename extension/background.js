/**
 * background.js — WebSocket to deployed server (Fly.io)
 * Fast, reliable, 1-second connections. No WebRTC complexity.
 *
 * IMPORTANT: this is an MV3 service worker — Chrome kills it after ~30s
 * idle, wiping every top-level `let`. sessionId/shareUrl are mirrored into
 * chrome.storage.session (survives worker restarts, cleared on browser
 * close) so restoreSession() can bring the WS back after every wake,
 * instead of silently staying disconnected forever (which is why messages
 * and Claude's replies were failing to relay after the popup closed).
 */

const SERVER_URL = 'https://claude-groupchats.groupchats.workers.dev';

let ws = null;
let sessionId = null;
let shareUrl = null;
let reconnectTimer = null;
let isConnected = false;

restoreSession();

async function restoreSession() {
  try {
    const stored = await chrome.storage.session.get(['sessionId', 'shareUrl']);
    if (stored.sessionId) {
      sessionId = stored.sessionId;
      shareUrl = stored.shareUrl;
      connectWs();
    }
  } catch {}
}

// ── Session ───────────────────────────────────────────────────────────────────

// Derive a STABLE key from the open claude.ai conversation so the same chat
// always maps to the same share session — persisting history + who's joined.
async function getConversationKey() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    for (const tab of tabs) {
      const u = tab.url || '';
      const m = u.match(/(session[_-][A-Za-z0-9]+)/i) || u.match(/\/code\/([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

async function createSession() {
  try {
    const key = await getConversationKey();
    const res = await fetch(`${SERVER_URL}/api/sessions/new`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();
    if (!data.token) throw new Error('No token');
    sessionId = data.token;

    const shareRes = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/share-info`);
    const shareData = await shareRes.json();
    shareUrl = shareData.url;
    const qrDataUrl = shareData.qrDataUrl;

    await chrome.storage.session.set({ sessionId, shareUrl });
    connectWs();
    return { shareUrl, qrDataUrl, sessionId };
  } catch (err) {
    return { error: err.message };
  }
}

async function stopSession() {
  if (ws) { ws.close(); ws = null; }
  sessionId = null; shareUrl = null;
  isConnected = false;
  await chrome.storage.session.remove(['sessionId', 'shareUrl']);
  updateBadge(false);
  broadcastToContent({ type: 'ext_disconnected' });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWs() {
  if (!sessionId) return;
  if (ws) { ws.close(); ws = null; }
  clearTimeout(reconnectTimer);

  const wsUrl = SERVER_URL.replace('https://', 'wss://').replace('http://', 'ws://');
  ws = new WebSocket(`${wsUrl}/ws?token=${sessionId}&role=owner-extension`);

  ws.onopen = () => {
    isConnected = true;
    updateBadge(true);
    broadcastToContent({ type: 'ext_session_ready', sessionId, shareUrl });
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'viewer_prompt_pending') {
        broadcastToContent({ type: 'inject_prompt', content: msg.content, sender: msg.sender || 'Friend' });
      }
    } catch {}
  };

  ws.onclose = () => {
    isConnected = false;
    updateBadge(sessionId ? true : false);
    if (sessionId) reconnectTimer = setTimeout(connectWs, 2000);
  };
}

// ── Send messages ─────────────────────────────────────────────────────────────

function send(msg) {
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify(msg));
  } else {
    console.log('[SS] dropped', msg.type, '— ws not open (readyState:', ws?.readyState, ')');
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'create_session') { createSession().then(sendResponse); return true; }
  if (msg.type === 'stop_session') { stopSession().then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'get_status') {
    // Popup opening is a reliable wake trigger — use it to pull back a
    // persisted session before answering, so we don't report "not connected"
    // and cause the popup to mint a duplicate session mid-reconnect.
    (sessionId ? Promise.resolve() : restoreSession())
      .then(() => sendResponse({ isConnected, sessionId, shareUrl }));
    return true;
  }
  if (msg.type === 'owner_sent_message') {
    send({ type: 'owner_sent_message', content: msg.content, timestamp: new Date().toISOString() });
    sendResponse({ ok: true }); return true;
  }
  if (msg.type === 'claude_response') {
    send({ type: 'owner_claude_response', content: msg.content, html: msg.html || '', timestamp: new Date().toISOString() });
    sendResponse({ ok: true }); return true;
  }
  if (msg.type === 'send_history') {
    send({ type: 'owner_history', messages: msg.messages, name: msg.name });
    sendResponse({ ok: true }); return true;
  }
  if (msg.type === 'prompt_injected') { sendResponse({ ok: true }); return true; }
});

function updateBadge(active) {
  chrome.action.setBadgeText({ text: active ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: active ? '#16A34A' : '#64748B' });
}

async function broadcastToContent(msg) {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
}

try {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => {
    if (isConnected) return;
    // sessionId may be null here if the service worker was just restarted —
    // pull it back from chrome.storage.session rather than giving up.
    if (sessionId) connectWs();
    else restoreSession();
  });
} catch {}
