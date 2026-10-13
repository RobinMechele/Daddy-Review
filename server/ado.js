'use strict';
const { mapLimit } = require('./util');

class AdoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.code = status === 401 ? 'ADO_ACCESS' : 'ADO';
  }
}

// Built-in groups that are never meaningful "team" reviewers; skipping them saves calls.
const SKIP_GROUPS = /(^|\\)(Project Valid Users|Project Collection Valid Users|Readers|Build Administrators|Project Administrators|Project Collection Administrators|Project Collection Build Administrators|Project Collection Build Service Accounts|Project Collection Service Accounts|Project Collection Proxy Service Accounts|Project Collection Test Service Accounts|Security Service Group|Release Administrators|Endpoint Administrators|Endpoint Creators|Deployment Group Administrators)$/i;

/** Query string builder that leaves `$top` / `searchCriteria.x` keys readable. */
function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

/** Thin Azure DevOps REST client. Every call goes through `request`. */
class Ado {
  constructor({ auth, config, log, fetch = globalThis.fetch }) {
    this.auth = auth;
    this.config = config;
    this.log = log;
    this.fetch = fetch;
    this.orgTenant = new Map();
    this.orgLevelPrs = new Map();
    this.projectCache = new Map();
  }

  orgUrl(org) {
    return `${this.config.ADO_BASE}/${encodeURIComponent(org)}`;
  }

  async request(method, url, { org, body, retry = {} } = {}) {
    const tenant = org ? this.orgTenant.get(org) : undefined;
    const token = await this.auth.getToken(tenant);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          'X-TFS-FedAuthRedirect': 'Suppress',
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new AdoError(0, `Can't reach Azure DevOps (${(e.cause && e.cause.code) || e.message})`);
    }
    const text = await res.text();
    const isJson = (res.headers.get('content-type') || '').includes('json');

    if (res.status === 429 && !retry.throttle) {
      const wait = Math.min(10, Number(res.headers.get('retry-after')) || 3);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(method, url, { org, body, retry: { ...retry, throttle: true } });
    }

    // Azure DevOps answers bad/foreign tokens with 401, 203 + HTML or a redirect to sign-in.
    const authFailed = res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400) || (res.ok && text && !isJson);
    if (authFailed) {
      if (org && !retry.tenant) {
        const t = await this.discoverTenant(org);
        if (t && t !== tenant) {
          this.orgTenant.set(org, t);
          return this.request(method, url, { org, body, retry: { ...retry, tenant: true } });
        }
      }
      throw new AdoError(401, org ? `No access to "${org}" with this account` : 'Azure DevOps refused the sign-in');
    }

    if (res.status === 400 && !retry.preview && /preview/i.test(text) && /api-version=\d+\.\d+(&|$)/.test(url)) {
      const next = url.replace(/api-version=(\d+\.\d+)(&|$)/, 'api-version=$1-preview$2');
      return this.request(method, next, { org, body, retry: { ...retry, preview: true } });
    }

    if (!res.ok) {
      let msg = '';
      try { msg = JSON.parse(text).message; } catch { /* not json */ }
      throw new AdoError(res.status, msg || `Azure DevOps answered HTTP ${res.status}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new AdoError(502, 'Unexpected answer from Azure DevOps');
    }
  }

  get(url, org) {
    return this.request('GET', url, { org });
  }

  /** The Entra tenant an organization is connected to (from an anonymous request). */
  async discoverTenant(org) {
    try {
      const res = await this.fetch(`${this.orgUrl(org)}/_apis/connectionData`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const t = res.headers.get('x-vss-resourcetenant');
      await res.arrayBuffer().catch(() => {});
      return t && !/^0{8}-/.test(t) ? t : null;
    } catch {
      return null;
    }
  }

  // ---- identity & discovery ------------------------------------------------

  async profile() {
    return this.get(`${this.config.VSSPS_APP}/_apis/profile/profiles/me?api-version=7.1`);
  }

  async accounts(memberId) {
    const r = await this.get(`${this.config.VSSPS_APP}/_apis/accounts?${qs({ memberId, 'api-version': '7.1' })}`);
    return (r.value || []).map((a) => a.accountName).filter(Boolean);
  }

  async connection(org) {
    const r = await this.get(`${this.orgUrl(org)}/_apis/connectionData`, org);
    const u = (r && r.authenticatedUser) || {};
    if (!u.id || /^0{8}-/.test(u.id)) throw new AdoError(401, `No access to "${org}" with this account`);
    return { id: u.id, name: u.providerDisplayName || u.customDisplayName || '' };
  }

  /** Teams/groups the user is a direct member of (to find "assigned to my team" PRs). */
  async groups(org, userId) {
    const base = `${this.config.VSSPS_BASE}/${encodeURIComponent(org)}/_apis/identities`;
    const me = await this.get(`${base}?${qs({ identityIds: userId, queryMembership: 'Direct', 'api-version': '7.1' })}`, org);
    const ident = me && Array.isArray(me.value) ? me.value.find(Boolean) : null;
    const descriptors = ((ident && ident.memberOf) || [])
      .map((d) => (typeof d === 'string' ? d : d && d.identityType ? `${d.identityType};${d.identifier}` : null))
      .filter(Boolean)
      .slice(0, 100);
    const out = [];
    for (let i = 0; i < descriptors.length; i += 25) {
      const chunk = descriptors.slice(i, i + 25).join(',');
      const r = await this.get(`${base}?${qs({ descriptors: chunk, 'api-version': '7.1' })}`, org);
      for (const g of (r && r.value) || []) {
        if (g && g.id) out.push({ id: g.id, name: g.providerDisplayName || g.customDisplayName || '' });
      }
    }
    return out.filter((g) => !SKIP_GROUPS.test(g.name)).slice(0, 30);
  }

  async projects(org) {
    const c = this.projectCache.get(org);
    if (c && Date.now() - c.at < 3600e3) return c.list;
    const r = await this.get(`${this.orgUrl(org)}/_apis/projects?${qs({ $top: 500, 'api-version': '7.1' })}`, org);
    const list = ((r && r.value) || []).map((p) => ({ id: p.id, name: p.name }));
    this.projectCache.set(org, { at: Date.now(), list });
    return list;
  }

  // ---- pull requests --------------------------------------------------------

  /** Active PRs in an organization matching the search criteria (all projects). */
  async pullRequests(org, criteria) {
    const query = qs({ 'searchCriteria.status': 'active', ...criteria, $top: 500, 'api-version': '7.1' });
    if (this.orgLevelPrs.get(org) !== false) {
      try {
        const r = await this.get(`${this.orgUrl(org)}/_apis/git/pullrequests?${query}`, org);
        this.orgLevelPrs.set(org, true);
        return (r && r.value) || [];
      } catch (e) {
        if (e.status !== 404 && e.status !== 400) throw e;
        this.log.info(`${org}: org-wide PR search unavailable, querying per project`);
        this.orgLevelPrs.set(org, false);
      }
    }
    const projects = await this.projects(org);
    const lists = await mapLimit(projects, 4, (p) =>
      this.get(`${this.orgUrl(org)}/${encodeURIComponent(p.id)}/_apis/git/pullrequests?${query}`, org)
        .then((r) => (r && r.value) || [])
        .catch(() => []));
    return lists.flat();
  }

  prBase(item) {
    return `${this.orgUrl(item.org)}/${encodeURIComponent(item.projectId)}/_apis/git/repositories/${encodeURIComponent(item.repoId)}/pullRequests/${item.id}`;
  }

  /** Files changed in the latest iteration (compared to the merge base). */
  async changedFiles(item) {
    const its = await this.get(`${this.prBase(item)}/iterations?api-version=7.1`, item.org);
    const list = (its && its.value) || [];
    if (!list.length) return [];
    const last = Math.max(...list.map((i) => i.id));
    const ch = await this.get(`${this.prBase(item)}/iterations/${last}/changes?${qs({ $top: 2000, 'api-version': '7.1' })}`, item.org);
    return ((ch && ch.changeEntries) || [])
      .filter((c) => c.item && c.item.path && !c.item.isFolder)
      .map((c) => ({ path: c.item.path, type: String(c.changeType || 'edit') }));
  }

  async threads(item) {
    const r = await this.get(`${this.prBase(item)}/threads?api-version=7.1`, item.org);
    const human = ((r && r.value) || []).filter((t) =>
      !t.isDeleted && Array.isArray(t.comments) && t.comments.length && t.comments[0].commentType !== 'system');
    const active = human.filter((t) => t.status === 'active' || t.status === 'pending');
    return {
      total: human.length,
      active: active.length,
      latest: active.slice(-4).reverse().map((t) => ({
        by: (t.comments[0].author && t.comments[0].author.displayName) || '',
        text: String(t.comments[0].content || '').slice(0, 220),
        file: (t.threadContext && t.threadContext.filePath) || null,
        replies: t.comments.length - 1,
      })),
    };
  }

  vote(item, reviewerId, vote) {
    return this.request('PUT', `${this.prBase(item)}/reviewers/${encodeURIComponent(reviewerId)}?api-version=7.1`, {
      org: item.org,
      body: { vote, id: reviewerId },
    });
  }
}

module.exports = { Ado, AdoError };
