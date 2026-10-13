'use strict';
const { execFile } = require('child_process');

/**
 * Native desktop popups for when the app window is closed but the background
 * server is still watching your PRs. Clicking a Windows toast opens the PR.
 */

// Windows PowerShell's own AppUserModelID: always registered, so toasts show up without installing anything.
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function windowsToastScript({ title, body, url }) {
  const xml = `<toast activationType="protocol" launch="${xmlEsc(url)}" duration="long">`
    + '<visual><binding template="ToastGeneric">'
    + `<text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text><text placement="attribution">Daddy Review</text>`
    + '</binding></visual>'
    + `<actions><action content="Open" activationType="protocol" arguments="${xmlEsc(url)}"/></actions>`
    + '</toast>';
  const b64 = Buffer.from(xml, 'utf8').toString('base64');
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
    '$t = [Windows.UI.Notifications.ToastNotification]::new($x)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${PS_AUMID}').Show($t)`,
  ].join('\n');
}

const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function createNotifier({ log, platform = process.platform, run = execFile }) {
  const done = (what) => (err) => {
    if (err) log.warn(`Desktop popup (${what}) failed: ${err.message.split('\n')[0]}`);
  };
  return function notify({ title, body = '', url }) {
    try {
      if (platform === 'win32') {
        const script = windowsToastScript({ title, body, url });
        run('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
        ], { windowsHide: true, timeout: 20000 }, done('toast'));
      } else if (platform === 'darwin') {
        run('osascript', ['-e', `display notification ${appleString(body)} with title ${appleString(title)}`], { timeout: 10000 }, done('osascript'));
      } else {
        run('notify-send', ['-a', 'Daddy Review', String(title), String(body)], { timeout: 10000 }, () => {});
      }
    } catch (e) {
      log.warn(`Desktop popup failed: ${e.message}`);
    }
  };
}

module.exports = { createNotifier, windowsToastScript };
