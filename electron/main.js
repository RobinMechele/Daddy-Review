'use strict';
/**
 * Daddy Review desktop app.
 *
 * One process: the engine (server/core.js) runs right here and the window talks
 * to it over IPC. No web server, no ports, nothing to host. The app lives in the
 * tray so it can pop up desktop notifications while its window is closed.
 */
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, protocol, nativeImage, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ICON = path.join(PUBLIC, 'icons', 'icon-512.png');
const ORIGIN = 'app://daddy';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const argv = process.argv.slice(1);
const DEMO = argv.includes('--demo') || process.env.DADDY_DEMO === '1';
const START_HIDDEN = argv.includes('--hidden');
// Tests: complete sign-in without a real browser.
const HEADLESS_LOGIN = DEMO || process.env.DADDY_TEST_LOGIN === 'fetch';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
if (DEMO) app.setPath('userData', path.join(app.getPath('temp'), 'daddy-review-demo'));
if (process.env.DADDY_USER_DATA) app.setPath('userData', process.env.DADDY_USER_DATA);
// Windows ties notifications to this id (the installer's Start menu shortcut uses the same one).
app.setAppUserModelId(app.isPackaged ? 'app.daddyreview' : process.execPath);

let core = null;
let loopback = null;
let mainWin = null;
let miniWin = null;
let tray = null;
let fake = null;
let quitting = false;
let booted = false;
const ui = { count: 0, bg: '#0a0e19', fg: '#e8ebf4' };
const liveNotifications = new Set(); // keep references so click handlers survive GC

// ---- start ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening the app again (Start menu, shortcut) just brings the running one forward.
  app.on('second-instance', () => booted && showMain());
  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox('Daddy Review could not start', String((e && e.stack) || e));
    app.exit(1);
  });
}

async function boot() {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  if (DEMO) {
    // A fresh, fake Azure DevOps with live activity, to try things without an account.
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { pollMinutes: 1 } }));
    const { createFakeAdo } = require('../demo/fake-ado');
    fake = await createFakeAdo({ autoLogin: true, simulate: true }).listen(0);
    Object.assign(process.env, fake.env(), { DADDY_DEMO: '1', DADDY_NO_AZ: '1' });
  }

  const { createCore } = require('../server/core');
  const { createLoopbackLogin } = require('../server/loopback');
  core = createCore({
    DATA_DIR: dataDir,
    logFile: path.join(userData, 'daddy-review.log'),
    quiet: app.isPackaged,
    notify: showNotification,
    // When you're looking at the window it shows the news itself.
    suppressToast: () => !!(mainWin && mainWin.isVisible() && mainWin.isFocused()),
    host: { desktop: true, login: () => loopback.start(), autostart },
  });
  loopback = createLoopbackLogin({
    auth: core.auth,
    log: core.log,
    openExternal,
    onSignedIn: () => {
      core.inbox.onSignIn().then(() => broadcast('daddy:refresh'));
      broadcast('daddy:refresh');
      showMain();
    },
  });

  registerProtocol();
  registerIpc();
  createTray();
  createMain();
  firstRun();
  booted = true;
  core.start();
}

function firstRun() {
  if (!app.isPackaged || DEMO) return;
  const marker = path.join(app.getPath('userData'), 'first-run-done');
  if (fs.existsSync(marker)) return;
  // A review assistant is only useful when it's running: start with Windows by default (Settings can turn it off).
  try { autostart.set(true); } catch { /* not fatal */ }
  fs.writeFileSync(marker, new Date().toISOString());
}

async function openExternal(url) {
  if (HEADLESS_LOGIN) {
    // Demo/tests: the fake Microsoft sign-in redirects straight back to us.
    await fetch(url, { redirect: 'follow' }).catch((e) => core.log.warn(`Demo sign-in: ${e.message}`));
    return;
  }
  await shell.openExternal(url);
}

// ---- the UI: served from inside the app as app://daddy/ --------------------------------

function registerProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'daddy') return new Response('Not found', { status: 404 });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad path', { status: 400 });
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
      if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP;
      return new Response(data, { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const trusted = (e) => {
  const url = (e.senderFrame && e.senderFrame.url) || '';
  return url === ORIGIN || url.startsWith(`${ORIGIN}/`);
};

function registerIpc() {
  ipcMain.handle('daddy:api', async (e, req) => {
    if (!trusted(e) || !req || typeof req.path !== 'string') return { status: 403, data: { error: 'Forbidden' } };
    return core.call(String(req.method || 'GET'), req.path, { body: req.body });
  });
  ipcMain.handle('daddy:mini', (e) => (trusted(e) ? openMini() : false));
  ipcMain.on('daddy:show-main', (e) => trusted(e) && showMain());
  ipcMain.on('daddy:badge', (e, msg) => trusted(e) && msg && setBadge(msg.count, msg.png));
  ipcMain.on('daddy:titlebar', (e, colors) => trusted(e) && colors && applyTitleBar(colors));
}

function broadcast(channel, data) {
  for (const w of [mainWin, miniWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

// ---- windows -------------------------------------------------------------------------

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
});

function titleBar(height) {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: ui.bg, symbolColor: ui.fg, height } };
}

function guard(win) {
  // PR links open in your normal browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(`${ORIGIN}/`)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x >= a.x - 50 && b.y >= a.y - 50 && b.x < a.x + a.width - 100 && b.y < a.y + a.height - 100);
    return visible ? b : { width: b.width, height: b.height, maximized: b.maximized };
  } catch {
    return {};
  }
}

function saveBounds() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...mainWin.getNormalBounds(), maximized: mainWin.isMaximized() }));
  } catch { /* not important */ }
}

function createMain() {
  const b = savedBounds();
  mainWin = new BrowserWindow({
    width: b.width || 1120,
    height: b.height || 800,
    x: b.x,
    y: b.y,
    minWidth: 400,
    minHeight: 520,
    show: false,
    title: 'Daddy Review',
    icon: ICON,
    backgroundColor: ui.bg,
    autoHideMenuBar: true,
    ...titleBar(44),
    webPreferences: webPreferences(),
  });
  if (b.maximized) mainWin.maximize();
  guard(mainWin);
  mainWin.loadURL(`${ORIGIN}/`);
  mainWin.once('ready-to-show', () => {
    if (!START_HIDDEN) mainWin.show();
  });
  mainWin.on('close', (e) => {
    saveBounds();
    if (quitting) return;
    // Closing the window keeps the assistant running in the tray.
    e.preventDefault();
    mainWin.hide();
    trayHintOnce();
  });
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMain();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function openMini() {
  if (miniWin && !miniWin.isDestroyed()) {
    miniWin.show();
    miniWin.focus();
    return true;
  }
  const { workArea } = screen.getPrimaryDisplay();
  miniWin = new BrowserWindow({
    width: 340,
    height: 540,
    x: workArea.x + workArea.width - 360,
    y: workArea.y + workArea.height - 560,
    minWidth: 280,
    minHeight: 320,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Daddy Review',
    icon: ICON,
    backgroundColor: ui.bg,
    ...titleBar(34),
    webPreferences: webPreferences(),
  });
  miniWin.setAlwaysOnTop(true, 'floating');
  guard(miniWin);
  miniWin.loadURL(`${ORIGIN}/?mini=1`);
  miniWin.once('ready-to-show', () => miniWin.show());
  miniWin.on('closed', () => {
    miniWin = null;
  });
  return true;
}

function applyTitleBar({ bg, fg }) {
  const color = /^#[0-9a-f]{6}$/i;
  if (!color.test(bg) || !color.test(fg)) return;
  ui.bg = bg;
  ui.fg = fg;
  for (const w of [mainWin, miniWin]) {
    if (!w || w.isDestroyed()) continue;
    w.setBackgroundColor(bg);
    if (process.platform !== 'darwin' && w.setTitleBarOverlay) w.setTitleBarOverlay({ color: bg, symbolColor: fg });
  }
}

// ---- tray, badge, notifications -----------------------------------------------------------

function trayImage() {
  const img = nativeImage.createEmpty();
  for (const [scale, file] of [[1, 'tray-16.png'], [2, 'tray-32.png']]) {
    img.addRepresentation({ scaleFactor: scale, buffer: fs.readFileSync(path.join(PUBLIC, 'icons', file)) });
  }
  return img;
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch (e) {
    core.log.warn(`No tray icon: ${e.message}`);
    return;
  }
  tray.on('click', () => {
    if (mainWin && mainWin.isVisible() && mainWin.isFocused()) mainWin.hide();
    else showMain();
  });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const login = process.platform === 'win32' ? 'Windows' : 'login';
  tray.setToolTip(ui.count ? `Daddy Review · ${ui.count} to review` : 'Daddy Review');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: ui.count ? `${ui.count} PR${ui.count > 1 ? 's' : ''} to review` : 'Nothing to review', enabled: false },
    { type: 'separator' },
    { label: 'Open Daddy Review', click: showMain },
    { label: 'Mini window', click: openMini },
    { label: 'Refresh', click: () => core.inbox.poll({ force: true }).then(() => broadcast('daddy:refresh')) },
    { type: 'separator' },
    { label: `Start with ${login}`, type: 'checkbox', checked: autostart.status().enabled, click: (item) => autostart.set(item.checked) },
    { type: 'separator' },
    { label: 'Quit Daddy Review', click: quit },
  ]));
}

function setBadge(count, png) {
  const n = Math.max(0, Number(count) || 0);
  ui.count = n;
  updateTray();
  if (process.platform === 'win32') {
    if (!mainWin || mainWin.isDestroyed()) return;
    const ok = typeof png === 'string' && png.startsWith('data:image/png;base64,');
    mainWin.setOverlayIcon(n && ok ? nativeImage.createFromDataURL(png) : null, n ? `${n} to review` : '');
  } else {
    app.setBadgeCount(n);
  }
}

function showNotification({ title, body, url, key }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body || '', icon: ICON });
  liveNotifications.add(n);
  const forget = () => liveNotifications.delete(n);
  n.on('click', () => {
    forget();
    if (key && url && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      broadcast('daddy:opened', { key });
    } else {
      showMain();
    }
  });
  n.on('close', forget);
  n.show();
  setTimeout(forget, 10 * 60e3).unref();
}

function trayHintOnce() {
  const marker = path.join(app.getPath('userData'), 'tray-hint-shown');
  if (fs.existsSync(marker)) return;
  fs.writeFileSync(marker, '1');
  showNotification({ title: 'Still here 👋', body: 'Daddy Review keeps watching your PRs from the tray. Right-click the tray icon to quit.' });
}

// ---- start with Windows / login -------------------------------------------------------------

const loginArgs = () => (app.isPackaged ? ['--hidden'] : [path.resolve(argv[0] || '.'), '--hidden']);
const linuxAutostartFile = () => path.join(app.getPath('appData'), 'autostart', 'daddy-review.desktop');

const autostart = {
  status() {
    if (DEMO) return { supported: false, enabled: false, platform: process.platform };
    if (process.platform === 'linux') return { supported: true, enabled: fs.existsSync(linuxAutostartFile()), platform: 'linux' };
    return { supported: true, enabled: app.getLoginItemSettings({ args: loginArgs() }).openAtLogin, platform: process.platform };
  },
  set(enabled) {
    if (DEMO) return this.status();
    if (process.platform === 'linux') {
      const file = linuxAutostartFile();
      if (enabled) {
        const exe = process.env.APPIMAGE || process.execPath;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Daddy Review\nExec="${exe}" ${loginArgs().map((a) => `"${a}"`).join(' ')}\nX-GNOME-Autostart-enabled=true\n`);
      } else {
        fs.rmSync(file, { force: true });
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true, args: loginArgs() });
    }
    updateTray();
    return this.status();
  },
};

// ---- quit ---------------------------------------------------------------------------

function quit() {
  quitting = true;
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  saveBounds();
  if (core) core.stop();
  if (loopback) loopback.cancel();
  if (fake) fake.close();
});

// Keep running in the tray when all windows are closed.
app.on('window-all-closed', () => {});
app.on('activate', () => booted && showMain());
