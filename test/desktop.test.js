'use strict';
/**
 * The desktop app's path: the engine called directly (as over Electron IPC) and
 * sign-in through the system browser with a short-lived localhost listener.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createFakeAdo, ME } = require('../demo/fake-ado');

const quietLog = { info() {}, warn() {}, error() {} };

test('desktop sign-in via system browser + loopback, then the queue loads over direct calls', async (t) => {
  const fake = await createFakeAdo({ autoLogin: true }).listen(0);
  Object.assign(process.env, fake.env());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-desktop-'));
  const { createCore } = require('../server/core');
  const { createLoopbackLogin } = require('../server/loopback');

  const opened = [];
  const toasts = [];
  let focused = false;
  let loopback = null;
  let signedIn = null;
  const signedInPromise = new Promise((r) => { signedIn = r; });
  const core = createCore({
    DATA_DIR: dataDir,
    NO_AZ: true,
    log: quietLog,
    notify: (n) => toasts.push(n),
    suppressToast: () => focused,
    host: { desktop: true, login: () => loopback.start(), autostart: { status: () => ({ supported: true, enabled: false }), set: (e) => ({ supported: true, enabled: e }) } },
  });
  loopback = createLoopbackLogin({
    auth: core.auth,
    log: quietLog,
    // Stands in for the user's browser: follow Microsoft's redirect back to us.
    openExternal: async (url) => {
      opened.push(url);
      const r = await fetch(url, { redirect: 'follow' });
      assert.match(await r.text(), /You&#39;re signed in|You're signed in/);
    },
    onSignedIn: () => signedIn(),
  });
  t.after(async () => {
    core.stop();
    loopback.cancel();
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  let r = await core.call('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.data.auth.signedIn, false);
  assert.equal(r.data.app.desktop, true);

  r = await core.call('POST', '/api/login');
  assert.deepEqual(r.data, { started: true });
  await signedInPromise;
  const redirect = new URL(opened[0]).searchParams.get('redirect_uri');
  assert.match(redirect, /^http:\/\/localhost:\d+$/);

  r = await core.call('POST', '/api/refresh');
  assert.equal(r.data.auth.signedIn, true);
  assert.equal(r.data.profile.name, ME.name);
  assert.equal(r.data.inbox.counts.todo, 7);

  // The loopback listener is gone once sign-in is done.
  await assert.rejects(fetch(redirect));

  // Query strings and errors come back as { status, data }, never as exceptions.
  r = await core.call('GET', `/api/pr?key=${encodeURIComponent('contoso#1201')}`);
  assert.equal(r.data.fileCount, 2);
  assert.equal((await core.call('GET', '/api/nope')).status, 404);
  assert.equal((await core.call('POST', '/api/vote', { body: { key: 'contoso#1201', vote: 3 } })).status, 400);
  assert.deepEqual((await core.call('POST', '/api/autostart', { body: { enabled: true } })).data, { supported: true, enabled: true });

  // Notifications: shown while the window isn't focused, held back while it is.
  fake.control.newPr({ title: 'Popup please', files: 1 });
  await core.call('POST', '/api/refresh');
  focused = true;
  fake.control.newPr({ title: 'No popup, I am looking', files: 1 });
  await core.call('POST', '/api/refresh');
  await new Promise((res) => setTimeout(res, 600));
  assert.deepEqual(toasts.map((n) => n.title), ['New review request']);
  assert.match(toasts[0].body, /Popup please/);
  assert.match(toasts[0].key, /^contoso#\d+$/);
  assert.match(toasts[0].url, /^http/);
});

test('a cancelled or failed Microsoft sign-in shows a clear page and leaves you signed out', async (t) => {
  const { createCore } = require('../server/core');
  const { createLoopbackLogin } = require('../server/loopback');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-desktop-'));
  const core = createCore({ DATA_DIR: dataDir, NO_AZ: true, log: quietLog });
  let page = '';
  const loopback = createLoopbackLogin({
    auth: core.auth,
    log: quietLog,
    openExternal: async (url) => {
      const redirect = new URL(url).searchParams.get('redirect_uri');
      const r = await fetch(`${redirect}/?error=access_denied&error_description=${encodeURIComponent('AADSTS65004: User declined to consent.')}`);
      page = await r.text();
    },
  });
  t.after(() => {
    loopback.cancel();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await loopback.start();
  assert.match(page, /Sign-in didn&#39;t finish/);
  assert.match(page, /User declined to consent\./);
  assert.doesNotMatch(page, /AADSTS/);
  assert.equal(core.auth.status().signedIn, false);
});
