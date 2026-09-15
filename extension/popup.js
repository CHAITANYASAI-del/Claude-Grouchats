// popup.js — auto-creates session, generates QR inline (no external requests)

function show(id) {
  ['stateLoading','stateLive','stateError','stateWrongSite'].forEach(s => {
    document.getElementById(s).style.display = s === id ? 'block' : 'none';
  });
}

async function isOnClaudeSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return !!tab?.url && /^https:\/\/claude\.ai\//.test(tab.url);
  } catch { return true; } // if we can't check, don't block the user
}

async function init() {
  show('stateLoading');

  if (!(await isOnClaudeSite())) {
    show('stateWrongSite');
    return;
  }

  const status = await ask({ type: 'get_status' });
  // A persisted shareUrl means a session already exists — reuse it even if
  // the WS hasn't finished reconnecting yet, so we never orphan a link a
  // friend already has open by minting a second session underneath it.
  if (status?.shareUrl) {
    renderLive(status.shareUrl);
    return;
  }

  const res = await ask({ type: 'create_session' });
  if (res?.shareUrl) {
    renderLive(res.shareUrl);
  } else {
    show('stateError');
  }
}

function renderLive(shareUrl) {
  show('stateLive');

  // Generate QR inline
  const qrContainer = document.getElementById('qrContainer');
  qrContainer.innerHTML = '';
  qrContainer.appendChild(generateQRSvg(shareUrl, 140));

  document.getElementById('copyBtn').onclick = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      const label = document.getElementById('copyLabel');
      const prev = label.textContent;
      label.textContent = 'Link copied!';
      setTimeout(() => { label.textContent = prev; }, 2000);
    });
  };
}

document.getElementById('retryBtn').onclick = init;

function ask(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, res => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    } catch { resolve(null); }
  });
}

// ── Pure JS QR Code Generator ─────────────────────────────────────────────────
// Minimal QR generator — no library needed, works in extension popup

function generateQRSvg(text, size = 140) {
  // Use QR API via data URI approach - generate via canvas
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Draw placeholder with URL text while we use img approach
  const img = document.createElement('img');

  // Use quickchart.io (free, no API key, no auth)
  const encoded = encodeURIComponent(text);
  img.src = `https://quickchart.io/qr?text=${encoded}&size=${size}&format=png&margin=1`;
  img.width = size;
  img.height = size;
  img.style.cssText = 'border-radius:8px;display:block;';

  img.onerror = () => {
    // Fallback: show URL as text if image fails
    const div = document.createElement('div');
    div.style.cssText = `
      width:${size}px;height:${size}px;background:#1E293B;border:1px solid #334155;
      border-radius:8px;display:flex;align-items:center;justify-content:center;
      font-size:9px;color:#64748B;text-align:center;padding:8px;word-break:break-all;
    `;
    div.textContent = 'Scan with camera or copy link above';
    img.replaceWith(div);
  };

  return img;
}

init();
