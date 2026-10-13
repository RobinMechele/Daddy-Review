'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** "Start at login" for the background server, per OS, without admin rights. */

const SCRIPT = path.join(__dirname, 'index.js');
const ROOT = path.join(__dirname, '..');

function entryFile(platform = process.platform, env = process.env) {
  const home = os.homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Daddy Review.vbs');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', 'app.daddyreview.server.plist');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'daddy-review.desktop');
}

function entryContent(platform = process.platform, node = process.execPath, script = SCRIPT) {
  if (platform === 'win32') {
    const q = (s) => s.replace(/"/g, '""');
    // A .vbs runs node without a console window.
    return [
      '\' Starts the Daddy Review background server at login (hidden window).',
      'Set shell = CreateObject("WScript.Shell")',
      `shell.CurrentDirectory = "${q(ROOT)}"`,
      `shell.Run """${q(node)}"" ""${q(script)}"" --background", 0, False`,
      '',
    ].join('\r\n');
  }
  if (platform === 'darwin') {
    const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.daddyreview.server</string>
  <key>ProgramArguments</key><array><string>${x(node)}</string><string>${x(script)}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
  }
  return `[Desktop Entry]
Type=Application
Name=Daddy Review
Comment=Pull request review sidekick (background server)
Exec="${node}" "${script}" --background
X-GNOME-Autostart-enabled=true
NoDisplay=true
`;
}

function status() {
  return { supported: true, enabled: fs.existsSync(entryFile()), platform: process.platform };
}

function enable() {
  const file = entryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = entryContent();
  if (process.platform === 'win32') {
    // UTF-16 with BOM so paths with non-ASCII characters survive Windows Script Host.
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  } else {
    fs.writeFileSync(file, text);
  }
  return status();
}

function disable() {
  try { fs.unlinkSync(entryFile()); } catch { /* already off */ }
  return status();
}

function set(enabled) {
  return enabled ? enable() : disable();
}

module.exports = { status, enable, disable, set, entryFile, entryContent };
