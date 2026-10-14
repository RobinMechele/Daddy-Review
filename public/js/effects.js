import { esc, icon } from './util.js';

// ---- toasts ---------------------------------------------------------------------

export function toast(message, { kind = 'info', action = null, ms = 4500 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast t-${kind}`;
  const ic = kind === 'ok' ? 'check' : kind === 'bad' ? 'alert' : 'spark';
  el.innerHTML = `${icon(ic)}<span>${esc(message)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ''}`;
  if (action) {
    el.querySelector('.toast-btn').addEventListener('click', () => {
      action.run();
      dismiss();
    });
  }
  host.append(el);
  // At most three at a time: the oldest make room.
  const live = [...host.querySelectorAll('.toast:not(.out)')];
  for (const old of live.slice(0, Math.max(0, live.length - 3))) old.dismiss();
  el.dismiss = dismiss;
  requestAnimationFrame(() => el.classList.add('in'));
  const timer = setTimeout(dismiss, ms);
  function dismiss() {
    el.classList.add('out');
    clearTimeout(timer);
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }
}

// ---- confetti -------------------------------------------------------------------

export function confetti(doc = document) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const win = doc.defaultView;
  const c = doc.createElement('canvas');
  c.className = 'confetti';
  doc.body.append(c);
  const ctx = c.getContext('2d');
  const dpr = win.devicePixelRatio || 1;
  const W = (c.width = win.innerWidth * dpr);
  const H = (c.height = win.innerHeight * dpr);
  const colors = ['#7c5cff', '#22d3ee', '#22c55e', '#f59e0b', '#f43f5e', '#e879f9'];
  const parts = Array.from({ length: 160 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3,
    y: H * 0.35,
    vx: (Math.random() - 0.5) * 18 * dpr,
    vy: (-Math.random() * 16 - 6) * dpr,
    r: (Math.random() * 5 + 3) * dpr,
    a: Math.random() * Math.PI,
    va: (Math.random() - 0.5) * 0.4,
    color: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.45 * dpr;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.a += p.va;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 2200);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    }
    if (t < 2200) win.requestAnimationFrame(frame);
    else c.remove();
  })(start);
}

// ---- OS notifications & taskbar badge --------------------------------------------

export const canNotify = () => 'Notification' in window && Notification.permission === 'granted';

/** Browser dev mode only; the desktop app shows notifications from its main process. */
export function notifyEvent(evt) {
  if (!canNotify()) return false;
  try {
    const n = new Notification(evt.title, { body: evt.body || '', icon: '/icons/icon-192.png', tag: `daddy-${evt.id}` });
    n.onclick = () => {
      window.focus();
      if (evt.url && /^https?:/i.test(evt.url)) window.open(evt.url, '_blank', 'noopener');
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

/** Red count badge for the Windows taskbar button (overlay icon). */
function badgePng(n) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#f43f5e';
  g.beginPath();
  g.arc(16, 16, 16, 0, Math.PI * 2);
  g.fill();
  const text = n > 99 ? '99+' : String(n);
  g.fillStyle = '#fff';
  g.font = `700 ${text.length > 2 ? 13 : text.length > 1 ? 17 : 21}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 16, 17);
  return c.toDataURL('image/png');
}

let lastBadge = null;
export function setBadge(n) {
  if (window.daddyNative) {
    if (n === lastBadge) return;
    lastBadge = n;
    window.daddyNative.setBadge(n, n > 0 ? badgePng(n) : null);
    return;
  }
  try {
    if (!('setAppBadge' in navigator)) return;
    if (n > 0) navigator.setAppBadge(n);
    else navigator.clearAppBadge();
  } catch { /* unsupported */ }
}
