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
  requestAnimationFrame(() => el.classList.add('in'));
  const timer = setTimeout(dismiss, ms);
  function dismiss() {
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

export async function notifyEvent(evt) {
  if (!canNotify()) return false;
  const opts = {
    body: evt.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `daddy-${evt.id}`,
    data: { url: evt.url || '/', key: evt.key || null, type: evt.type },
    requireInteraction: evt.type === 'new',
  };
  if (evt.key) opts.actions = [{ action: 'open', title: 'Review' }, { action: 'snooze', title: 'Snooze 1h' }];
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(evt.title, opts);
    else new Notification(evt.title, opts);
    return true;
  } catch {
    try {
      new Notification(evt.title, { body: opts.body, icon: opts.icon, tag: opts.tag });
      return true;
    } catch {
      return false;
    }
  }
}

export function setBadge(n) {
  try {
    if (!('setAppBadge' in navigator)) return;
    if (n > 0) navigator.setAppBadge(n);
    else navigator.clearAppBadge();
  } catch { /* unsupported */ }
}
