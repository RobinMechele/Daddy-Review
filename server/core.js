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
      app: { version: config.VERSION, demo: config.DEMO, platform: process.platform, desktop: !!host.desktop },
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
    'POST /api/login': () => (host.login ? host.login() : { url: auth.beginLogin() }),
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
    'GET /api/pr': ({ query }) => inbox.details(String(query.key)),
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

  return {
    config,
    log,
    auth,
    ado,
    inbox,
    state,
    call,
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
