'use strict';
/** The OS-specific bits (Windows toasts, start at login) checked without needing that OS. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowsToastScript, createNotifier } = require('../server/notify');
const autostart = require('../server/autostart');

test('Windows toast: user text is XML-escaped and carried as base64 (no quoting issues)', () => {
  const script = windowsToastScript({
    title: 'Jan "the man" <O\'Neil> & co approved',
    body: "Fix 'quotes' & <tags>",
    url: 'https://dev.azure.com/org/Proj%20X/_git/repo/pullrequest/1?a=1&b=2',
  });
  const b64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)[1];
  const xml = Buffer.from(b64, 'base64').toString('utf8');
  assert.match(xml, /<text>Jan &quot;the man&quot; &lt;O&apos;Neil&gt; &amp; co approved<\/text>/);
  assert.match(xml, /launch="https:\/\/dev\.azure\.com\/org\/Proj%20X\/_git\/repo\/pullrequest\/1\?a=1&amp;b=2"/);
  assert.equal((xml.match(/</g) || []).length, (xml.match(/>/g) || []).length, 'balanced tags');
  // Nothing user-controlled ends up in the PowerShell source itself.
  assert.doesNotMatch(script, /O'Neil|quotes/);
});

test('notifier picks the right OS command', () => {
  const calls = [];
  const run = (cmd, args) => calls.push([cmd, args]);
  const log = { warn() {} };
  createNotifier({ log, platform: 'win32', run })({ title: 't', body: 'b', url: 'http://localhost:4280' });
  createNotifier({ log, platform: 'darwin', run })({ title: 'He said "hi"', body: 'b', url: 'x' });
  createNotifier({ log, platform: 'linux', run })({ title: 't', body: 'b', url: 'x' });
  assert.equal(calls[0][0], 'powershell.exe');
  assert.ok(calls[0][1].includes('-EncodedCommand'));
  const decoded = Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /ToastNotificationManager/);
  assert.equal(calls[1][0], 'osascript');
  assert.match(calls[1][1][1], /with title "He said \\"hi\\""/);
  assert.deepEqual(calls[2], ['notify-send', ['-a', 'Daddy Review', 't', 'b']]);
});

test('start-at-login entries per OS', () => {
  const winFile = autostart.entryFile('win32', { APPDATA: 'C:\\Users\\robin\\AppData\\Roaming' });
  assert.match(winFile, /Startup[\\/]Daddy Review\.vbs$/);
  const vbs = autostart.entryContent('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Apps\\Daddy Review\\server\\index.js');
  assert.match(vbs, /shell\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Apps\\Daddy Review\\server\\index\.js"" --background", 0, False/);
  assert.match(autostart.entryContent('darwin', '/usr/local/bin/node', '/x/server/index.js'), /<string>--background<\/string>/);
  assert.match(autostart.entryContent('linux', '/usr/bin/node', '/x/server/index.js'), /^Exec="\/usr\/bin\/node" "\/x\/server\/index\.js" --background$/m);
});
