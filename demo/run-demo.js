#!/usr/bin/env node
'use strict';
/**
 * `npm run demo`: Daddy Review against a fake Azure DevOps with live activity
 * (new PRs, pushes, votes) so you can try everything without an account.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createFakeAdo } = require('./fake-ado');

async function run() {
  const fake = await createFakeAdo({ autoLogin: false, simulate: true }).listen(0);
  const dataDir = path.join(os.tmpdir(), `daddy-review-demo-${process.pid}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  // Check every minute in the demo so the simulated activity shows up quickly.
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { pollMinutes: 1 } }));
  Object.assign(process.env, fake.env(), {
    DADDY_DEMO: '1',
    DADDY_NO_AZ: '1',
    DADDY_DATA_DIR: dataDir,
    DADDY_PORT: process.env.DADDY_PORT || '4299',
  });

  const { createApp } = require('../server');
  const app = createApp();
  await app.listen();
  app.start();
  const url = app.config.APP_URL;
  console.log(`\n  ✦ Daddy Review demo running at ${url}\n    Fake Azure DevOps: ${fake.url}\n    Ctrl+C to stop.\n`);
  if (!process.argv.includes('--no-open')) {
    const opts = { detached: true, stdio: 'ignore' };
    if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], opts).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts).on('error', () => {}).unref();
  }
  const stop = async () => {
    await app.close();
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
