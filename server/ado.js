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
    this.repoCache = new Map();
  }

  orgUrl(org) {
    return `${this.config.ADO_BASE}/${encodeURIComponent(org)}`;
  }

  /** One call to Azure DevOps. `raw: true` returns the body as a Buffer (file contents). */
  async request(method, url, { org, body, raw = false, retry = {} } = {}) {
    const tenant = org ? this.orgTenant.get(org) : undefined;
    const token = await this.auth.getToken(tenant);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: raw ? '*/*' : 'application/json',
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
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const type = res.headers.get('content-type') || '';
    const isJson = type.includes('json');

    if (res.status === 429 && !retry.throttle) {
      const wait = Math.min(10, Number(res.headers.get('retry-after')) || 3);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(method, url, { org, body, raw, retry: { ...retry, throttle: true } });
    }

    // Azure DevOps answers bad/foreign tokens with 401, 203 + HTML or a redirect to sign-in.
    const unexpected = raw ? type.includes('text/html') : !isJson;
    const authFailed = res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400) || (res.ok && buf.length && unexpected);
    if (authFailed) {
      if (org && !retry.tenant) {
        const t = await this.discoverTenant(org);
        if (t && t !== tenant) {
          this.orgTenant.set(org, t);
          return this.request(method, url, { org, body, raw, retry: { ...retry, tenant: true } });
        }
      }
      throw new AdoError(401, org ? `No access to "${org}" with this account` : 'Azure DevOps refused the sign-in');
    }

    if (res.status === 400 && !retry.preview && /preview/i.test(text) && /api-version=\d+\.\d+(&|$)/.test(url)) {
      const next = url.replace(/api-version=(\d+\.\d+)(&|$)/, 'api-version=$1-preview$2');
      return this.request(method, next, { org, body, raw, retry: { ...retry, preview: true } });
    }

    if (!res.ok) {
      let msg = '';
      try { msg = JSON.parse(text).message; } catch { /* not json */ }
      throw new AdoError(res.status, msg || `Azure DevOps answered HTTP ${res.status}`);
    }
    if (raw) return buf;
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

  /**
   * Teams and groups you're in, also through nested groups (e.g. an Entra group
   * inside a team), so "assigned to my team" PRs are found.
   */
  async groups(org, userId) {
    const base = `${this.config.VSSPS_BASE}/${encodeURIComponent(org)}/_apis/identities`;
    const found = new Map();
    let firstError = null;
    try {
      let me = null;
      for (const membership of ['Expanded', 'Direct']) {
        try {
          me = await this.get(`${base}?${qs({ identityIds: userId, queryMembership: membership, 'api-version': '7.1' })}`, org);
          break;
        } catch (e) {
          if (e.code === 'AUTH_REQUIRED' || membership === 'Direct') throw e;
          this.log.info(`${org}: nested group membership unavailable (${e.message}), using direct membership`);
        }
      }
      const ident = me && Array.isArray(me.value) ? me.value.find(Boolean) : null;
      const descriptors = [...new Set(((ident && ident.memberOf) || [])
        .map((d) => (typeof d === 'string' ? d : d && d.identityType ? `${d.identityType};${d.identifier}` : null))
        .filter(Boolean))]
        .slice(0, 600);
      // Small chunks keep the URL short.
      for (let i = 0; i < descriptors.length; i += 15) {
        const chunk = descriptors.slice(i, i + 15).join(',');
        try {
          const r = await this.get(`${base}?${qs({ descriptors: chunk, 'api-version': '7.1' })}`, org);
          for (const g of (r && r.value) || []) {
            if (g && g.id) found.set(g.id, { id: g.id, name: g.providerDisplayName || g.customDisplayName || '' });
          }
        } catch (e) {
          if (e.code === 'AUTH_REQUIRED') throw e;
          firstError = firstError || e;
        }
      }
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED') throw e;
      firstError = firstError || e;
    }
    // The teams you're in, as Azure DevOps itself sees them.
    try {
      const r = await this.get(`${this.orgUrl(org)}/_apis/teams?${qs({ $mine: 'true', $top: 1000, 'api-version': '7.1-preview.3' })}`, org);
      for (const t of (r && r.value) || []) {
        if (t && t.id && !found.has(t.id)) found.set(t.id, { id: t.id, name: t.projectName ? `[${t.projectName}]\\${t.name}` : t.name || '' });
      }
    } catch (e) {
      if (e.code === 'AUTH_REQUIRED') throw e;
      firstError = firstError || e;
    }
    if (!found.size && firstError) throw firstError;
    return [...found.values()].filter((g) => !SKIP_GROUPS.test(g.name));
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

  /** Active PRs from one list endpoint, page by page: { list, complete }. */
  async pagedPrs(url, org, criteria, max) {
    const PAGE = 500;
    const list = [];
    for (let skip = 0; skip < max; skip += PAGE) {
      const query = qs({ 'searchCriteria.status': 'active', ...criteria, $top: PAGE, $skip: skip || undefined, 'api-version': '7.1' });
      const r = await this.get(`${url}?${query}`, org);
      const page = (r && r.value) || [];
      list.push(...page);
      if (page.length < PAGE) return { list, complete: true };
    }
    return { list, complete: false };
  }

  /** Active PRs in an organization (all projects) matching the criteria: { list, complete }. */
  async searchPrs(org, criteria = {}, max = 1500) {
    if (this.orgLevelPrs.get(org) !== false) {
      try {
        const r = await this.pagedPrs(`${this.orgUrl(org)}/_apis/git/pullrequests`, org, criteria, max);
        this.orgLevelPrs.set(org, true);
        return r;
      } catch (e) {
        if ((e.status !== 404 && e.status !== 400) || this.orgLevelPrs.get(org) === true) throw e;
        this.log.info(`${org}: org-wide PR search unavailable, querying per project`);
        this.orgLevelPrs.set(org, false);
      }
    }
    const projects = await this.projects(org);
    const results = await mapLimit(projects, 4, (p) =>
      this.pagedPrs(`${this.orgUrl(org)}/${encodeURIComponent(p.id)}/_apis/git/pullrequests`, org, criteria, max)
        .catch((e) => {
          if (e.code === 'AUTH_REQUIRED') throw e;
          this.log.warn(`${org}/${p.name}: ${e.message}`);
          return { list: [], complete: true };
        }));
    return { list: results.flatMap((r) => r.list), complete: results.every((r) => r.complete) };
  }

  /** Active PRs in an organization matching the search criteria (all projects). */
  async pullRequests(org, criteria) {
    return (await this.searchPrs(org, criteria)).list;
  }

  /** Every active PR in one project, or in one repository: { list, complete }. */
  scopePrs(org, { projectId, repoId }) {
    const e = encodeURIComponent;
    const url = repoId
      ? `${this.orgUrl(org)}/${e(projectId)}/_apis/git/repositories/${e(repoId)}/pullrequests`
      : `${this.orgUrl(org)}/${e(projectId)}/_apis/git/pullrequests`;
    return this.pagedPrs(url, org, {}, 1500);
  }

  /** All repositories you can see in an organization. */
  async repositories(org) {
    const c = this.repoCache.get(org);
    if (c && Date.now() - c.at < 10 * 60e3) return c.list;
    const r = await this.get(`${this.orgUrl(org)}/_apis/git/repositories?api-version=7.1`, org);
    const list = ((r && r.value) || [])
      .filter((x) => x && x.id && x.project && !x.isDisabled)
      .map((x) => ({ id: x.id, name: x.name || '', projectId: x.project.id, project: x.project.name || '' }));
    this.repoCache.set(org, { at: Date.now(), list });
    return list;
  }

  prBase(item) {
    return `${this.orgUrl(item.org)}/${encodeURIComponent(item.projectId)}/_apis/git/repositories/${encodeURIComponent(item.repoId)}/pullRequests/${item.id}`;
  }

  /** Files changed in the latest iteration (compared to the merge base). */
  async changedFiles(item) {
    const its = await this.iterations(item);
    if (!its.length) return [];
    return (await this.changes(item, its[its.length - 1].id)).map((c) => ({ path: c.path, type: c.type }));
  }

  /** One PR with everything (the list only has a shortened description). */
  pullRequest(item) {
    return this.get(`${this.prBase(item)}?api-version=7.1`, item.org);
  }

  /** The PR's iterations (pushes), oldest first. */
  async iterations(item) {
    const r = await this.get(`${this.prBase(item)}/iterations?api-version=7.1`, item.org);
    return ((r && r.value) || []).filter((i) => i && i.id).sort((a, b) => a.id - b.id).map((i) => ({
      id: i.id,
      source: (i.sourceRefCommit && i.sourceRefCommit.commitId) || null,
      target: (i.targetRefCommit && i.targetRefCommit.commitId) || null,
      base: (i.commonRefCommit && i.commonRefCommit.commitId) || null,
    }));
  }

  /** Files changed in an iteration compared to the merge base, with the blobs on both sides. */
  async changes(item, iterationId) {
    const out = [];
    let skip = 0;
    for (let page = 0; page < 5; page++) {
      const r = await this.get(`${this.prBase(item)}/iterations/${iterationId}/changes?${qs({ $top: 2000, $skip: skip || undefined, $compareTo: 0, 'api-version': '7.1' })}`, item.org);
      for (const c of (r && r.changeEntries) || []) {
        if (!c.item || !c.item.path || c.item.isFolder || (c.item.gitObjectType && c.item.gitObjectType !== 'blob')) continue;
        out.push({
          path: c.item.path,
          originalPath: c.originalPath || c.sourceServerItem || null,
          type: String(c.changeType || 'edit'),
          objectId: c.item.objectId || null,
          originalObjectId: c.item.originalObjectId || null,
          changeTrackingId: c.changeTrackingId || null,
        });
      }
      if (!r || !r.nextSkip) break;
      skip = r.nextSkip;
    }
    return out;
  }

  repoBase(item) {
    return `${this.orgUrl(item.org)}/${encodeURIComponent(item.projectId)}/_apis/git/repositories/${encodeURIComponent(item.repoId)}`;
  }

  /** A file's contents by its blob id. */
  blob(item, objectId) {
    return this.request('GET', `${this.repoBase(item)}/blobs/${encodeURIComponent(objectId)}?${qs({ $format: 'octetstream', 'api-version': '7.1' })}`, { org: item.org, raw: true });
  }

  /** A file's contents at a commit (when there's no blob id). */
  fileAt(item, path, commit) {
    const query = qs({ path, 'versionDescriptor.versionType': 'commit', 'versionDescriptor.version': commit, $format: 'octetstream', download: false, 'api-version': '7.1' });
    return this.request('GET', `${this.repoBase(item)}/items?${query}`, { org: item.org, raw: true });
  }

  /** Comment threads with their positions tracked to the latest push. */
  async threadsAt(item, iterationId) {
    if (iterationId) {
      try {
        const r = await this.get(`${this.prBase(item)}/threads?${qs({ $iteration: iterationId, $baseIteration: 0, 'api-version': '7.1' })}`, item.org);
        return (r && r.value) || [];
      } catch (e) {
        if (e.status !== 400) throw e;
      }
    }
    return this.threads(item);
  }

  createThread(item, thread) {
    return this.request('POST', `${this.prBase(item)}/threads?api-version=7.1`, { org: item.org, body: thread });
  }

  reply(item, threadId, parentCommentId, content) {
    return this.request('POST', `${this.prBase(item)}/threads/${encodeURIComponent(threadId)}/comments?api-version=7.1`, {
      org: item.org,
      body: { content, parentCommentId, commentType: 1 },
    });
  }

  setThreadStatus(item, threadId, status) {
    return this.request('PATCH', `${this.prBase(item)}/threads/${encodeURIComponent(threadId)}?api-version=7.1`, { org: item.org, body: { status } });
  }

  /** All comment threads of a PR (raw). */
  async threads(item) {
    const r = await this.get(`${this.prBase(item)}/threads?api-version=7.1`, item.org);
    return (r && r.value) || [];
  }

  /** Is this an Azure DevOps host we may send your token to? */
  isAdoHost(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const own = [this.config.ADO_BASE, this.config.VSSPS_BASE, this.config.VSSPS_APP].map((b) => new URL(b).host);
    if (own.includes(u.host)) return true;
    return u.protocol === 'https:' && /(^|\.)(dev\.azure\.com|visualstudio\.com)$/i.test(u.hostname);
  }

  /** A profile picture from Azure DevOps (they need your sign-in to load). */
  async image(url) {
    if (!this.isAdoHost(url)) throw new AdoError(400, 'Not an Azure DevOps image');
    const u = new URL(url);
    const org = /\.visualstudio\.com$/i.test(u.hostname) ? u.hostname.split('.')[0] : decodeURIComponent(u.pathname.split('/')[1] || '');
    const token = await this.auth.getToken(this.orgTenant.get(org));
    const res = await this.fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'image/*', 'X-TFS-FedAuthRedirect': 'Suppress' },
      signal: AbortSignal.timeout(15000),
    });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !/^image\//.test(type)) throw new AdoError(res.status || 404, 'No image');
    return { type, data: Buffer.from(await res.arrayBuffer()) };
  }

  removeReviewer(item, reviewerId) {
    return this.request('DELETE', `${this.prBase(item)}/reviewers/${encodeURIComponent(reviewerId)}?api-version=7.1`, { org: item.org });
  }

  vote(item, reviewerId, vote) {
    return this.request('PUT', `${this.prBase(item)}/reviewers/${encodeURIComponent(reviewerId)}?api-version=7.1`, {
      org: item.org,
      body: { vote, id: reviewerId },
    });
  }
}

module.exports = { Ado, AdoError };
