import { api } from './api.js';
import { $, patch, store, tomorrowMorning, VOTE_META } from './util.js';
import * as V from './views.js';
import { toast, confetti, notifyEvent, setBadge, canNotify } from './effects.js';
import { createPip } from './pip.js';

const params = new URLSearchParams(location.search);
// Set by electron/preload.js in the desktop app; absent in the browser dev mode.
const NATIVE = window.daddyNative || null;

const S = {
  data: null,
  tab: 'todo',
  expanded: null,
  details: {},
  selectedKey: null,
  serverDown: false,
  refreshing: false,
  busy: new Set(),
  skipped: new Set(),
  menu: null,
  settingsOpen: false,
  shortcuts: false,
  assistantOpen: params.get('action') === 'next',
  peek: null,
  session: store.get('session'),
  signingIn: false,
  signinError: null,
  native: !!NATIVE,
  autostart: null,
  theme: store.get('theme', 'auto'),
  setupDismissed: store.get('setupDismissed', false),
  mini: params.get('mini') === '1',
};
if (S.session && Date.now() - S.session.at > 3 * 36e5) S.session = null;
// Tidy the address, but the mini window must keep ?mini=1 to survive a reload.
if (params.toString() && !S.mini) history.replaceState(null, '', '/');

const pip = createPip({ html: () => V.mini(S), bind: (doc, win) => bindEvents(doc, win), onClose: () => {} });

function startSession(key) {
  const it = findItem(key);
  if (it && it.state === 'todo') {
    S.session = { key: it.key, title: it.title, at: Date.now() };
    store.set('session', S.session);
  }
}

// ---- data loading ------------------------------------------------------------------

let pollTimer = null;
let lastRefreshAsk = 0;

async function load() {
  clearTimeout(pollTimer);
  try {
    setData(await api('GET', '/api/state'));
    S.serverDown = false;
  } catch (e) {
    if (e.offline) {
      S.serverDown = true;
      render();
    }
  }
  const signed = S.data && S.data.auth.signedIn;
  const fast = S.serverDown || S.signingIn || (S.data && S.data.auth.checking) || (signed && !S.data.inbox.fetchedAt);
  pollTimer = setTimeout(load, fast ? 2500 : 15000);
}

async function refresh({ quiet = false } = {}) {
  lastRefreshAsk = Date.now();
  S.refreshing = true;
  if (!quiet) render();
  try {
    setData(await api('POST', '/api/refresh'));
  } catch (e) {
    if (!quiet) toast(e.message, { kind: 'bad' });
  }
  S.refreshing = false;
  render();
}

function setData(data) {
  const prev = S.data;
  S.data = data;
  if (data.auth.signedIn && S.signingIn) {
    S.signingIn = false;
    S.signinError = null;
  }
  if (data.auth.signedIn && (!prev || !prev.auth.signedIn)) loadAutostart();
  handleEvents(data.events || []);
  setBadge(data.auth.signedIn ? data.inbox.counts.todo : 0);
  const n = data.inbox.counts.todo;
  document.title = n ? `(${n}) Daddy Review` : 'Daddy Review';
  render();
}

function handleEvents(events) {
  const maxId = events.reduce((m, e) => Math.max(m, e.id), 0);
  const last = store.get('lastEvent');
  if (last === null || last > maxId) {
    store.set('lastEvent', maxId);
    return;
  }
  const fresh = events.filter((e) => e.id > last);
  if (!fresh.length) return;
  store.set('lastEvent', maxId);
  const watching = (document.visibilityState === 'visible' && document.hasFocus()) || (pip.window && pip.window.document.hasFocus());
  for (const e of fresh.slice(-3)) {
    if (e.type === 'goal') confetti(pip.window && pip.window.document.hasFocus() ? pip.window.document : document);
    if (watching) showPeek(e);
    // The desktop app shows native notifications from the main process itself.
    else if (!NATIVE && S.data.settings.desktopPopups) notifyEvent(e);
  }
  if (!NATIVE && fresh.length > 3 && !watching && S.data.settings.desktopPopups) {
    notifyEvent({ id: maxId + 0.5, title: `${fresh.length - 3} more updates`, body: 'Open Daddy Review', url: '/' });
  }
}

let peekTimer = null;
function showPeek(e) {
  S.peek = e;
  S.anim = 'peek';
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    S.peek = null;
    render();
  }, 9000);
}

async function loadAutostart() {
  try {
    S.autostart = await api('GET', '/api/autostart');
    render();
  } catch { /* optional */ }
}

// ---- rendering -----------------------------------------------------------------------

function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  if (NATIVE) {
    // Match the native window buttons (minimize/close) to the theme.
    const css = getComputedStyle(document.documentElement);
    NATIVE.setTitleBar({ bg: css.getPropertyValue('--bg').trim(), fg: css.getPropertyValue('--text').trim() });
  }
}

function render() {
  const root = $('#app');
  if (S.mini) {
    document.body.classList.add('pip-body');
    patch(root, `<div id="pip-root">${V.mini(S)}</div>`);
    return;
  }
  if (!S.data) {
    if (S.serverDown) patch(root, V.offline());
    return;
  }
  if (S.serverDown) {
    patch(root, V.offline());
    pip.update();
    return;
  }
  if (!S.data.auth.signedIn) {
    patch(root, V.signin(S));
    pip.update();
    return;
  }
  if (!root.querySelector('#list')) {
    root._html = null;
    root.innerHTML = '<div id="top"></div><main class="main"><div id="hero"></div><div id="setup"></div><div id="tabs"></div><section id="list"></section></main><div id="drawer"></div><div id="modal"></div><div id="assistant" class="assistant"></div>';
  }
  if (!V.visibleItems(S).some((i) => i.key === S.selectedKey)) S.selectedKey = null;
  patch($('#top'), V.topbar(S));
  patch($('#hero'), V.hero(S));
  patch($('#setup'), V.setupStrip(S));
  patch($('#tabs'), V.tabs(S));
  patch($('#list'), V.list(S));
  // Cards seen once don't animate again; only new arrivals slide in.
  const keys = S.data.inbox.items.map((i) => i.key);
  if (!S.seen) S.seen = new Set(S.data.inbox.fetchedAt ? keys : []);
  else keys.forEach((k) => S.seen.add(k));
  const drawer = $('#drawer');
  const typing = drawer.contains(document.activeElement) && document.activeElement.matches('input');
  if (!typing) patch(drawer, V.drawer(S));
  patch($('#modal'), V.shortcuts(S));
  patch($('#assistant'), V.assistant(S));
  S.anim = null; // entrance animations play once, not on every data refresh
  pip.update();
}

// ---- actions -------------------------------------------------------------------------

const findItem = (key) => S.data && S.data.inbox.items.find((i) => i.key === key);

function openPr(key, win = window) {
  const it = findItem(key);
  if (!it) return;
  win.open(it.url, '_blank', 'noopener');
  startSession(key);
  S.assistantOpen = false;
  S.peek = null;
  S.selectedKey = key;
  render();
}

async function vote(key, v, { fromSession = false } = {}) {
  if (v === -10 && !confirm('Reject this pull request?')) return;
  S.busy.add(key);
  S.menu = null;
  render();
  try {
    const data = await api('POST', '/api/vote', { key, vote: v });
    S.busy.delete(key);
    // From the assistant we keep the session so it can say "done" and offer the next one.
    if (fromSession) S.assistantOpen = true;
    else if (S.session && S.session.key === key && v !== 0) endSession();
    setData(data);
    toast(VOTE_META[v].label, { kind: v < 0 ? 'info' : 'ok', action: { label: 'Undo', run: () => undoVote(key, data.prevVote) } });
  } catch (e) {
    S.busy.delete(key);
    toast(e.message, { kind: 'bad' });
    render();
    if (e.status === 404) refresh({ quiet: true });
  }
}

async function undoVote(key, prev) {
  S.busy.add(key);
  render();
  try {
    setData(await api('POST', '/api/vote', { key, vote: prev, undo: true }));
    toast('Undone');
  } catch (e) {
    toast(e.message, { kind: 'bad' });
  }
  S.busy.delete(key);
  render();
}

async function snooze(key, h) {
  const body = h === 'tomorrow' ? { key, until: tomorrowMorning() } : { key, hours: Number(h) };
  S.menu = null;
  try {
    setData(await api('POST', '/api/snooze', body));
    toast(h === 'tomorrow' ? 'Snoozed until tomorrow' : `Snoozed for ${h}h`, { action: { label: 'Undo', run: () => unsnooze(key) } });
    if (S.session && S.session.key === key) endSession();
  } catch (e) {
    toast(e.message, { kind: 'bad' });
  }
}

async function unsnooze(key) {
  try {
    setData(await api('POST', '/api/snooze', { key, until: null }));
  } catch (e) {
    toast(e.message, { kind: 'bad' });
  }
}

async function saveSettings(patchBody, { quiet = true } = {}) {
  try {
    setData(await api('POST', '/api/settings', patchBody));
    if (!quiet) toast('Saved', { kind: 'ok' });
    return true;
  } catch (e) {
    toast(e.message, { kind: 'bad' });
    return false;
  }
}

function endSession() {
  S.session = null;
  store.set('session', null);
}

async function toggleDetails(key) {
  S.expanded = S.expanded === key ? null : key;
  S.selectedKey = key;
  S.menu = null;
  render();
  if (S.expanded && (!S.details[key] || S.details[key] === 'error')) {
    S.details[key] = 'loading';
    render();
    try {
      S.details[key] = await api('GET', `/api/pr?key=${encodeURIComponent(key)}`);
    } catch {
      S.details[key] = 'error';
    }
    render();
  }
}

async function signin() {
  S.signinError = null;
  try {
    const { url } = await api('POST', '/api/login');
    if (!url) {
      // Desktop app: your browser opened at Microsoft; we pick it up when you're back.
      S.signingIn = true;
      render();
      load();
      return;
    }
    const w = 520;
    const h = 680;
    const popup = window.open(url, 'daddy-signin', `popup,width=${w},height=${h},left=${Math.max(0, (screen.width - w) / 2)},top=${Math.max(0, (screen.height - h) / 2)}`);
    if (!popup) {
      location.href = url;
      return;
    }
    S.signingIn = true;
    render();
    load();
  } catch (e) {
    S.signinError = e.message;
    render();
  }
}

const actions = {
  signin,
  'signin-cancel': () => { S.signingIn = false; render(); },
  async 'use-azcli'() {
    S.data.auth.checking = true;
    render();
    try { setData(await api('POST', '/api/use-azcli')); } catch (e) { toast(e.message, { kind: 'bad' }); }
    if (!S.data.auth.signedIn) toast('No Azure CLI login found. Run "az login" first.', { kind: 'bad' });
  },
  async signout() {
    if (!confirm('Sign out of Daddy Review?')) return;
    S.settingsOpen = false;
    try { setData(await api('POST', '/api/logout')); } catch (e) { toast(e.message, { kind: 'bad' }); }
  },
  refresh: () => refresh(),
  tab: ({ tab }) => {
    S.tab = tab;
    S.menu = null;
    S.expanded = null;
    render();
  },
  expand: ({ key }) => toggleDetails(key),
  open: ({ key }, e) => openPr(key, (e && e.view) || window),
  review: ({ key }, e) => openPr(key, (e && e.view) || window),
  skip: ({ key }) => {
    S.skipped.add(key);
    render();
  },
  vote: ({ key, vote: v }) => vote(key, Number(v)),
  menu: ({ key }) => {
    S.menu = S.menu === key ? null : key;
    render();
  },
  snooze: ({ key, h }) => snooze(key, h),
  unsnooze: ({ key }) => { S.menu = null; unsnooze(key); },
  settings: () => {
    S.settingsOpen = true;
    S.menu = null;
    render();
    loadAutostart();
  },
  'close-settings': () => {
    S.settingsOpen = false;
    render();
  },
  toggle: ({ setting }) => saveSettings({ [setting]: !S.data.settings[setting] }),
  org: ({ org }) => {
    const o = S.data.orgs.find((x) => x.name === org);
    return saveSettings({ toggleOrg: { name: org, enabled: !(o && o.enabled) } });
  },
  'remove-org': ({ org }) => saveSettings({ removeOrg: org }),
  goal: ({ d }) => saveSettings({ dailyGoal: Math.min(50, Math.max(1, S.data.settings.dailyGoal + Number(d))) }),
  async 'notify-perm'() {
    if (!('Notification' in window)) return;
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      if (!S.data.settings.desktopPopups) await saveSettings({ desktopPopups: true });
      notifyEvent({ id: Date.now(), title: 'Popups are on', body: 'You\'ll hear from me when a PR needs you.' });
    }
    render();
  },
  async autostart() {
    try {
      S.autostart = await api('POST', '/api/autostart', { enabled: !(S.autostart && S.autostart.enabled) });
      toast(S.autostart.enabled ? 'Starts automatically when you log in' : 'Won\'t start at login', { kind: 'ok' });
    } catch (e) {
      toast(e.message, { kind: 'bad' });
    }
    render();
  },
  theme: ({ theme }) => {
    S.theme = theme;
    store.set('theme', theme);
    applyTheme();
    render();
  },
  'show-main': () => NATIVE && NATIVE.showMain(),
  assistant: () => {
    S.assistantOpen = !S.assistantOpen;
    S.anim = 'bubble';
    S.peek = null;
    if (!S.assistantOpen && S.session) {
      const it = findItem(S.session.key);
      if (!it || it.state !== 'todo') endSession();
    }
    render();
  },
  'peek-close': () => {
    S.peek = null;
    render();
  },
  async pip() {
    try {
      if (NATIVE) await NATIVE.openMini();
      else await pip.open();
    } catch (e) {
      toast('Mini window is not available here', { kind: 'bad' });
    }
  },
  shortcuts: () => {
    S.shortcuts = !S.shortcuts;
    S.settingsOpen = false;
    render();
  },
  'session-vote': ({ key, vote: v }) => vote(key, Number(v), { fromSession: true }),
  'session-end': () => {
    endSession();
    S.assistantOpen = false;
    render();
  },
  'setup-dismiss': () => {
    S.setupDismissed = true;
    store.set('setupDismissed', true);
    render();
  },
};

// ---- events --------------------------------------------------------------------------

function bindEvents(doc, win) {
  doc.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) {
      if (S.menu && !e.target.closest('.menu')) {
        S.menu = null;
        render();
      }
      return;
    }
    // Buttons inside a clickable card row shouldn't also toggle the card.
    if (el.dataset.act === 'expand' && e.target.closest('button, a, input, select') && e.target.closest('button, a, input, select') !== el) return;
    e.preventDefault();
    const fn = actions[el.dataset.act];
    if (fn) fn({ ...el.dataset }, e);
  });
  doc.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change]');
    if (el) saveSettings({ [el.dataset.change]: Number(el.value) });
  });
  doc.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-form="add-org"]');
    if (!form) return;
    e.preventDefault();
    const value = form.org.value.trim();
    if (!value) return;
    form.querySelector('button').disabled = true;
    const ok = await saveSettings({ addOrg: value });
    if (ok) toast('Organization added', { kind: 'ok' });
    form.querySelector('button').disabled = false;
    if (ok) form.reset();
  });
  doc.addEventListener('keydown', onKey);
  win.addEventListener('focus', onReturn);
}

function moveSelection(delta) {
  const keys = [...document.querySelectorAll('#list .card')].filter((c) => c.offsetParent !== null).map((c) => c.dataset.key);
  if (!keys.length) return;
  const i = keys.indexOf(S.selectedKey);
  S.selectedKey = keys[Math.min(keys.length - 1, Math.max(0, i < 0 ? 0 : i + delta))];
  render();
  document.querySelector(`#list .card.selected`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function onKey(e) {
  if (e.target.closest && e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  // Enter/Space on a focused button should press that button.
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('button, a, summary')) return;
  if (!S.data || !S.data.auth.signedIn) return;
  const sel = S.selectedKey && findItem(S.selectedKey);
  const k = e.key.toLowerCase();
  const map = {
    j: () => moveSelection(1),
    arrowdown: () => moveSelection(1),
    k: () => moveSelection(-1),
    arrowup: () => moveSelection(-1),
    enter: () => sel && toggleDetails(sel.key),
    ' ': () => sel && toggleDetails(sel.key),
    o: () => sel && openPr(sel.key),
    a: () => sel && sel.state === 'todo' && vote(sel.key, 10),
    w: () => sel && sel.state !== 'mine' && vote(sel.key, -5),
    s: () => sel && sel.state === 'todo' && snooze(sel.key, 1),
    n: () => {
      const next = V.nextItem(S);
      if (next) openPr(next.key);
    },
    r: () => refresh(),
    p: () => actions.pip(),
    '?': () => actions.shortcuts(),
    1: () => actions.tab({ tab: 'todo' }),
    2: () => actions.tab({ tab: 'waiting' }),
    3: () => actions.tab({ tab: 'mine' }),
    4: () => actions.tab({ tab: 'done' }),
    escape: () => {
      S.menu = null;
      S.settingsOpen = false;
      S.shortcuts = false;
      S.assistantOpen = false;
      S.expanded = null;
      render();
    },
  };
  const fn = map[k];
  if (fn) {
    e.preventDefault();
    fn();
  }
}

/** Back from reviewing in Azure DevOps: refresh and ask how it went. */
function onReturn() {
  if (!S.data || !S.data.auth.signedIn) return;
  const stale = Date.now() - (S.data.inbox.fetchedAt || 0) > 60000;
  if (S.session && Date.now() - S.session.at > 15000) {
    if (!S.assistantOpen) S.anim = 'bubble';
    S.assistantOpen = true;
    refresh({ quiet: true });
    render();
  } else if (stale && Date.now() - lastRefreshAsk > 30000) {
    refresh({ quiet: true });
  } else {
    load();
  }
}

// ---- boot --------------------------------------------------------------------------

applyTheme();
bindEvents(document, window);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onReturn();
});
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data && e.data.type === 'daddy-signed-in') load();
});
if (NATIVE) {
  document.documentElement.classList.add('native', `os-${NATIVE.platform}`);
  NATIVE.on('daddy:refresh', () => load());
  // A desktop notification was clicked and the PR opened in your browser.
  NATIVE.on('daddy:opened', ({ key } = {}) => key && startSession(key));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  applyTheme();
  render();
});
setInterval(() => {
  // keep relative times and the PiP window fresh
  if (S.data && S.data.auth.signedIn) render();
}, 60000);

// Expose for the browser console / debugging.
window.daddy = { S, refresh, canNotify };

load();
