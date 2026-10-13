'use strict';
/**
 * Pure review logic: turning Azure DevOps PRs into a prioritised queue,
 * detecting what changed between polls and computing review stats.
 */

const HOUR = 36e5;
const VOTES = [10, 5, 0, -5, -10];
const FEEDBACK = { 10: 'approved', 5: 'approved with suggestions', [-5]: 'is waiting for you', [-10]: 'rejected' };

const shortRef = (ref) => String(ref || '').replace(/^refs\/heads\//, '');
const cleanName = (name) => String(name || '').replace(/^\[[^\]]*\]\\/, '');

function webUrl(base, org, project, repo, id) {
  const e = encodeURIComponent;
  return `${base}/${e(org)}/${e(project)}/_git/${e(repo)}/pullrequest/${id}`;
}

/** Normalise an Azure DevOps PR into the shape the app works with. */
function toItem(pr, ctx) {
  const reviewers = (pr.reviewers || []).map((r) => ({
    id: r.id,
    name: cleanName(r.displayName),
    vote: Number(r.vote) || 0,
    required: !!r.isRequired,
    team: !!r.isContainer,
    declined: !!r.hasDeclined,
    me: !!ctx.myId && r.id === ctx.myId,
  }));
  const me = reviewers.find((r) => r.me);
  const teams = reviewers.filter((r) => ctx.groups && ctx.groups.has(r.id));
  const repo = pr.repository || {};
  const project = repo.project || {};
  const author = pr.createdBy || {};
  return {
    key: `${ctx.org}#${pr.pullRequestId}`,
    org: ctx.org,
    id: pr.pullRequestId,
    title: String(pr.title || `Pull request ${pr.pullRequestId}`),
    description: String(pr.description || '').slice(0, 800),
    project: project.name || '',
    projectId: project.id || project.name || '',
    repo: repo.name || '',
    repoId: repo.id || '',
    author: { id: author.id || '', name: author.displayName || 'Unknown' },
    created: pr.creationDate || new Date().toISOString(),
    draft: !!pr.isDraft,
    conflicts: pr.mergeStatus === 'conflicts',
    source: shortRef(pr.sourceRefName),
    target: shortRef(pr.targetRefName),
    commit: (pr.lastMergeSourceCommit && pr.lastMergeSourceCommit.commitId) || null,
    labels: (pr.labels || []).filter((l) => l && l.active !== false && l.name).map((l) => l.name).slice(0, 4),
    reviewers,
    myVote: me ? me.vote : 0,
    declined: !!(me && me.declined),
    direct: !!me,
    required: !!((me && me.required) || teams.some((t) => t.required)),
    team: teams.length ? teams[0].name : null,
    teamVote: teams.reduce((v, t) => (Math.abs(t.vote) > Math.abs(v) ? t.vote : v), 0),
    mine: !!ctx.myId && author.id === ctx.myId,
    url: webUrl(ctx.webBase, ctx.org, project.name || '', repo.name || '', pr.pullRequestId),
  };
}

/**
 * Where a PR belongs:
 *  todo    - needs your review (never voted, or new pushes since you voted)
 *  waiting - you asked for changes, ball is in the author's court
 *  done    - you approved (or your team already covered it)
 *  mine    - you created it
 *  draft   - not ready yet
 */
function classify(item, snap) {
  if (item.mine) return { state: 'mine', updated: false };
  if (item.declined) return { state: 'hidden', updated: false };
  if (item.draft) return { state: 'draft', updated: false };
  if (item.myVote === 0 && !item.direct && item.teamVote !== 0) {
    return { state: item.teamVote < 0 ? 'waiting' : 'done', updated: false, covered: true };
  }
  const changedSinceVote = item.myVote !== 0 && !!(snap && snap.votedCommit) && !!item.commit && snap.votedCommit !== item.commit;
  if (item.myVote === 0 || changedSinceVote) {
    return { state: 'todo', updated: changedSinceVote || !!(snap && snap.resetByPush) };
  }
  return { state: item.myVote < 0 ? 'waiting' : 'done', updated: false };
}

function sizeInfo(files) {
  const n = files.length;
  const label = n <= 2 ? 'XS' : n <= 5 ? 'S' : n <= 15 ? 'M' : n <= 40 ? 'L' : 'XL';
  const counts = {};
  for (const f of files) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(f.path || '');
    const ext = m ? m[1].toLowerCase() : null;
    if (ext) counts[ext] = (counts[ext] || 0) + 1;
  }
  const exts = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
  return { files: n, label, exts };
}

/** Rough review time in minutes, for "quick win" hints. */
function estimate(size, updated) {
  if (!size) return null;
  const m = Math.min(60, 2 + size.files * 1.5) * (updated ? 0.5 : 1);
  return Math.max(2, Math.round(m));
}

/** Priority score: higher = review first. Returns short reason tags for the UI. */
function score(item, now = Date.now()) {
  if (item.state !== 'todo') return { score: 0, reasons: [] };
  const reasons = [];
  const ageH = Math.max(0, (now - Date.parse(item.created)) / HOUR);
  let s = Math.min(40, ageH / 2);
  if (item.required) { s += 30; reasons.push('required'); }
  if (item.updated) { s += 25; reasons.push('updated'); }
  if (item.direct) s += 10;
  if (item.size) {
    const f = item.size.files;
    s += f <= 2 ? 20 : f <= 5 ? 14 : f <= 15 ? 6 : f <= 40 ? 0 : -10;
    if (f <= 5) reasons.push('quick');
  }
  if (item.conflicts) s -= 15;
  if (ageH >= 48) reasons.push('old');
  return { score: Math.round(s), reasons };
}

function event(type, it, extra = {}) {
  const base = { type, key: it.key, org: it.org, prTitle: it.title, url: it.url };
  if (type === 'new') return { ...base, title: 'New review request', body: `${it.title} · ${it.author.name}`, ...extra };
  if (type === 'updated') return { ...base, title: 'Updated since your review', body: it.title, ...extra };
  return { ...base, ...extra };
}

/**
 * Compare the previous snapshot with fresh items.
 * Returns the new snapshot, notification events and reviews you did (votes seen).
 */
function diff(prev, items, { now = Date.now(), baselineOrgs = new Set(), knownOrgs = new Set() } = {}) {
  const snapshot = {};
  const events = [];
  const reviews = [];
  for (const it of items) {
    const p = prev[it.key];
    const s = {
      state: null,
      myVote: it.myVote,
      commit: it.commit,
      votedCommit: (p && p.votedCommit) || null,
      resetByPush: !!(p && p.resetByPush),
    };
    if (it.mine) s.votes = Object.fromEntries(it.reviewers.filter((r) => !r.team).map((r) => [r.id, r.vote]));
    const fresh = !baselineOrgs.has(it.org);

    if (!p) {
      if (it.myVote !== 0) {
        s.votedCommit = it.commit;
        if (fresh && !it.mine) reviews.push({ key: it.key, org: it.org, title: it.title, vote: it.myVote, at: now });
      }
    } else if (it.myVote !== p.myVote) {
      if (it.myVote !== 0) {
        s.votedCommit = it.commit;
        s.resetByPush = false;
        if (!it.mine) reviews.push({ key: it.key, org: it.org, title: it.title, vote: it.myVote, at: now });
      } else if (it.commit !== p.commit) {
        s.resetByPush = true; // branch policy reset your vote after a new push
      }
    }

    const c = classify(it, s);
    s.state = c.state;
    if (!p) {
      if (fresh && c.state === 'todo') events.push(event('new', it));
    } else {
      if (c.state === 'todo' && p.state === 'draft') events.push(event('new', it));
      else if (c.state === 'todo' && c.updated && p.state !== 'todo') events.push(event('updated', it));
      if (it.mine && p.votes) {
        for (const r of it.reviewers) {
          if (r.team || r.vote === 0 || r.vote === (p.votes[r.id] || 0)) continue;
          events.push(event('feedback', it, { title: `${r.name || 'Someone'} ${FEEDBACK[r.vote] || 'voted'}`, body: it.title, vote: r.vote }));
        }
      }
    }
    snapshot[it.key] = s;
  }
  // Keep what we knew about orgs that failed to load this round.
  for (const [k, v] of Object.entries(prev)) {
    if (!snapshot[k] && !knownOrgs.has(k.slice(0, k.lastIndexOf('#')))) snapshot[k] = v;
  }
  return { snapshot, events, reviews };
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** Today's count, last 7 days and a weekday streak (weekends never break it). */
function stats(reviews, now = Date.now(), goal = 5) {
  const perDay = new Map();
  for (const r of reviews) {
    const k = dayKey(r.at);
    if (!perDay.has(k)) perDay.set(k, new Set());
    perDay.get(k).add(r.key);
  }
  const count = (t) => (perDay.get(dayKey(t)) || new Set()).size;
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);

  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(noon);
    d.setDate(d.getDate() - i);
    week.push({ day: d.getDay(), count: count(d.getTime()) });
  }

  let streak = 0;
  const d = new Date(noon);
  if (count(d.getTime()) === 0) d.setDate(d.getDate() - 1);
  for (let guard = 0; guard < 800; guard++) {
    const c = count(d.getTime());
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    if (c > 0) streak++;
    else if (!weekend) break;
    d.setDate(d.getDate() - 1);
  }

  const today = count(now);
  return {
    today,
    goal,
    week,
    weekTotal: week.reduce((a, b) => a + b.count, 0),
    streak,
    total: reviews.length,
  };
}

module.exports = { VOTES, toItem, classify, sizeInfo, estimate, score, diff, stats, shortRef, cleanName, webUrl };
