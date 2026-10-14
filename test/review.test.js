'use strict';
/** Reviewing inside the app: files, diffs, comments on lines, replies, resolving, voting. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createFakeAdo } = require('../demo/fake-ado');
const { diffText, isBinary } = require('../server/diff');

const quietLog = { info() {}, warn() {}, error() {} };

test('diff: every line, marked unchanged / removed / added', () => {
  const d = diffText('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
  assert.deepEqual(d.lines.map((l) => `${l.t}${l.s}`), [' a', '-b', '+B', ' c', ' d', '+e']);
  assert.deepEqual(d.lines.map((l) => [l.o, l.n]), [[1, 1], [2, null], [null, 2], [3, 3], [4, 4], [null, 5]]);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.deepEqual(diffText('', 'x\r\ny').lines.map((l) => l.t), ['+', '+']);
  assert.equal(isBinary(Buffer.from([65, 0, 66])), true);
  assert.equal(isBinary(Buffer.from('plain text')), false);
});

async function signedIn(t) {
  const fake = await createFakeAdo({ autoLogin: true }).listen(0);
  Object.assign(process.env, fake.env());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-review-'));
  const { createCore } = require('../server/core');
  const core = createCore({ DATA_DIR: dir, NO_AZ: true, log: quietLog, suppressToast: () => true });
  t.after(async () => {
    core.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { url } = (await core.call('POST', '/api/login')).data;
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await core.auth.completeLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state') });
  await core.call('POST', '/api/refresh');
  return { fake, core };
}

const get = async (core, p) => {
  const r = await core.call('GET', p);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const post = (core, p, body) => core.call('POST', p, { body });

test('review a PR in the app: files, diffs and comments on lines', async (t) => {
  const { fake, core } = await signedIn(t);
  const key = 'contoso#1201';

  const r = await get(core, `/api/review?key=${encodeURIComponent(key)}`);
  assert.deepEqual(r.files.map((f) => f.path), ['/src/Payments.Api/Controllers/InvoiceController.cs', '/src/Payments.Domain/Invoice.cs']);
  assert.equal(r.iteration, 1);
  const lineThread = r.threads.find((x) => x.path === '/src/Payments.Domain/Invoice.cs');
  assert.deepEqual({ side: lineThread.side, line: lineThread.line, status: lineThread.status }, { side: 'right', line: 12, status: 'active' });
  assert.equal(lineThread.comments[0].by, 'Jonas Weber');
  assert.equal(r.files[1].comments, 1);
  const general = r.threads.find((x) => !x.path);
  assert.match(general.comments[0].text, /migration/);

  // The diff of a changed file.
  const file = r.files[1].path;
  const d = await get(core, `/api/review/diff?key=${encodeURIComponent(key)}&path=${encodeURIComponent(file)}`);
  assert.ok(d.added >= 2 && d.removed >= 1, `+${d.added} -${d.removed}`);
  assert.ok(d.lines.some((l) => l.t === ' ') && d.lines.some((l) => l.t === '+') && d.lines.some((l) => l.t === '-'));
  assert.match(d.lines[0].s, /^using System;/);

  // A new file: everything added.
  const r2 = await get(core, '/api/review?key=contoso%231198');
  const addedFile = r2.files.find((f) => f.type === 'add');
  const d2 = await get(core, `/api/review/diff?key=contoso%231198&path=${encodeURIComponent(addedFile.path)}`);
  assert.ok(d2.lines.length > 5 && d2.lines.every((l) => l.t === '+'));

  // Comment on a line of the new version.
  const line = d.lines.find((l) => l.t === '+');
  let res = await post(core, '/api/review/comment', { key, content: 'Nice, but add a test for .5 cases', path: file, line: line.n, side: 'right', lineText: line.s });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const sent = fake.control.log.threads.at(-1);
  assert.deepEqual(sent.threadContext.rightFileStart, { line: line.n, offset: 1 });
  assert.deepEqual(sent.threadContext.rightFileEnd, { line: line.n, offset: line.s.length + 1 });
  assert.deepEqual(sent.pullRequestThreadContext.iterationContext, { firstComparingIteration: 1, secondComparingIteration: 1 });
  assert.equal(sent.pullRequestThreadContext.changeTrackingId, 2);
  const mine = res.data.threads.find((x) => x.comments[0].text === 'Nice, but add a test for .5 cases');
  assert.deepEqual({ path: mine.path, line: mine.line, side: mine.side, me: mine.comments[0].me }, { path: file, line: line.n, side: 'right', me: true });
  assert.equal(res.data.files[1].comments, 2);

  // On a removed line (old version).
  const gone = d.lines.find((l) => l.t === '-');
  res = await post(core, '/api/review/comment', { key, content: 'Why remove this?', path: file, line: gone.o, side: 'left', lineText: gone.s });
  assert.deepEqual(fake.control.log.threads.at(-1).threadContext.leftFileStart, { line: gone.o, offset: 1 });
  assert.equal(res.data.threads.find((x) => x.comments[0].text === 'Why remove this?').side, 'left');

  // Reply, then resolve.
  res = await post(core, '/api/review/comment', { key, content: 'Not needed, these were never stored.', threadId: general.id });
  assert.deepEqual(res.data.threads.find((x) => x.id === general.id).comments.map((c) => c.by), ['Jonas Weber', fake.me.name]);
  res = await post(core, '/api/review/status', { key, threadId: general.id, status: 'fixed' });
  assert.equal(res.data.threads.find((x) => x.id === general.id).status, 'fixed');
  res = await post(core, '/api/review/status', { key, threadId: general.id, status: 'active' });
  assert.equal(res.data.threads.find((x) => x.id === general.id).status, 'active');

  // A general comment on the PR.
  res = await post(core, '/api/review/comment', { key, content: 'Looks good overall 👍' });
  const overall = res.data.threads.find((x) => x.comments[0].text === 'Looks good overall 👍');
  assert.equal(overall.path, null);
  assert.equal(fake.control.log.threads.at(-1).threadContext, undefined);

  // Approve from the review screen.
  res = await post(core, '/api/vote', { key, vote: 10 });
  assert.equal(res.data.inbox.items.find((i) => i.key === key).state, 'done');

  // Nonsense is refused.
  assert.equal((await post(core, '/api/review/comment', { key, content: '   ' })).status, 400);
  assert.equal((await post(core, '/api/review/comment', { key, content: 'x', path: '/not/in/pr.cs' })).status, 404);
  assert.equal((await post(core, '/api/review/comment', { key, content: 'x', path: file, line: -3 })).status, 400);
  assert.equal((await post(core, '/api/review/status', { key, threadId: general.id, status: 'nope' })).status, 400);
  assert.equal((await core.call('GET', `/api/review/diff?key=${encodeURIComponent(key)}&path=%2Fetc%2Fpasswd`)).status, 404);
  assert.equal((await core.call('GET', '/api/review?key=contoso%239999')).status, 404);
});

test('a new push: the review shows the latest version', async (t) => {
  const { fake, core } = await signedIn(t);
  const key = 'contoso#1201';
  const file = '/src/Payments.Domain/Invoice.cs';
  const before = await get(core, `/api/review/diff?key=${encodeURIComponent(key)}&path=${encodeURIComponent(file)}`);
  fake.control.pushCommit('contoso', 1201);
  await core.call('POST', '/api/refresh');
  const r = await get(core, `/api/review?key=${encodeURIComponent(key)}`);
  assert.equal(r.iteration, 2);
  const after = await get(core, `/api/review/diff?key=${encodeURIComponent(key)}&path=${encodeURIComponent(file)}`);
  assert.notEqual(after.version, before.version);
});
