#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { loadConfig } = require('./config');
const { Auth } = require('./auth');
const { Ado } = require('./ado');
const { Inbox } = require('./inbox');
const { createNotifier } = require('./notify');
const autostart = require('./autostart');
const { createLogger, HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const log = overrides.log || createLogger({
    file: config.BACKGROUND ? path.join(config.DATA_DIR, 'server.log') : null,
    quiet: config.BACKGROUND || overrides.quiet,
  });

  let inbox = null;
  const auth = new Auth({ config, log, getSettings: () => inbox.settings, fetch: overrides.fetch, runAz: overrides.runAz });
  const ado = new Ado({ auth, config, log, fetch: overrides.fetch });
  const notify = overrides.notify || createNotifier({ log });
  inbox = new Inbox({ config, ado, auth, log, notify });

  const hosts = new Set([`localhost:${config.PORT}`, `127.0.0.1:${config.PORT}`, `[::1]:${config.PORT}`]);

  function state() {
    const a = auth.status();
    return {
      app: { version: config.VERSION, demo: config.DEMO, port: config.PORT, platform: process.platform },
      auth: a,
      profile: inbox.profile ? { name: inbox.profile.name, email: inbox.profile.email } : a.user ? { name: a.user.name, email: a.user.email } : null,
      settings: { ...inbox.settings },
      orgs: inbox.orgList(),
      inbox: inbox.view(),
      stats: inbox.stats(),
      events: inbox.recentEvents(),
    };
  }

  const withTimeout = (p, ms) => {
    let timer;
    return Promise.race([p, new Promise((r) => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
  };

  const routes = {
    'GET /api/ping': () => ({ app: 'daddy-review', version: config.VERSION }),
    'GET /api/state': ({ req }) => {
      inbox.markClient(req.headers['x-daddy-notify'] === 'granted');
      return state();
    },
    'POST /api/refresh': async () => {
      await withTimeout(inbox.poll({ force: true }), 45000);
      return state();
    },
    'POST /api/login': () => ({ url: auth.beginLogin() }),
    'POST /api/logout': () => {
      auth.logout();
      // Signing out means signed out: don't silently come back in through Azure CLI.
      inbox.updateSettings({ useAzCli: false });
      inbox.onSignOut();
      return state();
    },
    'POST /api/use-azcli': async () => {
      inbox.updateSettings({ useAzCli: true });
      auth.az.failedAt = 0;
      auth.az.ok = null;
      await auth.probe();
      if (auth.status().signedIn) await withTimeout(inbox.onSignIn(), 45000);
      return state();
    },
    'POST /api/vote': async ({ body }) => {
      const r = await inbox.vote(String(body.key), Number(body.vote), { undo: !!body.undo });
      return { ...state(), prevVote: r.prevVote };
    },
    'POST /api/snooze': ({ body }) => {
      const until = body.until === null ? null : body.hours ? Date.now() + Number(body.hours) * 36e5 : body.until;
      inbox.snooze(String(body.key), until);
      return state();
    },
    'POST /api/settings': async ({ body }) => {
      const { orgsChanged } = inbox.updateSettings(body || {});
      if (orgsChanged) await withTimeout(inbox.poll({ force: true }), 20000);
      return state();
    },
    'GET /api/pr': ({ url }) => inbox.details(String(url.searchParams.get('key'))),
    'GET /api/autostart': () => autostart.status(),
    'POST /api/autostart': ({ body }) => autostart.set(!!body.enabled),
    'POST /api/shutdown': () => {
      setTimeout(() => app.close().then(() => process.exit(0)), 100);
      return { ok: true };
    },
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(body);
  }

  const json = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 100 * 1024) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Bad JSON')); }
      });
      req.on('error', reject);
    });
  }

  async function handleApi(req, res, url) {
    // Only our own pages can call the API: cross-site pages can't send this header without a CORS preflight we never allow.
    if (req.headers['x-daddy-review'] !== '1') return json(res, 403, { error: 'Forbidden' });
    const origin = req.headers.origin;
    if (origin && !hosts.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'Forbidden' });
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return json(res, 404, { error: 'Not found' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      json(res, 200, await route({ req, body, url }));
    } catch (e) {
      let status = 500;
      if (e.code === 'AUTH_REQUIRED') status = 401;
      else if (e instanceof HttpError) status = e.status;
      else if (e.code === 'ADO' || e.code === 'ADO_ACCESS' || e.code === 'TENANT_AUTH') status = 502;
      if (status === 500) log.error(`${req.method} ${url.pathname}: ${e.stack || e.message}`);
      json(res, status, { error: e.message || 'Something went wrong', code: e.code || null });
    }
  }

  function page(res, status, { title, message, ok }) {
    const nonce = crypto.randomBytes(12).toString('base64');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Daddy Review</title><link rel="icon" href="/icons/icon.svg">
<style nonce="${nonce}">
:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;background:#0b0f1a;color:#e6e9f2}
@media (prefers-color-scheme:light){body{background:#f5f6fb;color:#0f172a}.card{background:#fff!important}}
.card{background:#131a2b;border-radius:20px;padding:36px 40px;text-align:center;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.dot{width:64px;height:64px;border-radius:50%;margin:0 auto 18px;display:grid;place-items:center;font-size:30px;color:#fff;background:${ok ? 'linear-gradient(135deg,#22c55e,#22d3ee)' : 'linear-gradient(135deg,#f43f5e,#f59e0b)'}}
h1{font-size:20px;margin:0 0 6px}p{margin:0;opacity:.7}a{color:#7c5cff}
</style></head><body><div class="card"><div class="dot">${ok ? '✓' : '!'}</div><h1>${esc(title)}</h1><p>${esc(message)}</p>${ok ? '' : '<p style="margin-top:14px"><a href="/">Back to Daddy Review</a></p>'}</div>
${ok ? `<script nonce="${nonce}">try{window.opener&&window.opener.postMessage({type:"daddy-signed-in"},location.origin)}catch(e){}setTimeout(function(){window.close();location.replace("/")},900)</script>` : ''}
</body></html>`;
    send(res, status, html, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self'`,
    });
  }

  async function handleCallback(req, res, url) {
    const error = url.searchParams.get('error');
    if (error) {
      const desc = String(url.searchParams.get('error_description') || error).split(/\r?\n/)[0].replace(/^AADSTS\d+:\s*/, '');
      return page(res, 400, { title: 'Sign-in didn\'t finish', message: desc.slice(0, 300) });
    }
    try {
      await auth.completeLogin({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
      inbox.onSignIn();
      page(res, 200, { title: 'You\'re signed in', message: 'Loading your pull requests…', ok: true });
    } catch (e) {
      log.warn(`Sign-in failed: ${e.message}`);
      page(res, 400, { title: 'Sign-in failed', message: e.message });
    }
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad path'); }
    if (rel === '/' || rel === '/index.html') rel = '/index.html';
    const file = path.normalize(path.join(config.PUBLIC_DIR, rel));
    if (!file.startsWith(config.PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) {
        // Unknown paths without an extension fall back to the app shell.
        if (!path.extname(rel)) return serveStatic(req, res, new URL('/', config.APP_URL));
        return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      }
      const ext = path.extname(file);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
      if (ext === '.html') headers['Content-Security-Policy'] = CSP;
      if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
      send(res, 200, req.method === 'HEAD' ? undefined : data, headers);
    });
  }

  async function handle(req, res) {
    if (!hosts.has(String(req.headers.host || ''))) return send(res, 403, 'Forbidden host');
    const url = new URL(req.url, config.APP_URL);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname === '/' && (url.searchParams.has('code') || url.searchParams.has('error'))) return handleCallback(req, res, url);
    return serveStatic(req, res, url);
  }

  const servers = [];
  const app = {
    config,
    auth,
    ado,
    inbox,
    log,
    state,
    async listen() {
      const make = () => http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          log.error(e.stack || e.message);
          if (!res.headersSent) send(res, 500, 'Internal error');
        });
      });
      const primary = make();
      await new Promise((resolve, reject) => {
        primary.once('error', reject);
        primary.listen(config.PORT, '127.0.0.1', resolve);
      });
      servers.push(primary);
      // Browsers may resolve "localhost" to ::1 first; listen there too when IPv6 exists.
      const v6 = make();
      await new Promise((resolve) => {
        v6.once('error', () => resolve());
        v6.listen(config.PORT, '::1', () => { servers.push(v6); resolve(); });
      });
      return app;
    },
    async start() {
      await auth.probe();
      inbox.start();
    },
    async close() {
      inbox.stop();
      await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); })));
    },
  };
  return app;
}

// ---- command line ---------------------------------------------------------------

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  try {
    if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], opts).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).on('error', () => {}).unref();
  } catch { /* the URL is printed anyway */ }
}

/** Talk to an already-running instance (127.0.0.1 with the Host header it expects). */
function localRequest(config, method, pathname) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: config.PORT,
      method,
      path: pathname,
      headers: { 'X-Daddy-Review': '1', Host: `localhost:${config.PORT}` },
      timeout: 1500,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function ping(config) {
  const j = await localRequest(config, 'GET', '/api/ping');
  return !!(j && j.app === 'daddy-review');
}

function spawnBackground() {
  spawn(process.execPath, [__filename, '--background'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.join(__dirname, '..'),
    env: process.env,
  }).unref();
}

async function waitUntilUp(config, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ping(config)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main(argv) {
  const flags = new Set(argv);
  const config = loadConfig();
  const banner = (lines) => console.log(['', '  ✦ Daddy Review', ...lines.map((l) => `    ${l}`), ''].join('\n'));

  if (flags.has('--help') || flags.has('-h')) {
    banner([
      'node server/index.js             start and open the app',
      'node server/index.js --install   start in background + launch at login',
      'node server/index.js --uninstall stop and remove from login',
      '  --background  no browser, log to ~/.daddy-review/server.log',
      '  --no-open     do not open the browser',
    ]);
    return;
  }

  if (flags.has('--uninstall')) {
    autostart.disable();
    if (await ping(config)) {
      await localRequest(config, 'POST', '/api/shutdown');
    }
    banner(['Stopped and removed from login. Your settings stay in ~/.daddy-review.', 'Uninstall the app window via its ⋯ menu → Uninstall.']);
    return;
  }

  if (flags.has('--install')) {
    autostart.enable();
    if (!(await ping(config))) spawnBackground();
    const up = await waitUntilUp(config);
    banner([
      up ? `Running at ${config.APP_URL}` : 'Server did not start, run "npm start" to see why.',
      'Starts automatically when you log in.',
      'In the browser click "Install app" (or the ⊕ icon in the address bar).',
    ]);
    if (up) openBrowser(`${config.APP_URL}/?welcome=1`);
    return;
  }

  const background = flags.has('--background');
  const app = createApp({ BACKGROUND: background });
  try {
    await app.listen();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      if (await ping(config)) {
        if (!background && !flags.has('--no-open')) openBrowser(config.APP_URL);
        if (!background) banner([`Already running at ${config.APP_URL}`]);
        process.exit(0);
      }
      console.error(`Port ${config.PORT} is used by another program. Start with DADDY_PORT=4281 (or another free port).`);
      process.exit(1);
    }
    throw e;
  }
  if (!background) banner([`Running at ${config.APP_URL}`, 'Keep this window open, or run with --install to run in the background.', 'Ctrl+C to stop.']);
  app.log.info(`Daddy Review ${config.VERSION} listening on ${config.APP_URL}`);
  if (!background && !flags.has('--no-open')) openBrowser(config.APP_URL);
  app.start();

  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { createApp, main };
