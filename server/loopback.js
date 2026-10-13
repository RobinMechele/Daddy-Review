'use strict';
const http = require('http');
const { resultPage, cleanSignInError } = require('./pages');

/**
 * Desktop sign-in: open your normal browser at Microsoft (so your work account's
 * single sign-on just works), and listen on a random localhost port only until
 * Microsoft sends you back. Same approach as Git Credential Manager and `az login`.
 */
function createLoopbackLogin({ auth, openExternal, log, onSignedIn, timeoutMs = 10 * 60e3 }) {
  let current = null;

  function cancel() {
    if (current) current.close();
    current = null;
  }

  async function start() {
    cancel();
    const servers = [];
    let handled = false;
    let timer = null;
    const session = {
      close() {
        clearTimeout(timer);
        for (const s of servers) {
          if (s.closeAllConnections) s.closeAllConnections();
          s.close();
        }
        if (current === session) current = null;
      },
    };

    const handler = async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const isAnswer = url.pathname === '/' && (url.searchParams.has('code') || url.searchParams.has('error'));
      if (!isAnswer || handled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      handled = true;
      let page;
      if (url.searchParams.has('error')) {
        page = resultPage({ ok: false, title: 'Sign-in didn\'t finish', message: cleanSignInError(url.searchParams.get('error_description') || url.searchParams.get('error')) });
      } else {
        try {
          await auth.completeLogin({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
          page = resultPage({ ok: true, title: 'You\'re signed in', message: 'You can close this tab and go back to Daddy Review.' });
          if (onSignedIn) onSignedIn();
        } catch (e) {
          log.warn(`Sign-in failed: ${e.message}`);
          page = resultPage({ ok: false, title: 'Sign-in failed', message: e.message });
        }
      }
      res.writeHead(page.status, page.headers);
      res.end(page.html, () => session.close());
    };

    const first = http.createServer(handler);
    await new Promise((resolve, reject) => {
      first.once('error', reject);
      first.listen(0, '127.0.0.1', resolve);
    });
    servers.push(first);
    const { port } = first.address();
    // Browsers may resolve "localhost" to ::1 first; take the same port there when IPv6 exists.
    const v6 = http.createServer(handler);
    await new Promise((resolve) => {
      v6.once('error', () => resolve());
      v6.listen(port, '::1', () => {
        servers.push(v6);
        resolve();
      });
    });
    timer = setTimeout(() => session.close(), timeoutMs);
    if (timer.unref) timer.unref();
    current = session;

    const url = auth.beginLogin({ redirectUri: `http://localhost:${port}` });
    try {
      await openExternal(url);
    } catch (e) {
      session.close();
      throw e;
    }
    return { started: true };
  }

  return { start, cancel };
}

module.exports = { createLoopbackLogin };
