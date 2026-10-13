'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { readJson, writeJson } = require('./util');

/**
 * Azure DevOps sign-in without a PAT.
 *
 *  1. "Sign in with Microsoft": OAuth 2.0 authorization code + PKCE against
 *     Entra ID with a loopback redirect to this local server. The refresh token
 *     is kept in ~/.daddy-review/auth.json so you stay signed in.
 *  2. Azure CLI: if `az login` was done on this machine we silently borrow its
 *     token (`az account get-access-token`), so there is nothing to click.
 */

const EXTRA_SCOPES = 'offline_access openid profile';
// Personal Microsoft accounts all live in this tenant; they refresh via "consumers".
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const SAFE_TENANT = /^[\w.-]{1,100}$/;

class AuthRequired extends Error {
  constructor(message = 'Sign in required') {
    super(message);
    this.code = 'AUTH_REQUIRED';
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function userFromClaims(c) {
  return {
    name: c.name || [c.given_name, c.family_name].filter(Boolean).join(' ') || '',
    email: c.preferred_username || c.upn || c.unique_name || c.email || '',
    tenant: c.tid || null,
  };
}

function defaultRunAz(args) {
  return new Promise((resolve, reject) => {
    const done = (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(String(stdout));
    const opts = { timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 };
    // On Windows `az` is a .cmd shim, which needs a shell. Args are constants or validated.
    if (process.platform === 'win32') exec(`az ${args.map((a) => `"${a}"`).join(' ')}`, opts, done);
    else execFile('az', args, opts, done);
  });
}

class Auth {
  constructor({ config, getSettings, log, fetch = globalThis.fetch, runAz = defaultRunAz }) {
    this.config = config;
    this.getSettings = getSettings;
    this.log = log;
    this.fetch = fetch;
    this.runAz = runAz;
    this.file = path.join(config.DATA_DIR, 'auth.json');
    const saved = readJson(this.file, null);
    this.saved = saved && saved.refreshToken ? saved : null;
    this.tokens = new Map(); // tenant key -> { token, exp }
    this.inflight = new Map();
    this.pending = new Map(); // oauth state -> { verifier, authority, at }
    this.az = { ok: null, user: null, failedAt: 0 };
    this.checking = false;
    this.lastError = null;
  }

  get redirectUri() {
    return `http://localhost:${this.config.PORT}`;
  }

  get authority() {
    const t = this.getSettings().tenant;
    return SAFE_TENANT.test(t || '') ? t : 'organizations';
  }

  useAz() {
    return !this.config.NO_AZ && this.getSettings().useAzCli !== false;
  }

  status() {
    if (this.saved) return { signedIn: true, method: 'microsoft', user: this.saved.user };
    if (this.az.ok && this.useAz()) return { signedIn: true, method: 'azcli', user: this.az.user };
    return { signedIn: false, method: null, user: null, checking: this.checking, error: this.lastError };
  }

  /** Silent sign-in attempt (Azure CLI) used at startup. */
  async probe() {
    if (this.saved || !this.useAz()) return this.status();
    this.checking = true;
    try {
      await this.getToken();
    } catch { /* not signed in, that's fine */ }
    this.checking = false;
    return this.status();
  }

  homeTenant() {
    return (this.saved && this.saved.homeTenant) || (this.az.user && this.az.user.tenant) || null;
  }

  keyFor(tenant) {
    return !tenant || tenant === this.homeTenant() ? 'home' : tenant;
  }

  /** Access token for Azure DevOps, optionally for a specific Entra tenant. */
  async getToken(tenant) {
    const key = this.keyFor(tenant);
    const cached = this.tokens.get(key);
    if (cached && cached.exp - 120000 > Date.now()) return cached.token;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.acquire(key === 'home' ? null : tenant).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async acquire(tenant) {
    let result;
    if (this.saved && !this.saved.refreshToken) {
      this.clear('Your sign-in expired. Please sign in again.');
      throw new AuthRequired(this.lastError);
    }
    if (this.saved) result = await this.refresh(tenant);
    else if (this.useAz()) result = await this.azToken(tenant);
    else throw new AuthRequired();
    this.tokens.set(this.keyFor(tenant), result);
    return result.token;
  }

  invalidate(tenant) {
    this.tokens.delete(this.keyFor(tenant));
  }

  async refresh(tenant) {
    const home = this.saved.homeTenant === MSA_TENANT ? 'consumers' : this.saved.homeTenant;
    const authority = tenant || home || this.authority;
    const json = await this.tokenRequest(authority, {
      grant_type: 'refresh_token',
      refresh_token: this.saved.refreshToken,
    });
    if (json.error || !json.access_token) {
      const msg = String(json.error_description || json.error || 'Token refresh failed').split(/\r?\n/)[0];
      if (!tenant && ['invalid_grant', 'interaction_required', 'invalid_client', 'unauthorized_client'].includes(json.error)) {
        this.log.warn(`Sign-in expired: ${msg}`);
        this.clear('Your sign-in expired. Please sign in again.');
        throw new AuthRequired(this.lastError);
      }
      const err = new Error(msg);
      err.code = tenant ? 'TENANT_AUTH' : 'TOKEN_ERROR';
      throw err;
    }
    if (json.refresh_token && json.refresh_token !== this.saved.refreshToken) {
      this.saved.refreshToken = json.refresh_token;
      this.persist();
    }
    return { token: json.access_token, exp: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  }

  async azToken(tenant) {
    if (!tenant && this.az.ok === false && Date.now() - this.az.failedAt < 60000) throw new AuthRequired();
    const args = ['account', 'get-access-token', '--resource', this.config.ADO_RESOURCE, '--output', 'json'];
    if (tenant) {
      if (!SAFE_TENANT.test(tenant)) throw new Error('Invalid tenant');
      args.push('--tenant', tenant);
    }
    let out;
    try {
      out = JSON.parse(await this.runAz(args));
      if (!out.accessToken) throw new Error('No token in Azure CLI output');
    } catch (e) {
      if (tenant) {
        const err = new Error('Azure CLI has no access to this organization\'s tenant');
        err.code = 'TENANT_AUTH';
        throw err;
      }
      if (this.az.ok) this.log.warn('Azure CLI sign-in is no longer available');
      this.az = { ok: false, user: null, failedAt: Date.now() };
      throw new AuthRequired();
    }
    const claims = decodeJwt(out.accessToken);
    if (!tenant) {
      if (!this.az.ok) this.log.info('Signed in via Azure CLI');
      this.az = { ok: true, user: userFromClaims(claims), failedAt: 0 };
    }
    return { token: out.accessToken, exp: claims.exp ? claims.exp * 1000 : Date.now() + 30 * 60000 };
  }

  async tokenRequest(authority, params) {
    const body = new URLSearchParams({
      client_id: this.config.CLIENT_ID,
      scope: `${this.config.ADO_RESOURCE}/.default ${EXTRA_SCOPES}`,
      ...params,
    });
    let res;
    try {
      res = await this.fetch(`${this.config.LOGIN_BASE}/${encodeURIComponent(authority)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      const err = new Error(`Can't reach Microsoft sign-in (${(e.cause && e.cause.code) || e.message})`);
      err.code = 'NETWORK';
      throw err;
    }
    try {
      return await res.json();
    } catch {
      return { error: 'bad_response', error_description: `Sign-in server answered HTTP ${res.status}` };
    }
  }

  /**
   * Returns the Microsoft sign-in URL (auth code + PKCE). `redirectUri` is the
   * localhost address that receives the answer (any port is allowed for loopback).
   */
  beginLogin({ redirectUri = this.redirectUri } = {}) {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > 15 * 60000) this.pending.delete(k);
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const authority = this.authority;
    this.pending.set(state, { verifier, authority, redirectUri, at: now });
    const q = new URLSearchParams({
      client_id: this.config.CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: `${this.config.ADO_RESOURCE}/.default ${EXTRA_SCOPES}`,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${this.config.LOGIN_BASE}/${encodeURIComponent(authority)}/oauth2/v2.0/authorize?${q}`;
  }

  async completeLogin({ code, state }) {
    const p = this.pending.get(state);
    if (!p || !code) throw new Error('This sign-in attempt expired. Please try again.');
    this.pending.delete(state);
    const json = await this.tokenRequest(p.authority, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    });
    if (json.error || !json.access_token) {
      throw new Error(String(json.error_description || json.error || 'Sign-in failed').split(/\r?\n/)[0]);
    }
    const claims = decodeJwt(json.access_token);
    const idClaims = json.id_token ? decodeJwt(json.id_token) : {};
    const user = userFromClaims({ ...claims, ...idClaims, tid: claims.tid || idClaims.tid });
    this.saved = {
      method: 'microsoft',
      refreshToken: json.refresh_token || null,
      homeTenant: claims.tid || idClaims.tid || null,
      user,
      savedAt: new Date().toISOString(),
    };
    this.tokens.clear();
    this.tokens.set('home', { token: json.access_token, exp: Date.now() + (Number(json.expires_in) || 3600) * 1000 });
    this.lastError = null;
    if (this.saved.refreshToken) this.persist();
    this.log.info(`Signed in as ${user.email || user.name || 'unknown user'}`);
    return user;
  }

  logout() {
    const method = this.status().method;
    this.clear(null);
    return method;
  }

  clear(reason) {
    this.saved = null;
    this.lastError = reason || null;
    this.tokens.clear();
    try { fs.unlinkSync(this.file); } catch { /* not there */ }
  }

  persist() {
    writeJson(this.file, this.saved, 0o600);
  }
}

module.exports = { Auth, AuthRequired, decodeJwt };
