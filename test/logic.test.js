'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../server/logic');
const { parseOrg } = require('../server/inbox');

const ME = 'me-id';
const ctx = { org: 'contoso', myId: ME, groups: new Map([['team-id', '[Proj]\\Team A']]), webBase: 'https://dev.azure.com' };

function pr(over = {}) {
  return {
    pullRequestId: 7,
    title: 'Fix it',
    creationDate: new Date(Date.now() - 5 * 36e5).toISOString(),
    createdBy: { id: 'author', displayName: 'Ann Author' },
    repository: { id: 'r1', name: 'repo one', project: { id: 'p1', name: 'Proj X' } },
    reviewers: [{ id: ME, displayName: 'Me', vote: 0 }],
    lastMergeSourceCommit: { commitId: 'c1' },
    sourceRefName: 'refs/heads/feature/x',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    ...over,
  };
}

test('toItem normalises a PR and builds the web link', () => {
  const it = logic.toItem(pr(), ctx);
  assert.equal(it.key, 'contoso#7');
  assert.equal(it.url, 'https://dev.azure.com/contoso/Proj%20X/_git/repo%20one/pullrequest/7');
  assert.equal(it.source, 'feature/x');
  assert.equal(it.direct, true);
  assert.equal(it.myVote, 0);
  assert.equal(it.mine, false);
});

test('classify: todo, waiting, done, mine, draft, team-covered', () => {
  const c = (over, snap) => logic.classify(logic.toItem(pr(over), ctx), snap).state;
  const covered = (over) => logic.classify(logic.toItem(pr(over), ctx), {});
  assert.equal(c(), 'todo');
  assert.equal(c({ reviewers: [{ id: ME, vote: -5 }] }, { votedCommit: 'c1' }), 'waiting');
  assert.equal(c({ reviewers: [{ id: ME, vote: 10 }] }, { votedCommit: 'c1' }), 'done');
  assert.equal(c({ createdBy: { id: ME } }), 'mine');
  assert.equal(c({ isDraft: true }), 'draft');
  // A teammate voting for your team doesn't make it done for you.
  assert.deepEqual(covered({ reviewers: [{ id: 'team-id', vote: 10, isContainer: true }] }), { state: 'todo', updated: false, covered: true });
  assert.deepEqual(covered({ reviewers: [{ id: 'team-id', vote: -5, isContainer: true }] }), { state: 'todo', updated: false, covered: true });
  assert.equal(c({ reviewers: [{ id: 'team-id', vote: 0, isContainer: true, isRequired: true }] }), 'todo');
  assert.equal(c({ reviewers: [{ id: ME, vote: 10, hasDeclined: true }] }), 'hidden');
});

test('classify: new pushes after your vote put it back in todo as "updated"', () => {
  const it = logic.toItem(pr({ reviewers: [{ id: ME, vote: 10 }], lastMergeSourceCommit: { commitId: 'c2' } }), ctx);
  const r = logic.classify(it, { votedCommit: 'c1' });
  assert.deepEqual(r, { state: 'todo', updated: true });
});

test('score prefers required, small and updated PRs', () => {
  const base = { state: 'todo', created: new Date().toISOString(), direct: true };
  const small = logic.score({ ...base, size: { files: 1 } });
  const big = logic.score({ ...base, size: { files: 80 } });
  const required = logic.score({ ...base, required: true, size: { files: 80 } });
  assert.ok(small.score > big.score);
  assert.ok(required.score > big.score);
  assert.ok(small.reasons.includes('quick'));
  assert.ok(required.reasons.includes('required'));
  assert.equal(logic.score({ ...base, state: 'done' }).score, 0);
});

test('sizeInfo labels and top extensions', () => {
  const s = logic.sizeInfo([{ path: '/a.cs' }, { path: '/b.cs' }, { path: '/c.ts' }]);
  assert.deepEqual(s, { files: 3, label: 'S', exts: ['cs', 'ts'] });
  assert.equal(logic.sizeInfo(Array.from({ length: 41 }, (_, i) => ({ path: `/f${i}.js` }))).label, 'XL');
  assert.equal(logic.estimate({ files: 4 }, false), 8);
  assert.equal(logic.estimate(null), null);
});

test('diff: baseline is silent, then new PRs, updates and your votes are detected', () => {
  const items1 = [logic.toItem(pr(), ctx)];
  const r1 = logic.diff({}, items1, { baselineOrgs: new Set(['contoso']), knownOrgs: new Set(['contoso']) });
  assert.equal(r1.events.length, 0);

  // A new PR shows up
  const items2 = [...items1, logic.toItem(pr({ pullRequestId: 8, title: 'New one' }), ctx)];
  const r2 = logic.diff(r1.snapshot, items2, { knownOrgs: new Set(['contoso']) });
  assert.deepEqual(r2.events.map((e) => [e.type, e.key]), [['new', 'contoso#8']]);

  // You approve #7 -> counted as a review
  const items3 = [logic.toItem(pr({ reviewers: [{ id: ME, vote: 10 }] }), ctx), items2[1]];
  const r3 = logic.diff(r2.snapshot, items3, { knownOrgs: new Set(['contoso']) });
  assert.equal(r3.reviews.length, 1);
  assert.equal(r3.snapshot['contoso#7'].state, 'done');
  assert.equal(r3.events.length, 0);

  // Author pushes again -> "updated" event, back to todo
  const items4 = [logic.toItem(pr({ reviewers: [{ id: ME, vote: 10 }], lastMergeSourceCommit: { commitId: 'c9' } }), ctx), items2[1]];
  const r4 = logic.diff(r3.snapshot, items4, { knownOrgs: new Set(['contoso']) });
  assert.deepEqual(r4.events.map((e) => e.type), ['updated']);
  assert.equal(r4.snapshot['contoso#7'].state, 'todo');

  // Branch policy resets the vote on push -> also "updated"
  const items5 = [logic.toItem(pr({ reviewers: [{ id: ME, vote: 0 }], lastMergeSourceCommit: { commitId: 'c10' } }), ctx), items2[1]];
  const r5 = logic.diff(r3.snapshot, items5, { knownOrgs: new Set(['contoso']) });
  assert.deepEqual(r5.events.map((e) => e.type), ['updated']);
  assert.equal(r5.snapshot['contoso#7'].resetByPush, true);
});

test('diff: feedback on your own PRs and keeping snapshots of failed orgs', () => {
  const mine = (vote) => logic.toItem(pr({ createdBy: { id: ME }, reviewers: [{ id: 'bob', displayName: 'Bob', vote }] }), ctx);
  const r1 = logic.diff({}, [mine(0)], { baselineOrgs: new Set(['contoso']), knownOrgs: new Set(['contoso']) });
  const r2 = logic.diff(r1.snapshot, [mine(10)], { knownOrgs: new Set(['contoso']) });
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].type, 'feedback');
  assert.equal(r2.events[0].title, 'Bob approved');
  assert.equal(r2.reviews.length, 0);

  const kept = logic.diff({ 'other#1': { state: 'todo' } }, [], { knownOrgs: new Set(['contoso']) });
  assert.ok(kept.snapshot['other#1']);
  const dropped = logic.diff({ 'contoso#1': { state: 'todo' } }, [], { knownOrgs: new Set(['contoso']) });
  assert.equal(dropped.snapshot['contoso#1'], undefined);
});

test('stats: today, week and a streak that survives weekends', () => {
  // Wednesday 2026-10-14 10:00 local
  const wed = new Date(2026, 9, 14, 10).getTime();
  const day = (d, h = 11) => new Date(2026, 9, d, h).getTime();
  const reviews = [
    { key: 'a', at: day(14, 9) },
    { key: 'b', at: day(14, 9) },
    { key: 'b', at: day(14, 9) }, // same PR twice = one review
    { key: 'c', at: day(13) },
    { key: 'd', at: day(12) }, // Monday
    { key: 'e', at: day(9) }, // previous Friday (weekend in between)
  ];
  const s = logic.stats(reviews, wed, 5);
  assert.equal(s.today, 2);
  assert.equal(s.streak, 4);
  assert.equal(s.week.length, 7);
  assert.equal(s.week[6].count, 2);
  // Nothing today yet doesn't break the streak
  assert.equal(logic.stats(reviews.slice(3), wed, 5).streak, 3);
  assert.equal(logic.stats([], wed, 5).streak, 0);
});

test('parseOrg accepts names and URLs', () => {
  assert.equal(parseOrg('contoso'), 'contoso');
  assert.equal(parseOrg('https://dev.azure.com/contoso/Project/_git/repo'), 'contoso');
  assert.equal(parseOrg('https://contoso.visualstudio.com/'), 'contoso');
  assert.equal(parseOrg(' dev.azure.com/fab-rikam '), 'fab-rikam');
});
