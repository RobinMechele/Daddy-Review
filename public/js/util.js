export const $ = (sel, root = document) => root.querySelector(sel);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape for HTML text and attribute values. Everything from Azure DevOps goes through this. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Profile pictures that failed to load; we show initials for those. */
export const failedImages = new Set();
export const imageSrc = (url) => `/avatar?u=${encodeURIComponent(url)}`;

export const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function fmtAge(hours) {
  if (hours < 1 / 60) return 'now';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  if (hours < 24 * 14) return `${Math.round(hours / 24)}d`;
  return `${Math.round(hours / 24 / 7)}w`;
}

export function fmtMinutes(m) {
  if (!m) return '';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function initials(name) {
  const parts = String(name || '?').replace(/[[\]()]/g, '').trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function hue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export const firstName = (name) => String(name || '').split(/[\s,]+/).filter(Boolean)[0] || '';

export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? 'Late shift' : h < 12 ? 'Morning' : h < 18 ? 'Hey' : 'Evening';
}

export const VOTE_META = {
  10: { label: 'Approved', act: 'Approve', short: 'Approve', icon: 'check', cls: 'ok' },
  5: { label: 'Approved with suggestions', act: 'Approve with suggestions', short: 'Suggest', icon: 'check2', cls: 'ok' },
  0: { label: 'Vote reset', act: 'Reset my vote', short: 'Reset', icon: 'undo', cls: 'muted' },
  [-5]: { label: 'Waiting for author', act: 'Wait for author', short: 'Wait', icon: 'pause', cls: 'warn' },
  [-10]: { label: 'Rejected', act: 'Reject', short: 'Reject', icon: 'x', cls: 'bad' },
};

export function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export const store = {
  get(k, fallback = null) {
    try {
      const v = localStorage.getItem(`daddy.${k}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      if (v === null || v === undefined) localStorage.removeItem(`daddy.${k}`);
      else localStorage.setItem(`daddy.${k}`, JSON.stringify(v));
    } catch { /* private mode */ }
  },
};

/** Replace innerHTML only when it changed (keeps focus/scroll stable between polls). */
export function patch(el, html) {
  if (!el || el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}
