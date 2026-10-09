import { createApp } from '../src/app.js';

export const NIGHT = Date.UTC(2026, 9, 10, 1, 0, 0); // 9:00 PM Oct 9, Ann Arbor (EDT)
export const DAY = Date.UTC(2026, 9, 9, 18, 0, 0); // 2:00 PM Oct 9, Ann Arbor
export const SPOT = { lat: 42.2808, lng: -83.743 };
export const MIN = 60_000;

const open = new Set();
export function closeAll() {
  for (const app of open) {
    app.server.closeAllConnections();
    app.server.close();
  }
  open.clear();
}

export async function setup(start = NIGHT) {
  const state = { now: start };
  const app = createApp({ clock: () => state.now, adminKey: 'admin-secret', attestationMode: 'dev' });
  open.add(app);
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function call(method, path, { token, body, admin } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (admin) headers['x-admin-key'] = 'admin-secret';
    const res = await fetch(base + path, {
      method,
      headers,
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  }

  let n = 0;
  async function newUser({ age = 25, optIn = false, established = true } = {}) {
    const born = new Date(state.now);
    born.setUTCFullYear(born.getUTCFullYear() - age - 1);
    const r = await call('POST', '/v1/users', {
      body: { handle: `user${++n}`, birthdate: born.toISOString().slice(0, 10) },
    });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    const u = { id: r.body.user.id, token: r.body.token };
    if (established) app.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(state.now - 3 * 86400_000, u.id);
    if (optIn) await call('PATCH', '/v1/me', { token: u.token, body: { presence_opt_in: true } });
    return u;
  }

  const pinBody = (over = {}) => ({ ...SPOT, category: 'food', title: 'Midnight tacos', attestation: 'dev-ok', ...over });
  const near = (over = {}) => ({ ...SPOT, attestation: 'dev-ok', ...over });

  return { state, app, call, newUser, pinBody, near, close: closeAll };
}
