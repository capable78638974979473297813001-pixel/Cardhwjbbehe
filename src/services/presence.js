import { RULES } from '../config.js';
import { forbidden } from '../errors.js';
import { distanceM, hashString, parseCoords, scatterDots } from '../geo.js';
import { resolveCity, isUnlocked } from '../time.js';
import { inSensitiveZone } from './safety.js';

const bandFor = (n) => (n >= 50 ? '50+' : n >= 25 ? '25+' : n >= 10 ? '10+' : n >= 5 ? '5+' : null);

/**
 * Anonymous crowd info for a pin. Counts come from a delayed 5-minute snapshot,
 * are hidden below the minimum, and dots are random decoration (never real positions).
 */
export function crowdFor(db, pin, now, { exact }) {
  const { bucketMs, minCount, maxDots, dotRadiusM } = RULES.presence;
  const bucketStart = Math.floor(now / bucketMs) * bucketMs;
  const { n } = db
    .prepare(
      'SELECT COUNT(*) AS n FROM presence WHERE pin_id = ? AND entered_at <= ? AND expires_at > ?',
    )
    .get(pin.id, bucketStart, bucketStart);
  if (n < minCount) return null;
  const crowd = { band: bandFor(n), as_of: bucketStart };
  if (exact) {
    crowd.dots = scatterDots(
      pin.lat,
      pin.lng,
      Math.min(n, maxDots),
      dotRadiusM,
      hashString(`${pin.id}:${bucketStart}`),
    );
  }
  return crowd;
}

/** Opt-in heartbeat. Stores which pin you are at, never your coordinates. */
export function heartbeat(ctx, user, body) {
  const { db, now } = ctx;
  if (!user.presence_opt_in) {
    throw forbidden('presence_off', 'Turn on presence sharing to be counted at spots');
  }
  const { lat, lng } = parseCoords(body);
  const city = resolveCity(lat, lng);
  const clear = () => db.prepare('DELETE FROM presence WHERE user_id = ?').run(user.id);

  if (!city || !isUnlocked(now, city.tz) || inSensitiveZone(db, lat, lng)) {
    clear();
    return { counted: false };
  }
  const pins = db
    .prepare('SELECT id, lat, lng FROM pins WHERE city = ? AND hidden = 0 AND expires_at > ?')
    .all(city.key, now);
  let nearest = null;
  let nearestD = RULES.presence.matchRadiusM;
  for (const p of pins) {
    const d = distanceM(lat, lng, p.lat, p.lng);
    if (d <= nearestD) {
      nearest = p;
      nearestD = d;
    }
  }
  if (!nearest) {
    clear(); // you left: you vanish from the count
    return { counted: false };
  }
  const existing = db.prepare('SELECT pin_id, entered_at FROM presence WHERE user_id = ?').get(user.id);
  const enteredAt = existing && existing.pin_id === nearest.id ? existing.entered_at : now;
  db.prepare(
    `INSERT INTO presence (user_id, pin_id, entered_at, last_seen_at, expires_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET pin_id = excluded.pin_id, entered_at = excluded.entered_at,
       last_seen_at = excluded.last_seen_at, expires_at = excluded.expires_at`,
  ).run(user.id, nearest.id, enteredAt, now, now + RULES.presence.ttlMs);
  return { counted: true, pin_id: nearest.id, expires_at: now + RULES.presence.ttlMs };
}

export function leave(ctx, user) {
  ctx.db.prepare('DELETE FROM presence WHERE user_id = ?').run(user.id);
}
