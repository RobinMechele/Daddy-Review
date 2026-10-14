'use strict';
/** Which PRs you see: your teams (also nested), repositories you watch, drafts going live, paging. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createFakeAdo } = require('../demo/fake-ado');
const { Ado } = require('../server/ado');

const quietLog = { info() {}, warn() {}, error() {} };

async function signedInCore(t, savedState = null) {
  const fake = await createFakeAdo({ autoLogin: true }).listen(0);
  Object.assign(process.env, fake.env());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-scope-'));
  if (savedState) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(savedState));
  const { createCore } = require('../server/core');
  const toasts = [];
  const core = createCore({ DATA_DIR: dir, NO_AZ: true, log: quietLog, notify: (n) => toasts.push(n), suppressToast: () => false });
  t.after(async () => {
    core.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { url } = (await core.call('POST', '/api/login')).data;
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await core.auth.completeLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state') });
  const r = await core.call('POST', '/api/refresh');
  assert.equal(r.data.auth.signedIn, true);
  return { fake, core, toasts, dir };
}

const item = (r, id) => r.data.inbox.items.find((i) => i.id === id);

test('watch repositories: every active PR in them shows, "only these" hides the rest', async (t) => {
  const { fake, core } = await signedInCore(t);

  // Pick from the organization's projects and repositories.
  let r = await core.call('GET', '/api/repos?org=contoso');
  assert.equal(r.status, 200);
  const mobile = r.data.projects.find((p) => p.name === 'Mobile');
  assert.deepEqual(mobile.repos.map((x) => x.name), ['mobile-app']);
  assert.deepEqual(r.data.projects.map((p) => p.name), ['Mobile', 'Payments', 'Platform']);
  assert.equal((await core.call('GET', '/api/repos?org=nope')).status, 404);

  // Watching mobile-app adds the PR that doesn't ask for you.
  const pick = [{ kind: 'repo', id: mobile.repos[0].id, name: 'mobile-app', projectId: mobile.id, project: 'Mobile' }];
  r = await core.call('POST', '/api/settings', { body: { setRepos: { org: 'contoso', pick } } });
  assert.equal(r.status, 200);
  assert.equal(item(r, 1209).state, 'other');
  assert.equal(item(r, 1209).watched, true);
  assert.equal(item(r, 1201).state, 'todo', 'PRs for you elsewhere stay');
  const org = r.data.orgs.find((o) => o.name === 'contoso');
  assert.deepEqual(org.watch, { count: 1, only: false, names: ['mobile-app'] });
  assert.ok(fake.control.listCalls.some((p) => p.includes('/proj-Mobile/_apis/git/repositories/repo-mobile-app/pullrequests?')));

  // PRs that were already open there aren't news, and old votes there don't count as reviews today.
  assert.ok(!r.data.events.some((e) => e.key === 'contoso#1209'));
  // A new PR there pops up, named after the repository.
  fake.control.newPr({ org: 'contoso', repo: 'mobile-app', author: 'sofia', title: 'Faster app start' });
  fake.control.pr('contoso', 1300).reviewers = [];
  r = await core.call('POST', '/api/refresh');
  const evt = r.data.events.find((e) => e.type === 'new' && e.prTitle === 'Faster app start');
  assert.equal(evt.title, 'New PR in mobile-app');

  // Only these: the rest of contoso is hidden, your own PRs and other orgs stay.
  r = await core.call('POST', '/api/settings', { body: { setRepos: { org: 'contoso', pick, only: true } } });
  const contoso = r.data.inbox.items.filter((i) => i.org === 'contoso');
  assert.deepEqual([...new Set(contoso.filter((i) => !i.mine).map((i) => i.repo))], ['mobile-app']);
  assert.equal(contoso.filter((i) => i.mine).length, 3);
  assert.ok(item(r, 312), 'other organizations are not affected');

  // A whole project.
  const payments = (await core.call('GET', '/api/repos?org=contoso')).data.projects.find((p) => p.name === 'Payments');
  r = await core.call('POST', '/api/settings', { body: { setRepos: { org: 'contoso', pick: [{ kind: 'project', id: payments.id, name: 'Payments' }], only: true } } });
  assert.deepEqual([...new Set(r.data.inbox.items.filter((i) => i.org === 'contoso' && !i.mine).map((i) => i.repo))].sort(), ['checkout-web', 'payments-api']);

  // Back to everything for you.
  r = await core.call('POST', '/api/settings', { body: { setRepos: { org: 'contoso', pick: [] } } });
  assert.equal(r.data.orgs.find((o) => o.name === 'contoso').watch, null);
  assert.equal(item(r, 1209).state, 'other', 'without picks, Others has the whole organization');
  assert.equal(r.data.inbox.counts.todo, 9);

  // Junk is ignored.
  r = await core.call('POST', '/api/settings', { body: { setRepos: { org: 'contoso', pick: [{ kind: 'repo', id: '../x', projectId: 'p' }, 'x', null] } } });
  assert.equal(r.data.settings.repos.contoso, undefined);
});

test('a draft that gets published shows up as ready for review', async (t) => {
  const { fake, core, toasts } = await signedInCore(t);
  let r = await core.call('GET', '/api/state');
  assert.equal(item(r, 1203).state, 'draft');

  fake.control.publish('contoso', 1203);
  r = await core.call('POST', '/api/refresh');
  assert.equal(item(r, 1203).state, 'todo');
  const evt = r.data.events.find((e) => e.key === 'contoso#1203');
  assert.equal(evt.title, 'Ready for review');
  await new Promise((res) => setTimeout(res, 600));
  assert.ok(toasts.some((n) => n.title === 'Ready for review' && n.key === 'contoso#1203'));
});

test('a draft you were added to only when it was published still pops up', async (t) => {
  const { fake, core } = await signedInCore(t);
  const pr = fake.control.newPr({ org: 'contoso', repo: 'infra', author: 'lucas', title: 'Rotate storage keys' });
  pr.isDraft = true;
  pr.reviewers = [];
  // Doesn't ask for you yet: under "Others".
  let r = await core.call('POST', '/api/refresh');
  assert.equal(item(r, pr.pullRequestId).state, 'other');

  fake.control.publish('contoso', pr.pullRequestId);
  pr.reviewers = [{ id: fake.me.id, displayName: fake.me.name, vote: 0, isRequired: true, isContainer: false }];
  r = await core.call('POST', '/api/refresh');
  assert.equal(item(r, pr.pullRequestId).state, 'todo');
  assert.ok(r.data.events.some((e) => e.key === `contoso#${pr.pullRequestId}` && e.type === 'new'));
});

test('your teams, also through nested groups, without one query per team', async (t) => {
  const { fake, core } = await signedInCore(t);
  const r = await core.call('GET', '/api/state');
  assert.equal(item(r, 1205).team, 'Platform Team');
  assert.equal(item(r, 1208).team, 'Payments Team');
  const contoso = r.data.orgs.find((o) => o.name === 'contoso');
  assert.equal(contoso.counts.teams, 3, 'Platform, Payments and the Entra group');
  // One look through the active PRs instead of a query per team.
  assert.ok(!fake.control.listCalls.some((p) => /reviewerId=g-/.test(p)));
});

test('paging: lists of more than one page are read to the end', async () => {
  const ado = new Ado({ auth: {}, config: { ADO_BASE: 'https://dev.azure.com' }, log: quietLog });
  const urls = [];
  const all = Array.from({ length: 1203 }, (_, i) => ({ pullRequestId: i + 1 }));
  ado.get = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const skip = Number(u.searchParams.get('$skip')) || 0;
    return { value: all.slice(skip, skip + Number(u.searchParams.get('$top'))) };
  };
  let r = await ado.searchPrs('contoso', {}, 5000);
  assert.equal(r.list.length, 1203);
  assert.equal(r.complete, true);
  assert.equal(urls.length, 3);
  assert.match(urls[1], /\$skip=500/);

  // Capped: says it's not complete.
  r = await ado.searchPrs('contoso', {}, 1000);
  assert.equal(r.list.length, 1000);
  assert.equal(r.complete, false);
});

test('big organizations: teams are looked up every 10 minutes, asked for directly in between', async () => {
  const { Inbox } = require('../server/inbox');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-big-'));
  const calls = [];
  const teamPr = { pullRequestId: 5, createdBy: { id: 'x' }, reviewers: [{ id: 'team-1', vote: 0, isContainer: true }], repository: { id: 'r', name: 'r', project: { id: 'p', name: 'P' } } };
  const ado = {
    connection: async () => ({ id: 'me', name: 'Me' }),
    groups: async () => [{ id: 'team-1', name: '[P]\\Team One' }],
    searchPrs: async () => { calls.push('scan'); return { list: [teamPr], complete: false }; },
    pullRequests: async (org, q) => { calls.push(JSON.stringify(q)); return q['searchCriteria.reviewerId'] === 'team-1' ? [teamPr] : []; },
  };
  const inbox = new Inbox({ config: { DATA_DIR: dir, WEB_BASE: 'https://dev.azure.com' }, ado, auth: {}, log: quietLog });
  let items = await inbox.fetchOrg('contoso');
  assert.equal(items.length, 1);
  assert.equal(calls.filter((c) => c === 'scan').length, 1);

  calls.length = 0;
  items = await inbox.fetchOrg('contoso');
  assert.equal(items.length, 1);
  assert.deepEqual(calls, ['{"searchCriteria.reviewerId":"me"}', '{"searchCriteria.creatorId":"me"}', '{"searchCriteria.reviewerId":"team-1"}']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('after updating, PRs the app now finds (e.g. nested teams) are taken in quietly', async (t) => {
  // State from 1.1: both organizations seen before, the Payments team PR never was.
  const { core, toasts } = await signedInCore(t, {
    baselined: { contoso: true, 'fabrikam-labs': true },
    snapshot: { 'contoso#1201': { state: 'todo', myVote: 0, commit: 'x' } },
    reviews: [],
  });
  const r = await core.call('GET', '/api/state');
  assert.ok(item(r, 1208));
  assert.deepEqual(r.data.events, []);
  assert.equal(r.data.stats.today, 0, 'old votes are not counted as reviews today');
  await new Promise((res) => setTimeout(res, 600));
  assert.deepEqual(toasts, []);
});

test('Others: open PRs that don\'t ask for you, and adding yourself as a reviewer', async (t) => {
  const { fake, core } = await signedInCore(t);
  let r = await core.call('GET', '/api/state');
  assert.equal(item(r, 1209).state, 'other');
  assert.equal(r.data.inbox.counts.other, 3);
  assert.equal(r.data.inbox.counts.todo, 9, 'not counted as waiting for you');

  // A new PR elsewhere in the organization: in Others, but no popup (you don't watch that repository).
  const quiet = fake.control.newPr({ org: 'contoso', repo: 'infra', author: 'noah', title: 'Tidy pipeline variables' });
  quiet.reviewers = [];
  r = await core.call('POST', '/api/refresh');
  assert.equal(item(r, quiet.pullRequestId).state, 'other');
  assert.ok(!r.data.events.some((e) => e.key === `contoso#${quiet.pullRequestId}`));

  // Someone adds you as a reviewer: now it's a review request.
  fake.control.pr('contoso', quiet.pullRequestId).reviewers = [{ id: fake.me.id, displayName: fake.me.name, vote: 0, isRequired: false, isContainer: false }];
  r = await core.call('POST', '/api/refresh');
  assert.equal(item(r, quiet.pullRequestId).state, 'todo');
  assert.equal(r.data.events.find((e) => e.key === `contoso#${quiet.pullRequestId}`).title, 'New review request');

  // Add yourself to one: you become a reviewer in Azure DevOps, it moves to To review.
  r = await core.call('POST', '/api/pickup', { body: { key: 'contoso#1209' } });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.control.log.votes.at(-1), { org: 'contoso', id: 1209, reviewer: fake.me.id, vote: 0 });
  assert.equal(item(r, 1209).state, 'todo');
  r = await core.call('POST', '/api/refresh');
  assert.equal(item(r, 1209).state, 'todo');
  assert.ok(!r.data.events.some((e) => e.key === 'contoso#1209'), 'no popup for something you did yourself');

  // Undo takes you off again.
  r = await core.call('POST', '/api/pickup', { body: { key: 'contoso#1209', undo: true } });
  assert.equal(fake.control.log.votes.at(-1).removed, true);
  assert.equal(item(r, 1209).state, 'other');
  assert.ok(!fake.control.pr('contoso', 1209).reviewers.some((x) => x.id === fake.me.id));

  // Approving straight from Others works too.
  r = await core.call('POST', '/api/vote', { body: { key: 'contoso#1209', vote: 10 } });
  assert.equal(item(r, 1209).state, 'done');
});
