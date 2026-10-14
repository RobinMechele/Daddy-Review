'use strict';
const fs = require('fs');
const { loadConfig } = require('./config');
const { Auth } = require('./auth');
const { Ado } = require('./ado');
const { Inbox } = require('./inbox');
const { createLogger, HttpError } = require('./util');

/**
 * The engine of Daddy Review: sign-in, Azure DevOps, the review queue.
 * The desktop app talks to it over Electron IPC; the browser dev mode and the
 * tests go through a thin HTTP wrapper (server/index.js). Same calls either way.
 *
 * `host` lets the shell plug in what only it can do:
 *   host.login()      start sign-in (desktop: system browser + loopback)
 *   host.autostart    { status(), set(enabled) } for "start with Windows"
 *   host.update       { status(), check(), install() } automatic updates
 *   host.hotkey       { status() } the global shortcut
 *   host.onSettings   called after settings change
 */
function createCore(overrides = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const log = overrides.log || createLogger({ file: overrides.logFile || null, quiet: !!overrides.quiet });
  const host = overrides.host || {};

  let inbox = null;
  const auth = new Auth({ config, log, getSettings: () => inbox.settings, fetch: overrides.fetch, runAz: overrides.runAz });
  const ado = new Ado({ auth, config, log, fetch: overrides.fetch });
  inbox = new Inbox({ config, ado, auth, log, notify: overrides.notify || (() => {}), suppressToast: overrides.suppressToast });

  function state() {
    const a = auth.status();
    const user = inbox.profile || a.user;
    return {
      app: {
        version: config.VERSION,
        demo: config.DEMO,
        platform: process.platform,
        desktop: !!host.desktop,
        update: host.update ? host.update.status() : null,
        hotkey: host.hotkey ? host.hotkey.status() : null,
      },
      auth: a,
      profile: user ? { name: user.name, email: user.email } : null,
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
    'GET /api/state': ({ meta }) => {
      if (meta.canNotify !== undefined) inbox.markClient(meta.canNotify);
      return state();
    },
    'POST /api/refresh': async () => {
      await withTimeout(inbox.poll({ force: true }), 45000);
      return state();
    },
    'POST /api/login': ({ body }) => {
      // Personal Microsoft accounts sign in through the "common" endpoint (work accounts still work there too).
      if (body.personal) inbox.updateSettings({ tenant: 'common' });
      return host.login ? host.login() : { url: auth.beginLogin() };
    },
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
      if (host.onSettings) host.onSettings(inbox.settings);
      if (orgsChanged) await withTimeout(inbox.poll({ force: true }), 20000);
      return state();
    },
    'POST /api/update/check': () => {
      if (!host.update) throw new HttpError(400, 'Updates are not available here');
      host.update.check();
      return state();
    },
    'POST /api/update/install': () => {
      if (!host.update) throw new HttpError(400, 'Updates are not available here');
      host.update.install();
      return { ok: true };
    },
    'GET /api/pr': ({ query }) => inbox.details(String(query.key)),
    'GET /api/repos': ({ query }) => inbox.repoChoices(String(query.org || '')),
    'GET /api/autostart': () => (host.autostart ? host.autostart.status() : { supported: false, enabled: false }),
    'POST /api/autostart': ({ body }) => {
      if (!host.autostart) throw new HttpError(400, 'Not available here');
      return host.autostart.set(!!body.enabled);
    },
  };

  /** Handle one API call. Never throws: returns { status, data }. */
  async function call(method, rawPath, { body = {}, meta = {} } = {}) {
    let url;
    try {
      url = new URL(String(rawPath), 'http://core');
    } catch {
      return { status: 400, data: { error: 'Bad path' } };
    }
    const route = routes[`${String(method).toUpperCase()} ${url.pathname}`];
    if (!route) return { status: 404, data: { error: 'Not found' } };
    try {
      const data = await route({ body: body && typeof body === 'object' ? body : {}, query: Object.fromEntries(url.searchParams), meta });
      return { status: 200, data };
    } catch (e) {
      let status = 500;
      if (e.code === 'AUTH_REQUIRED') status = 401;
      else if (e instanceof HttpError) status = e.status;
      else if (['ADO', 'ADO_ACCESS', 'TENANT_AUTH', 'NETWORK'].includes(e.code)) status = 502;
      if (status === 500) log.error(`${method} ${url.pathname}: ${e.stack || e.message}`);
      return { status, data: { error: e.message || 'Something went wrong', code: e.code || null } };
    }
  }

  // Profile pictures: fetched with your token, kept in memory for a while.
  const images = new Map();
  async function image(url) {
    const hit = images.get(url);
    if (hit && hit.pending) return hit.pending;
    if (hit && Date.now() - hit.at < (hit.img ? 12 * 36e5 : 30 * 60e3)) {
      if (hit.img) return hit.img;
      throw new HttpError(404, 'No image');
    }
    const pending = ado.image(url).then(
      (img) => { images.set(url, { img, at: Date.now() }); return img; },
      (e) => {
        images.set(url, { img: null, at: Date.now() });
        throw e.code === 'AUTH_REQUIRED' ? e : new HttpError(404, 'No image');
      },
    );
    images.set(url, { pending, at: Date.now() });
    if (images.size > 600) images.delete(images.keys().next().value);
    return pending;
  }

  return {
    config,
    log,
    auth,
    ado,
    inbox,
    state,
    call,
    image,
    async start() {
      await auth.probe();
      inbox.start();
    },
    stop() {
      inbox.stop();
    },
  };
}

module.exports = { createCore };
