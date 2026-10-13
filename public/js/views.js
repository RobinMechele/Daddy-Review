import { esc, icon, fmtAge, fmtMinutes, initials, hue, firstName, greeting, VOTE_META } from './util.js';

const SIZE_TITLE = { XS: '1–2 files', S: '3–5 files', M: '6–15 files', L: '16–40 files', XL: '40+ files' };
const REASON = { required: 'Required', updated: 'Updated', quick: 'Quick win', old: 'Waiting long' };
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export const avatar = (name, cls = '') =>
  `<span class="avatar ${cls}" style="--h:${hue(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;

const chip = (html, cls = '', title = '') => `<span class="chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${html}</span>`;

const mascot = (cls = '') => `<span class="mascot ${cls}" aria-hidden="true"><i></i><i></i><b></b></span>`;

export function logo() {
  return `<span class="logo">${mascot('sm')}<span class="logo-text">Daddy<b>Review</b></span></span>`;
}

// ---- small building blocks ---------------------------------------------------------

export function goalRing(stats, size = 64) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const p = Math.min(1, stats.today / Math.max(1, stats.goal));
  const done = stats.today >= stats.goal;
  return `<div class="goal ${done ? 'goal-done' : ''}" style="--size:${size}px" title="${stats.today} of ${stats.goal} reviews today">
    <svg viewBox="0 0 64 64"><circle class="goal-bg" cx="32" cy="32" r="${r}"/>
      <circle class="goal-fg" cx="32" cy="32" r="${r}" stroke-dasharray="${(p * c).toFixed(1)} ${c.toFixed(1)}"/></svg>
    <div class="goal-num">${done ? icon('check') : `<b>${stats.today}</b><span>/${stats.goal}</span>`}</div>
  </div>`;
}

function weekBars(stats) {
  const max = Math.max(stats.goal, ...stats.week.map((d) => d.count), 1);
  return `<div class="week" title="Reviews, last 7 days">${stats.week.map((d, i) => `
    <div class="bar ${i === 6 ? 'today' : ''}" title="${d.count} review${d.count === 1 ? '' : 's'}">
      <i style="height:${Math.max(6, (d.count / max) * 100)}%" class="${d.count ? '' : 'zero'}"></i><span>${DAYS[d.day]}</span>
    </div>`).join('')}</div>`;
}

function chipsFor(it) {
  const out = [];
  if (it.updated) out.push(chip(`${icon('spark')}Updated`, 'accent', 'New changes since your review'));
  if (it.required) out.push(chip('Required', 'warn', 'You (or your team) are a required reviewer'));
  if (it.team && !it.direct) out.push(chip(`${icon('users')}${esc(it.team)}`, '', 'Assigned to your team'));
  if (it.covered) out.push(chip('Team covered', 'muted', 'A teammate already voted for your team'));
  if (it.conflicts) out.push(chip(`${icon('alert')}Conflicts`, 'bad', 'Merge conflicts, the author has to fix these first'));
  for (const l of it.labels || []) out.push(chip(esc(l), 'label'));
  return out.join('');
}

function reviewersMini(it) {
  const people = it.reviewers.filter((r) => !r.team && !r.me).slice(0, 5);
  return `<span class="stack">${people.map((r) => {
    const v = VOTE_META[r.vote] || VOTE_META[0];
    return `<span class="stack-item" title="${esc(r.name)}: ${esc(v.label)}">${avatar(r.name, 'xs')}${r.vote ? `<i class="vdot v-${v.cls}">${icon(v.icon)}</i>` : ''}</span>`;
  }).join('')}</span>`;
}

function mineStatus(it) {
  const people = it.reviewers.filter((r) => !r.team);
  const ok = people.filter((r) => r.vote >= 5).length;
  const blocked = people.some((r) => r.vote < 0);
  const requiredOk = it.reviewers.filter((r) => r.required).every((r) => r.vote >= 5);
  const ready = ok > 0 && requiredOk && !blocked && !it.conflicts;
  return { ok, total: people.length, blocked, ready };
}

function lead(it) {
  if (it.state === 'mine') {
    const m = mineStatus(it);
    const cls = m.ready ? 'l-ready' : m.blocked ? 'l-blocked' : 'l-pending';
    const title = m.ready ? 'Ready to complete' : m.blocked ? 'Changes requested' : 'Waiting for reviewers';
    return `<div class="lead ${cls}" title="${title}">${icon(m.ready ? 'check' : m.blocked ? 'pause' : 'clock')}<small>${m.ok}/${m.total}</small></div>`;
  }
  if (it.state === 'waiting' || it.state === 'done') {
    const v = VOTE_META[it.covered ? it.teamVote : it.myVote] || VOTE_META[0];
    return `<div class="lead v-${v.cls}" title="${esc(it.covered ? `Team: ${v.label}` : v.label)}">${icon(it.covered ? 'users' : v.icon)}</div>`;
  }
  if (it.state === 'draft') return `<div class="lead s-none" title="Draft">${icon('pr')}</div>`;
  if (!it.size) return `<div class="lead s-none" title="Size unknown">${icon('pr')}</div>`;
  return `<div class="lead s-${it.size.label}" title="${it.size.files} file${it.size.files === 1 ? '' : 's'} · ${SIZE_TITLE[it.size.label]}">
    <b>${it.size.label}</b>${it.minutes ? `<small>~${it.minutes}m</small>` : ''}</div>`;
}

function menu(it) {
  const v = (vote, cls = '') => {
    const m = VOTE_META[vote];
    return `<button class="menu-item ${cls} ${it.myVote === vote && vote !== 0 ? 'current' : ''}" data-act="vote" data-key="${esc(it.key)}" data-vote="${vote}">${icon(m.icon)}${m.act}</button>`;
  };
  const sn = (h, label) => `<button class="menu-item" data-act="snooze" data-key="${esc(it.key)}" data-h="${h}">${icon('snooze')}${label}</button>`;
  return `<div class="menu" role="menu">
    ${v(10)}${v(5)}${v(-5)}${v(-10, 'danger')}
    ${it.myVote !== 0 ? v(0) : ''}
    <hr>
    ${it.snoozedUntil ? `<button class="menu-item" data-act="unsnooze" data-key="${esc(it.key)}">${icon('undo')}Unsnooze</button>` : `${sn(1, 'Snooze 1 hour')}${sn(4, 'Snooze 4 hours')}${sn('tomorrow', 'Snooze until tomorrow')}`}
  </div>`;
}

function details(it, d) {
  if (!d || d === 'loading') return '<div class="details"><div class="skeleton line"></div><div class="skeleton line short"></div></div>';
  if (d === 'error') return '<div class="details"><p class="muted">Couldn\'t load details.</p></div>';
  const files = d.files || [];
  const desc = (d.description || '').trim();
  const people = it.reviewers.filter((r) => !r.me);
  return `<div class="details">
    <div class="branch">${icon('branch')}<code>${esc(it.source)}</code>${icon('arrow')}<code>${esc(it.target)}</code><span class="muted">· ${esc(it.project)} · ${esc(it.org)}</span></div>
    ${desc ? `<p class="desc">${esc(desc.length > 420 ? `${desc.slice(0, 420)}…` : desc)}</p>` : ''}
    <div class="detail-grid">
      <div><h4>${icon('file')}Files <span>${d.fileCount ?? '?'}</span></h4>
        <ul class="files">${files.slice(0, 8).map((f) => {
          const parts = f.path.split('/');
          const name = parts.pop();
          return `<li title="${esc(f.path)}"><span class="ct ct-${esc(f.type.split(',')[0].trim())}"></span><span class="fdir">${esc(parts.slice(-2).join('/'))}/</span>${esc(name)}</li>`;
        }).join('')}${files.length > 8 ? `<li class="muted">+${files.length - 8} more</li>` : ''}</ul></div>
      <div><h4>${icon('chat')}Comments <span>${d.threads ? `${d.threads.active} open` : '?'}</span></h4>
        ${d.threads && d.threads.latest.length ? `<ul class="threads">${d.threads.latest.map((t) => `<li>${avatar(t.by, 'xs')}<div><b>${esc(t.by)}</b>${t.file ? `<small>${esc(t.file.split('/').pop())}</small>` : ''}<p>${esc(t.text)}</p></div></li>`).join('')}</ul>` : '<p class="muted small">No open comments</p>'}
      </div>
      <div><h4>${icon('users')}Reviewers</h4>
        <ul class="people">${people.map((r) => {
          const v = VOTE_META[r.vote] || VOTE_META[0];
          return `<li>${avatar(r.name, 'xs')}<span>${esc(r.name)}</span>${r.required ? '<em>req</em>' : ''}<i class="v-${v.cls}" title="${esc(v.label)}">${r.vote ? icon(v.icon) : ''}</i></li>`;
        }).join('') || '<li class="muted">Only you</li>'}</ul>
      </div>
    </div>
  </div>`;
}

export function card(it, S) {
  const k = esc(it.key);
  const busy = S.busy.has(it.key);
  const who = it.state === 'mine' ? reviewersMini(it) : `${avatar(it.author.name, 'xs')}<span class="who">${esc(it.author.name)}</span>`;
  const meta = [who, `<span class="repo">${esc(it.repo)}</span>`, `<span title="${esc(new Date(it.created).toLocaleString())}">${fmtAge(it.ageH)}</span>`];
  const canVote = it.state !== 'mine';
  const actions = [
    `<button class="icon-btn" data-act="open" data-key="${k}" title="Open in Azure DevOps (O)">${icon('open')}</button>`,
    it.state === 'todo' ? `<button class="icon-btn ok" data-act="vote" data-vote="10" data-key="${k}" title="Approve (A)">${icon('check')}</button>` : '',
    canVote ? `<button class="icon-btn" data-act="menu" data-key="${k}" title="More">${icon('more')}</button>` : '',
  ].join('');
  return `<article class="card ${S.seen && !S.seen.has(it.key) ? 'fresh' : ''} ${S.selectedKey === it.key ? 'selected' : ''} ${S.expanded === it.key ? 'expanded' : ''} ${busy ? 'busy' : ''} st-${it.state}" data-key="${k}">
    <div class="card-row" data-act="expand" data-key="${k}">
      ${lead(it)}
      <div class="card-body">
        <div class="card-title">${esc(it.title)}</div>
        <div class="card-meta">${meta.join('<span class="sep">·</span>')}${chipsFor(it)}</div>
      </div>
      <div class="card-actions">${busy ? '<span class="spinner"></span>' : actions}</div>
    </div>
    ${S.menu === it.key ? menu(it) : ''}
    ${S.expanded === it.key ? details(it, S.details[it.key]) : ''}
  </article>`;
}

// ---- page sections -----------------------------------------------------------------

export function topbar(S) {
  const d = S.data;
  const name = d.profile?.name || d.auth.user?.name || '';
  return `<header class="topbar">
    ${logo()}
    ${d.app.demo ? '<span class="pill demo" title="Fake Azure DevOps data">Demo</span>' : ''}
    <div class="top-actions">
      <button class="icon-btn ${d.inbox.polling || S.refreshing ? 'spin' : ''}" data-act="refresh" title="Refresh (R)">${icon('refresh')}</button>
      <button class="icon-btn" data-act="pip" title="Mini window, always on top">${icon('pip')}</button>
      <button class="icon-btn" data-act="settings" title="Settings">${icon('sliders')}</button>
      ${name ? `<button class="avatar-btn" data-act="settings" title="${esc(name)}">${avatar(name, 'sm')}</button>` : ''}
    </div>
  </header>`;
}

export function hero(S) {
  const { inbox, stats } = S.data;
  const next = nextItem(S);
  const stat = (ic, val, label, title) => `<div class="stat" title="${esc(title)}">${icon(ic)}<b>${val}</b><span>${label}</span></div>`;
  const stats4 = `<div class="hero-stats">
      ${goalRing(stats, 76)}
      <div class="stat-grid">
        ${stat('flame', stats.streak, 'streak', 'Workdays in a row with at least one review')}
        ${stat('inbox', inbox.counts.todo, 'to do', 'Waiting for your review')}
        ${stat('clock', inbox.counts.todo ? fmtAge(inbox.oldestH) : '–', 'oldest', 'Longest waiting PR')}
        ${stat('timer', inbox.minutesTotal ? fmtMinutes(inbox.minutesTotal).replace(' min', 'm') : '–', 'to clear', 'Estimated time to clear your queue')}
      </div>
      ${weekBars(stats)}
    </div>`;
  if (!next) {
    const firstLoad = !inbox.fetchedAt;
    return `<section class="hero">${stats4}
      <div class="next empty">
        ${firstLoad ? '<div class="skeleton line"></div><div class="skeleton line short"></div>' : `
        <div class="zero">${mascot('happy')}</div>
        <div><div class="next-title">All clear</div>
        <p class="muted">${stats.today ? `${stats.today} review${stats.today > 1 ? 's' : ''} today. Nice work.` : 'Nothing waiting for you.'}</p></div>`}
      </div></section>`;
  }
  const why = next.reasons.map((r) => chip(REASON[r] || r, r === 'quick' ? 'ok' : r === 'updated' ? 'accent' : r === 'required' ? 'warn' : '')).join('');
  return `<section class="hero">${stats4}
    <div class="next">
      <div class="next-label">${icon('target')}Next up</div>
      <div class="next-title" title="${esc(next.title)}">${esc(next.title)}</div>
      <div class="next-meta">${avatar(next.author.name, 'xs')}${esc(next.author.name)}<span class="sep">·</span>${esc(next.repo)}<span class="sep">·</span>${fmtAge(next.ageH)}
        ${next.size ? `<span class="sep">·</span><span class="size-pill s-${next.size.label}">${next.size.label}</span>` : ''}${next.minutes ? `<span class="muted">~${next.minutes} min</span>` : ''}</div>
      ${why ? `<div class="next-why">${why}</div>` : ''}
      <div class="next-actions">
        <button class="btn primary" data-act="review" data-key="${esc(next.key)}">Review now ${icon('arrow')}</button>
        <button class="btn ghost" data-act="vote" data-vote="10" data-key="${esc(next.key)}" title="Approve without opening">${icon('check')}</button>
        <button class="btn ghost" data-act="skip" data-key="${esc(next.key)}" title="Show another one (N)">${icon('skip')}Skip</button>
      </div>
    </div>
  </section>`;
}

export function setupStrip(S) {
  if (S.setupDismissed) return '';
  const items = [];
  if (!S.native && 'Notification' in window && Notification.permission === 'default') items.push(`<button class="setup-item" data-act="notify-perm">${icon('bell')}Turn on popups</button>`);
  if (S.autostart && !S.autostart.enabled && !S.data.app.demo) items.push(`<button class="setup-item" data-act="autostart">${icon('power')}Start with ${S.data.app.platform === 'win32' ? 'Windows' : 'login'}</button>`);
  if (!items.length) return '';
  return `<div class="setup">${items.join('')}<button class="icon-btn sm" data-act="setup-dismiss" title="Hide">${icon('x')}</button></div>`;
}

export function tabs(S) {
  const c = S.data.inbox.counts;
  const t = (id, label, n, hot) => `<button class="tab ${S.tab === id ? 'active' : ''}" data-act="tab" data-tab="${id}">${label}${n ? `<span class="count ${hot ? 'hot' : ''}">${n}</span>` : ''}</button>`;
  return `<nav class="tabs" role="tablist">
    ${t('todo', 'To review', c.todo, true)}${t('waiting', 'Waiting', c.waiting)}${t('mine', 'Mine', c.mine)}${t('done', 'Done', c.done)}
  </nav>`;
}

export function visibleItems(S) {
  const items = S.data.inbox.items;
  if (S.tab === 'todo') return items.filter((i) => i.state === 'todo' && !i.snoozedUntil);
  const list = items.filter((i) => i.state === S.tab);
  return list.sort((a, b) => (S.tab === 'waiting' ? b.ageH - a.ageH : a.ageH - b.ageH));
}

export function list(S) {
  const { inbox } = S.data;
  if (!inbox.fetchedAt) {
    return `<div class="cards">${'<div class="card skeleton-card"><div class="skeleton block"></div><div><div class="skeleton line"></div><div class="skeleton line short"></div></div></div>'.repeat(4)}</div>`;
  }
  if (!S.data.orgs.length) {
    return `<div class="empty-state onboard">${mascot()}<h3>Which organization?</h3>
      <p>I couldn't find your Azure DevOps organizations automatically.</p>
      <form class="add-org" data-form="add-org"><input name="org" placeholder="dev.azure.com/your-org" autocomplete="off" spellcheck="false" autofocus><button class="btn primary sm">${icon('plus')}Add</button></form></div>`;
  }
  const items = visibleItems(S);
  let html = items.map((i) => card(i, S)).join('');
  if (S.tab === 'todo') {
    const snoozed = inbox.items.filter((i) => i.state === 'todo' && i.snoozedUntil);
    const drafts = inbox.items.filter((i) => i.state === 'draft');
    if (snoozed.length) html += `<details class="group"><summary>${icon('snooze')}Snoozed <span>${snoozed.length}</span></summary>${snoozed.map((i) => card(i, S)).join('')}</details>`;
    if (drafts.length) html += `<details class="group"><summary>${icon('pr')}Drafts <span>${drafts.length}</span></summary>${drafts.map((i) => card(i, S)).join('')}</details>`;
  }
  if (!items.length) {
    const empty = {
      todo: ['Inbox zero', 'Go grab a coffee, you earned it.'],
      waiting: ['No one to wait for', 'PRs where you asked for changes show up here.'],
      mine: ['No open PRs from you', 'Your own PRs and their votes show up here.'],
      done: ['Nothing here yet', 'PRs you approved stay here until they\'re merged.'],
    }[S.tab];
    html = `<div class="empty-state">${mascot(S.tab === 'todo' ? 'happy' : '')}<h3>${empty[0]}</h3><p>${empty[1]}</p></div>${html}`;
  }
  const errs = Object.entries(inbox.errors || {});
  const banner = inbox.error ? `<div class="banner bad">${icon('alert')}${esc(inbox.error)}</div>`
    : errs.length ? `<div class="banner warn" data-act="settings">${icon('alert')}${esc(errs[0][0])}: ${esc(errs[0][1])}${errs.length > 1 ? ` (+${errs.length - 1})` : ''}</div>` : '';
  return `${banner}<div class="cards">${html}</div>`;
}

export function nextItem(S) {
  const todo = S.data.inbox.items.filter((i) => i.state === 'todo' && !i.snoozedUntil);
  return todo.find((i) => !S.skipped.has(i.key)) || (S.skipped.size && todo.length ? (S.skipped.clear(), todo[0]) : null);
}

// ---- sign-in / offline ---------------------------------------------------------------

export function signin(S) {
  const a = S.data.auth;
  // Never block the button on the (slow on Windows) Azure CLI check; it runs alongside.
  const busy = S.signingIn;
  return `<div class="center-screen">
    <div class="signin-card">
      ${mascot('xl')}
      <h1>Daddy Review</h1>
      <p class="tagline">Your pull request sidekick for Azure DevOps</p>
      <button class="btn ms" data-act="signin" ${busy ? 'disabled' : ''}>
        ${busy ? '<span class="spinner"></span>' : icon('ms', 'ms-logo')}${S.signingIn ? (S.native ? 'Finish in your browser…' : 'Finish signing in…') : 'Sign in with Microsoft'}
      </button>
      ${S.signingIn ? `<button class="link" data-act="signin-cancel">Cancel</button>${S.native ? '<button class="link" data-act="signin">Open the browser again</button>' : ''}` : ''}
      ${a.error ? `<p class="error">${esc(a.error)}</p>` : ''}
      ${S.signinError ? `<p class="error">${esc(S.signinError)}</p>` : ''}
      <p class="hint">${a.checking && !S.signingIn ? '<span class="spinner"></span>Looking for an Azure CLI login…' : `${icon('shield')}${S.native ? 'Opens your browser to sign in. No PAT needed.' : 'No PAT. Your work account, stays on this PC.'}`}</p>
      ${S.data.settings.useAzCli === false ? '<button class="link" data-act="use-azcli">Use Azure CLI login instead</button>' : ''}
    </div>
    <ul class="features">
      <li>${icon('bell')}<span>Popups for new PRs</span></li>
      <li>${icon('target')}<span>Quick wins first</span></li>
      <li>${icon('flame')}<span>Daily goal & streak</span></li>
    </ul>
  </div>`;
}

export function offline() {
  return `<div class="center-screen">
    <div class="signin-card">
      ${mascot('xl sleepy')}
      <h1>Daddy is napping</h1>
      <p class="tagline">The Daddy Review service isn't running on this PC.</p>
      <div class="howto"><span>Start it with</span><code>npm run web</code></div>
      <p class="hint"><span class="spinner"></span>Reconnecting…</p>
    </div>
  </div>`;
}

// ---- settings drawer ------------------------------------------------------------------

const sw = (on, attrs) => `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" ${attrs}><i></i></button>`;

export function drawer(S) {
  if (!S.settingsOpen) return '';
  const d = S.data;
  const st = d.settings;
  const name = d.profile?.name || d.auth.user?.name || 'You';
  const email = d.profile?.email || d.auth.user?.email || '';
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const hours = (sel, key) => `<select data-change="${key}" aria-label="${key}">${Array.from({ length: 25 }, (_, h) => h)
    .filter((h) => (key === 'workStart' ? h < 24 : h > 0))
    .map((h) => `<option value="${h}" ${sel === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>`;
  return `<div class="overlay" data-act="close-settings"></div>
  <aside class="drawer" role="dialog" aria-label="Settings">
    <header><h2>Settings</h2><button class="icon-btn" data-act="close-settings" title="Close (Esc)">${icon('x')}</button></header>
    <section class="account">
      ${avatar(name, 'lg')}
      <div class="grow"><b>${esc(name)}</b><small>${esc(email)}</small><span class="pill">${d.auth.method === 'azcli' ? 'Azure CLI' : d.app.demo ? 'Demo account' : 'Microsoft account'}</span></div>
      <button class="btn ghost sm" data-act="signout">${icon('logout')}Sign out</button>
    </section>

    <section>
      <h3>Organizations</h3>
      ${d.orgs.map((o) => `<div class="row">
        <span class="grow">${esc(o.name)}${o.error ? `<small class="err">${esc(o.error)}</small>` : ''}</span>
        ${o.manual ? `<button class="icon-btn sm" data-act="remove-org" data-org="${esc(o.name)}" title="Remove">${icon('trash')}</button>` : ''}
        ${sw(o.enabled, `data-act="org" data-org="${esc(o.name)}" aria-label="${esc(o.name)}"`)}
      </div>`).join('') || '<p class="muted small">No organizations found yet.</p>'}
      <form class="add-org" data-form="add-org"><input name="org" placeholder="Add org name or URL" autocomplete="off" spellcheck="false"><button class="btn sm">${icon('plus')}Add</button></form>
      ${d.inbox.discoverError ? '<p class="small muted">Couldn\'t list your organizations automatically. Add yours above.</p>' : ''}
    </section>

    <section>
      <h3>Daily goal</h3>
      <div class="row"><span class="grow">Reviews per day</span>
        <div class="stepper"><button data-act="goal" data-d="-1" aria-label="Less">−</button><b>${st.dailyGoal}</b><button data-act="goal" data-d="1" aria-label="More">+</button></div></div>
    </section>

    <section>
      <h3>Popups</h3>
      <div class="row"><span class="grow">Desktop popups<small>${perm === 'denied' ? 'Blocked in browser settings' : perm === 'default' ? 'Needs your permission' : 'New PRs, updates, feedback'}</small></span>
        ${perm === 'default' ? `<button class="btn sm" data-act="notify-perm">Allow</button>` : ''}
        ${sw(st.desktopPopups, 'data-act="toggle" data-setting="desktopPopups" aria-label="Desktop popups"')}</div>
      <div class="row"><span class="grow">Nudges<small>Reminder when PRs wait too long</small></span>${sw(st.nudges, 'data-act="toggle" data-setting="nudges" aria-label="Nudges"')}</div>
      ${st.nudges ? `<div class="row sub"><span class="grow">Work hours</span>${hours(st.workStart, 'workStart')}<span class="muted">–</span>${hours(st.workEnd, 'workEnd')}</div>` : ''}
      <div class="row"><span class="grow">Team reviews<small>PRs assigned to your teams</small></span>${sw(st.includeTeams, 'data-act="toggle" data-setting="includeTeams" aria-label="Team reviews"')}</div>
      <div class="row"><span class="grow">Check every</span><select data-change="pollMinutes" aria-label="Refresh interval">${[1, 2, 3, 5, 10, 15].map((m) => `<option value="${m}" ${st.pollMinutes === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></div>
    </section>

    <section>
      <h3>App</h3>
      ${S.autostart && !d.app.demo ? `<div class="row"><span class="grow">Start with ${d.app.platform === 'win32' ? 'Windows' : 'login'}<small>Runs quietly in the background</small></span>${sw(S.autostart.enabled, 'data-act="autostart" aria-label="Start at login"')}</div>` : ''}
      <div class="row"><span class="grow">Theme</span><div class="seg">${['auto', 'light', 'dark'].map((t) => `<button class="${S.theme === t ? 'on' : ''}" data-act="theme" data-theme="${t}" title="${t}">${icon(t === 'auto' ? 'monitor' : t === 'light' ? 'sun' : 'moon')}</button>`).join('')}</div></div>
    </section>
    <footer><span>v${esc(d.app.version)}</span><button class="link" data-act="shortcuts">${icon('keyboard')}Shortcuts</button></footer>
  </aside>`;
}

export function shortcuts(S) {
  if (!S.shortcuts) return '';
  const k = [['J / K', 'Move'], ['Enter', 'Details'], ['O', 'Open in Azure DevOps'], ['A', 'Approve'], ['W', 'Wait for author'], ['S', 'Snooze 1h'], ['N', 'Review next'], ['R', 'Refresh'], ['1–4', 'Tabs'], ['P', 'Mini window'], ['Esc', 'Close']];
  return `<div class="overlay" data-act="shortcuts"></div><div class="modal" role="dialog" aria-label="Keyboard shortcuts"><h2>${icon('keyboard')}Shortcuts</h2>
    <dl>${k.map(([a, b]) => `<dt><kbd>${a}</kbd></dt><dd>${b}</dd>`).join('')}</dl></div>`;
}

// ---- assistant ---------------------------------------------------------------------

export function assistant(S) {
  const d = S.data;
  const todo = d.inbox.counts.todo;
  const next = nextItem(S);
  const session = S.session;
  const sessItem = session && d.inbox.items.find((i) => i.key === session.key);
  let body = '';

  if (S.assistantOpen) {
    if (session && sessItem) {
      const mins = Math.max(1, Math.round((Date.now() - session.at) / 60000));
      if (sessItem.state !== 'todo') {
        const v = VOTE_META[sessItem.myVote] || VOTE_META[0];
        body = `<div class="as-head">${mascot('happy sm')}<div><b>Nice, that's done</b><small>${esc(v.label)} · ${mins} min</small></div></div>
          ${next ? miniNext(next, 'Next up') : '<p class="as-empty">That was the last one 🎉</p>'}
          <div class="as-actions">${next ? `<button class="btn primary sm" data-act="review" data-key="${esc(next.key)}">Next ${icon('arrow')}</button>` : ''}<button class="btn ghost sm" data-act="session-end">Close</button></div>`;
      } else {
        body = `<div class="as-head">${mascot('sm')}<div><b>How did it go?</b><small>${mins} min on</small></div></div>
          <div class="as-pr">${esc(sessItem.title)}</div>
          <div class="vote-grid">
            ${[10, 5, -5, -10].map((v) => `<button class="vote-btn v-${VOTE_META[v].cls}" data-act="session-vote" data-vote="${v}" data-key="${esc(sessItem.key)}">${icon(VOTE_META[v].icon)}<span>${VOTE_META[v].short}</span></button>`).join('')}
          </div>
          <div class="as-actions"><button class="btn ghost sm" data-act="session-end">Still reviewing</button><button class="btn ghost sm" data-act="snooze" data-key="${esc(sessItem.key)}" data-h="1">${icon('snooze')}Later</button></div>`;
      }
    } else {
      const name = firstName(d.profile?.name || d.auth.user?.name);
      body = `<div class="as-head">${mascot(todo ? 'sm' : 'happy sm')}<div><b>${greeting()}${name ? `, ${esc(name)}` : ''}</b>
        <small>${todo ? `${todo} waiting${d.inbox.minutesTotal ? ` · ~${fmtMinutes(d.inbox.minutesTotal)}` : ''}` : 'Nothing waiting. Enjoy.'}</small></div></div>
        ${next ? miniNext(next, 'Next up') : ''}
        <div class="as-actions">
          ${next ? `<button class="btn primary sm" data-act="review" data-key="${esc(next.key)}">Review ${icon('arrow')}</button><button class="btn ghost sm" data-act="skip" data-key="${esc(next.key)}">${icon('skip')}Skip</button>` : ''}
          <button class="btn ghost sm" data-act="pip" title="Always-on-top mini window">${icon('pip')}Pop out</button>
        </div>`;
    }
  }

  const peek = !S.assistantOpen && S.peek ? `<div class="peek ${S.anim === 'peek' ? 'pop' : ''}" role="status">
      <button class="peek-x" data-act="peek-close" title="Dismiss">${icon('x')}</button>
      <b>${esc(S.peek.title)}</b><p>${esc(S.peek.body || '')}</p>
      ${S.peek.key && S.peek.type !== 'feedback' ? `<button class="btn primary sm" data-act="review" data-key="${esc(S.peek.key)}">Review ${icon('arrow')}</button>` : ''}
    </div>` : '';

  return `${peek}
    ${S.assistantOpen ? `<div class="bubble ${S.anim === 'bubble' ? 'pop' : ''}" role="dialog" aria-label="Assistant">${body}</div>` : ''}
    <button class="fab ${S.assistantOpen ? 'open' : ''} ${sessItem && sessItem.state === 'todo' && !S.assistantOpen ? 'pulse' : ''}" data-act="assistant" title="Assistant">
      ${mascot(todo ? '' : 'happy')}${todo ? `<span class="fab-badge">${todo}</span>` : ''}
    </button>`;
}

function miniNext(it, label) {
  return `<div class="as-next">
    <div class="next-label">${label}</div>
    <div class="as-title">${esc(it.title)}</div>
    <div class="as-meta">${it.size ? `<span class="size-pill s-${it.size.label}">${it.size.label}</span>` : ''}${it.minutes ? `~${it.minutes} min · ` : ''}${esc(it.author.name)} · ${fmtAge(it.ageH)}${it.reasons.map((r) => ` · ${REASON[r]}`).join('')}</div>
  </div>`;
}

// ---- mini (picture-in-picture) window ---------------------------------------------------

export function mini(S) {
  const d = S.data;
  if (!d) return `<div class="mini"><p class="muted">Connecting…</p></div>`;
  if (!d.auth.signedIn) return `<div class="mini"><div class="mini-empty">${mascot('sleepy')}<p>Sign in in the main window</p></div></div>`;
  const todo = d.inbox.items.filter((i) => i.state === 'todo' && !i.snoozedUntil);
  const session = S.session && d.inbox.items.find((i) => i.key === S.session.key && i.state === 'todo');
  // While you're reviewing one, "next" is the one after it.
  const next = session ? todo.find((i) => i.key !== session.key && !S.skipped.has(i.key)) || null : nextItem(S);
  const rest = todo.filter((i) => i.key !== (next && next.key) && i.key !== (session && session.key)).slice(0, 4);
  return `<div class="mini">
    <header class="mini-top">
      ${goalRing(d.stats, 44)}
      <div class="grow"><b>${todo.length}</b> to review<small>${d.stats.streak ? `${icon('flame')}${d.stats.streak} day streak` : d.inbox.minutesTotal ? `~${fmtMinutes(d.inbox.minutesTotal)}` : ''}</small></div>
      <button class="icon-btn sm ${d.inbox.polling ? 'spin' : ''}" data-act="refresh" title="Refresh">${icon('refresh')}</button>
    </header>
    ${session ? `<div class="mini-session"><div class="next-label">How did it go?</div><div class="mini-title">${esc(session.title)}</div>
      <div class="vote-grid">${[10, 5, -5, -10].map((v) => `<button class="vote-btn v-${VOTE_META[v].cls}" data-act="session-vote" data-vote="${v}" data-key="${esc(session.key)}" title="${VOTE_META[v].label}">${icon(VOTE_META[v].icon)}</button>`).join('')}</div></div>` : ''}
    ${next ? `<div class="mini-next">
      <div class="next-label">Next up</div>
      <div class="mini-title">${esc(next.title)}</div>
      <div class="as-meta">${next.size ? `<span class="size-pill s-${next.size.label}">${next.size.label}</span>` : ''}${next.minutes ? `~${next.minutes} min · ` : ''}${esc(next.author.name)} · ${fmtAge(next.ageH)}</div>
      <div class="mini-actions"><button class="btn primary sm" data-act="review" data-key="${esc(next.key)}">Review ${icon('arrow')}</button>
        <button class="btn ghost sm" data-act="vote" data-vote="10" data-key="${esc(next.key)}" title="Approve">${icon('check')}</button>
        <button class="btn ghost sm" data-act="skip" data-key="${esc(next.key)}" title="Skip">${icon('skip')}</button></div>
    </div>` : `<div class="mini-empty">${mascot('happy')}<p>All clear</p></div>`}
    ${rest.length ? `<ul class="mini-list">${rest.map((i) => `<li data-act="review" data-key="${esc(i.key)}" title="${esc(i.title)}"><span class="dot s-${i.size ? i.size.label : 'none'}"></span><span class="grow">${esc(i.title)}</span><small>${fmtAge(i.ageH)}</small></li>`).join('')}</ul>` : ''}
  </div>`;
}
