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
    step('opens on the sign-in screen, sandboxed');

    await win.click('[data-act="signin"]');
    await win.waitForSelector('.hero .next-title', { timeout: 20000 });
    assert.equal(await win.textContent('.hero .next-title'), 'Fix rounding error in invoice totals');
    const counts = await win.$$eval('.tab .count', (els) => els.map((e) => e.textContent));
    assert.deepEqual(counts, ['7', '1', '3', '3']);
    step('signs in and loads the review queue');

    await win.click('#list .card:nth-child(3) .card-row');
    await win.waitForSelector('.details .files li');
    step('shows PR details');

    await win.click('.hero [data-act="vote"]');
    await win.waitForSelector('.toast.in');
    await win.waitForFunction(() => document.querySelector('.hero .goal-num')?.textContent.trim().startsWith('1'));
    step('approves from the app (goal 1/5)');

    await win.click('.hero [data-act="review"]');
    await win.waitForFunction(() => true);
    const opened = await app.evaluate(() => global.__opened);
    assert.equal(opened.length, 1);
    assert.match(opened[0], /\/pullrequest\/\d+$/);
    step('"Review now" opens the PR in your browser');

    const [mini] = await Promise.all([app.waitForEvent('window'), win.click('.top-actions [data-act="pip"]')]);
    await mini.waitForSelector('.mini-next, .mini-session');
    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), top: w.isAlwaysOnTop() })));
    assert.ok(windows.some((w) => w.url.includes('mini=1') && w.top), 'mini window stays on top');
    await mini.screenshot({ path: path.join(SHOTS, 'app-mini.png') });
    step('mini window opens, always on top');

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

/** The installed app without --demo: a first start, like after running the installer. */
async function firstStart() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-first-'));
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
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main()
  .then(() => (EXE ? firstStart() : null))
  .then(() => console.log('\nDesktop app: all checks passed.')).catch((e) => {
  console.error(e);
  process.exit(1);
});
