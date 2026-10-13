'use strict';
const crypto = require('crypto');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Strip "AADSTS50126: " style prefixes and trace ids from Microsoft errors. */
function cleanSignInError(text) {
  return String(text || '').split(/\r?\n/)[0].replace(/^AADSTS\d+:\s*/, '').slice(0, 300);
}

/**
 * The small page your browser shows after Microsoft sign-in.
 * `closePopup` is for the browser dev mode, where sign-in runs in a popup.
 */
function resultPage({ ok, title, message, closePopup = false }) {
  const nonce = crypto.randomBytes(12).toString('base64');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Daddy Review</title>
<style nonce="${nonce}">
:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;background:#0b0f1a;color:#e6e9f2}
@media (prefers-color-scheme:light){body{background:#f5f6fb;color:#0f172a}.card{background:#fff!important}}
.card{background:#131a2b;border-radius:20px;padding:36px 40px;text-align:center;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.dot{width:64px;height:64px;border-radius:50%;margin:0 auto 18px;display:grid;place-items:center;font-size:30px;color:#fff;background:${ok ? 'linear-gradient(135deg,#22c55e,#22d3ee)' : 'linear-gradient(135deg,#f43f5e,#f59e0b)'}}
h1{font-size:20px;margin:0 0 6px}p{margin:0;opacity:.7}
</style></head><body><div class="card"><div class="dot">${ok ? '✓' : '!'}</div><h1>${esc(title)}</h1><p>${esc(message)}</p></div>
${ok && closePopup ? `<script nonce="${nonce}">try{window.opener&&window.opener.postMessage({type:"daddy-signed-in"},location.origin)}catch(e){}setTimeout(function(){window.close();location.replace("/")},900)</script>` : ''}
</body></html>`;
  return {
    status: ok ? 200 : 400,
    html,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  };
}

/** 1×1 transparent PNG: what a missing profile picture becomes (the initials show through). */
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

module.exports = { resultPage, cleanSignInError, esc, BLANK_PNG };
