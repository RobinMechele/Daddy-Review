import { esc, icon, fmtAge, VOTE_META } from './util.js';
import { avatar } from './views.js';
import { md } from './md.js';

/**
 * The review screen: a PR's files with their diffs and comment threads, where you
 * comment on lines, reply, resolve and vote without leaving the app.
 */

const CONTEXT = 3;
const STATUS_LABEL = { active: 'Active', pending: 'Pending', fixed: 'Resolved', wontFix: 'Won\'t fix', closed: 'Closed', byDesign: 'By design' };
const isOpen = (t) => t.status === 'active' || t.status === 'pending';
const ago = (iso) => (iso ? fmtAge(Math.max(0, (Date.now() - Date.parse(iso)) / 36e5)) : '');
const fileName = (p) => p.split('/').pop();
const dirName = (p) => p.split('/').slice(0, -1).join('/').replace(/^\//, '');
const typeOf = (f) => {
  const t = f.type.toLowerCase();
  return t.includes('add') ? 'A' : t.includes('delete') ? 'D' : t.includes('rename') && !t.includes('edit') ? 'R' : 'M';
};
const TYPE_TITLE = { A: 'Added', D: 'Deleted', R: 'Renamed', M: 'Changed' };

export const isViewed = (R, f) => !!f.version && R.viewed[f.path] === f.version;

function draft(R, id) {
  return esc(R.drafts[id] || '');
}

// ---- threads ------------------------------------------------------------------------

function thread(R, t, { showFile = false } = {}) {
  const open = isOpen(t);
  const busy = R.busy.has(`t${t.id}`);
  return `<div class="thread ${open ? '' : 'resolved'}" data-thread="${t.id}">
    <div class="th-head">
      <span class="th-status s-${esc(t.status)}">${esc(STATUS_LABEL[t.status] || t.status)}</span>
      ${showFile && t.path ? `<button class="link th-file" data-act="rv-file" data-path="${esc(t.path)}" data-line="${t.line || ''}">${icon('file')}${esc(fileName(t.path))}${t.line ? `<span>:${t.line}</span>` : ''}</button>` : ''}
      <span class="grow"></span>
      <button class="btn ghost xs" data-act="rv-status" data-id="${t.id}" data-status="${open ? 'fixed' : 'active'}" ${busy ? 'disabled' : ''}>${open ? `${icon('check')}Resolve` : `${icon('undo')}Reopen`}</button>
    </div>
    ${t.comments.map((c) => `<div class="cm">
      ${avatar(c.by, 'xs', c.image)}
      <div class="cm-body"><div class="cm-head"><b>${esc(c.me ? 'You' : c.by)}</b><span>${ago(c.at)}</span></div><div class="md">${md(c.text)}</div></div>
    </div>`).join('')}
    <div class="reply">
      <textarea data-draft="t${t.id}" rows="1" placeholder="Reply…" aria-label="Reply">${draft(R, `t${t.id}`)}</textarea>
      <button class="btn primary sm" data-act="rv-reply" data-id="${t.id}" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span>' : ''}Reply</button>
    </div>
  </div>`;
}

function composer(R, id, placeholder) {
  const busy = R.busy.has(id);
  return `<div class="composer">
    <textarea data-draft="${esc(id)}" rows="3" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">${draft(R, id)}</textarea>
    <div class="composer-actions">
      <span class="muted small">Markdown · Ctrl+Enter to send</span>
      ${id === 'overview' ? '' : '<button class="btn ghost sm" data-act="rv-cancel">Cancel</button>'}
      <button class="btn primary sm" data-act="rv-send" data-id="${esc(id)}" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span>' : ''}Comment</button>
    </div>
  </div>`;
}

// ---- diff ---------------------------------------------------------------------------

/** Highlight what changed inside a line that was edited (common start/end stay plain). */
function pairHighlight(a, b) {
  if (a.length > 400 || b.length > 400) return [esc(a), esc(b)];
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  if (s + e === 0) return [esc(a), esc(b)];
  const wrap = (x) => (x.slice(s, x.length - e) ? `${esc(x.slice(0, s))}<mark>${esc(x.slice(s, x.length - e))}</mark>${esc(x.slice(x.length - e))}` : esc(x));
  return [wrap(a), wrap(b)];
}

function codeHtml(lines) {
  const html = lines.map((l) => esc(l.s));
  for (let i = 0; i < lines.length;) {
    if (lines[i].t !== '-') { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].t === '-') j++;
    let k = j;
    while (k < lines.length && lines[k].t === '+') k++;
    const pairs = Math.min(j - i, k - j);
    for (let p = 0; p < pairs; p++) [html[i + p], html[j + p]] = pairHighlight(lines[i + p].s, lines[j + p].s);
    i = k;
  }
  return html;
}

const anchorOf = (l) => (l.t === '-' ? `left:${l.o}` : `right:${l.n}`);

function diffView(R, f, d, threads) {
  if (!d || d === 'loading') return '<div class="diff-wrap"><div class="skeleton line"></div><div class="skeleton line short"></div><div class="skeleton line"></div></div>';
  if (d === 'error') return `<div class="rv-note">${icon('alert')}Couldn't load this file. <button class="link" data-act="rv-file" data-path="${esc(f.path)}" data-retry="1">Try again</button></div>`;
  if (d.binary) return `<div class="rv-note">${icon('file')}Binary file, nothing to show here.</div>`;
  if (d.tooLarge) return `<div class="rv-note">${icon('file')}This file is too big to show here. <button class="link" data-act="rv-open">Open in Azure DevOps</button></div>`;
  const lines = d.lines;
  if (!lines.length) return `<div class="rv-note">${icon('file')}Empty file.</div>`;

  const byAnchor = new Map();
  const loose = [];
  const known = new Set(lines.map(anchorOf).concat(lines.filter((l) => l.t === ' ').map((l) => `left:${l.o}`)));
  for (const t of threads) {
    const a = t.line ? `${t.side === 'left' ? 'left' : 'right'}:${t.line}` : null;
    if (!a || !known.has(a)) { loose.push(t); continue; }
    // A comment on the old side of an unchanged line shows on that line too.
    const line = t.side === 'left' ? lines.find((l) => l.o === t.line && (l.t === '-' || l.t === ' ')) : null;
    const key = line && line.t === ' ' ? `right:${line.n}` : a;
    if (!byAnchor.has(key)) byAnchor.set(key, []);
    byAnchor.get(key).push(t);
  }
  const comp = R.composer && R.composer.path === f.path ? `${R.composer.side}:${R.composer.line}` : null;

  // Which lines to show: changes, commented lines and a few lines around them.
  const important = lines.map((l) => l.t !== ' ' || byAnchor.has(anchorOf(l)) || anchorOf(l) === comp);
  const show = new Array(lines.length).fill(false);
  important.forEach((imp, i) => {
    if (!imp) return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) show[k] = true;
  });
  const expanded = R.expanded[f.path] || new Set();
  const html = codeHtml(lines);
  const rows = [];
  const row = (i) => {
    const l = lines[i];
    const side = l.t === '-' ? 'left' : 'right';
    const no = l.t === '-' ? l.o : l.n;
    const cls = l.t === '+' ? 't-add' : l.t === '-' ? 't-del' : 't-ctx';
    rows.push(`<tr class="dl ${cls}"><td class="ln">${l.o || ''}</td><td class="ln">${l.n || ''}</td><td class="code"><button class="add-c" data-act="rv-line" data-path="${esc(f.path)}" data-line="${no}" data-side="${side}" data-i="${i}" title="Comment on this line" aria-label="Comment on line ${no}">${icon('plus')}</button><span class="sg">${l.t === ' ' ? ' ' : l.t}</span>${html[i] || ' '}</td></tr>`);
    for (const t of byAnchor.get(anchorOf(l)) || []) rows.push(`<tr class="th-row"><td colspan="3">${thread(R, t)}</td></tr>`);
    if (anchorOf(l) === comp) rows.push(`<tr class="th-row"><td colspan="3">${composer(R, `new:${f.path}:${side}:${no}`, `Comment on line ${no}`)}</td></tr>`);
  };
  for (let i = 0; i < lines.length;) {
    if (show[i]) { row(i++); continue; }
    // A stretch of unchanged lines: folded, unless it's short or you unfolded it.
    let j = i;
    while (j < lines.length && !show[j]) j++;
    if (j - i >= 4 && !expanded.has(i)) {
      rows.push(`<tr class="fold"><td colspan="3"><button data-act="rv-expand" data-path="${esc(f.path)}" data-fold="${i}">${icon('more')}Show ${j - i} unchanged lines</button></td></tr>`);
    } else {
      for (let k = i; k < j; k++) row(k);
    }
    i = j;
  }
  return `${loose.length ? `<div class="loose">${loose.map((t) => thread(R, t)).join('')}</div>` : ''}
    <div class="diff-wrap"><table class="diff"><colgroup><col class="c-ln"><col class="c-ln"><col></colgroup><tbody>${rows.join('')}</tbody></table></div>`;
}

// ---- the screen ---------------------------------------------------------------------

function header(S, R, it) {
  const v = it ? it.myVote : 0;
  const vb = (vote) => {
    const m = VOTE_META[vote];
    return `<button class="vote-pill v-${m.cls} ${v === vote ? 'on' : ''}" data-act="rv-vote" data-vote="${vote}" title="${m.act}">${icon(m.icon)}<span>${m.short}</span></button>`;
  };
  const next = it && it.state !== 'todo' ? S.data.inbox.items.find((i) => i.state === 'todo' && !i.snoozedUntil && i.key !== it.key) : null;
  return `<header class="rv-head">
    <button class="icon-btn" data-act="rv-back" title="Back (Esc)">${icon('back')}</button>
    <div class="rv-title">
      <h1 title="${esc(it ? it.title : '')}">${esc(it ? it.title : 'Pull request')}<span class="muted">!${esc(it ? it.id : '')}</span></h1>
      ${it ? `<div class="rv-meta">${avatar(it.author.name, 'xs', it.author.image)}${esc(it.author.name)}<span class="sep">·</span>${esc(it.repo)}<span class="sep">·</span><code>${esc(it.source)}</code>${icon('arrow')}<code>${esc(it.target)}</code><span class="sep">·</span>${fmtAge(it.ageH)}</div>` : ''}
    </div>
    <div class="rv-actions">
      ${next ? `<button class="btn sm primary" data-act="rv-next-pr" data-key="${esc(next.key)}" title="${esc(next.title)}">Next PR ${icon('arrow')}</button>` : ''}
      ${it && it.state !== 'mine' ? `<div class="vote-bar">${[10, 5, -5, -10].map(vb).join('')}</div>` : ''}
      <button class="icon-btn" data-act="rv-reload" title="Reload">${icon('refresh')}</button>
      <button class="icon-btn" data-act="rv-open" title="Open in Azure DevOps">${icon('open')}</button>
    </div>
  </header>`;
}

function sidebar(R) {
  const files = R.data ? R.data.files : [];
  const generalOpen = R.data ? R.data.threads.filter((t) => !t.path && isOpen(t)).length : 0;
  const viewed = files.filter((f) => isViewed(R, f)).length;
  return `<nav class="rv-side" aria-label="Files">
    <button class="rv-item ${R.file ? '' : 'on'}" data-act="rv-overview">${icon('chat')}<span class="grow">Overview</span>${generalOpen ? `<span class="bubble-count">${generalOpen}</span>` : ''}</button>
    <div class="rv-files-head"><span>Files <b>${files.length}</b></span><span title="Files you marked as viewed">${viewed}/${files.length} viewed</span></div>
    <div class="rv-progress"><i style="width:${files.length ? (viewed / files.length) * 100 : 0}%"></i></div>
    <div class="rv-files">
      ${files.map((f) => {
        const t = typeOf(f);
        return `<div class="rv-file ${R.file === f.path ? 'on' : ''} ${isViewed(R, f) ? 'viewed' : ''}">
          <button class="rv-item" data-act="rv-file" data-path="${esc(f.path)}" title="${esc(f.path)}">
            <span class="ct-badge ct-${t}" title="${TYPE_TITLE[t]}">${t}</span>
            <span class="grow"><span class="fname">${esc(fileName(f.path))}</span><small>${esc(dirName(f.path))}</small></span>
            ${f.comments ? `<span class="bubble-count">${f.comments}</span>` : ''}
          </button>
          <input type="checkbox" data-viewed="${esc(f.path)}" ${isViewed(R, f) ? 'checked' : ''} title="Viewed" aria-label="Viewed ${esc(fileName(f.path))}">
        </div>`;
      }).join('') || '<p class="muted small">No changed files.</p>'}
    </div>
  </nav>`;
}

function overview(S, R, it) {
  const threads = R.data.threads;
  const general = threads.filter((t) => !t.path);
  const onFiles = threads.filter((t) => t.path && isOpen(t));
  const desc = R.data.description || (it && it.description) || '';
  const people = it ? it.reviewers.filter((r) => !r.me) : [];
  return `<section class="rv-overview">
    <div class="rv-card">
      <h3>Description</h3>
      ${desc ? `<div class="md">${md(desc)}</div>` : '<p class="muted">No description.</p>'}
    </div>
    ${people.length ? `<div class="rv-card"><h3>Reviewers</h3><ul class="people">${people.map((r) => {
      const v = VOTE_META[r.vote] || VOTE_META[0];
      return `<li>${avatar(r.name, 'xs', r.image)}<span>${esc(r.name)}</span>${r.required ? '<em>req</em>' : ''}<i class="v-${v.cls}" title="${esc(v.label)}">${r.vote ? icon(v.icon) : ''}</i></li>`;
    }).join('')}</ul></div>` : ''}
    ${onFiles.length ? `<div class="rv-card"><h3>Open comments on files <span class="muted">${onFiles.length}</span></h3>${onFiles.map((t) => thread(R, t, { showFile: true })).join('')}</div>` : ''}
    <div class="rv-card"><h3>Discussion <span class="muted">${general.length || ''}</span></h3>
      ${general.map((t) => thread(R, t)).join('')}
      ${composer(R, 'overview', 'Write a comment on this PR')}
    </div>
  </section>`;
}

function fileView(R, f) {
  const d = R.diffs[f.path];
  const threads = R.data.threads.filter((t) => t.path === f.path);
  const files = R.data.files;
  const i = files.indexOf(f);
  const t = typeOf(f);
  return `<section class="rv-filepane">
    <div class="rv-filebar">
      <span class="ct-badge ct-${t}" title="${TYPE_TITLE[t]}">${t}</span>
      <div class="grow rv-path" title="${esc(f.path)}"><b>${esc(fileName(f.path))}</b><small>${esc(dirName(f.path))}${f.originalPath && f.originalPath !== f.path ? ` · was ${esc(f.originalPath)}` : ''}</small></div>
      ${d && d.lines ? `<span class="delta"><b class="ok-t">+${d.added}</b><b class="bad-t">−${d.removed}</b></span>` : ''}
      <label class="viewed-toggle"><input type="checkbox" data-viewed="${esc(f.path)}" ${isViewed(R, f) ? 'checked' : ''}>Viewed</label>
      <button class="icon-btn sm" data-act="rv-step" data-d="-1" title="Previous file (P)" ${i <= 0 ? 'disabled' : ''}>${icon('back')}</button>
      <button class="icon-btn sm" data-act="rv-step" data-d="1" title="Next file (N)" ${i >= files.length - 1 ? 'disabled' : ''}>${icon('arrow')}</button>
    </div>
    ${diffView(R, f, d, threads)}
  </section>`;
}

export function reviewView(S) {
  const R = S.review;
  if (!R) return '';
  const it = S.data && S.data.inbox.items.find((i) => i.key === R.key);
  let main;
  if (R.loading) main = '<div class="rv-card"><div class="skeleton line"></div><div class="skeleton line short"></div><div class="skeleton line"></div></div>';
  else if (R.error) main = `<div class="rv-note">${icon('alert')}${esc(R.error)} <button class="link" data-act="rv-reload">Try again</button></div>`;
  else {
    const f = R.file && R.data.files.find((x) => x.path === R.file);
    main = f ? fileView(R, f) : overview(S, R, it);
  }
  const stale = it && R.commit && it.commit && it.commit !== R.commit;
  return `<div class="rv">
    ${header(S, R, it)}
    ${!it && !R.loading ? `<div class="rv-note warn">${icon('alert')}This PR is no longer active (completed or abandoned).</div>` : ''}
    ${stale ? `<div class="rv-note accent">${icon('spark')}New changes were pushed. <button class="link" data-act="rv-reload">Show them</button></div>` : ''}
    <div class="rv-body">${sidebar(R)}<div class="rv-main">${main}</div></div>
  </div>`;
}
