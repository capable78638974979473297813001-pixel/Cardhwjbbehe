import { createServer } from 'node:http';
import { RULES } from './config.js';
import { tx, openDb } from './db.js';
import { HttpError, bad, forbidden, notFound } from './errors.js';
import { authenticate, publicUser, register, setPresenceOptIn } from './services/users.js';
import { createPin, getPin, mapFor, reportPin, stillHere, purgeExpired } from './services/pins.js';
import { heartbeat, leave } from './services/presence.js';
import { createNode, createSquad, joinSquad, listNodes } from './services/squads.js';
import { createDrop, grantTokens } from './services/vendors.js';
import { defaultAttestationVerifier } from './services/safety.js';

const MAX_BODY = 16 * 1024;

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('invalid_json', 'Body must be valid JSON');
  }
}

/**
 * createApp wires services to HTTP. Dependencies (db, clock, attestation) are injectable so
 * everything is testable without a network or real time.
 */
export function createApp({
  db = openDb(),
  clock = Date.now,
  attestationMode = process.env.ATTESTATION_MODE ?? 'dev', // dev | strict | off
  verifyAttestation = defaultAttestationVerifier,
  adminKey = process.env.ADMIN_KEY ?? '',
} = {}) {
  const buckets = new Map(); // userId -> { windowStart, count }

  function rateLimit(userId, now) {
    const b = buckets.get(userId);
    if (!b || now - b.windowStart >= 60_000) {
      buckets.set(userId, { windowStart: now, count: 1 });
      return;
    }
    if (++b.count > RULES.rateLimit.perMinute) throw new HttpError(429, 'rate_limited', 'Slow down');
  }

  const requireAdmin = (req) => {
    if (!adminKey || req.headers['x-admin-key'] !== adminKey) throw forbidden('admin_only', 'Admin only');
  };

  // [method, pattern, auth, handler]. Handlers receive ({ctx, user, body, params, query, req}).
  const routes = [
    ['GET', '/health', 'none', () => ({ ok: true })],
    ['POST', '/v1/users', 'none', ({ ctx, body }) => register(db, ctx.now, body)],
    ['GET', '/v1/me', 'user', ({ ctx, user }) => publicUser(user, ctx.now)],
    [
      'PATCH',
      '/v1/me',
      'user',
      ({ ctx, user, body }) => {
        if (typeof body.presence_opt_in === 'boolean') setPresenceOptIn(db, user, body.presence_opt_in);
        return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), ctx.now);
      },
    ],
    ['POST', '/v1/map', 'user', ({ ctx, body }) => mapFor(ctx, body)],
    ['POST', '/v1/pins', 'user', ({ ctx, user, body }) => tx(db, () => createPin(ctx, user, body))],
    [
      'POST',
      '/v1/pins/:id/view',
      'user',
      ({ ctx, params, body }) => {
        const lat = body.lat === undefined ? null : Number(body.lat);
        const lng = body.lng === undefined ? null : Number(body.lng);
        return getPin(ctx, params.id, Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null);
      },
    ],
    ['POST', '/v1/pins/:id/still-here', 'user', ({ ctx, user, params, body }) => tx(db, () => stillHere(ctx, user, params.id, body))],
    ['POST', '/v1/pins/:id/report', 'user', ({ ctx, user, params, body }) => tx(db, () => reportPin(ctx, user, params.id, body))],
    ['POST', '/v1/presence', 'user', ({ ctx, user, body }) => tx(db, () => heartbeat(ctx, user, body))],
    ['DELETE', '/v1/presence', 'user', ({ ctx, user }) => (leave(ctx, user), { ok: true })],
    ['POST', '/v1/squads', 'user', ({ ctx, user, body }) => tx(db, () => createSquad(ctx, user, body))],
    ['POST', '/v1/squads/join', 'user', ({ ctx, user, body }) => joinSquad(ctx, user, body)],
    ['POST', '/v1/squads/:id/nodes', 'user', ({ ctx, user, params, body }) => createNode(ctx, user, params.id, body)],
    ['GET', '/v1/squads/:id/nodes', 'user', ({ ctx, user, params }) => ({ nodes: listNodes(ctx, user, params.id) })],
    ['POST', '/v1/vendor/drops', 'user', ({ ctx, user, body }) => tx(db, () => createDrop(ctx, user, body))],
    [
      'POST',
      '/v1/sensitive-zones',
      'admin',
      ({ body }) => {
        const { label, lat, lng, radius_m } = body;
        if (!label || ![lat, lng, radius_m].every(Number.isFinite)) throw bad('invalid_zone', 'label, lat, lng, radius_m required');
        const r = db.prepare('INSERT INTO sensitive_zones (label, lat, lng, radius_m) VALUES (?,?,?,?)').run(label, lat, lng, radius_m);
        return { id: Number(r.lastInsertRowid) };
      },
    ],
    [
      'POST',
      '/v1/admin/vendors/:id/tokens',
      'admin',
      ({ params, body }) => grantTokens(db, params.id, Number(body.amount)),
    ],
  ].map(([method, pattern, auth, handler]) => ({
    method,
    auth,
    handler,
    keys: [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]),
    re: new RegExp(`^${pattern.replace(/:\w+/g, '(\\d+)')}$`),
  }));

  async function handle(req) {
    const url = new URL(req.url, 'http://x');
    let matchedPath = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      matchedPath = true;
      if (r.method !== req.method) continue;
      const now = clock();
      const params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
      const body = ['GET', 'DELETE'].includes(req.method) ? {} : await readJson(req);
      let user = null;
      if (r.auth === 'user') {
        user = authenticate(db, req.headers.authorization);
        rateLimit(user.id, now);
      } else if (r.auth === 'admin') requireAdmin(req);
      const ctx = { db, now, attestationMode, verifyAttestation };
      return r.handler({ ctx, user, body, params, req });
    }
    throw matchedPath ? new HttpError(405, 'method_not_allowed', 'Method not allowed') : notFound('No such route');
  }

  const server = createServer(async (req, res) => {
    try {
      const out = await handle(req);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal', 'Something went wrong');
      if (!(e instanceof HttpError)) console.error(e);
      res
        .writeHead(err.status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: err.code, message: err.message, ...err.extra } }));
    }
  });

  return { server, db, handle, purge: () => purgeExpired(db, clock()) };
}
