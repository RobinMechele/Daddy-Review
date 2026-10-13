'use strict';
/**
 * A tiny fake of Microsoft sign-in + the Azure DevOps REST endpoints Daddy Review
 * uses. Powers `npm run demo` and the end-to-end tests. Not used in real mode.
 *
 * Mounted paths:  /login  (Entra ID)   /app  (app.vssps.visualstudio.com)
 *                 /ado    (dev.azure.com)   /vssps (vssps.dev.azure.com)   /web (PR pages)
 */
const http = require('http');
const crypto = require('crypto');

const TENANT = '7a1c0de5-0000-4000-8000-00000000demo'.slice(0, 36);
const ME = { id: 'b5c1a7e2-1111-4a4a-9c9c-000000000001', name: 'Alex Morgan', email: 'alex.morgan@contoso.com' };
const PEOPLE = {
  priya: { id: 'p-priya', displayName: 'Priya Shah' },
  jonas: { id: 'p-jonas', displayName: 'Jonas Weber' },
  mia: { id: 'p-mia', displayName: 'Mia Chen' },
  lucas: { id: 'p-lucas', displayName: 'Lucas Martin' },
  sofia: { id: 'p-sofia', displayName: 'Sofia Rossi' },
  noah: { id: 'p-noah', displayName: 'Noah Kim' },
  emma: { id: 'p-emma', displayName: 'Emma Laurent' },
  me: { id: ME.id, displayName: ME.name },
};
const TEAMS = {
  platform: { id: 'g-platform', displayName: '[Platform]\\Platform Team', descriptor: 'Microsoft.TeamFoundation.Identity;S-1-9-1551374245-platform' },
  payments: { id: 'g-payments', displayName: '[Payments]\\Payments Team', descriptor: 'Microsoft.TeamFoundation.Identity;S-1-9-1551374245-payments' },
};
const REPOS = {
  'payments-api': { project: 'Payments', files: ['src/Payments.Api/Controllers/InvoiceController.cs', 'src/Payments.Domain/Invoice.cs', 'src/Payments.Domain/Money.cs', 'tests/Payments.Tests/InvoiceTests.cs', 'src/Payments.Api/Webhooks/WebhookHandler.cs', 'src/Payments.Infrastructure/RetryPolicy.cs', 'src/Payments.Api/appsettings.json'] },
  'checkout-web': { project: 'Payments', files: ['src/components/PayButton.tsx', 'src/components/Cart.tsx', 'src/flags.ts', 'src/styles/checkout.css', 'README.md', 'src/hooks/usePayment.ts'] },
  'mobile-app': { project: 'Mobile', files: ['app/src/main/java/settings/SettingsScreen.kt', 'app/src/main/res/values-night/colors.xml', 'app/src/main/res/values/themes.xml', 'ios/Settings/SettingsView.swift'] },
  infra: { project: 'Platform', files: ['pipelines/build.yml', 'pipelines/templates/test.yml', 'terraform/main.tf', 'otel/collector.yaml', 'docs/runbook.md'] },
  'shared-libs': { project: 'Platform', files: ['src/Auth/Middleware.cs', 'src/Auth/TokenValidator.cs', 'src/Shared.csproj', 'tests/AuthTests.cs', 'Directory.Build.props'] },
  'ml-pipeline': { project: 'Research', files: ['features/extract.py', 'features/arrow_io.py', 'tests/test_tokenizer.py', 'requirements.txt', 'notebooks/benchmark.ipynb'] },
};

const b64url = (s) => Buffer.from(s).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const rid = () => crypto.randomBytes(10).toString('hex');

function fakeJwt(extra = {}) {
  const payload = {
    aud: '499b84ac-1321-427f-aa17-267ca6975798',
    tid: TENANT,
    oid: ME.id,
    name: ME.name,
    upn: ME.email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...extra,
  };
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

function filesFor(repo, n) {
  const pool = REPOS[repo].files;
  return Array.from({ length: n }, (_, i) => {
    const base = pool[i % pool.length];
    return i < pool.length ? base : base.replace(/(\.[a-z]+)$/i, `${Math.floor(i / pool.length) + 1}$1`);
  });
}

function seed(now = Date.now()) {
  const h = 36e5;
  const R = (who, vote = 0, extra = {}) => ({ id: who.id, displayName: who.displayName, vote, isRequired: false, isContainer: !!extra.team, ...extra });
  const prs = [];
  const add = (org, id, repo, author, hoursAgo, nFiles, title, reviewers, extra = {}) => {
    prs.push({
      org, pullRequestId: id, repo, title, author, files: filesFor(repo, nFiles),
      creationDate: new Date(now - hoursAgo * h).toISOString(),
      reviewers, commit: rid(), iterations: 1, status: 'active',
      isDraft: !!extra.draft, mergeStatus: extra.conflicts ? 'conflicts' : 'succeeded',
      description: extra.description || '', labels: extra.labels || [], threads: extra.threads || [],
    });
  };
  const P = PEOPLE;
  add('contoso', 1201, 'payments-api', P.priya, 3, 2, 'Fix rounding error in invoice totals', [R(P.me, 0, { isRequired: true }), R(P.jonas)],
    { description: 'Totals were rounded per line instead of per invoice. Now uses banker\'s rounding once at the end.', labels: ['bug'], threads: [{ by: P.jonas, text: 'Do we need a migration for already issued invoices?', status: 'active' }] });
  add('contoso', 1198, 'payments-api', P.jonas, 26, 7, 'Add retry policy to payment webhook handler', [R(P.me, 0, { isRequired: true }), R(P.priya, 10)],
    { description: 'Exponential backoff with jitter for the PSP webhook. Max 5 attempts, dead-letter after that.' });
  add('contoso', 1187, 'checkout-web', P.mia, 74, 18, 'Checkout: Apple Pay button behind feature flag', [R(P.me), R(P.emma, 5)],
    { labels: ['feature'], description: 'Adds the Apple Pay button. Hidden behind `checkout.applePay` flag.' });
  add('contoso', 1205, 'infra', P.lucas, 5, 34, 'Bump OpenTelemetry to 1.9 and drop legacy exporter', [R(TEAMS.platform, 0, { team: true, isRequired: true })],
    { description: 'The legacy Jaeger exporter is gone. Collector config updated.' });
  add('contoso', 1176, 'mobile-app', P.sofia, 50, 12, 'Dark mode for settings screen', [R(P.me, -5), R(P.mia, 10)],
    { threads: [{ by: P.me, text: 'Contrast of the secondary text is too low in dark mode (3.1:1).', status: 'active' }] });
  add('contoso', 1169, 'shared-libs', P.noah, 96, 46, 'Refactor auth middleware into shared package', [R(P.me, 10), R(P.lucas, 5)],
    { description: 'Moves token validation into Shared.Auth so all services use the same rules.' });
  add('contoso', 1207, 'checkout-web', P.emma, 0.7, 1, 'Typo in checkout README', [R(P.me)], { labels: ['docs'] });
  add('contoso', 1203, 'payments-api', P.jonas, 20, 9, 'WIP: new ledger schema', [R(P.me)], { draft: true });
  add('contoso', 1190, 'payments-api', P.priya, 48, 4, 'Cache exchange rates for 5 minutes', [R(P.me, 10)]);
  add('contoso', 1199, 'infra', P.lucas, 6, 9, 'Migrate CI to pipeline templates', [R(TEAMS.platform, 10, { team: true }), R(P.noah, 10, { votedFor: [{ id: TEAMS.platform.id }] })]);
  add('fabrikam-labs', 312, 'ml-pipeline', P.mia, 8, 6, 'Speed up feature extraction with Arrow', [R(P.me, 0, { isRequired: true })], { labels: ['perf'] });
  add('fabrikam-labs', 309, 'ml-pipeline', P.noah, 30, 2, 'Fix flaky test in tokenizer', [R(P.me)], { conflicts: true });
  // Created by me
  add('contoso', 1200, 'payments-api', P.me, 22, 6, 'Add idempotency keys to refunds endpoint', [R(P.priya, 10), R(P.jonas, 0, { isRequired: true }), R(TEAMS.payments, 0, { team: true })]);
  add('contoso', 1184, 'shared-libs', P.me, 70, 23, 'Upgrade to .NET 9', [R(P.lucas, -5), R(P.noah, 5)],
    { threads: [{ by: P.lucas, text: 'Build agents still have the .NET 8 SDK only, can we bump the image first?', status: 'active' }] });
  add('contoso', 1206, 'infra', P.me, 4, 2, 'Docs: on-call runbook', [R(P.mia, 10, { isRequired: true })]);
  return prs;
}

const SIMULATED = [
  ['contoso', 'payments-api', 'priya', 1, 'Hotfix: null check in refund flow', true],
  ['contoso', 'checkout-web', 'emma', 3, 'Show saved cards first', false],
  ['fabrikam-labs', 'ml-pipeline', 'noah', 5, 'Pin numpy below 2.1', false],
  ['contoso', 'mobile-app', 'sofia', 8, 'Haptic feedback on pay button', false],
  ['contoso', 'infra', 'lucas', 4, 'Alert on webhook dead-letter queue depth', true],
];

function createFakeAdo({ autoLogin = true, simulate = false, seedNow } = {}) {
  let prs = seed(seedNow);
  const codes = new Map();
  const accessTokens = new Set();
  const refreshTokens = new Set();
  const log = { votes: [], tokenRequests: [] };
  let port = 0;
  let nextId = 1300;
  let simIndex = 0;
  const timers = [];

  const base = () => `http://127.0.0.1:${port}`;
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const html = (res, status, body) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8' });

  const issue = () => {
    const access = fakeJwt();
    const refresh = `rt-${rid()}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return { token_type: 'Bearer', expires_in: 3600, access_token: access, refresh_token: refresh, id_token: fakeJwt({ preferred_username: ME.email }) };
  };

  const toApi = (pr) => {
    const repo = REPOS[pr.repo];
    return {
      pullRequestId: pr.pullRequestId,
      codeReviewId: pr.pullRequestId,
      status: pr.status,
      title: pr.title,
      description: pr.description,
      isDraft: pr.isDraft,
      creationDate: pr.creationDate,
      createdBy: { ...pr.author, uniqueName: `${pr.author.id}@contoso.com` },
      sourceRefName: `refs/heads/${pr.author.displayName.split(' ')[0].toLowerCase()}/${pr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
      targetRefName: 'refs/heads/main',
      mergeStatus: pr.mergeStatus,
      lastMergeSourceCommit: { commitId: pr.commit },
      labels: pr.labels.map((name) => ({ name, active: true })),
      reviewers: pr.reviewers.map((r) => ({ ...r })),
      repository: { id: `repo-${pr.repo}`, name: pr.repo, project: { id: `proj-${repo.project}`, name: repo.project } },
    };
  };

  const findPr = (org, id) => prs.find((p) => p.org === org && p.pullRequestId === Number(id));

  const control = {
    pushCommit(org, id) {
      const pr = findPr(org, id);
      pr.commit = rid();
      pr.iterations++;
      return pr;
    },
    newPr({ org = 'contoso', repo = 'payments-api', author = 'priya', files = 2, title = 'New change', required = false } = {}) {
      const pr = {
        org, pullRequestId: nextId++, repo, title, author: PEOPLE[author], files: filesFor(repo, files),
        creationDate: new Date().toISOString(), reviewers: [{ id: ME.id, displayName: ME.name, vote: 0, isRequired: required, isContainer: false }],
        commit: rid(), iterations: 1, status: 'active', isDraft: false, mergeStatus: 'succeeded', description: '', labels: [], threads: [],
      };
      prs.push(pr);
      return pr;
    },
    vote(org, id, who, vote) {
      const pr = findPr(org, id);
      const r = pr.reviewers.find((x) => x.id === PEOPLE[who].id);
      if (r) r.vote = vote;
      else pr.reviewers.push({ id: PEOPLE[who].id, displayName: PEOPLE[who].displayName, vote, isRequired: false, isContainer: false });
      return pr;
    },
    complete(org, id) {
      findPr(org, id).status = 'completed';
    },
    pr: findPr,
    /** An access token as if it came from `az account get-access-token`. */
    issueToken() {
      return issue().access_token;
    },
    get log() { return log; },
    reset() { prs = seed(); },
  };

  function authorized(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && accessTokens.has(m[1]);
  }

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handle(req, res) {
    const url = new URL(req.url, base());
    const p = url.pathname;
    const qp = (k) => url.searchParams.get(k);

    // ---- Microsoft sign-in --------------------------------------------------
    let m = /^\/login\/[^/]+\/oauth2\/v2\.0\/authorize$/.exec(p);
    if (m) {
      const redirect = qp('redirect_uri');
      if (!redirect || !/^http:\/\/localhost:\d+$/.test(redirect)) return html(res, 400, 'AADSTS50011: redirect URI mismatch');
      if (qp('code_challenge_method') !== 'S256' || !qp('code_challenge')) return html(res, 400, 'PKCE required');
      const code = `code-${rid()}`;
      codes.set(code, { challenge: qp('code_challenge'), redirect, clientId: qp('client_id') });
      const target = `${redirect}/?code=${encodeURIComponent(code)}&state=${encodeURIComponent(qp('state'))}`;
      if (autoLogin) return send(res, 302, '', { Location: target });
      return html(res, 200, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in (demo)</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:15px 'Segoe UI',system-ui,sans-serif;background:#f3f3f3">
<div style="background:#fff;padding:40px 44px;width:340px;box-shadow:0 2px 6px rgba(0,0,0,.2)">
<div style="display:grid;grid-template-columns:repeat(2,10px);gap:2px;margin-bottom:18px"><i style="background:#f25022;height:10px"></i><i style="background:#7fba00;height:10px"></i><i style="background:#00a4ef;height:10px"></i><i style="background:#ffb900;height:10px"></i></div>
<h2 style="font-weight:600;margin:0 0 6px">Pick an account</h2><p style="color:#666;margin:0 0 18px">Demo sign-in. Nothing leaves your computer.</p>
<a id="acct" href="${target.replace(/"/g, '&quot;')}" style="display:block;padding:12px;border:1px solid #ddd;color:#111;text-decoration:none">${ME.name}<br><small style="color:#666">${ME.email}</small></a></div></body>`);
    }
    if (/^\/login\/[^/]+\/oauth2\/v2\.0\/token$/.test(p) && req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
      log.tokenRequests.push(form.get('grant_type'));
      if (form.get('grant_type') === 'authorization_code') {
        const c = codes.get(form.get('code'));
        codes.delete(form.get('code'));
        if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70008: code expired' });
        if (c.redirect !== form.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (sha(form.get('code_verifier') || '') !== c.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return send(res, 200, issue());
      }
      if (form.get('grant_type') === 'refresh_token') {
        const rt = form.get('refresh_token');
        if (!refreshTokens.has(rt)) return send(res, 400, { error: 'invalid_grant', error_description: 'AADSTS700082: refresh token expired' });
        refreshTokens.delete(rt);
        return send(res, 200, issue());
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---- fake PR web page (demo "Open in Azure DevOps") ---------------------
    m = /^\/web\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)$/.exec(p);
    if (m) {
      const pr = findPr(decodeURIComponent(m[1]), m[4]);
      const title = pr ? pr.title.replace(/</g, '&lt;') : 'Pull request';
      return html(res, 200, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>PR ${m[4]} (demo)</title>
<body style="margin:0;font:14px 'Segoe UI',system-ui,sans-serif;background:#f8f8f8;color:#222"><div style="background:#0078d4;color:#fff;padding:12px 20px;font-weight:600">Azure DevOps · demo</div>
<div style="max-width:720px;margin:40px auto;background:#fff;padding:28px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.15)"><div style="color:#666">${decodeURIComponent(m[3])} · !${m[4]}</div><h1 style="font-size:22px">${title}</h1>
<p>In real mode this opens the pull request in Azure DevOps. Review it, then switch back to Daddy Review to cast your vote.</p></div></body>`);
    }

    // ---- REST APIs (need a token) -------------------------------------------
    if (/^\/(app|ado|vssps)\//.test(p)) {
      if (!authorized(req)) return send(res, 401, { message: 'TF400813: not authorized' }, { 'x-vss-resourcetenant': TENANT });
    } else {
      return send(res, 404, { message: 'not found' });
    }

    if (p === '/app/_apis/profile/profiles/me') {
      return send(res, 200, { id: ME.id, publicAlias: ME.id, displayName: ME.name, emailAddress: ME.email });
    }
    if (p === '/app/_apis/accounts') {
      if (qp('memberId') !== ME.id) return send(res, 400, { message: 'memberId required' });
      return send(res, 200, { count: 2, value: [{ accountId: 'a1', accountName: 'contoso' }, { accountId: 'a2', accountName: 'fabrikam-labs' }] });
    }
    m = /^\/ado\/([^/]+)\/_apis\/connectionData$/.exec(p);
    if (m) return send(res, 200, { authenticatedUser: { id: ME.id, providerDisplayName: ME.name } });

    m = /^\/vssps\/([^/]+)\/_apis\/identities$/.exec(p);
    if (m) {
      if (qp('identityIds') === ME.id && qp('queryMembership') === 'Direct') {
        return send(res, 200, { count: 1, value: [{ id: ME.id, providerDisplayName: ME.name, memberOf: [TEAMS.platform.descriptor, TEAMS.payments.descriptor, 'Microsoft.TeamFoundation.Identity;S-1-9-valid-users'] }] });
      }
      const wanted = (qp('descriptors') || '').split(',');
      const all = [...Object.values(TEAMS), { id: 'g-valid', displayName: '[contoso]\\Project Collection Valid Users', descriptor: 'Microsoft.TeamFoundation.Identity;S-1-9-valid-users' }];
      return send(res, 200, { value: all.filter((t) => wanted.includes(t.descriptor)).map((t) => ({ id: t.id, providerDisplayName: t.displayName, isContainer: true })) });
    }

    m = /^\/ado\/([^/]+)\/_apis\/git\/pullrequests$/.exec(p);
    if (m) {
      const org = decodeURIComponent(m[1]);
      const reviewerId = qp('searchCriteria.reviewerId');
      const creatorId = qp('searchCriteria.creatorId');
      const list = prs.filter((pr) => pr.org === org && pr.status === (qp('searchCriteria.status') || 'active')
        && (!reviewerId || pr.reviewers.some((r) => r.id === reviewerId))
        && (!creatorId || pr.author.id === creatorId));
      return send(res, 200, { count: list.length, value: list.map(toApi) });
    }

    m = /^\/ado\/([^/]+)\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)(\/.*)?$/.exec(p);
    if (m) {
      const pr = findPr(decodeURIComponent(m[1]), m[2]);
      if (!pr) return send(res, 404, { message: 'TF401180: pull request not found' });
      const rest = m[3] || '';
      if (rest === '/iterations') return send(res, 200, { count: pr.iterations, value: Array.from({ length: pr.iterations }, (_, i) => ({ id: i + 1 })) });
      if (/^\/iterations\/\d+\/changes$/.test(rest)) {
        return send(res, 200, { changeEntries: pr.files.map((f, i) => ({ changeTrackingId: i + 1, changeType: i % 5 === 4 ? 'add' : 'edit', item: { path: `/${f}` } })) });
      }
      if (rest === '/threads') {
        return send(res, 200, {
          value: [
            { id: 1, status: 'unknown', comments: [{ commentType: 'system', content: 'Policy check passed' }] },
            ...pr.threads.map((t, i) => ({ id: i + 2, status: t.status, isDeleted: false, comments: [{ commentType: 'text', content: t.text, author: t.by }] })),
          ],
        });
      }
      const rv = /^\/reviewers\/([^/]+)$/.exec(rest);
      if (rv && req.method === 'PUT') {
        const payload = JSON.parse(await body(req) || '{}');
        const id = decodeURIComponent(rv[1]);
        let r = pr.reviewers.find((x) => x.id === id);
        if (!r) { r = { id, displayName: id === ME.id ? ME.name : id, vote: 0, isRequired: false, isContainer: false }; pr.reviewers.push(r); }
        r.vote = Number(payload.vote) || 0;
        log.votes.push({ org: pr.org, id: pr.pullRequestId, reviewer: id, vote: r.vote });
        return send(res, 200, { ...r });
      }
    }
    return send(res, 404, { message: `fake ADO: no route for ${req.method} ${p}` });
  }

  const server = http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { message: e.message })));

  return {
    control,
    me: ME,
    tenant: TENANT,
    get url() { return base(); },
    env() {
      return {
        DADDY_LOGIN_URL: `${base()}/login`,
        DADDY_VSSPS_APP_URL: `${base()}/app`,
        DADDY_ADO_URL: `${base()}/ado`,
        DADDY_VSSPS_URL: `${base()}/vssps`,
        DADDY_WEB_URL: `${base()}/web`,
      };
    },
    listen(p = 0) {
      return new Promise((resolve) => server.listen(p, '127.0.0.1', () => {
        port = server.address().port;
        if (simulate) startSimulation();
        resolve(this);
      }));
    },
    close() {
      timers.forEach(clearTimeout);
      server.closeAllConnections && server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    },
  };

  function startSimulation() {
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    at(25000, () => control.pushCommit('contoso', 1169));
    at(50000, () => control.vote('contoso', 1200, 'jonas', 10));
    const loop = () => {
      const s = SIMULATED[simIndex++ % SIMULATED.length];
      control.newPr({ org: s[0], repo: s[1], author: s[2], files: s[3], title: s[4], required: s[5] });
      at(120000, loop);
    };
    at(75000, loop);
  }
}

module.exports = { createFakeAdo, ME, TENANT };
