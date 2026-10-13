/** Calls the local Daddy Review server. The custom header is what lets the server trust us. */
export async function api(method, path, body) {
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
