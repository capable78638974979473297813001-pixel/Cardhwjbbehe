import { RULES } from '../config.js';
import { bad, conflict, forbidden, notFound } from '../errors.js';
import { approximate, distanceM, parseCoords } from '../geo.js';
import { isUnlocked, nextUnlockMs, nightKey, resolveCity } from '../time.js';
import { crowdFor } from './presence.js';
import { checkCategory, checkText, inSensitiveZone } from './safety.js';

function cityOrThrow(lat, lng) {
  const city = resolveCity(lat, lng);
  if (!city) throw forbidden('outside_service_area', 'AfterHours is not live in your area yet');
  return city;
}

function requireUnlocked(now, city) {
  if (!isUnlocked(now, city.tz)) {
    throw forbidden('locked', 'The map is locked until tonight', {
      unlocks_at: nextUnlockMs(now, city.tz),
    });
  }
}

function requireAttestation(ctx, body) {
  if (!ctx.verifyAttestation(String(body?.attestation ?? ''), { mode: ctx.attestationMode })) {
    throw forbidden('attestation_failed', 'Could not verify this device is genuine');
  }
}

/** Render a pin for a viewer: exact location only when they are nearby. */
export function viewPin(ctx, pin, viewerLat, viewerLng) {
  const near =
    viewerLat != null && distanceM(viewerLat, viewerLng, pin.lat, pin.lng) <= RULES.exactRevealM;
  const loc = near ? { lat: pin.lat, lng: pin.lng } : approximate(pin.lat, pin.lng);
  const confirmers = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM confirmations WHERE pin_id = ?')
    .get(pin.id).n;
  return {
    id: pin.id,
    kind: 'pin',
    category: pin.category,
    title: pin.title,
    lat: loc.lat,
    lng: loc.lng,
    approximate: !near,
    created_at: pin.created_at,
    expires_at: pin.expires_at,
    confirmations: confirmers,
    crowd: crowdFor(ctx.db, pin, ctx.now, { exact: near }),
  };
}

export function createPin(ctx, user, body) {
  const { db, now } = ctx;
  const { lat, lng } = parseCoords(body);
  const city = cityOrThrow(lat, lng);
  requireUnlocked(now, city);
  requireAttestation(ctx, body);
  const category = checkCategory(body.category);
  const title = checkText(body.title);
  if (inSensitiveZone(db, lat, lng)) {
    throw forbidden('sensitive_location', 'Pins cannot be dropped at this kind of location');
  }
  const isNew = now - user.created_at < RULES.newAccountMs;
  const cap = isNew ? RULES.maxPinsPerNight.newAccount : RULES.maxPinsPerNight.established;
  const tonight = db
    .prepare('SELECT created_at FROM pins WHERE creator_id = ? AND city = ? AND created_at > ?')
    .all(user.id, city.key, now - 18 * 3600 * 1000)
    .filter((p) => nightKey(p.created_at, city.tz) === nightKey(now, city.tz)).length;
  if (tonight >= cap) throw forbidden('pin_limit', 'You have dropped enough pins for tonight');

  const r = db
    .prepare(
      `INSERT INTO pins (creator_id, city, category, title, lat, lng, created_at, expires_at, max_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(user.id, city.key, category, title, lat, lng, now, now + RULES.pinTtlMs, now + RULES.pinMaxLifeMs);
  const pin = db.prepare('SELECT * FROM pins WHERE id = ?').get(r.lastInsertRowid);
  return viewPin(ctx, pin, lat, lng);
}

function livePin(db, id, now) {
  const pin = db.prepare('SELECT * FROM pins WHERE id = ? AND hidden = 0 AND expires_at > ?').get(id, now);
  if (!pin) throw notFound('That spot is gone');
  return pin;
}

/** "Still Here": needs two different people physically present to extend a pin. */
export function stillHere(ctx, user, pinId, body) {
  const { db, now } = ctx;
  const pin = livePin(db, pinId, now);
  const city = cityOrThrow(pin.lat, pin.lng);
  requireUnlocked(now, city);
  requireAttestation(ctx, body);
  const { lat, lng } = parseCoords(body);
  if (pin.creator_id === user.id) throw conflict('own_pin', 'You cannot confirm your own pin');
  if (distanceM(lat, lng, pin.lat, pin.lng) > RULES.presenceRadiusM) {
    throw forbidden('not_present', 'You need to be at the spot to tap Still Here');
  }
  db.prepare(
    `INSERT INTO confirmations (pin_id, user_id, at) VALUES (?,?,?)
     ON CONFLICT(pin_id, user_id) DO UPDATE SET at = excluded.at`,
  ).run(pin.id, user.id, now);
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM confirmations WHERE pin_id = ? AND at > ?')
    .get(pin.id, now - RULES.confirmWindowMs);
  let expiresAt = pin.expires_at;
  let extended = false;
  if (n >= RULES.confirmersToExtend) {
    const next = Math.min(pin.max_expires_at, now + RULES.pinTtlMs);
    if (next > expiresAt) {
      expiresAt = next;
      extended = true;
      db.prepare('UPDATE pins SET expires_at = ? WHERE id = ?').run(expiresAt, pin.id);
    }
  }
  return { extended, recent_confirmers: n, needed: RULES.confirmersToExtend, expires_at: expiresAt };
}

export function reportPin(ctx, user, pinId, body) {
  const { db, now } = ctx;
  const pin = livePin(db, pinId, now);
  if (pin.creator_id === user.id) throw conflict('own_pin', 'You cannot report your own pin');
  const reason = String(body?.reason ?? '').slice(0, 200);
  db.prepare('INSERT OR IGNORE INTO reports (pin_id, user_id, reason, at) VALUES (?,?,?,?)').run(
    pin.id,
    user.id,
    reason,
    now,
  );
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE pin_id = ?').get(pin.id);
  const hidden = n >= RULES.reportsToHide;
  if (hidden) {
    db.prepare('UPDATE pins SET hidden = 1 WHERE id = ?').run(pin.id);
    db.prepare('DELETE FROM presence WHERE pin_id = ?').run(pin.id);
  }
  return { reports: n, hidden };
}

export function getPin(ctx, pinId, viewerLat, viewerLng) {
  return viewPin(ctx, livePin(ctx.db, pinId, ctx.now), viewerLat, viewerLng);
}

/** The main map call. During the day it returns only a teaser. */
export function mapFor(ctx, body) {
  const { db, now } = ctx;
  const { lat, lng } = parseCoords(body);
  const city = cityOrThrow(lat, lng);
  if (!isUnlocked(now, city.tz)) {
    const unlocksAt = nextUnlockMs(now, city.tz);
    const tonight = nightKey(unlocksAt, city.tz);
    const scheduled = db
      .prepare('SELECT night FROM flash_drops WHERE city = ? AND starts_at >= ?')
      .all(city.key, now)
      .filter((d) => d.night === tonight).length;
    return {
      locked: true,
      city: city.key,
      unlocks_at: unlocksAt,
      teaser: { scheduled_spots: scheduled },
      pins: [],
      drops: [],
    };
  }
  const pins = db
    .prepare('SELECT * FROM pins WHERE city = ? AND hidden = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 300')
    .all(city.key, now)
    .map((p) => viewPin(ctx, p, lat, lng));
  const drops = db
    .prepare('SELECT * FROM flash_drops WHERE city = ? AND starts_at <= ? AND ends_at > ?')
    .all(city.key, now, now)
    .filter((d) => distanceM(lat, lng, d.lat, d.lng) <= RULES.flashDrop.radiusM)
    .map((d) => ({
      id: d.id,
      kind: 'flash_drop',
      promoted: true, // always labeled so it is never confused with a real pin
      title: d.title,
      lat: d.lat,
      lng: d.lng,
      ends_at: d.ends_at,
    }));
  return { locked: false, city: city.key, pins, drops };
}

export function purgeExpired(db, now) {
  db.prepare('DELETE FROM presence WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM ghost_nodes WHERE expires_at <= ?').run(now);
  const old = now - 24 * 3600 * 1000;
  db.prepare('DELETE FROM presence WHERE pin_id IN (SELECT id FROM pins WHERE expires_at <= ?)').run(old);
  db.prepare('DELETE FROM confirmations WHERE pin_id IN (SELECT id FROM pins WHERE expires_at <= ?)').run(old);
  db.prepare('DELETE FROM reports WHERE pin_id IN (SELECT id FROM pins WHERE expires_at <= ?)').run(old);
  db.prepare('DELETE FROM pins WHERE expires_at <= ?').run(old);
}
