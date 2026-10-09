import { RULES, CITIES, CITY_MAX_DISTANCE_M } from './config.js';
import { distanceM } from './geo.js';

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = Number(p.value);
  return { year: o.year, month: o.month, day: o.day, hour: o.hour, minute: o.minute };
}

// UTC ms for a given local wall-clock time in tz (two passes handles DST edges).
function localToUtc(y, mo, d, h, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, 0, 0);
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    guess -= asUtc - Date.UTC(y, mo - 1, d, h, 0, 0);
  }
  return guess;
}

export function isUnlocked(ms, tz) {
  const { hour } = localParts(ms, tz);
  return hour >= RULES.unlockHour || hour < RULES.lockHour;
}

export function nextUnlockMs(ms, tz) {
  const p = localParts(ms, tz);
  let t = localToUtc(p.year, p.month, p.day, RULES.unlockHour, tz);
  if (t <= ms) {
    const next = localParts(t + 26 * 3600 * 1000, tz);
    t = localToUtc(next.year, next.month, next.day, RULES.unlockHour, tz);
  }
  return t;
}

/** Identifies "tonight": the local date of the moment shifted back by the lock hour. */
export function nightKey(ms, tz) {
  const p = localParts(ms - RULES.lockHour * 3600 * 1000, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function resolveCity(lat, lng) {
  let best = null;
  let bestD = Infinity;
  for (const c of CITIES) {
    const d = distanceM(lat, lng, c.lat, c.lng);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return bestD <= CITY_MAX_DISTANCE_M ? best : null;
}
