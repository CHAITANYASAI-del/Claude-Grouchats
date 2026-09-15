/**
 * Claude Groupchats — Cloudflare Worker + Durable Object relay
 *
 * Instant (native WebSocket), free forever, no sleep, no credit card.
 * Each session token maps to one SessionRoom Durable Object that holds the
 * live WebSocket connections (via Hibernation API) and the merged history
 * (persisted in DO storage so it survives hibernation).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/**
 * Sanitize a Claude response coming from the (possibly stale) owner extension.
 * The older published extension prefixes replies with "Claude responded:" and
 * double-renders the text (either exact "AA" halves like "Hi!Hi!", or a
 * truncated preview glued in front of the full copy). Clean both so viewers
 * see the reply exactly once, unprefixed.
 */
function cleanClaudeText(raw) {
  let s = (raw || '').toString().trim();
  // Drop the stale extension's literal prefix (any capitalization / spacing).
  s = s.replace(/^\s*Claude\s+responded\s*:\s*/i, '').trim();
  return collapseDoubled(s);
}

function collapseDoubled(s) {
  s = (s || '').trim();
  if (s.length < 2) return s;

  // Case 1: whole string is exact "AA" — collapse to A ("Hi!Hi!" alone).
  if (s.length % 2 === 0) {
    const h = s.length / 2;
    if (s.slice(0, h) === s.slice(h)) return s.slice(0, h).trim();
  }

  // Case 2: the OPENING chunk is repeated back-to-back, then real text
  // continues — "Hi!Hi! What can I help…" → "Hi! What can I help…". Take the
  // largest k where s[0..k) === s[k..2k), collapse that first copy away.
  for (let k = Math.floor(s.length / 2); k >= 1; k--) {
    if (s.slice(0, k) === s.slice(k, 2 * k)) {
      return (s.slice(0, k) + s.slice(2 * k)).trim();
    }
  }

  // Case 3: preview + full — a truncated opening (usually ending in "…")
  // is glued before the full copy. Keep from the second occurrence.
  const head = s.slice(0, 40);
  if (head.length === 40) {
    const idx = s.indexOf(head, 1);
    if (idx > 0) {
      const first = s.slice(0, idx);
      const second = s.slice(idx).trim();
      if (/(\.\.\.|…)\s*$/.test(first) || second.length >= first.length) return second;
    }
  }
  return s;
}

function randomToken(n = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return [...arr].map(x => chars[x % chars.length]).join('');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;
    const base = `${url.protocol}//${url.host}`;

    // ── WebSocket → route to the session's Durable Object ──
    // Sanitize the token the same way /api/sessions/new does — a stray
    // character (e.g. a copy-pasted "]") must not silently create/connect
    // to a different, empty Durable Object.
    if (path === '/ws') {
      const rawToken = url.searchParams.get('token');
      const token = rawToken ? rawToken.replace(/[^A-Za-z0-9]/g, '').slice(0, 48) : '';
      if (!token) return new Response('Missing token', { status: 400 });
      const id = env.SESSION_ROOM.idFromName(token);
      const stub = env.SESSION_ROOM.get(id);
      return stub.fetch(request);
    }

    // ── REST ──
    if (path === '/api/config') {
      return json({ serverUrl: base, isProduction: true });
    }

    if (path === '/api/sessions/new' && request.method === 'POST') {
      // A stable per-conversation key makes the same chat reuse the same
      // session (persistent history + remembered participants). Falls back
      // to a random token when no key is provided.
      let key = null;
      try { key = (await request.json()).key; } catch {}
      const token = key
        ? String(key).replace(/[^A-Za-z0-9]/g, '').slice(0, 48)
        : randomToken(8);
      // Touch the DO so the session exists
      const id = env.SESSION_ROOM.idFromName(token);
      const stub = env.SESSION_ROOM.get(id);
      await stub.fetch(new Request(`https://do/init?token=${token}`));
      return json({ token });
    }

    const shareMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9]+)\/share-info$/);
    if (shareMatch) {
      return json({ url: `${base}/join/${shareMatch[1]}` });
    }

    const sessMatch = path.match(/^\/api\/sessions\/([A-Za-z0-9]+)$/);
    if (sessMatch) {
      return json({ token: sessMatch[1] });
    }

    // ── Static viewer for / and /join/:token ──
    // Return the HTML content directly (status 200) so the browser keeps the
    // /join/:token URL — the viewer reads the session token from the path.
    if (path === '/' || path.startsWith('/join/')) {
      let res = await env.ASSETS.fetch(new Request(`${base}/viewer.html`));
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) res = await env.ASSETS.fetch(new Request(`${base}${loc}`));
      }
      return new Response(res.body, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      });
    }

    // Any other asset (e.g. /viewer.html directly)
    return env.ASSETS.fetch(request);
  },
};

// ── Durable Object: one live room per session token ──
export class SessionRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async getHistory() {
    return (await this.ctx.storage.get('history')) || [];
  }
  async setHistoryStore(messages) {
    await this.ctx.storage.put('history', messages);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Session init ping (from /api/sessions/new)
    if (url.pathname === '/init') {
      const existing = await this.ctx.storage.get('history');
      if (!existing) await this.ctx.storage.put('history', []);
      return new Response('ok');
    }

    if (url.pathname === '/debug') {
      const history = await this.getHistory();
      const sockets = this.ctx.getWebSockets();
      return new Response(JSON.stringify({
        messageCount: history.length,
        last3: history.slice(-3).map(m => ({ type: m.type, role: m.role, preview: (m.content || '').slice(0, 60) })),
        connectedSockets: sockets.length,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const role = url.searchParams.get('role') || 'viewer';
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Accept with hibernation; tag by role so we can filter later
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role });

      // Send current history + session name immediately
      const history = await this.getHistory();
      const name = await this.ctx.storage.get('name');
      console.log(`[DO] ${role} connected | history=${history.length} | name=${name || '-'}`);
      server.send(JSON.stringify({ type: 'history', messages: history, name }));

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  roleOf(ws) {
    try { return (ws.deserializeAttachment() || {}).role; } catch { return undefined; }
  }

  broadcast(jsonStr, { except } = {}) {
    for (const ws of this.ctx.getWebSockets()) {
      if (except && ws === except) continue;
      try { ws.send(jsonStr); } catch {}
    }
  }
  sendToRole(role, jsonStr) {
    for (const ws of this.ctx.getWebSockets(role)) {
      try { ws.send(jsonStr); } catch {}
    }
  }

  makeMsg(type, content, role, extra = {}) {
    return { type, content, role, timestamp: new Date().toISOString(), ...extra };
  }

  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
    catch { return; }

    const role = this.roleOf(ws);

    // Extension → full scraped history. The DOM scrape is the AUTHORITATIVE,
    // correctly-ordered snapshot of exactly what the owner sees, so we use its
    // order verbatim (no timestamp synthesis, no sorting — that was what
    // jumbled the transcript). We only append genuinely just-arrived live
    // messages (< 30s old) that the scrape hasn't captured yet, so a message
    // the friend sent a second ago isn't briefly lost mid-injection.
    if (role === 'owner-extension' && msg.type === 'owner_history') {
      const scraped = (msg.messages || []).map(m =>
        m.type === 'claude_text' ? { ...m, content: cleanClaudeText(m.content) } : m
      );
      const existing = await this.getHistory();
      const norm = (m) => (m.content || '')
        .replace(/^\[[^\]]{1,40}\]:\s*/i, '').trim().slice(0, 120);
      const scrapedKeys = new Set(scraped.map(m => m.type + '::' + norm(m)));

      const now = Date.now();
      const recentExtras = existing.filter(m => {
        if (scrapedKeys.has(m.type + '::' + norm(m))) return false;
        const t = Date.parse(m.timestamp || '');
        return t && (now - t) < 30000;   // only the last 30 seconds of live msgs
      });

      const merged = [...scraped, ...recentExtras];
      await this.setHistoryStore(merged);
      if (msg.name) await this.ctx.storage.put('name', msg.name);
      const name = await this.ctx.storage.get('name');
      console.log(`[DO] owner_history: ${scraped.length} scraped + ${recentExtras.length} recent live | name=${name || '-'}`);
      this.sendToRole('viewer', JSON.stringify({ type: 'history', messages: merged, name }));
      return;
    }

    // Extension → owner typed & sent a message
    if (role === 'owner-extension' && msg.type === 'owner_sent_message') {
      const ownerMsg = this.makeMsg('prompt_sent', msg.content, 'owner');
      const hist = await this.getHistory(); hist.push(ownerMsg); await this.setHistoryStore(hist);
      this.broadcast(JSON.stringify(ownerMsg), { except: ws });
      return;
    }

    // Extension → Claude responded (dedup identical consecutive)
    if (role === 'owner-extension' && msg.type === 'owner_claude_response') {
      const hist = await this.getHistory();
      const cleaned = cleanClaudeText(msg.content);
      const last = hist[hist.length - 1];
      if (last?.type === 'claude_text' && last?.content === cleaned) return;
      // Prefer the doubled/prefixed html cleaned to plain text; the stale
      // extension's html is unreliable, so render from the cleaned text.
      const claudeMsg = this.makeMsg('claude_text', cleaned, 'claude', { html: msg.html || '' });
      hist.push(claudeMsg); await this.setHistoryStore(hist);
      this.broadcast(JSON.stringify(claudeMsg), { except: ws });
      return;
    }

    // Viewer → prompt: broadcast to everyone + route to extension for injection
    if (role === 'viewer' && msg.type === 'viewer_prompt') {
      const name = (msg.name || 'Friend').toString().slice(0, 40);
      const promptMsg = this.makeMsg('prompt_sent', msg.content, 'viewer', { name });
      const hist = await this.getHistory(); hist.push(promptMsg); await this.setHistoryStore(hist);
      this.broadcast(JSON.stringify(promptMsg));  // includes sender
      // Inject into the owner's Claude labelled with the viewer's real name
      this.sendToRole('owner-extension', JSON.stringify({
        type: 'viewer_prompt_pending', content: msg.content, sender: name,
      }));
      return;
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch {}
  }
  async webSocketError(ws) {
    try { ws.close(); } catch {}
  }
}
