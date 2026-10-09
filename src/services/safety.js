import { BANNED_TERMS, CATEGORIES } from '../config.js';
import { bad, forbidden } from '../errors.js';
import { distanceM } from '../geo.js';

export function checkText(text, field = 'title') {
  const t = String(text ?? '').trim();
  if (t.length < 2 || t.length > 80) throw bad('invalid_text', `${field} must be 2-80 characters`);
  const lower = t.toLowerCase();
  const hit = BANNED_TERMS.find((w) => lower.includes(w));
  if (hit) throw forbidden('content_policy', 'That kind of spot is not allowed on AfterHours');
  return t;
}

export function checkCategory(c) {
  if (!CATEGORIES.includes(c)) throw bad('invalid_category', `category must be one of: ${CATEGORIES.join(', ')}`);
  return c;
}

export function inSensitiveZone(db, lat, lng) {
  const zones = db.prepare('SELECT lat, lng, radius_m FROM sensitive_zones').all();
  return zones.some((z) => distanceM(lat, lng, z.lat, z.lng) <= z.radius_m);
}

/**
 * Device attestation hook. The default only works in dev: a real deployment must
 * plug in Apple App Attest / Google Play Integrity verification here.
 */
export function defaultAttestationVerifier(token, { mode }) {
  if (mode === 'off') return true;
  if (mode === 'dev') return token === 'dev-ok';
  return false; // 'strict' with no verifier injected fails closed
}
