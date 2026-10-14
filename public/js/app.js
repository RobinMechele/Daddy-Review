import { api } from './api.js';
import { $, patch, store, tomorrowMorning, VOTE_META, failedImages, icon } from './util.js';
import * as V from './views.js';
import * as RV from './review.js';
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
  filter: '',
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
  repoPicker: null,
  review: null,
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
    root.innerHTML = `<div id="top"></div><main class="main"><div id="hero"></div><div id="setup"></div>
      <div class="toolbar"><div id="tabs"></div><label class="search" title="Search (/)">${icon('search')}<input id="filter" type="search" placeholder="Search" autocomplete="off" spellcheck="false" aria-label="Search pull requests"></label></div>
      <section id="list"></section></main><section id="review"></section><div id="drawer"></div><div id="modal"></div><div id="assistant" class="assistant"></div>`;
    const input = $('#filter');
    input.value = S.filter;
    input.addEventListener('input', () => {
      S.filter = input.value.trim();
      S.expanded = null;
      render();
    });
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
  renderReview();
  renderDrawer();
  renderModal();
  patch($('#assistant'), V.assistant(S));
  S.anim = null; // entrance animations play once, not on every data refresh
  pip.update();
}

/** A selector that finds the same control again after re-rendering (by its data-* attributes). */
function selectorFor(el) {
  if (!el || !el.dataset || !Object.keys(el.dataset).length) return null;
  return Object.entries(el.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(v)}"]`).join('');
}

/**
 * Settings: the panel stays put and only its content is updated, so clicking a
 * switch doesn't make it slide in again, jump to the top or lose focus.
 */
function renderDrawer() {
  const host = $('#drawer');
  if (!S.settingsOpen) {
    if (host.firstChild) {
      host.innerHTML = '';
      host._html = null;
    }
    return;
  }
  let panel = host.querySelector('aside.drawer');
  if (!panel) {
    host.innerHTML = '<div class="overlay" data-act="close-settings"></div><aside class="drawer" role="dialog" aria-label="Settings"></aside>';
    panel = host.querySelector('aside.drawer');
  }
  const active = panel.contains(document.activeElement) ? document.activeElement : null;
  if (active && active.matches('input')) return; // typing an organization name
  const scroll = panel.scrollTop;
  const focus = selectorFor(active);
  if (!patch(panel, V.drawer(S))) return;
  panel.scrollTop = scroll;
  if (focus) panel.querySelector(focus)?.focus({ preventScroll: true });
}

/** Shortcuts and the repository picker (keeps your typing and scroll position). */
function renderModal() {
  const modal = $('#modal');
  const filter = $('#repo-filter');
  if (S.repoPicker && filter && document.activeElement === filter) {
    patch($('#picker-body'), V.pickerBody(S));
    modal._html = null;
    return;
  }
  const list = modal.querySelector('.picker-list');
  const scroll = list ? list.scrollTop : 0;
  if (patch(modal, V.shortcuts(S) + V.repoPicker(S))) {
    const again = modal.querySelector('.picker-list');
    if (again) again.scrollTop = scroll;
  }
}

// ---- reviewing inside the app ------------------------------------------------------------

/** The review screen; keeps what you're typing (and where) when the app refreshes. */
function renderReview() {
  const host = $('#review');
  document.body.classList.toggle('reviewing', !!S.review);
  if (!S.review) {
    patch(host, '');
    return;
  }
  const top = $('#top');
  if (top) document.documentElement.style.setProperty('--top-h', `${top.offsetHeight}px`);
  const active = document.activeElement;
  const draftId = active && host.contains(active) && active.dataset ? active.dataset.draft : null;
  const sel = draftId ? [active.selectionStart, active.selectionEnd] : null;
  const files = host.querySelector('.rv-files');
  const filesScroll = files ? files.scrollTop : 0;
  if (!patch(host, RV.reviewView(S))) return;
  const head = host.querySelector('.rv-head');
  if (head) document.documentElement.style.setProperty('--rv-h', `${head.offsetHeight + 14}px`);
  const again = host.querySelector('.rv-files');
  if (again) again.scrollTop = filesScroll;
  if (draftId) {
    const el = host.querySelector(`[data-draft="${CSS.escape(draftId)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(sel[0], sel[1]);
    }
  }
}

const VIEWED_KEY = 'viewed';
function loadViewed(key) {
  const all = store.get(VIEWED_KEY, {}) || {};
  return (all[key] && all[key].files) || {};
}
function saveViewed(key, files) {
  const all = store.get(VIEWED_KEY, {}) || {};
  all[key] = { at: Date.now(), files };
  // Forget PRs you haven't looked at in a month.
  for (const [k, v] of Object.entries(all)) if (!v || Date.now() - v.at > 30 * 864e5) delete all[k];
  store.set(VIEWED_KEY, all);
}

/** Review a PR: in the app, or in Azure DevOps if you switched that off. */
function startReview(key, e) {
  if (S.data && S.data.settings.reviewInApp === false) return openPr(key, (e && e.view) || window);
  if (S.mini && NATIVE) {
    NATIVE.openReview(key);
    return null;
  }
  return openReview(key);
}

async function openReview(key, { file = null } = {}) {
  if (!findItem(key)) {
    toast('That PR is no longer active', { kind: 'bad' });
    return;
  }
  const same = S.review && S.review.key === key;
  S.review = {
    key,
    loading: true,
    error: null,
    data: same ? S.review.data : null,
    commit: null,
    file: file || (same ? S.review.file : null),
    diffs: {},
    expanded: same ? S.review.expanded : {},
    composer: null,
    drafts: same ? S.review.drafts : {},
    busy: new Set(),
    viewed: loadViewed(key),
  };
  S.assistantOpen = false;
  S.peek = null;
  S.settingsOpen = false;
  S.menu = null;
  render();
  if (!same) window.scrollTo(0, 0);
  try {
    const data = await api('GET', `/api/review?key=${encodeURIComponent(key)}`);
    if (!S.review || S.review.key !== key) return;
    Object.assign(S.review, { loading: false, data, commit: data.commit });
    if (S.review.file && !data.files.some((f) => f.path === S.review.file)) S.review.file = null;
    render();
    if (S.review.file) loadDiff(S.review.file);
  } catch (e) {
    if (!S.review || S.review.key !== key) return;
    Object.assign(S.review, { loading: false, error: e.message });
    render();
  }
}

function closeReview() {
  S.review = null;
  render();
  window.scrollTo(0, 0);
}

async function loadDiff(path, { retry = false } = {}) {
  const R = S.review;
  if (!R || (R.diffs[path] && R.diffs[path] !== 'error' && !retry)) return;
  R.diffs[path] = 'loading';
  render();
  try {
    const d = await api('GET', `/api/review/diff?key=${encodeURIComponent(R.key)}&path=${encodeURIComponent(path)}`);
    if (S.review === R) R.diffs[path] = d;
  } catch {
    if (S.review === R) R.diffs[path] = 'error';
  }
  render();
}

function showFile(path, { line = null, retry = false } = {}) {
  const R = S.review;
  if (!R || !R.data) return;
  R.file = path;
  R.composer = null;
  render();
  window.scrollTo(0, 0);
  loadDiff(path, { retry }).then(() => {
    if (!line) return;
    const th = [...document.querySelectorAll('#review .th-row')].find((el) => el.previousElementSibling && el.previousElementSibling.querySelector(`.add-c[data-line="${line}"]`));
    (th || document.querySelector(`#review .add-c[data-line="${line}"]`))?.scrollIntoView({ block: 'center' });
  });
}

function stepFile(d) {
  const R = S.review;
  if (!R || !R.data || !R.data.files.length) return;
  const files = R.data.files;
  const i = R.file ? files.findIndex((f) => f.path === R.file) : -1;
  const next = files[Math.min(files.length - 1, Math.max(0, i + d))];
  if (next && next.path !== R.file) showFile(next.path);
}

function setViewed(path, on) {
  const R = S.review;
  const f = R && R.data && R.data.files.find((x) => x.path === path);
  if (!f) return;
  if (on && f.version) R.viewed[path] = f.version;
  else delete R.viewed[path];
  saveViewed(R.key, R.viewed);
  render();
}

/** Send a new comment (on a line or the PR) or a reply; the box keeps its text if it fails. */
async function sendComment(draftId) {
  const R = S.review;
  if (!R) return;
  const content = (R.drafts[draftId] || '').trim();
  if (!content) {
    toast('Write something first');
    return;
  }
  const body = { key: R.key, content };
  let busyId = draftId;
  if (draftId.startsWith('t')) {
    body.threadId = Number(draftId.slice(1));
  } else if (draftId.startsWith('new:')) {
    const c = R.composer;
    if (!c) return;
    Object.assign(body, { path: c.path, line: c.line, side: c.side, lineText: c.lineText });
  }
  R.busy.add(busyId);
  render();
  try {
    const data = await api('POST', '/api/review/comment', body);
    if (S.review !== R) return;
    R.data = { ...R.data, files: data.files, threads: data.threads };
    delete R.drafts[draftId];
    if (draftId.startsWith('new:')) R.composer = null;
    toast(body.threadId ? 'Replied' : 'Comment added', { kind: 'ok' });
  } catch (e) {
    toast(e.message, { kind: 'bad' });
  }
  R.busy.delete(busyId);
  render();
}

async function setThreadStatus(id, status) {
  const R = S.review;
  if (!R) return;
  R.busy.add(`t${id}`);
  render();
  try {
    const data = await api('POST', '/api/review/status', { key: R.key, threadId: Number(id), status });
    if (S.review === R) R.data = { ...R.data, files: data.files, threads: data.threads };
    toast(status === 'fixed' ? 'Resolved' : 'Reopened', { kind: 'ok' });
  } catch (e) {
    toast(e.message, { kind: 'bad' });
  }
  R.busy.delete(`t${id}`);
  render();
}

// ---- repository picker -----------------------------------------------------------------

async function openRepoPicker(org) {
  S.repoPicker = { org, loading: true, error: null, projects: [], pick: new Map(), only: false, filter: '', open: new Set(), saving: false };
  render();
  try {
    const r = await api('GET', `/api/repos?org=${encodeURIComponent(org)}`);
    if (!S.repoPicker || S.repoPicker.org !== org) return;
    Object.assign(S.repoPicker, {
      loading: false,
      projects: r.projects,
      pick: new Map(r.pick.map((p) => [`${p.kind}:${p.id}`, p])),
      only: r.only,
    });
  } catch (e) {
    if (!S.repoPicker) return;
    Object.assign(S.repoPicker, { loading: false, error: e.message });
  }
  render();
  $('#repo-filter')?.focus();
}

function togglePick(el) {
  const P = S.repoPicker;
  if (!P) return;
  const { pick: kind, id } = el.dataset;
  const key = `${kind}:${id}`;
  if (!el.checked) {
    P.pick.delete(key);
  } else if (kind === 'project') {
    const p = P.projects.find((x) => x.id === id);
    if (!p) return;
    // The whole project replaces single repositories in it.
    for (const r of p.repos) P.pick.delete(`repo:${r.id}`);
    P.pick.set(key, { kind, id, name: p.name, projectId: p.id, project: p.name });
  } else {
    const p = P.projects.find((x) => x.id === el.dataset.project);
    const r = p && p.repos.find((x) => x.id === id);
    if (!r) return;
    P.pick.set(key, { kind, id, name: r.name, projectId: p.id, project: p.name });
  }
  if (!P.pick.size) P.only = false;
  render();
}

async function saveRepoPicker() {
  const P = S.repoPicker;
  if (!P || P.saving) return;
  P.saving = true;
  render();
  const ok = await saveSettings({ setRepos: { org: P.org, pick: [...P.pick.values()], only: P.only } });
  if (S.repoPicker === P) {
    P.saving = false;
    if (ok) {
      S.repoPicker = null;
      toast(P.pick.size === 1 ? `Watching ${[...P.pick.values()][0].name}` : P.pick.size ? 'Saved' : 'All repositories', { kind: 'ok' });
    }
  }
  render();
}

// ---- actions -------------------------------------------------------------------------

const findItem = (key) => S.data && S.data.inbox.items.find((i) => i.key === key);

function openPr(key, win = window, { session = true } = {}) {
  const it = findItem(key);
  if (!it) return;
  win.open(it.url, '_blank', 'noopener');
  if (session) startSession(key);
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

/** Add yourself as a reviewer of a PR from "Others". */
async function pickUp(key, { undo = false } = {}) {
  S.busy.add(key);
  S.menu = null;
  render();
  try {
    const data = await api('POST', '/api/pickup', { key, undo });
    S.busy.delete(key);
    setData(data);
    if (undo) toast('Removed you as reviewer');
    else toast('Added to your reviews', { kind: 'ok', action: { label: 'Undo', run: () => pickUp(key, { undo: true }) } });
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

async function signin(body) {
  S.signinError = null;
  try {
    const { url } = await api('POST', '/api/login', body);
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
  signin: () => signin(),
  'signin-personal': () => signin({ personal: true }),
  async 'update-check'() {
    try { setData(await api('POST', '/api/update/check')); } catch (e) { toast(e.message, { kind: 'bad' }); }
  },
  async 'update-install'() {
    try {
      await api('POST', '/api/update/install');
      if (S.data.app.update && S.data.app.update.status === 'ready') toast('Restarting into the new version…');
    } catch (e) {
      toast(e.message, { kind: 'bad' });
    }
  },
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
    S.review = null;
    try { setData(await api('POST', '/api/logout')); } catch (e) { toast(e.message, { kind: 'bad' }); }
  },
  refresh: () => refresh(),
  tab: ({ tab }) => {
    S.tab = tab;
    S.menu = null;
    S.expanded = null;
    render();
    // Narrow window: keep the chosen tab in view (sideways only).
    const t = $('#tabs .tab.active');
    const nav = t && t.parentElement;
    if (nav && (t.offsetLeft < nav.scrollLeft || t.offsetLeft + t.offsetWidth > nav.scrollLeft + nav.clientWidth)) {
      nav.scrollLeft = t.offsetLeft - (nav.clientWidth - t.offsetWidth) / 2;
    }
  },
  expand: ({ key }) => toggleDetails(key),
  open: ({ key }, e) => openPr(key, (e && e.view) || window),
  review: ({ key }, e) => startReview(key, e),
  skip: ({ key }) => {
    S.skipped.add(key);
    render();
  },
  vote: ({ key, vote: v }) => vote(key, Number(v)),
  pickup: ({ key }) => pickUp(key),
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
  // Switches flip right away; the app catches up in the background.
  toggle: ({ setting }) => {
    const value = !S.data.settings[setting];
    S.data.settings[setting] = value;
    render();
    return saveSettings({ [setting]: value });
  },
  org: ({ org }) => {
    const o = S.data.orgs.find((x) => x.name === org);
    if (!o) return null;
    o.enabled = !o.enabled;
    render();
    return saveSettings({ toggleOrg: { name: org, enabled: o.enabled } });
  },
  'remove-org': ({ org }) => saveSettings({ removeOrg: org }),
  'rv-back': () => closeReview(),
  'rv-reload': () => S.review && openReview(S.review.key),
  'rv-overview': () => {
    if (!S.review) return;
    S.review.file = null;
    S.review.composer = null;
    render();
    window.scrollTo(0, 0);
  },
  'rv-file': ({ path, line, retry }) => showFile(path, { line: line ? Number(line) : null, retry: !!retry }),
  'rv-step': ({ d }) => stepFile(Number(d)),
  'rv-expand': ({ path, fold }) => {
    const R = S.review;
    if (!R) return;
    if (!R.expanded[path]) R.expanded[path] = new Set();
    R.expanded[path].add(Number(fold));
    render();
  },
  'rv-line': ({ path, line, side, i }) => {
    const R = S.review;
    const d = R && R.diffs[path];
    if (!d || !d.lines) return;
    const l = d.lines[Number(i)];
    R.composer = { path, line: Number(line), side, lineText: l ? l.s : '' };
    render();
    const id = `new:${path}:${side}:${line}`;
    $(`#review [data-draft="${CSS.escape(id)}"]`)?.focus();
  },
  'rv-cancel': () => {
    if (!S.review) return;
    S.review.composer = null;
    render();
  },
  'rv-send': ({ id }) => sendComment(id),
  'rv-reply': ({ id }) => sendComment(`t${id}`),
  'rv-status': ({ id, status }) => setThreadStatus(id, status),
  'rv-vote': ({ vote: v }) => S.review && vote(S.review.key, Number(v)),
  'rv-open': () => S.review && openPr(S.review.key, window, { session: false }),
  'rv-next-pr': ({ key }) => openReview(key),
  'review-app': ({ key }) => openReview(key),
  repos: ({ org }) => openRepoPicker(org),
  'repos-close': () => { S.repoPicker = null; render(); },
  'repos-expand': ({ id }) => {
    const open = S.repoPicker && S.repoPicker.open;
    if (!open) return;
    if (open.has(id)) open.delete(id);
    else open.add(id);
    render();
  },
  'repos-only': () => {
    if (!S.repoPicker || !S.repoPicker.pick.size) return;
    S.repoPicker.only = !S.repoPicker.only;
    render();
  },
  'repos-clear': () => {
    if (!S.repoPicker) return;
    S.repoPicker.pick.clear();
    S.repoPicker.only = false;
    render();
  },
  'repos-save': () => saveRepoPicker(),
  goal: ({ d }) => {
    S.data.settings.dailyGoal = Math.min(50, Math.max(1, S.data.settings.dailyGoal + Number(d)));
    render();
    return saveSettings({ dailyGoal: S.data.settings.dailyGoal });
  },
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
    const pick = e.target.closest('[data-pick]');
    if (pick) return togglePick(pick);
    const viewed = e.target.closest('[data-viewed]');
    if (viewed) return setViewed(viewed.dataset.viewed, viewed.checked);
    const el = e.target.closest('[data-change]');
    if (el) {
      S.data.settings[el.dataset.change] = Number(el.value);
      saveSettings({ [el.dataset.change]: Number(el.value) });
    }
  });
  doc.addEventListener('input', (e) => {
    // What you type in a review is kept, so a refresh never wipes it.
    if (e.target.dataset && e.target.dataset.draft && S.review) {
      S.review.drafts[e.target.dataset.draft] = e.target.value;
      return;
    }
    if (e.target.id !== 'repo-filter' || !S.repoPicker) return;
    S.repoPicker.filter = e.target.value.trim();
    render();
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
  // A profile picture that can't load: remember it and show the initials underneath.
  doc.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.classList && img.classList.contains('av-img')) {
      failedImages.add(img.dataset.src);
      img.remove();
    }
  }, true);
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
  if (S.review && onReviewKey(e)) return;
  if (S.repoPicker && e.key === 'Escape') {
    e.preventDefault();
    S.repoPicker = null;
    render();
    return;
  }
  if (e.target.id === 'filter' && e.key === 'Escape') {
    e.target.value = '';
    S.filter = '';
    e.target.blur();
    render();
    return;
  }
  if (e.target.closest && e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || S.repoPicker) return;
  if (e.key === '/' && S.data && S.data.auth.signedIn && !S.mini) {
    e.preventDefault();
    $('#filter')?.focus();
    return;
  }
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
    5: () => actions.tab({ tab: 'other' }),
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

/** Keys on the review screen. Returns true when handled. */
function onReviewKey(e) {
  const R = S.review;
  const inText = e.target.closest && e.target.closest('textarea, input, select');
  if (inText && e.target.dataset && e.target.dataset.draft) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendComment(e.target.dataset.draft);
      return true;
    }
    if (e.key === 'Escape') {
      e.target.blur();
      if (e.target.dataset.draft.startsWith('new:')) actions['rv-cancel']();
      return true;
    }
    return true;
  }
  if (inText || e.metaKey || e.ctrlKey || e.altKey || S.settingsOpen || S.repoPicker || S.shortcuts) return false;
  const map = {
    escape: () => (R.composer ? actions['rv-cancel']() : closeReview()),
    n: () => stepFile(1),
    j: () => stepFile(1),
    p: () => stepFile(-1),
    k: () => stepFile(-1),
    v: () => {
      const f = R.file && R.data && R.data.files.find((x) => x.path === R.file);
      if (f) setViewed(f.path, !RV.isViewed(R, f));
    },
    a: () => vote(R.key, 10),
    o: () => openPr(R.key, window, { session: false }),
    r: () => openReview(R.key),
  };
  const fn = map[e.key.toLowerCase()];
  if (!fn) return false;
  e.preventDefault();
  fn();
  return true;
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
  // A notification or the mini window asked to review a PR here.
  NATIVE.on('daddy:review', ({ key } = {}) => key && openReview(key));
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
