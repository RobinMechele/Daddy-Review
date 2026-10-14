'use strict';
/**
 * End-to-end through the browser-mode HTTP wrapper: the real engine talking to
 * the fake Azure DevOps + fake Microsoft sign-in. Covers sign-in (PKCE), org discovery, the queue, votes, events,
 * desktop popups, persistence, token refresh and Azure CLI sign-in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createFakeAdo, ME } = require('../demo/fake-ado');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const quietLog = { info() {}, warn() {}, error() {} };

let fake;
let dataDir;
let port;
let app;
const toasts = [];

async function boot(extra = {}) {
  const { createApp } = require('../server');
  const a = createApp({ PORT: port, DATA_DIR: dataDir, NO_AZ: true, log: quietLog, notify: (t) => toasts.push(t), ...extra });
  await a.listen();
  return a;
}

/** Fresh connection per request (no keep-alive pool surviving server restarts). */
function api(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: p,
      agent: false,
      headers: { 'X-Daddy-Review': '1', 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const byKey = (state, key) => state.inbox.items.find((i) => i.key === key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  fake = await createFakeAdo({ autoLogin: true }).listen(0);
  Object.assign(process.env, fake.env());
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-test-'));
  port = await freePort();
  app = await boot();
});

test.after(async () => {
  if (app) await app.close();
  await fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('API rejects requests without the app header or from a foreign host', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(r.status, 403);
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example:80', 'X-Daddy-Review': '1' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
  const cross = await api('GET', '/api/state', null, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
});

test('serves the app shell with a strict CSP', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await r.text(), /Daddy Review/);
  const js = await fetch(`http://127.0.0.1:${port}/js/app.js`);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const trav = await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`);
  assert.notEqual(trav.status, 200);
});

test('starts signed out', async () => {
  const { body } = await api('GET', '/api/state');
  assert.equal(body.auth.signedIn, false);
  assert.equal(body.inbox.items.length, 0);
});

test('Microsoft sign-in with PKCE and loopback redirect', async () => {
  const { body } = await api('POST', '/api/login');
  const u = new URL(body.url);
  assert.equal(u.searchParams.get('redirect_uri'), `http://localhost:${port}`);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('scope'), /^499b84ac-1321-427f-aa17-267ca6975798\/\.default offline_access/);

  const auth = await fetch(body.url, { redirect: 'manual' });
  assert.equal(auth.status, 302);
  const back = new URL(auth.headers.get('location'));
  assert.equal(back.origin, `http://localhost:${port}`);
  const cb = await fetch(`http://127.0.0.1:${port}/${back.search}`);
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /signed in/);

  // Replaying the same code must fail (state is single use).
  const again = await fetch(`http://127.0.0.1:${port}/${back.search}`);
  assert.equal(again.status, 400);
  assert.ok(fs.existsSync(path.join(dataDir, 'auth.json')));
});

test('loads the review queue from all organizations', async () => {
  const { body } = await api('POST', '/api/refresh');
  assert.equal(body.auth.signedIn, true);
  assert.equal(body.auth.method, 'microsoft');
  assert.equal(body.profile.name, ME.name);
  assert.deepEqual(body.orgs.map((o) => o.name), ['contoso', 'fabrikam-labs']);
  const c = body.inbox.counts;
  assert.deepEqual({ todo: c.todo, waiting: c.waiting, done: c.done, mine: c.mine, draft: c.draft }, { todo: 9, waiting: 1, done: 2, mine: 3, draft: 1 });
  assert.equal(body.inbox.next, 'contoso#1201');
  const first = byKey(body, 'contoso#1201');
  assert.deepEqual(first.size, { files: 2, label: 'XS', exts: ['cs'] });
  assert.ok(first.reasons.includes('required'));
  assert.equal(byKey(body, 'contoso#1205').team, 'Platform Team');
  // A teammate approved for your team: still yours to review, ranked lower.
  assert.equal(byKey(body, 'contoso#1199').covered, true);
  assert.equal(byKey(body, 'contoso#1199').state, 'todo');
  // You're in the Payments team only through an Entra group: still found.
  assert.equal(byKey(body, 'contoso#1208').team, 'Payments Team');
  assert.equal(byKey(body, 'contoso#1208').state, 'todo');
  // Doesn't ask for you and you don't watch its repository.
  assert.equal(byKey(body, 'contoso#1209'), undefined);
  assert.equal(byKey(body, 'fabrikam-labs#309').conflicts, true);
  assert.match(first.url, /\/web\/contoso\/Payments\/_git\/payments-api\/pullrequest\/1201$/);
  assert.equal(body.events.length, 0, 'first load is a silent baseline');
});

test('voting approves in Azure DevOps, counts the review, and can be undone', async () => {
  const r = await api('POST', '/api/vote', { key: 'contoso#1201', vote: 10 });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.control.log.votes.at(-1), { org: 'contoso', id: 1201, reviewer: ME.id, vote: 10 });
  assert.equal(byKey(r.body, 'contoso#1201').state, 'done');
  assert.equal(r.body.stats.today, 1);
  assert.equal(r.body.prevVote, 0);

  const u = await api('POST', '/api/vote', { key: 'contoso#1201', vote: 0, undo: true });
  assert.equal(fake.control.log.votes.at(-1).vote, 0);
  assert.equal(byKey(u.body, 'contoso#1201').state, 'todo');
  assert.equal(u.body.stats.today, 0);

  // A refresh must not double count anything.
  const s = await api('POST', '/api/refresh');
  assert.equal(s.body.stats.today, 0);

  const bad = await api('POST', '/api/vote', { key: 'contoso#1201', vote: 7 });
  assert.equal(bad.status, 400);
  const missing = await api('POST', '/api/vote', { key: 'contoso#999999', vote: 10 });
  assert.equal(missing.status, 404);
});

test('detects new PRs, pushes after your vote and feedback on your PRs (with desktop popups)', async () => {
  toasts.length = 0;
  fake.control.newPr({ title: 'Hotfix: null check', files: 1, required: true });
  fake.control.pushCommit('contoso', 1169);
  fake.control.vote('contoso', 1200, 'jonas', 10);
  const { body } = await api('POST', '/api/refresh');
  const types = body.events.map((e) => e.type).sort();
  assert.deepEqual(types, ['feedback', 'new', 'updated']);
  assert.equal(body.events.find((e) => e.type === 'feedback').title, 'Jonas Weber approved');
  const updated = byKey(body, 'contoso#1169');
  assert.equal(updated.state, 'todo');
  assert.equal(updated.updated, true);
  await sleep(600);
  assert.equal(toasts.length, 3, 'no app window open -> native popups');
  assert.ok(toasts.every((t) => t.title && t.url));

  // With the app open (notifications granted), the server stays quiet.
  toasts.length = 0;
  await api('GET', '/api/state', null, { 'X-Daddy-Notify': 'granted' });
  fake.control.newPr({ title: 'Another one', files: 3 });
  await api('POST', '/api/refresh');
  await sleep(600);
  assert.equal(toasts.length, 0);
});

test('PR details: files and open comments', async () => {
  const { status, body } = await api('GET', `/api/pr?key=${encodeURIComponent('contoso#1176')}`);
  assert.equal(status, 200);
  assert.equal(body.fileCount, 12);
  assert.equal(body.threads.active, 1);
  assert.equal(body.threads.total, 1);
  assert.match(body.threads.latest[0].text, /Contrast/);
});

test('snooze hides a PR from the queue until later', async () => {
  const r = await api('POST', '/api/snooze', { key: 'contoso#1201', hours: 1 });
  const it = byKey(r.body, 'contoso#1201');
  assert.ok(it.snoozedUntil > Date.now());
  assert.notEqual(r.body.inbox.next, 'contoso#1201');
  const back = await api('POST', '/api/snooze', { key: 'contoso#1201', until: null });
  assert.equal(byKey(back.body, 'contoso#1201').snoozedUntil, null);
});

test('settings: disable an org, add one by URL, validate input', async () => {
  let r = await api('POST', '/api/settings', { toggleOrg: { name: 'fabrikam-labs', enabled: false } });
  assert.equal(r.body.inbox.items.some((i) => i.org === 'fabrikam-labs'), false);
  r = await api('POST', '/api/settings', { toggleOrg: { name: 'fabrikam-labs', enabled: true } });
  assert.equal(r.body.inbox.items.some((i) => i.org === 'fabrikam-labs'), true);
  r = await api('POST', '/api/settings', { dailyGoal: 8, pollMinutes: 5, nudges: false });
  assert.equal(r.body.settings.dailyGoal, 8);
  assert.equal(r.body.settings.pollMinutes, 5);
  assert.equal(r.body.stats.goal, 8);
  r = await api('POST', '/api/settings', { addOrg: 'https://dev.azure.com/contoso/Payments' });
  assert.equal(r.status, 200);
  assert.equal(r.body.orgs.filter((o) => o.name === 'contoso').length, 1);
  r = await api('POST', '/api/settings', { addOrg: '../../etc' });
  assert.equal(r.status, 400);
});

test('expired access tokens are refreshed silently', async () => {
  app.auth.tokens.clear();
  const before = fake.control.log.tokenRequests.filter((g) => g === 'refresh_token').length;
  const { body } = await api('POST', '/api/refresh');
  assert.equal(body.auth.signedIn, true);
  assert.equal(fake.control.log.tokenRequests.filter((g) => g === 'refresh_token').length, before + 1);
});

test('restart keeps you signed in, your stats and does not re-notify', async () => {
  await api('POST', '/api/vote', { key: 'contoso#1198', vote: -5 });
  const eventsBefore = (await api('GET', '/api/state')).body.events.length;
  await app.close();
  app = await boot();
  const { body } = await api('POST', '/api/refresh');
  assert.equal(body.auth.signedIn, true);
  assert.equal(body.stats.today, 1);
  assert.equal(byKey(body, 'contoso#1198').state, 'waiting');
  assert.equal(body.events.length, eventsBefore, 'no new events after restart');
});

test('sign out forgets the account', async () => {
  const { body } = await api('POST', '/api/logout');
  assert.equal(body.auth.signedIn, false);
  assert.equal(body.inbox.items.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'auth.json')), false);
});

test('Azure CLI sign-in works with zero clicks', async () => {
  await app.close();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-az-'));
  let calls = 0;
  app = await boot({
    DATA_DIR: dir,
    NO_AZ: false,
    runAz: async (args) => {
      calls++;
      assert.deepEqual(args.slice(0, 4), ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798']);
      return JSON.stringify({ accessToken: fake.control.issueToken(), tokenType: 'Bearer' });
    },
  });
  await app.auth.probe();
  const { body } = await api('POST', '/api/refresh');
  assert.equal(body.auth.method, 'azcli');
  assert.equal(body.inbox.counts.mine, 3);
  assert.ok(calls >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
