import { createHash, randomBytes } from 'node:crypto';
import { RULES } from '../config.js';
import { bad, conflict, unauthorized } from '../errors.js';

const HANDLE_RE = /^[a-z0-9_.]{3,24}$/i;
export const hashToken = (t) => createHash('sha256').update(t).digest('hex');

export function ageOn(birthdate, nowMs) {
  const b = new Date(`${birthdate}T00:00:00Z`);
  if (Number.isNaN(b.getTime())) return null;
  const n = new Date(nowMs);
  let age = n.getUTCFullYear() - b.getUTCFullYear();
  const beforeBirthday =
    n.getUTCMonth() < b.getUTCMonth() ||
    (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function publicUser(u, nowMs) {
  return {
    id: u.id,
    handle: u.handle,
    role: u.role,
    presence_opt_in: !!u.presence_opt_in,
    new_account: nowMs - u.created_at < RULES.newAccountMs,
  };
}

export function register(db, now, body) {
  const handle = String(body?.handle ?? '');
  if (!HANDLE_RE.test(handle)) throw bad('invalid_handle', 'Handle must be 3-24 letters, numbers, _ or .');
  const age = ageOn(String(body?.birthdate ?? ''), now);
  if (age === null) throw bad('invalid_birthdate', 'birthdate must be YYYY-MM-DD');
  if (age < RULES.minAge) throw bad('age_restricted', `AfterHours is ${RULES.minAge}+`);
  const token = randomBytes(24).toString('hex');
  try {
    const r = db
      .prepare('INSERT INTO users (handle, birthdate, token_hash, created_at) VALUES (?,?,?,?)')
      .run(handle, body.birthdate, hashToken(token), now);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    return { user: publicUser(user, now), token };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw conflict('handle_taken', 'Handle already in use');
    throw e;
  }
}

export function authenticate(db, header) {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  if (!m) throw unauthorized();
  const user = db.prepare('SELECT * FROM users WHERE token_hash = ?').get(hashToken(m[1]));
  if (!user) throw unauthorized();
  return user;
}

export function setPresenceOptIn(db, user, value) {
  const on = value ? 1 : 0;
  db.prepare('UPDATE users SET presence_opt_in = ? WHERE id = ?').run(on, user.id);
  // Turning presence off removes you from every crowd count immediately.
  if (!on) db.prepare('DELETE FROM presence WHERE user_id = ?').run(user.id);
}
