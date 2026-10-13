/** Calls the Daddy Review engine: over IPC in the desktop app, over HTTP in the browser dev mode. */
export async function api(method, path, body) {
  if (window.daddyNative) {
    // Desktop app: straight to the engine over IPC, no network involved.
    const { status, data } = await window.daddyNative.api(method, path, body);
    if (status >= 400) {
      const e = new Error((data && data.error) || `Request failed (${status})`);
      e.status = status;
      e.code = data && data.code;
      throw e;
    }
    return data;
  }
  const headers = { 'X-Daddy-Review': '1' };
  if ('Notification' in window) headers['X-Daddy-Notify'] = Notification.permission;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch {
    const e = new Error('Daddy Review is not running');
    e.offline = true;
    throw e;
  }
  let data = null;
  try {
    data = await res.json();
  } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || `Request failed (${res.status})`);
    e.status = res.status;
    e.code = data && data.code;
    throw e;
  }
  return data;
}
