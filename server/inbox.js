'use strict';
const path = require('path');
const logic = require('./logic');
const { mapLimit, readJson, writeJson, HttpError } = require('./util');

const DEFAULT_SETTINGS = {
  disabledOrgs: [],
  extraOrgs: [],
  includeTeams: true,
  pollMinutes: 2,
  dailyGoal: 5,
  desktopPopups: true,
  nudges: true,
  workStart: 9,
  workEnd: 18,
  useAzCli: true,
  tenant: 'organizations',
};
const POLL_CHOICES = [1, 2, 3, 5, 10, 15];
const NUDGE_EVERY = 2 * 36e5;
const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Accepts "contoso", "https://dev.azure.com/contoso/..." or "https://contoso.visualstudio.com". */
function parseOrg(input) {
  const s = String(input || '').trim();
  let m = /^(?:https?:\/\/)?dev\.azure\.com\/([^/?#\s]+)/i.exec(s);
  if (m) return decodeURIComponent(m[1]);
  m = /^(?:https?:\/\/)?([^./?#\s]+)\.visualstudio\.com/i.exec(s);
  if (m) return m[1];
  return s.replace(/\/+$/, '');
}

const friendly = (e) => (e && e.message ? String(e.message).slice(0, 200) : 'Something went wrong');

/** Polls Azure DevOps, keeps the review queue, events and stats. */
class Inbox {
  constructor({ config, ado, auth, log, notify = () => {}, suppressToast = null }) {
    this.config = config;
    this.ado = ado;
    this.auth = auth;
    this.log = log;
    this.notify = notify;
    // Desktop app: "is the window focused?" (it shows the news itself then).
    // Browser mode: a tab that can show notifications polled recently.
    this.suppressToast = suppressToast || (() => Date.now() - this.notifyClientAt < 150000);
    this.file = path.join(config.DATA_DIR, 'state.json');
    const saved = readJson(this.file, {}) || {};
    this.state = {
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
      snapshot: saved.snapshot || {},
      baselined: saved.baselined || {},
      reviews: Array.isArray(saved.reviews) ? saved.reviews : [],
      snoozed: saved.snoozed || {},
      events: Array.isArray(saved.events) ? saved.events : [],
      seq: Number(saved.seq) || 0,
      lastNudgeAt: Number(saved.lastNudgeAt) || 0,
    };
    this.items = new Map();
    this.orgItems = new Map();
    this.orgMeta = new Map();
    this.sizeCache = new Map();
    this.discovered = null;
    this.discoveredAt = 0;
    this.profile = null;
    this.errors = {};
    this.lastError = null;
    this.fetchedAt = 0;
    this.polling = null;
    this.notifyClientAt = 0;
    this.startedAt = Date.now();
    this.timer = null;
    this.toastQueue = [];
  }

  get settings() {
    return this.state.settings;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    try {
      writeJson(this.file, this.state);
    } catch (e) {
      this.log.warn(`Could not save state: ${e.message}`);
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  start() {
    const tick = async () => {
      await this.poll().catch(() => {});
      this.timer = setTimeout(tick, this.settings.pollMinutes * 60e3);
    };
    this.tick = tick;
    this.timer = setTimeout(tick, 200);
  }

  reschedule() {
    if (!this.tick) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(this.tick, this.settings.pollMinutes * 60e3);
  }

  stop() {
    clearTimeout(this.timer);
    this.tick = null;
    this.saveNow();
  }

  onSignIn() {
    this.discovered = null;
    this.orgMeta.clear();
    this.lastError = null;
    return this.poll({ force: true });
  }

  onSignOut() {
    this.items.clear();
    this.orgItems.clear();
    this.orgMeta.clear();
    this.discovered = null;
    this.profile = null;
    this.errors = {};
    this.fetchedAt = 0;
  }

  // ---- polling --------------------------------------------------------------

  poll({ force = false } = {}) {
    if (this.polling) return this.polling;
    if (!force && Date.now() - this.fetchedAt < 20000) return Promise.resolve();
    this.polling = this.doPoll()
      .catch((e) => {
        if (e.code === 'AUTH_REQUIRED') {
          this.lastError = null;
          if (this.items.size) this.onSignOut();
        } else {
          this.lastError = friendly(e);
          this.log.warn(`Refresh failed: ${this.lastError}`);
        }
      })
      .finally(() => {
        this.polling = null;
      });
    return this.polling;
  }

  async doPoll() {
    await this.auth.getToken(); // throws AUTH_REQUIRED when nobody is signed in
    const orgs = await this.resolveOrgs();
    const enabled = orgs.filter((o) => o.enabled).map((o) => o.name);
    const errors = {};
    await mapLimit(enabled, 3, async (org) => {
      try {
        this.orgItems.set(org, await this.fetchOrg(org));
      } catch (e) {
        if (e.code === 'AUTH_REQUIRED') throw e;
        errors[org] = friendly(e);
        this.log.warn(`${org}: ${errors[org]}`);
      }
    });
    for (const org of [...this.orgItems.keys()]) if (!enabled.includes(org)) this.orgItems.delete(org);
    const items = [...this.orgItems.values()].flat();
    await this.loadSizes(items);

    const okOrgs = enabled.filter((o) => !errors[o]);
    const baselineOrgs = new Set(okOrgs.filter((o) => !this.state.baselined[o]));
    const { snapshot, events, reviews } = logic.diff(this.state.snapshot, items, {
      now: Date.now(),
      baselineOrgs,
      knownOrgs: new Set(okOrgs),
    });
    this.state.snapshot = snapshot;
    for (const o of okOrgs) this.state.baselined[o] = true;
    this.items = new Map(items.map((i) => [i.key, i]));
    this.errors = errors;
    this.lastError = null;
    this.fetchedAt = Date.now();
    for (const r of reviews) this.addReview(r);
    for (const e of events) this.emit(e);
    this.maybeNudge();
    this.save();
  }

  async resolveOrgs() {
    const stale = Date.now() - this.discoveredAt > (this.discoverError ? 5 * 60e3 : 3600e3);
    if (!this.discovered || stale) {
      try {
        const p = await this.ado.profile();
        this.profile = { id: p.id, name: p.displayName || '', email: p.emailAddress || '' };
        this.discovered = await this.ado.accounts(p.publicAlias || p.id);
        this.discoverError = null;
      } catch (e) {
        if (e.code === 'AUTH_REQUIRED') throw e;
        this.discoverError = friendly(e);
        this.discovered = this.discovered || [];
        this.log.warn(`Could not list your organizations: ${this.discoverError}`);
      }
      this.discoveredAt = Date.now();
    }
    return this.orgList();
  }

  orgList() {
    const s = this.settings;
    const discovered = this.discovered || [];
    const names = [...new Set([...discovered, ...s.extraOrgs])].sort((a, b) => a.localeCompare(b));
    return names.map((name) => ({
      name,
      enabled: !s.disabledOrgs.includes(name),
      manual: !discovered.includes(name),
      error: this.errors[name] || null,
    }));
  }

  async fetchOrg(org) {
    let meta = this.orgMeta.get(org);
    if (!meta || Date.now() - meta.at > 6 * 36e5) {
      const conn = await this.ado.connection(org);
      meta = { myId: conn.id, at: Date.now(), groups: meta ? meta.groups : [], groupsAt: meta ? meta.groupsAt : 0 };
      this.orgMeta.set(org, meta);
    }
    if (this.settings.includeTeams && Date.now() - meta.groupsAt > 36e5) {
      try {
        meta.groups = await this.ado.groups(org, meta.myId);
      } catch (e) {
        if (e.code === 'AUTH_REQUIRED') throw e;
        this.log.warn(`${org}: could not load your teams (${friendly(e)})`);
      }
      meta.groupsAt = Date.now();
    }
    const groups = this.settings.includeTeams ? meta.groups || [] : [];
    const queries = [
      { 'searchCriteria.reviewerId': meta.myId },
      { 'searchCriteria.creatorId': meta.myId },
      ...groups.map((g) => ({ 'searchCriteria.reviewerId': g.id })),
    ];
    const lists = await mapLimit(queries, 4, (q, i) =>
      this.ado.pullRequests(org, q).catch((e) => {
        if (i < 2) throw e;
        return [];
      }));
    const byId = new Map();
    for (const pr of lists.flat()) if (pr && pr.pullRequestId) byId.set(pr.pullRequestId, pr);
    const ctx = { org, myId: meta.myId, groups: new Map(groups.map((g) => [g.id, g.name])), webBase: this.config.WEB_BASE };
    return [...byId.values()].map((pr) => logic.toItem(pr, ctx));
  }

  async loadSizes(items) {
    const need = items.filter((i) => !i.mine && !i.draft && i.commit);
    await mapLimit(need, 4, async (it) => {
      const ck = `${it.key}@${it.commit}`;
      let files = this.sizeCache.get(ck);
      if (!files) {
        try {
          files = await this.ado.changedFiles(it);
          this.sizeCache.set(ck, files);
        } catch (e) {
          if (e.code === 'AUTH_REQUIRED') throw e;
          return;
        }
      }
      it.files = files;
    });
    const keep = new Set(need.map((i) => `${i.key}@${i.commit}`));
    for (const k of this.sizeCache.keys()) if (!keep.has(k)) this.sizeCache.delete(k);
  }

  // ---- events, reviews, nudges ------------------------------------------------

  emit(e) {
    const evt = { id: ++this.state.seq, at: Date.now(), ...e };
    this.state.events.push(evt);
    if (this.state.events.length > 60) this.state.events.splice(0, this.state.events.length - 60);
    this.save();
    if (this.settings.desktopPopups && evt.title && !this.suppressToast()) this.queueToast(evt);
    return evt;
  }

  queueToast(evt) {
    this.toastQueue.push(evt);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      const q = this.toastQueue.splice(0);
      const shown = q.length > 3 ? q.slice(0, 2) : q;
      for (const e of shown) this.notify({ title: e.title, body: e.body || '', url: e.url || null, key: e.key || null, type: e.type });
      if (q.length > 3) this.notify({ title: `${q.length - 2} more updates`, body: 'Open Daddy Review to see them', url: null, key: null, type: 'more' });
    }, 400);
  }

  addReview(r) {
    const goal = this.settings.dailyGoal;
    const before = logic.stats(this.state.reviews, r.at, goal).today;
    this.state.reviews.push(r);
    if (this.state.reviews.length > 3000) this.state.reviews.splice(0, this.state.reviews.length - 3000);
    const after = logic.stats(this.state.reviews, r.at, goal).today;
    if (before < goal && after >= goal) {
      this.emit({ type: 'goal', title: 'Daily goal reached 🎉', body: `${after} reviews today. Legend.` });
    }
  }

  maybeNudge(now = Date.now()) {
    const s = this.settings;
    if (!s.nudges) return null;
    const d = new Date(now);
    const hour = d.getHours() + d.getMinutes() / 60;
    if (d.getDay() === 0 || d.getDay() === 6 || hour < s.workStart || hour >= s.workEnd) return null;
    if (now - this.startedAt < 10 * 60e3) return null;
    const last = this.state.reviews.length ? this.state.reviews[this.state.reviews.length - 1].at : 0;
    if (now - Math.max(last, this.state.lastNudgeAt) < NUDGE_EVERY) return null;
    const v = this.view(now);
    const todo = v.items.filter((i) => i.state === 'todo' && !i.snoozedUntil);
    if (!todo.length) return null;
    const next = todo[0];
    this.state.lastNudgeAt = now;
    const n = todo.length;
    return this.emit({
      type: 'nudge',
      key: next.key,
      url: next.url,
      prTitle: next.title,
      title: `${n} PR${n > 1 ? 's' : ''} waiting for you`,
      body: `Next: ${next.title}${next.minutes ? ` · ~${next.minutes} min` : ''}`,
    });
  }

  // ---- views ----------------------------------------------------------------

  view(now = Date.now()) {
    const snoozed = this.state.snoozed;
    let cleaned = false;
    for (const [k, until] of Object.entries(snoozed)) {
      if (until <= now) { delete snoozed[k]; cleaned = true; }
    }
    if (cleaned) this.save();

    const items = [];
    for (const it of this.items.values()) {
      const c = logic.classify(it, this.state.snapshot[it.key]);
      if (c.state === 'hidden') continue;
      const size = it.files ? logic.sizeInfo(it.files) : null;
      const view = { ...it, state: c.state, updated: !!c.updated, covered: !!c.covered, size };
      delete view.files;
      const sc = logic.score(view, now);
      view.score = sc.score;
      view.reasons = sc.reasons;
      view.minutes = c.state === 'todo' ? logic.estimate(size, c.updated) : null;
      view.ageH = Math.max(0, (now - Date.parse(it.created)) / 36e5);
      view.snoozedUntil = snoozed[it.key] || null;
      items.push(view);
    }
    items.sort((a, b) => b.score - a.score || Date.parse(a.created) - Date.parse(b.created));
    const active = items.filter((i) => i.state === 'todo' && !i.snoozedUntil);
    const counts = { todo: active.length, waiting: 0, done: 0, mine: 0, draft: 0, snoozed: 0 };
    for (const i of items) {
      if (i.state === 'todo' && i.snoozedUntil) counts.snoozed++;
      else if (i.state !== 'todo') counts[i.state] = (counts[i.state] || 0) + 1;
    }
    return {
      items,
      counts,
      next: active.length ? active[0].key : null,
      minutesTotal: active.reduce((a, i) => a + (i.minutes || 0), 0),
      oldestH: active.reduce((a, i) => Math.max(a, i.ageH), 0),
      fetchedAt: this.fetchedAt || null,
      polling: !!this.polling,
      errors: this.errors,
      error: this.lastError,
      discoverError: this.discoverError || null,
    };
  }

  stats(now = Date.now()) {
    return logic.stats(this.state.reviews, now, this.settings.dailyGoal);
  }

  recentEvents() {
    return this.state.events.slice(-30);
  }

  markClient(canNotify) {
    if (canNotify) this.notifyClientAt = Date.now();
  }

  // ---- actions --------------------------------------------------------------

  async vote(key, vote, { undo = false } = {}) {
    const it = this.items.get(key);
    if (!it) throw new HttpError(404, 'That PR is no longer active. Refreshing…');
    if (!logic.VOTES.includes(vote)) throw new HttpError(400, 'Unknown vote');
    const meta = this.orgMeta.get(it.org);
    if (!meta) throw new HttpError(409, 'Still loading, try again in a second');
    await this.ado.vote(it, meta.myId, vote);

    const prevVote = it.myVote;
    it.myVote = vote;
    it.direct = true;
    const mine = it.reviewers.find((r) => r.me);
    if (mine) mine.vote = vote;
    else it.reviewers.push({ id: meta.myId, name: (this.profile && this.profile.name) || 'You', vote, required: false, team: false, declined: false, me: true });

    const snap = this.state.snapshot[key] || { votedCommit: null, resetByPush: false };
    snap.myVote = vote;
    snap.commit = it.commit;
    if (vote !== 0) {
      snap.votedCommit = it.commit;
      snap.resetByPush = false;
    }
    snap.state = logic.classify(it, snap).state;
    this.state.snapshot[key] = snap;

    if (undo) {
      const idx = this.state.reviews.map((r) => r.key).lastIndexOf(key);
      if (idx >= 0 && Date.now() - this.state.reviews[idx].at < 3600e3) this.state.reviews.splice(idx, 1);
    } else if (vote !== 0) {
      this.addReview({ key, org: it.org, title: it.title, vote, at: Date.now() });
    }
    this.save();
    return { prevVote };
  }

  snooze(key, until) {
    if (until === null) delete this.state.snoozed[key];
    else {
      const t = Number(until);
      if (!Number.isFinite(t) || t <= Date.now()) throw new HttpError(400, 'Bad snooze time');
      this.state.snoozed[key] = Math.min(t, Date.now() + 30 * 864e5);
    }
    this.save();
  }

  async details(key) {
    const it = this.items.get(key);
    if (!it) throw new HttpError(404, 'That PR is no longer active');
    const [files, threads] = await Promise.all([
      it.files ? Promise.resolve(it.files) : this.ado.changedFiles(it).catch(() => null),
      this.ado.threads(it).catch(() => null),
    ]);
    return {
      key,
      description: it.description,
      fileCount: files ? files.length : null,
      files: files ? files.slice(0, 150) : null,
      threads,
    };
  }

  updateSettings(patch = {}) {
    const s = this.settings;
    const bool = (k) => { if (typeof patch[k] === 'boolean') s[k] = patch[k]; };
    ['includeTeams', 'desktopPopups', 'nudges', 'useAzCli'].forEach(bool);
    const int = (k, lo, hi) => {
      const v = Number(patch[k]);
      if (patch[k] !== undefined && Number.isInteger(v) && v >= lo && v <= hi) s[k] = v;
    };
    int('dailyGoal', 1, 50);
    int('workStart', 0, 23);
    int('workEnd', 1, 24);
    if (POLL_CHOICES.includes(Number(patch.pollMinutes))) {
      s.pollMinutes = Number(patch.pollMinutes);
      this.reschedule();
    }
    if (typeof patch.tenant === 'string' && /^[\w.-]{1,100}$/.test(patch.tenant)) s.tenant = patch.tenant;

    let orgsChanged = false;
    if (patch.addOrg !== undefined) {
      const name = parseOrg(patch.addOrg);
      if (!ORG_NAME.test(name)) throw new HttpError(400, 'That doesn\'t look like an organization name');
      if (!s.extraOrgs.includes(name)) s.extraOrgs.push(name);
      s.disabledOrgs = s.disabledOrgs.filter((o) => o !== name);
      orgsChanged = true;
    }
    if (typeof patch.removeOrg === 'string') {
      s.extraOrgs = s.extraOrgs.filter((o) => o !== patch.removeOrg);
      orgsChanged = true;
    }
    if (patch.toggleOrg && typeof patch.toggleOrg.name === 'string') {
      const { name, enabled } = patch.toggleOrg;
      s.disabledOrgs = s.disabledOrgs.filter((o) => o !== name);
      if (enabled === false) s.disabledOrgs.push(name);
      orgsChanged = true;
    }
    if (patch.includeTeams !== undefined) {
      for (const m of this.orgMeta.values()) m.groupsAt = 0;
      orgsChanged = true;
    }
    this.save();
    return { orgsChanged };
  }
}

module.exports = { Inbox, DEFAULT_SETTINGS, parseOrg };
