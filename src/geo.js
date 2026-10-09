import { RULES } from './config.js';
import { bad } from './errors.js';

const R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;

export function distanceM(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function parseCoords(obj) {
  const lat = Number(obj?.lat);
  const lng = Number(obj?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw bad('invalid_location', 'lat and lng are required');
  }
  if (obj.accuracy_m !== undefined && Number(obj.accuracy_m) > RULES.maxAccuracyM) {
    throw bad('low_accuracy', `Location accuracy must be ${RULES.maxAccuracyM} m or better`);
  }
  return { lat, lng };
}

/** Snap to the centre of a ~550 m grid cell so far-away viewers only see an area. */
export function approximate(lat, lng) {
  const c = RULES.approxCellDeg;
  const snap = (v) => (Math.floor(v / c) + 0.5) * c;
  return { lat: round(snap(lat), 5), lng: round(snap(lng), 5) };
}

const round = (v, p) => Math.round(v * 10 ** p) / 10 ** p;

// Small seeded PRNG so decorative dots are stable within a snapshot bucket.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random points inside a circle. These are decoration, never real positions. */
export function scatterDots(lat, lng, count, radiusM, seed) {
  const rnd = mulberry32(seed);
  const dots = [];
  for (let i = 0; i < count; i++) {
    const r = radiusM * Math.sqrt(rnd());
    const theta = rnd() * 2 * Math.PI;
    const dLat = (r * Math.cos(theta)) / 111_320;
    const dLng = (r * Math.sin(theta)) / (111_320 * Math.cos(rad(lat)));
    dots.push({ lat: round(lat + dLat, 6), lng: round(lng + dLng, 6) });
  }
  return dots;
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
