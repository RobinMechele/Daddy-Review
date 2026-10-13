'use strict';
/**
 * Automatic updates from this repository's GitHub Releases (free, no tokens:
 * the repo is public). New versions download in the background; you choose
 * when to restart, and otherwise they install the next time the app quits.
 *
 * Windows and Linux (AppImage) update themselves. macOS builds aren't signed,
 * which macOS requires for self-updates, so there we point you to the download.
 */
const { app, shell } = require('electron');

const RELEASES_PAGE = 'https://github.com/RobinMechele/Daddy-Review/releases/latest';
const CHECK_EVERY = 4 * 36e5;

function createUpdater({ log, enabled, onChange, notify }) {
  const state = {
    supported: false,
    current: app.getVersion(),
    status: 'idle', // idle | checking | none | available | downloading | ready | error
    version: null,
    progress: 0,
    error: null,
    checkedAt: null,
  };
  const selfUpdate = process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE);
  let updater = null;
  let notified = null;

  const set = (patch) => {
    Object.assign(state, patch);
    if (onChange) onChange({ ...state });
  };

  if (enabled) {
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
    } catch (e) {
      log.warn(`Updates unavailable: ${e.message}`);
    }
  }

  if (updater) {
    state.supported = true;
    updater.logger = {
      info: (m) => log.info(`update: ${m}`),
      warn: (m) => log.warn(`update: ${m}`),
      error: (m) => log.warn(`update: ${m}`),
      debug: () => {},
    };
    updater.autoDownload = selfUpdate;
    updater.autoInstallOnAppQuit = true;
    // Tests point the app at a local feed instead of GitHub.
    if (process.env.DADDY_UPDATE_URL) {
      updater.setFeedURL({ provider: 'generic', url: process.env.DADDY_UPDATE_URL });
      updater.autoInstallOnAppQuit = false;
    }

    updater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    updater.on('update-not-available', () => set({ status: 'none', checkedAt: Date.now() }));
    updater.on('update-available', (info) => set({ status: selfUpdate ? 'downloading' : 'available', version: info.version, progress: 0, checkedAt: Date.now() }));
    updater.on('download-progress', (p) => set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', (info) => {
      set({ status: 'ready', version: info.version, progress: 100 });
      if (notified !== info.version) {
        notified = info.version;
        notify({ title: `Update ${info.version} is ready`, body: 'Restart Daddy Review to use it. Otherwise it installs the next time it quits.' });
      }
    });
    updater.on('error', (e) => {
      const msg = String((e && e.message) || e).split('\n')[0].slice(0, 200);
      log.warn(`update failed: ${msg}`);
      set({ status: 'error', error: msg });
    });
  }

  function check() {
    if (!updater || ['checking', 'downloading', 'ready'].includes(state.status)) return { ...state };
    updater.checkForUpdates().catch(() => { /* reported through the 'error' event */ });
    return { ...state };
  }

  return {
    status: () => ({ ...state }),
    check,
    /** Restart into the new version (Windows/Linux), or open the download page (macOS). */
    install() {
      if (state.status === 'ready' && updater) {
        // Silent install, then start the new version.
        setImmediate(() => updater.quitAndInstall(true, true));
      } else if (state.status === 'available') {
        shell.openExternal(RELEASES_PAGE);
      }
    },
    start() {
      if (!updater) return;
      setTimeout(check, 20000).unref();
      setInterval(check, CHECK_EVERY).unref();
    },
  };
}

module.exports = { createUpdater };
