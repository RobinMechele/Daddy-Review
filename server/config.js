'use strict';
const os = require('os');
const path = require('path');

/**
 * Runtime configuration. Everything has a sensible default so the app works
 * without setup; the DADDY_* environment variables exist for the demo, the
 * tests and unusual setups (custom port, different Entra app registration).
 */
function loadConfig(overrides = {}) {
  const env = process.env;
  const port = Number(overrides.PORT || env.DADDY_PORT) || 4280;
  const cfg = {
    APP_NAME: 'Daddy Review',
    VERSION: require('../package.json').version,
    PORT: port,
    APP_URL: `http://localhost:${port}`,
    DATA_DIR: env.DADDY_DATA_DIR || path.join(os.homedir(), '.daddy-review'),
    PUBLIC_DIR: path.join(__dirname, '..', 'public'),
    // Public client used by Git Credential Manager / Visual Studio for Azure DevOps.
    // It allows loopback redirects, so no app registration and no PAT are needed.
    CLIENT_ID: env.DADDY_CLIENT_ID || '872cd9fa-d31f-45e0-9eab-6e460a02d1f1',
    ADO_RESOURCE: '499b84ac-1321-427f-aa17-267ca6975798',
    LOGIN_BASE: env.DADDY_LOGIN_URL || 'https://login.microsoftonline.com',
    VSSPS_APP: env.DADDY_VSSPS_APP_URL || 'https://app.vssps.visualstudio.com',
    ADO_BASE: env.DADDY_ADO_URL || 'https://dev.azure.com',
    VSSPS_BASE: env.DADDY_VSSPS_URL || 'https://vssps.dev.azure.com',
    WEB_BASE: env.DADDY_WEB_URL || 'https://dev.azure.com',
    DEMO: env.DADDY_DEMO === '1',
    NO_AZ: env.DADDY_NO_AZ === '1',
    BACKGROUND: false,
  };
  return { ...cfg, ...overrides, PORT: port, APP_URL: `http://localhost:${port}` };
}

module.exports = { loadConfig };
