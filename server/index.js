#!/usr/bin/env node
'use strict';
/**
 * Browser mode, for development and the tests: serves the same UI over
 * http://localhost and forwards /api calls to the core. The desktop app
 * (electron/main.js) doesn't use this; it talks to the core directly.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCore } = require('./core');
const { resultPage, cleanSignInError, BLANK_PNG } = require('./pages');
const { HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function createApp(overrides = {}) {
  const core = createCore(overrides);
  const { config, auth, inbox, log } = core;
  const hosts = new Set([`localhost:${config.PORT}`, `127.0.0.1:${config.PORT}`, `[::1]:${config.PORT}`]);

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
        if (size > 100 * 1024) {
          reject(new HttpError(413, 'Too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'Bad JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  async function handleApi(req, res, url) {
    // Only our own page can call the API: other sites can't send this header without a CORS preflight we never allow.
    if (req.headers['x-daddy-review'] !== '1') return json(res, 403, { error: 'Forbidden' });
    const origin = req.headers.origin;
    if (origin && !hosts.has(origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'Forbidden' });
    let body = {};
    if (req.method === 'POST') {
      try {
        body = await readBody(req);
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }
    const meta = req.headers['x-daddy-notify'] ? { canNotify: req.headers['x-daddy-notify'] === 'granted' } : {};
    const r = await core.call(req.method, url.pathname + url.search, { body, meta });
    return json(res, r.status, r.data);
  }

  async function handleCallback(req, res, url) {
    let page;
    if (url.searchParams.has('error')) {
      page = resultPage({ ok: false, title: 'Sign-in didn\'t finish', message: cleanSignInError(url.searchParams.get('error_description') || url.searchParams.get('error')) });
    } else {
      try {
        await auth.completeLogin({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
        inbox.onSignIn();
        page = resultPage({ ok: true, title: 'You\'re signed in', message: 'Loading your pull requests…', closePopup: true });
      } catch (e) {
        log.warn(`Sign-in failed: ${e.message}`);
        page = resultPage({ ok: false, title: 'Sign-in failed', message: e.message });
      }
    }
    send(res, page.status, page.html, page.headers);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'Bad path');
    }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(config.PUBLIC_DIR, rel));
    if (!file.startsWith(config.PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      const ext = path.extname(file);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
      if (ext === '.html') headers['Content-Security-Policy'] = CSP;
      send(res, 200, req.method === 'HEAD' ? undefined : data, headers);
    });
  }

  async function handle(req, res) {
    if (!hosts.has(String(req.headers.host || ''))) return send(res, 403, 'Forbidden host');
    const url = new URL(req.url, `http://localhost:${config.PORT}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname === '/avatar') {
      try {
        const img = await core.image(String(url.searchParams.get('u')));
        return send(res, 200, img.data, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=3600' });
      } catch {
        return send(res, 200, BLANK_PNG, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=600' });
      }
    }
    if (url.pathname === '/' && (url.searchParams.has('code') || url.searchParams.has('error'))) return handleCallback(req, res, url);
    return serveStatic(req, res, url);
  }

  const servers = [];
  const app = {
    ...core,
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
      const v6 = make();
      await new Promise((resolve) => {
        v6.once('error', () => resolve());
        v6.listen(config.PORT, '::1', () => {
          servers.push(v6);
          resolve();
        });
      });
      return app;
    },
    async close() {
      core.stop();
      await Promise.all(servers.map((s) => new Promise((r) => {
        if (s.closeAllConnections) s.closeAllConnections();
        s.close(() => r());
      })));
    },
  };
  return app;
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  try {
    if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], opts).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts).on('error', () => {}).unref();
  } catch { /* the URL is printed anyway */ }
}

async function main(argv) {
  const app = createApp();
  try {
    await app.listen();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${app.config.PORT} is in use. Start with DADDY_PORT=4281 (or another free port).`);
      process.exit(1);
    }
    throw e;
  }
  const url = `http://localhost:${app.config.PORT}`;
  console.log(`\n  ✦ Daddy Review (browser dev mode) at ${url}\n    The desktop app is "npm start". Ctrl+C to stop.\n`);
  if (!argv.includes('--no-open')) openBrowser(url);
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

module.exports = { createApp, openBrowser };
