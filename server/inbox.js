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
  quietHours: false,
  hotkey: true,
  // Per organization: repositories/projects to watch ({ pick: [...], only }).
  repos: {},
};
const POLL_CHOICES = [1, 2, 3, 5, 10, 15];
const NUDGE_EVERY = 2 * 36e5;
// Organizations with more active PRs than this are looked through for your teams every 10 minutes.
const SCAN_MAX = 1000;
const SCAN_EVERY_BIG = 10 * 60e3;
const ID = /^[\w.-]{1,100}$/;
const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Bumped when the app starts finding more PRs (e.g. nested teams in 1.2): the extra
// ones are taken in silently once instead of popping up as "new".
const SCOPE_VERSION = 2;

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
      baselined: (saved.scopeVersion || 1) >= SCOPE_VERSION ? saved.baselined || {} : {},
      scopeVersion: SCOPE_VERSION,
      reviews: Array.isArray(saved.reviews) ? saved.reviews : [],
      snoozed: saved.snoozed || {},
      events: Array.isArray(saved.events) ? saved.events : [],
      seq: Number(saved.seq) || 0,
      lastNudgeAt: Number(saved.lastNudgeAt) || 0,
      lastRecap: saved.lastRecap || null,
    };
    const st = this.state.settings;
    if (!st.repos || typeof st.repos !== 'object' || Array.isArray(st.repos)) st.repos = {};
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
    await Promise.all([this.loadSizes(items), this.loadComments(items)]);

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
    this.maybeRecap();
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
    return names.map((name) => {
      const meta = this.orgMeta.get(name);
      const w = s.repos[name];
      return {
        name,
        enabled: !s.disabledOrgs.includes(name),
        manual: !discovered.includes(name),
        error: this.errors[name] || null,
        counts: (meta && meta.counts) || null,
        watch: w && w.pick.length ? { count: w.pick.length, only: !!w.only, names: w.pick.slice(0, 3).map((p) => p.name) } : null,
      };
    });
  }

  /** The repositories/projects you watch in an organization, or null for "all". */
  watchOf(org) {
    const w = this.settings.repos && this.settings.repos[org];
    if (!w || !Array.isArray(w.pick) || !w.pick.length) return null;
    const projects = new Set(w.pick.filter((p) => p.kind === 'project').map((p) => p.id));
    const repos = new Set(w.pick.filter((p) => p.kind === 'repo').map((p) => p.id));
    const scopes = [
      ...[...projects].map((projectId) => ({ projectId })),
      ...w.pick.filter((p) => p.kind === 'repo' && !projects.has(p.projectId)).map((p) => ({ projectId: p.projectId, repoId: p.id, name: p.name })),
    ];
    return { only: !!w.only, scopes, has: (it) => projects.has(it.projectId) || repos.has(it.repoId) };
  }

  async fetchOrg(org) {
    let meta = this.orgMeta.get(org);
    if (!meta || Date.now() - meta.at > 6 * 36e5) {
      const conn = await this.ado.connection(org);
      meta = { ...(meta || {}), myId: conn.id, at: Date.now(), groups: meta ? meta.groups : [], groupsAt: meta ? meta.groupsAt : 0 };
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
    const groupIds = new Set(groups.map((g) => g.id));
    const watch = this.watchOf(org);
    const forYou = (pr) => (pr.createdBy && pr.createdBy.id === meta.myId)
      || (pr.reviewers || []).some((r) => r && (r.id === meta.myId || groupIds.has(r.id)));
    const found = [];

    // PRs for your teams: look through the active PRs and keep the ones that ask for a team you're in.
    const scan = groupIds.size && !(watch && watch.only) ? await this.scanTeams(org, meta, groupIds) : null;
    if (scan && scan.complete) {
      found.push(...scan.list.filter(forYou));
    } else {
      // Asked for you or created by you, plus (big orgs) the teams seen on PRs.
      const queries = [
        { 'searchCriteria.reviewerId': meta.myId },
        { 'searchCriteria.creatorId': meta.myId },
        ...(groupIds.size ? meta.teamHits || [] : []).slice(0, 15).map((id) => ({ 'searchCriteria.reviewerId': id })),
      ];
      const lists = await mapLimit(queries, 4, (q, i) =>
        this.ado.pullRequests(org, q).catch((e) => {
          if (i < 2 || e.code === 'AUTH_REQUIRED') throw e;
          return [];
        }));
      found.push(...lists.flat());
      if (scan) found.push(...scan.list.filter(forYou));
    }

    // Repositories you watch: every active PR in them, for you or not.
    if (watch) {
      const lists = await mapLimit(watch.scopes, 4, (sc) =>
        this.ado.scopePrs(org, sc).then((r) => r.list).catch((e) => {
          if (e.code === 'AUTH_REQUIRED') throw e;
          this.log.warn(`${org}: could not load ${sc.name || 'a watched project'} (${friendly(e)})`);
          return [];
        }));
      found.push(...lists.flat());
    }

    const byId = new Map();
    for (const pr of found) if (pr && pr.pullRequestId && pr.status !== 'completed' && pr.status !== 'abandoned') byId.set(pr.pullRequestId, pr);
    const ctx = { org, myId: meta.myId, groups: new Map(groups.map((g) => [g.id, g.name])), webBase: this.config.WEB_BASE };
    let items = [...byId.values()].map((pr) => logic.toItem(pr, ctx));
    if (watch) {
      for (const it of items) it.watched = watch.has(it);
      // "Only these repositories": your own PRs always stay.
      if (watch.only) items = items.filter((it) => it.mine || it.watched);
    }
    meta.counts = {
      prs: items.length,
      forYou: items.filter((it) => it.direct || it.team).length,
      viaTeams: items.filter((it) => it.team && !it.direct && !it.mine).length,
      mine: items.filter((it) => it.mine).length,
      teams: groups.length,
    };
    const summary = JSON.stringify(meta.counts);
    if (summary !== meta.logged) {
      meta.logged = summary;
      this.log.info(`${org}: ${items.length} active PRs (for you ${meta.counts.forYou}, yours ${meta.counts.mine}, teams ${groups.length}${watch ? `, watching ${watch.scopes.length}` : ''})`);
    }
    return items;
  }

  /**
   * Look through the organization's active PRs for ones that ask for your teams.
   * Done every refresh, except in very big organizations (every 10 minutes there;
   * in between, the teams found on PRs are asked for directly).
   */
  async scanTeams(org, meta, groupIds) {
    if (meta.scan && !meta.scan.complete && Date.now() - meta.scan.at < SCAN_EVERY_BIG) return null;
    let r;
    try {
      r = await this.ado.searchPrs(org, {}, SCAN_MAX);
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED') throw e;
      this.log.warn(`${org}: could not look for PRs for your teams (${friendly(e)})`);
      return null;
    }
    const hits = new Set();
    for (const pr of r.list) for (const rv of pr.reviewers || []) if (rv && groupIds.has(rv.id)) hits.add(rv.id);
    meta.teamHits = [...hits];
    if (!r.complete && !(meta.scan && !meta.scan.complete)) this.log.info(`${org}: more than ${SCAN_MAX} active PRs, team PRs are checked every 10 minutes`);
    meta.scan = { at: Date.now(), complete: r.complete };
    return r;
  }

  /** Projects and repositories to pick from in Settings. */
  async repoChoices(org) {
    if (!this.orgList().some((o) => o.name === org)) throw new HttpError(404, 'Unknown organization');
    const repos = await this.ado.repositories(org);
    const projects = new Map();
    for (const r of repos) {
      if (!projects.has(r.projectId)) projects.set(r.projectId, { id: r.projectId, name: r.project, repos: [] });
      projects.get(r.projectId).repos.push({ id: r.id, name: r.name });
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const list = [...projects.values()].sort(byName);
    for (const p of list) p.repos.sort(byName);
    const w = this.settings.repos[org];
    return { org, projects: list, pick: w ? w.pick : [], only: !!(w && w.only) };
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

  /** Comment threads on your own PRs: what waits for your answer, and new comments. */
  async loadComments(items) {
    const mine = items.filter((i) => i.mine);
    await mapLimit(mine, 4, async (it) => {
      const meta = this.orgMeta.get(it.org);
      if (!meta) return;
      try {
        it.comments = logic.summarizeThreads(await this.ado.threads(it), meta.myId);
      } catch (e) {
        if (e.code === 'AUTH_REQUIRED') throw e;
      }
    });
  }

  // ---- events, reviews, nudges ------------------------------------------------

  inWorkHours(now = Date.now()) {
    const d = new Date(now);
    const hour = d.getHours() + d.getMinutes() / 60;
    return d.getDay() !== 0 && d.getDay() !== 6 && hour >= this.settings.workStart && hour < this.settings.workEnd;
  }

  emit(e) {
    const evt = { id: ++this.state.seq, at: Date.now(), ...e };
    this.state.events.push(evt);
    if (this.state.events.length > 60) this.state.events.splice(0, this.state.events.length - 60);
    this.save();
    const quiet = this.settings.quietHours && !this.inWorkHours(evt.at);
    if (this.settings.desktopPopups && evt.title && !quiet && !this.suppressToast()) this.queueToast(evt);
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
    if (!s.nudges || !this.inWorkHours(now)) return null;
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

  /** Friday, near the end of the work day: a short recap of the week. */
  maybeRecap(now = Date.now()) {
    const s = this.settings;
    if (!s.nudges) return null;
    const d = new Date(now);
    const hour = d.getHours() + d.getMinutes() / 60;
    if (d.getDay() !== 5 || hour < Math.max(s.workStart, s.workEnd - 1.5)) return null;
    const r = logic.weekRecap(this.state.reviews, now);
    if (this.state.lastRecap === r.week) return null;
    this.state.lastRecap = r.week;
    this.save();
    if (!r.count) return null;
    const streak = this.stats(now).streak;
    return this.emit({
      type: 'recap',
      title: `Your week: ${r.count} review${r.count > 1 ? 's' : ''} 🎉`,
      body: [streak > 1 ? `${streak}-day streak` : null, r.bestCount > 1 ? `best day ${r.bestDay} (${r.bestCount})` : null].filter(Boolean).join(' · ') || 'Have a good weekend!',
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
      this.ado.threads(it).then(logic.threadDetails).catch(() => null),
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
    ['includeTeams', 'desktopPopups', 'nudges', 'useAzCli', 'quietHours', 'hotkey'].forEach(bool);
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
      // Team PRs that appear now aren't news.
      this.state.baselined = {};
      orgsChanged = true;
    }
    if (patch.setRepos && typeof patch.setRepos.org === 'string') {
      const { org, pick, only } = patch.setRepos;
      const clean = (Array.isArray(pick) ? pick : []).slice(0, 300).filter((p) => p && typeof p === 'object').map((p) => ({
        kind: p.kind === 'project' ? 'project' : 'repo',
        id: String(p.id || ''),
        name: String(p.name || '').slice(0, 200),
        projectId: String(p.projectId || p.id || ''),
        project: String(p.project || '').slice(0, 200),
      })).filter((p) => ID.test(p.id) && ID.test(p.projectId));
      const repos = { ...s.repos };
      if (clean.length) repos[org] = { pick: clean, only: !!only };
      else delete repos[org];
      s.repos = repos;
      // PRs that were already open in newly watched repositories aren't news.
      delete this.state.baselined[org];
      orgsChanged = true;
    }
    this.save();
    return { orgsChanged };
  }
}

module.exports = { Inbox, DEFAULT_SETTINGS, parseOrg };
