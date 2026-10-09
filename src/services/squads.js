import { randomBytes } from 'node:crypto';
import { forbidden, notFound } from '../errors.js';
import { parseCoords } from '../geo.js';
import { checkText } from './safety.js';

const NODE_TTL_MS = 6 * 60 * 60 * 1000;

export function createSquad(ctx, user, body) {
  const name = checkText(body?.name, 'name');
  const code = randomBytes(4).toString('hex');
  const r = ctx.db
    .prepare('INSERT INTO squads (name, owner_id, invite_code) VALUES (?,?,?)')
    .run(name, user.id, code);
  ctx.db.prepare('INSERT INTO squad_members (squad_id, user_id) VALUES (?,?)').run(r.lastInsertRowid, user.id);
  return { id: Number(r.lastInsertRowid), name, invite_code: code };
}

export function joinSquad(ctx, user, body) {
  const squad = ctx.db.prepare('SELECT * FROM squads WHERE invite_code = ?').get(String(body?.invite_code ?? ''));
  if (!squad) throw notFound('Invalid invite code');
  ctx.db.prepare('INSERT OR IGNORE INTO squad_members (squad_id, user_id) VALUES (?,?)').run(squad.id, user.id);
  return { id: squad.id, name: squad.name };
}

function requireMember(db, squadId, userId) {
  const m = db.prepare('SELECT 1 FROM squad_members WHERE squad_id = ? AND user_id = ?').get(squadId, userId);
  if (!m) throw forbidden('not_in_squad', 'You are not in this squad');
}

/** A Ghost Node shares a meeting SPOT with your squad. It never shares anyone's live position. */
export function createNode(ctx, user, squadId, body) {
  requireMember(ctx.db, squadId, user.id);
  const { lat, lng } = parseCoords(body);
  const name = checkText(body?.name, 'name');
  const r = ctx.db
    .prepare('INSERT INTO ghost_nodes (squad_id, creator_id, name, lat, lng, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(squadId, user.id, name, lat, lng, ctx.now, ctx.now + NODE_TTL_MS);
  return { id: Number(r.lastInsertRowid), name, lat, lng, expires_at: ctx.now + NODE_TTL_MS };
}

export function listNodes(ctx, user, squadId) {
  requireMember(ctx.db, squadId, user.id);
  return ctx.db
    .prepare('SELECT id, name, lat, lng, created_at, expires_at FROM ghost_nodes WHERE squad_id = ? AND expires_at > ?')
    .all(squadId, ctx.now);
}
