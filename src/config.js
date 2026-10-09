// Product rules live here so they are easy to tune and easy to test.
export const RULES = {
  minAge: 18,
  unlockHour: 20, // map unlocks at 8:00 PM city-local time
  lockHour: 6, // and locks again at 6:00 AM
  pinTtlMs: 3 * 60 * 60 * 1000, // 3-hour kill switch
  pinMaxLifeMs: 12 * 60 * 60 * 1000, // no pin lives forever, however many taps
  confirmWindowMs: 30 * 60 * 1000, // "Still Here" taps counted within this window
  confirmersToExtend: 2, // distinct people needed to extend a pin
  presenceRadiusM: 150, // must be this close to create/confirm a pin
  exactRevealM: 1609, // ~1 mile: exact location only revealed this close
  approxCellDeg: 0.005, // ~550 m grid for far-away viewers
  reportsToHide: 3,
  newAccountMs: 24 * 60 * 60 * 1000,
  maxPinsPerNight: { newAccount: 2, established: 6 },
  maxAccuracyM: 100, // reject low-quality GPS fixes
  presence: {
    ttlMs: 30 * 60 * 1000, // presence expires 30 min after the last heartbeat
    bucketMs: 5 * 60 * 1000, // counts are delayed to 5-minute snapshots
    matchRadiusM: 75, // user counts toward a pin within this distance
    minCount: 5, // never show a crowd count below this
    maxDots: 60,
    dotRadiusM: 40,
  },
  flashDrop: {
    durationMs: 60 * 60 * 1000,
    radiusM: 8047, // 5 miles
    maxPerCityPerNight: 5,
    maxScheduleAheadMs: 24 * 60 * 60 * 1000,
  },
  rateLimit: { perMinute: 120 },
};

export const CATEGORIES = ['food', 'popup', 'drop', 'music', 'skate', 'market', 'art', 'other'];

// Content policy: unpermitted/illegal activity is not allowed on the map.
export const BANNED_TERMS = [
  'takeover',
  'street race',
  'streetrace',
  'drag race',
  'sideshow',
  'bootleg',
  'unlicensed',
  'underage',
  'no id',
  'gun',
  'drugs',
];

// Cities set the timezone for the 8 PM unlock. Add more as you launch.
export const CITIES = [
  { key: 'ann-arbor', name: 'Ann Arbor', lat: 42.2808, lng: -83.743, tz: 'America/Detroit' },
  { key: 'detroit', name: 'Detroit', lat: 42.3314, lng: -83.0458, tz: 'America/Detroit' },
  { key: 'chicago', name: 'Chicago', lat: 41.8781, lng: -87.6298, tz: 'America/Chicago' },
  { key: 'nyc', name: 'New York', lat: 40.7128, lng: -74.006, tz: 'America/New_York' },
  { key: 'la', name: 'Los Angeles', lat: 34.0522, lng: -118.2437, tz: 'America/Los_Angeles' },
];
export const CITY_MAX_DISTANCE_M = 60_000;
