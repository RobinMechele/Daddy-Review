'use strict';
/** Comments on your PRs, the weekly recap, quiet hours, profile pictures and personal accounts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const logic = require('../server/logic');
const { createFakeAdo, ME } = require('../demo/fake-ado');

const quietLog = { info() {}, warn() {}, error() {} };
const ctx = { org: 'contoso', myId: 'me', groups: new Map(), webBase: 'https://dev.azure.com' };

const comment = (by, extra = {}) => ({ commentType: 'text', content: 'x', author: { id: by, displayName: by.toUpperCase() }, publishedDate: extra.at || '2026-10-01T10:00:00Z', ...extra });

test('summarizeThreads: open threads and the ones waiting for your answer', () => {
  const threads = [
    { status: 'active', comments: [comment('ann'), comment('me')] }, // you answered last
    { status: 'active', comments: [comment('bob', { at: '2026-10-02T10:00:00Z' })] }, // waiting on you
    { status: 'fixed', comments: [comment('cat')] }, // resolved
    { status: 'active', comments: [{ commentType: 'system', content: 'voted' }] }, // system noise
    { status: 'active', isDeleted: true, comments: [comment('dan')] },
  ];
  assert.deepEqual(logic.summarizeThreads(threads, 'me'), { open: 2, total: 3, waitingOnYou: 1, fromOthers: 3, lastBy: 'BOB' });
  assert.deepEqual(logic.summarizeThreads([], 'me'), { open: 0, total: 0, waitingOnYou: 0, fromOthers: 0, lastBy: null });
});

test('diff: a new comment from someone else on your PR is an event (not on first sight)', () => {
  const mine = (n) => ({ ...logic.toItem({ pullRequestId: 5, title: 'Mine', createdBy: { id: 'me' }, reviewers: [], repository: { project: {} } }, ctx), comments: { fromOthers: n, lastBy: 'Bob' } });
  const r1 = logic.diff({}, [mine(1)], { knownOrgs: new Set(['contoso']) });
  assert.equal(r1.events.length, 0);
  const r2 = logic.diff(r1.snapshot, [mine(2)], { knownOrgs: new Set(['contoso']) });
  assert.deepEqual(r2.events.map((e) => e.title), ['Bob commented on your PR']);
  // A round where comments couldn't load keeps the old count (no false alarm later).
  const r3 = logic.diff(r2.snapshot, [{ ...mine(0), comments: undefined }], { knownOrgs: new Set(['contoso']) });
  assert.equal(r3.snapshot['contoso#5'].othersComments, 2);
});

test('weekRecap counts this week since Monday', () => {
  const at = (d, h = 10) => new Date(2026, 9, d, h).getTime(); // October 2026; Mon 12th
  const reviews = [
    { key: 'a', at: at(9) }, // last Friday: not this week
    { key: 'b', at: at(12) },
    { key: 'c', at: at(13) },
    { key: 'd', at: at(13) },
    { key: 'd', at: at(13, 15) }, // same PR same day: once
    { key: 'e', at: at(16) },
  ];
  const r = logic.weekRecap(reviews, at(16, 17));
  assert.deepEqual(r, { week: '2026-10-12', count: 4, bestDay: 'Tuesday', bestCount: 2 });
});

function makeInbox(settings = {}) {
  const { Inbox } = require('../server/inbox');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-inbox-'));
  const toasts = [];
  const inbox = new Inbox({
    config: { DATA_DIR: dir, WEB_BASE: 'https://dev.azure.com' },
    ado: {},
    auth: {},
    log: quietLog,
    notify: (n) => toasts.push(n),
    suppressToast: () => false,
  });
  Object.assign(inbox.state.settings, settings);
  return { inbox, toasts, dir };
}

test('quiet hours: no desktop popups outside work hours, but the event is kept', async () => {
  const { inbox, toasts, dir } = makeInbox({ quietHours: true, workStart: 9, workEnd: 18 });
  assert.equal(inbox.inWorkHours(new Date(2026, 9, 13, 10).getTime()), true); // Tuesday 10:00
  assert.equal(inbox.inWorkHours(new Date(2026, 9, 13, 20).getTime()), false); // Tuesday 20:00
  assert.equal(inbox.inWorkHours(new Date(2026, 9, 17, 10).getTime()), false); // Saturday
  inbox.inWorkHours = () => false;
  inbox.emit({ type: 'new', title: 'Evening PR', body: '' });
  inbox.inWorkHours = () => true;
  inbox.emit({ type: 'new', title: 'Daytime PR', body: '' });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(toasts.map((t) => t.title), ['Daytime PR']);
  assert.equal(inbox.recentEvents().length, 2);
  inbox.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('weekly recap: Friday afternoon, once per week, only with reviews', async () => {
  const { inbox, toasts, dir } = makeInbox({ workStart: 9, workEnd: 18 });
  const fri = (h) => new Date(2026, 9, 16, h).getTime();
  inbox.state.reviews = [{ key: 'x', at: new Date(2026, 9, 14, 11).getTime() }, { key: 'y', at: new Date(2026, 9, 14, 12).getTime() }];
  assert.equal(inbox.maybeRecap(new Date(2026, 9, 15, 17).getTime()), null, 'not on Thursday');
  assert.equal(inbox.maybeRecap(fri(11)), null, 'not Friday morning');
  const evt = inbox.maybeRecap(fri(17));
  assert.equal(evt.title, 'Your week: 2 reviews 🎉');
  assert.equal(evt.body, 'best day Wednesday (2)');
  assert.equal(inbox.maybeRecap(fri(17) + 60000), null, 'once per week');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(toasts.length, 1);
  inbox.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- through the app with the fake Azure DevOps ----------------------------------------

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function api(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { 'X-Daddy-Review': '1', 'Content-Type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('profile pictures, comment notifications and personal-account sign-in through the app', async (t) => {
  const fake = await createFakeAdo({ autoLogin: true }).listen(0);
  Object.assign(process.env, fake.env());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-feat-'));
  const port = await freePort();
  const { createApp } = require('../server');
  const toasts = [];
  const app = await createApp({ PORT: port, DATA_DIR: dir, NO_AZ: true, log: quietLog, notify: (n) => toasts.push(n) }).listen();
  t.after(async () => {
    await app.close();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Personal Microsoft account: signs in through the "common" endpoint.
  const login = await api(port, 'POST', '/api/login', { personal: true });
  assert.match(login.body.url, /\/login\/common\/oauth2\/v2\.0\/authorize\?/);
  const auth = await fetch(login.body.url, { redirect: 'manual' });
  const back = new URL(auth.headers.get('location'));
  assert.equal((await get(port, `/${back.search}`)).status, 200);

  let r = await api(port, 'POST', '/api/refresh');
  assert.equal(r.body.auth.signedIn, true);
  assert.equal(r.body.settings.tenant, 'common');

  // Your PRs carry comment summaries.
  const mine = r.body.inbox.items.filter((i) => i.state === 'mine');
  const byId = Object.fromEntries(mine.map((i) => [i.id, i.comments]));
  assert.deepEqual(byId[1200], { open: 1, total: 1, waitingOnYou: 1, fromOthers: 1, lastBy: 'Jonas Weber' });
  assert.equal(byId[1184].waitingOnYou, 1, 'Noah\'s thread was answered by you, Lucas\' was not');
  assert.equal(byId[1184].open, 2);

  // Someone comments on your PR -> event + desktop popup.
  fake.control.comment('contoso', 1206, 'mia', 'Can you add the escalation phone numbers?');
  r = await api(port, 'POST', '/api/refresh');
  const evt = r.body.events.find((e) => e.type === 'comment');
  assert.equal(evt.title, 'Mia Chen commented on your PR');
  assert.equal(evt.body, 'Docs: on-call runbook');
  await new Promise((res) => setTimeout(res, 600));
  assert.ok(toasts.some((n) => n.title === 'Mia Chen commented on your PR' && n.key === 'contoso#1206'));

  // Profile pictures load with your sign-in; missing ones become a transparent pixel.
  const priya = r.body.inbox.items.find((i) => i.id === 1201).author.image;
  assert.match(priya, /MemberAvatars\/p-priya$/);
  let img = await get(port, `/avatar?u=${encodeURIComponent(priya)}`);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/svg+xml');
  const emma = r.body.inbox.items.find((i) => i.id === 1207).author.image;
  img = await get(port, `/avatar?u=${encodeURIComponent(emma)}`);
  assert.equal(img.type, 'image/png');
  assert.ok(img.body.length < 100);
  // Never sends your token anywhere else.
  assert.equal(app.ado.isAdoHost('https://evil.example.com/a.png'), false);
  assert.equal(app.ado.isAdoHost('https://dev.azure.com/contoso/_apis/GraphProfile/MemberAvatars/x'), true);
  assert.equal(app.ado.isAdoHost('https://contoso.visualstudio.com/_api/_common/identityImage?id=1'), true);
  assert.equal(app.ado.isAdoHost('http://dev.azure.com/x'), false);
  img = await get(port, `/avatar?u=${encodeURIComponent('https://evil.example.com/a.png')}`);
  assert.equal(img.type, 'image/png');

  // Updates exist only in the desktop app.
  assert.equal((await api(port, 'POST', '/api/update/check')).status, 400);
  assert.equal(r.body.app.update, null);
});

test('personal accounts refresh through "consumers"', async () => {
  const { Auth } = require('../server/auth');
  const seen = [];
  const auth = new Auth({
    config: { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-msa-')), LOGIN_BASE: 'https://login.example', CLIENT_ID: 'c', ADO_RESOURCE: 'r', PORT: 1 },
    getSettings: () => ({ tenant: 'common' }),
    log: quietLog,
    fetch: async (url) => {
      seen.push(url);
      return { status: 200, json: async () => ({ access_token: 'a.b.c', refresh_token: 'rt2', expires_in: 3600 }) };
    },
  });
  auth.saved = { refreshToken: 'rt', homeTenant: '9188040d-6c67-4c5b-b112-36a304b66dad', user: { name: ME.name } };
  auth.persist = () => {};
  await auth.getToken();
  assert.equal(seen[0], 'https://login.example/consumers/oauth2/v2.0/token');
});
