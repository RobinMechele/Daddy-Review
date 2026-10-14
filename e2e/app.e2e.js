#!/usr/bin/env node
'use strict';
/**
 * Drives the real desktop app (Electron) in demo mode: sign in, see the queue,
 * vote, open a PR, the mini window, closing to the tray.
 *   npm run test:app            (Linux CI: xvfb-run -a npm run test:app)
 * Set DADDY_APP_EXE to an installed app (e.g. ...\Daddy Review.exe) to test the
 * real installed build instead of the source; that also checks the non-demo
 * first start (sign-in screen, "start with Windows" switched on).
 * Screenshots go to e2e/screenshots/.
 */
const { _electron: electron } = require('playwright-core');
const http = require('http');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');
const EXE = process.env.DADDY_APP_EXE || null;
// Containers (root) and Ubuntu CI runners can't use Chromium's sandbox; real installs do.
const NO_SANDBOX = process.platform === 'linux' && ((process.getuid && process.getuid() === 0) || !!process.env.CI);

function launch(extraArgs, userData) {
  const args = [...(EXE ? [] : [ROOT]), ...extraArgs, ...(NO_SANDBOX ? ['--no-sandbox'] : [])];
  return electron.launch({
    ...(EXE ? { executablePath: EXE } : {}),
    args,
    env: { ...process.env, DADDY_USER_DATA: userData },
    colorScheme: process.env.DADDY_SHOT_THEME || 'dark',
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(EXE ? `Installed app: ${EXE}` : 'App from source');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-app-'));
  const app = await launch(['--demo'], userData);
  const errors = [];
  const step = (name) => console.log(`  ✓ ${name}`);
  try {
    // PR links must go to the real browser: record instead of opening one.
    await app.evaluate(({ shell }) => {
      global.__opened = [];
      shell.openExternal = async (url) => { global.__opened.push(url); };
    });

    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await win.waitForSelector('.signin-card');
    assert.equal(await win.evaluate(() => typeof window.daddyNative), 'object');
    assert.equal(await win.evaluate(() => typeof window.require), 'undefined', 'no Node.js in the page');
    assert.ok(await win.evaluate(() => document.documentElement.classList.contains('native')));
    await win.screenshot({ path: path.join(SHOTS, 'app-signin.png') });
    assert.ok(await win.isVisible('[data-act="signin-personal"]'), 'personal account option');
    step('opens on the sign-in screen, sandboxed');

    await win.click('[data-act="signin"]');
    await win.waitForSelector('.hero .next-title', { timeout: 20000 });
    assert.equal(await win.textContent('.hero .next-title'), 'Fix rounding error in invoice totals');
    const counts = await win.$$eval('.tab .count', (els) => els.map((e) => e.textContent));
    assert.deepEqual(counts, ['9', '1', '3', '2', '3']);
    step('signs in and loads the review queue');

    await win.waitForFunction(() => [...document.querySelectorAll('#list img.av-img')].some((i) => i.complete && i.naturalWidth > 1), null, { timeout: 10000 });
    step('shows Azure DevOps profile pictures');

    await win.click('#list .card:nth-child(3) .card-row');
    await win.waitForSelector('.details .files li');
    step('shows PR details');

    await win.fill('#filter', 'tokenizer');
    await win.waitForFunction(() => document.querySelectorAll('#list .cards > .card').length === 1);
    assert.match(await win.textContent('#list .card-title'), /tokenizer/i);
    await win.fill('#filter', 'zzz-nothing');
    await win.waitForSelector('text=No matches');
    await win.fill('#filter', '');
    await win.waitForFunction(() => document.querySelectorAll('#list .cards > .card').length > 1);
    step('search filters the list');

    await win.click('.tab[data-tab="mine"]');
    await win.waitForSelector('#list .chip.accent');
    const answer = await win.$$eval('#list .chip.accent', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(answer.includes('1 to answer'), `comments waiting on you: ${answer}`);
    await win.click('.tab[data-tab="todo"]');
    step('your PRs show comments waiting for your answer');

    await win.click('.top-actions [data-act="settings"]');
    await win.waitForSelector('.drawer');
    assert.ok(await win.isVisible('.drawer [data-setting="quietHours"]'));
    assert.ok(await win.isVisible('.drawer [data-setting="hotkey"]'));
    step('settings: work-hours-only popups and global shortcut');

    // Watch a repository: every active PR in it shows up, also ones that don't ask for you.
    assert.match(await win.textContent('.drawer [data-act="repos"][data-org="contoso"]'), /All repositories/);
    await win.click('.drawer [data-act="repos"][data-org="contoso"]');
    await win.waitForSelector('.picker [data-pick="repo"]');
    await win.fill('#repo-filter', 'mobile');
    await win.waitForFunction(() => document.querySelectorAll('.picker [data-pick="repo"]').length === 1);
    await win.screenshot({ path: path.join(SHOTS, 'app-repos.png') });
    await win.check('.picker [data-pick="repo"]');
    await win.click('.picker [data-act="repos-save"]');
    await win.waitForSelector('.picker', { state: 'detached' });
    assert.match(await win.textContent('.drawer [data-act="repos"][data-org="contoso"]'), /Watching mobile-app/);
    step('pick repositories to watch');

    // Clicking around in Settings doesn't rebuild the panel (no slide-in again, no jump to the top).
    await win.evaluate(() => { document.querySelector('aside.drawer').dataset.probe = '1'; });
    await win.evaluate(() => { document.querySelector('aside.drawer').scrollTop = 200; });
    const before = await win.evaluate(() => document.querySelector('aside.drawer').scrollTop);
    await win.click('.drawer [data-setting="quietHours"]');
    await win.waitForSelector('.drawer [data-setting="quietHours"].on');
    await win.click('.drawer [data-act="goal"][data-d="1"]');
    await win.waitForTimeout(400);
    const panel = await win.evaluate(() => ({ probe: document.querySelector('aside.drawer').dataset.probe, top: document.querySelector('aside.drawer').scrollTop }));
    assert.equal(panel.probe, '1', 'same panel, not rebuilt');
    assert.equal(panel.top, before, 'keeps its scroll position');
    await win.click('.drawer [data-setting="quietHours"]');
    await win.click('.drawer [data-act="goal"][data-d="-1"]');
    await win.waitForSelector('.drawer [data-setting="quietHours"]:not(.on)');
    await win.click('.drawer [data-act="close-settings"]');
    step('settings stay put while you change them');

    // Others: open PRs that don't ask for you; add yourself as reviewer.
    await win.click('.tab[data-tab="other"]');
    await win.waitForSelector('#list .card [data-act="pickup"]');
    assert.match(await win.textContent('#list .card-title'), /Offline mode for order history/);
    await win.screenshot({ path: path.join(SHOTS, 'app-others.png') });
    await win.click('#list .card [data-act="pickup"]');
    await win.waitForFunction(() => document.querySelector('.tab[data-tab="todo"] .count')?.textContent === '10');
    assert.equal(await win.$('.tab[data-tab="other"] .count'), null);
    await win.click('.tab[data-tab="todo"]');
    step('see PRs that don\'t ask for you, and pick one up');

    await win.click('.hero [data-act="vote"]');
    await win.waitForSelector('.toast.in');
    await win.waitForFunction(() => document.querySelector('.hero .goal-num')?.textContent.trim().startsWith('1'));
    step('approves from the app (goal 1/5)');

    // The whole review inside the app.
    await win.click('.hero [data-act="review"]');
    await win.waitForSelector('.rv-overview');
    assert.equal(await app.evaluate(() => global.__opened.length), 0, 'stays in the app');
    const reviewTitle = await win.textContent('.rv-title h1');
    await win.click('.rv-file .rv-item >> nth=0');
    await win.waitForSelector('.diff .dl.t-add');
    await win.hover('.diff .dl.t-add >> nth=0');
    await win.click('.diff .dl.t-add .add-c >> nth=0');
    await win.fill('.composer textarea', 'Can we **name** this better?');
    await win.keyboard.press('Control+Enter');
    await win.waitForFunction(() => [...document.querySelectorAll('.diff .thread .md b')].some((b) => b.textContent === 'name'));
    step('review in the app: diff, comment on a line');

    await win.fill('.diff .thread textarea', 'Or keep it, fine either way.');
    await win.click('.diff .thread [data-act="rv-reply"]');
    await win.waitForFunction(() => document.querySelectorAll('.diff .thread .cm').length === 2);
    await win.click('.diff .thread [data-act="rv-status"]');
    await win.waitForSelector('.diff .thread.resolved');
    await win.check('.rv-filebar [data-viewed]');
    await win.waitForSelector('.rv-file.viewed');
    await win.screenshot({ path: path.join(SHOTS, 'app-review.png') });
    step('reply, resolve and mark files as viewed');

    await win.click('.rv-head [data-act="rv-vote"][data-vote="10"]');
    await win.waitForSelector('.rv-head .vote-pill.on[data-vote="10"]');
    await win.waitForSelector('.rv-head [data-act="rv-next-pr"]');
    await win.click('.rv-head [data-act="rv-open"]');
    const opened = await app.evaluate(() => global.__opened);
    assert.equal(opened.length, 1);
    assert.match(opened[0], /\/pullrequest\/\d+$/);
    await win.keyboard.press('Escape');
    await win.waitForSelector('.hero');
    assert.notEqual(await win.textContent('.hero .next-title'), reviewTitle);
    step('approve from the review, "Next PR", open in Azure DevOps');

    // Comments others left on lines show on those lines.
    await win.click('.tab[data-tab="done"]');
    await win.click('#list .card[data-key="contoso#1201"] [data-act="review-app"]');
    await win.waitForSelector('.rv-overview .th-file');
    await win.click('.rv-overview .th-file');
    await win.waitForSelector('.diff .thread');
    assert.match(await win.textContent('.diff .thread'), /overflow/);
    await win.click('.rv-head [data-act="rv-back"]');
    await win.click('.tab[data-tab="todo"]');
    step('comments on lines show on those lines');

    // The goal ring's check mark stands upright.
    await win.click('.top-actions [data-act="settings"]');
    for (let i = 0; i < 3; i++) await win.click('.drawer [data-act="goal"][data-d="-1"]');
    await win.click('.drawer [data-act="close-settings"]');
    await win.waitForSelector('.hero .goal-done .goal-num .ic');
    assert.equal(await win.$eval('.hero .goal-num .ic', (el) => getComputedStyle(el).transform), 'none');
    await win.click('.top-actions [data-act="settings"]');
    for (let i = 0; i < 3; i++) await win.click('.drawer [data-act="goal"][data-d="1"]');
    await win.click('.drawer [data-act="close-settings"]');
    step('goal reached: the check mark is upright');

    const [mini] = await Promise.all([app.waitForEvent('window'), win.click('.top-actions [data-act="pip"]')]);
    await mini.waitForSelector('.mini-next, .mini-session');
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), top: w.isAlwaysOnTop() })));
    assert.ok(windows.some((w) => w.url.includes('mini=1') && w.top), 'mini window stays on top');
    await mini.screenshot({ path: path.join(SHOTS, 'app-mini.png') });
    step('mini window opens, always on top');

    // "Review" in the mini window opens the review in the main window.
    await mini.click('.mini-next [data-act="review"]');
    await win.waitForSelector('.rv-head');
    await win.keyboard.press('Escape');
    await win.waitForSelector('.hero');
    step('the mini window opens reviews in the main window');

    await win.bringToFront();
    await win.waitForTimeout(500);
    await win.screenshot({ path: path.join(SHOTS, 'app-main.png') });

    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('mini=1'));
      w.close();
    });
    await new Promise((r) => setTimeout(r, 500));
    const state = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), visible: w.isVisible() })));
    assert.ok(state.some((w) => !w.url.includes('mini=1') && !w.visible), 'closing hides to the tray');
    step('closing the window keeps it running in the tray');

    assert.deepEqual(errors, []);
    step('no errors in the app');
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

/**
 * A local update feed offering "version 99.0.0" (the file in DADDY_UPDATE_TEST_FILE),
 * so we can see the installed app find, download and verify an update.
 */
async function startUpdateFeed(file) {
  const data = fs.readFileSync(file);
  const name = 'Daddy-Review-Setup-99.0.0.exe';
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const yml = `version: 99.0.0\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${data.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-10-13T00:00:00.000Z'\n`;
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (/^\/latest(-linux|-mac)?\.yml$/.test(p)) {
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      return res.end(yml);
    }
    if (p === `/${name}`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
      return res.end(data);
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

/** The installed app without --demo: a first start, like after running the installer. */
async function firstStart() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-first-'));
  const feed = process.env.DADDY_UPDATE_TEST_FILE ? await startUpdateFeed(process.env.DADDY_UPDATE_TEST_FILE) : null;
  if (feed) process.env.DADDY_UPDATE_URL = feed.url;
  const app = await launch([], userData);
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.signin-card');
    // Usable right away, even while it looks for an Azure CLI login.
    assert.match(await win.textContent('[data-act="signin"]'), /Sign in with Microsoft/);
    assert.equal(await win.isEnabled('[data-act="signin"]'), true);
    const info = await app.evaluate(({ app: a, Notification }) => ({
      packaged: a.isPackaged,
      autostart: a.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
      notifications: Notification.isSupported(),
    }));
    assert.equal(info.packaged, true);
    console.log(`  ✓ first start shows sign-in (packaged, notifications supported: ${info.notifications})`);
    if (process.platform !== 'linux') {
      assert.equal(info.autostart, true, 'starts with Windows after the first run');
      console.log('  ✓ "start with Windows" is on after the first run');
      await app.evaluate(({ app: a }) => a.setLoginItemSettings({ openAtLogin: false, args: ['--hidden'] }));
    }
    if (feed) {
      // Self-updating builds (Windows, AppImage) download it; others just report it.
      const selfUpdate = process.platform === 'win32' || !!process.env.APPIMAGE;
      const want = selfUpdate ? 'ready' : 'available';
      await win.evaluate(() => window.daddyNative.api('POST', '/api/update/check'));
      const deadline = Date.now() + 180000;
      let st = null;
      while (Date.now() < deadline) {
        st = (await win.evaluate(() => window.daddyNative.api('GET', '/api/state'))).data.app.update;
        if (st.status === want || st.status === 'error') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.equal(st.status, want, `update status: ${JSON.stringify(st)}`);
      assert.equal(st.version, '99.0.0');
      console.log(`  ✓ finds a new version and ${selfUpdate ? 'downloads + verifies it (ready to restart)' : 'offers the download'}`);
    }
  } finally {
    if (feed) feed.close();
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

/** The installed app checking the real GitHub Releases feed (no test feed). */
async function githubUpdateCheck() {
  delete process.env.DADDY_UPDATE_URL;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-gh-'));
  const app = await launch([], userData);
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.signin-card');
    await win.evaluate(() => window.daddyNative.api('POST', '/api/update/check'));
    let st = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      st = (await win.evaluate(() => window.daddyNative.api('GET', '/api/state'))).data.app.update;
      if (st && !['idle', 'checking'].includes(st.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`  GitHub says: ${st.status}${st.version ? ` (${st.version})` : ''} for installed ${st.current}`);
    assert.notEqual(st.status, 'error', `update check failed: ${st.error}`);
    assert.ok(['none', 'available', 'downloading', 'ready'].includes(st.status));
    console.log('  ✓ checks GitHub Releases for updates');
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

const only = process.env.DADDY_E2E_ONLY;
(only === 'github-update' ? githubUpdateCheck() : main().then(() => (EXE ? firstStart() : null)))
  .then(() => console.log('\nDesktop app: all checks passed.')).catch((e) => {
  console.error(e);
  process.exit(1);
});
