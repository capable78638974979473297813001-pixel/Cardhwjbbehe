import { RULES } from '../config.js';
import { bad, forbidden, notFound } from '../errors.js';
import { parseCoords } from '../geo.js';
import { nightKey, resolveCity } from '../time.js';
import { checkText } from './safety.js';

/** Admin hook (payments would call this after a purchase): make a vendor and add Flash Drop tokens. */
export function grantTokens(db, userId, amount) {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw notFound('No such user');
  if (!Number.isInteger(amount) || amount <= 0) throw bad('invalid_amount', 'amount must be a positive integer');
  db.prepare("UPDATE users SET role = 'vendor' WHERE id = ?").run(userId);
  db.prepare(
    `INSERT INTO vendor_tokens (vendor_id, balance) VALUES (?,?)
     ON CONFLICT(vendor_id) DO UPDATE SET balance = balance + excluded.balance`,
  ).run(userId, amount);
  return db.prepare('SELECT balance FROM vendor_tokens WHERE vendor_id = ?').get(userId);
}

export function createDrop(ctx, user, body) {
  const { db, now } = ctx;
  if (user.role !== 'vendor') throw forbidden('not_vendor', 'Only vendors can run Flash Drops');
  const title = checkText(body?.title);
  const { lat, lng } = parseCoords(body);
  const city = resolveCity(lat, lng);
  if (!city) throw forbidden('outside_service_area', 'AfterHours is not live in this area yet');

  const startsAt = body.starts_at === undefined ? now : Number(new Date(body.starts_at));
  if (!Number.isFinite(startsAt) || startsAt < now - 60_000 || startsAt > now + RULES.flashDrop.maxScheduleAheadMs) {
    throw bad('invalid_start', 'starts_at must be within the next 24 hours');
  }
  const night = nightKey(startsAt, city.tz);
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM flash_drops WHERE city = ? AND night = ?')
    .get(city.key, night);
  if (n >= RULES.flashDrop.maxPerCityPerNight) {
    throw forbidden('drop_cap', 'Flash Drops are sold out for that night in this city');
  }
  const paid = db
    .prepare('UPDATE vendor_tokens SET balance = balance - 1 WHERE vendor_id = ? AND balance > 0')
    .run(user.id);
  if (paid.changes === 0) throw forbidden('no_tokens', 'You are out of Flash Drop tokens');
  const endsAt = startsAt + RULES.flashDrop.durationMs;
  const r = db
    .prepare('INSERT INTO flash_drops (vendor_id, city, night, title, lat, lng, starts_at, ends_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(user.id, city.key, night, title, lat, lng, startsAt, endsAt);
  return { id: Number(r.lastInsertRowid), promoted: true, starts_at: startsAt, ends_at: endsAt };
}
