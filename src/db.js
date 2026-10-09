import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  birthdate TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  token_hash TEXT NOT NULL UNIQUE,
  presence_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pins (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  city TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_expires_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pins_live ON pins(city, expires_at);
CREATE TABLE IF NOT EXISTS confirmations (
  pin_id INTEGER NOT NULL REFERENCES pins(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  PRIMARY KEY (pin_id, user_id)
);
CREATE TABLE IF NOT EXISTS reports (
  pin_id INTEGER NOT NULL REFERENCES pins(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (pin_id, user_id)
);
-- Presence deliberately stores NO coordinates: only which pin the user is at.
CREATE TABLE IF NOT EXISTS presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  pin_id INTEGER NOT NULL REFERENCES pins(id),
  entered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS squads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS squad_members (
  squad_id INTEGER NOT NULL REFERENCES squads(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (squad_id, user_id)
);
CREATE TABLE IF NOT EXISTS ghost_nodes (
  id INTEGER PRIMARY KEY,
  squad_id INTEGER NOT NULL REFERENCES squads(id),
  creator_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vendor_tokens (
  vendor_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS flash_drops (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES users(id),
  city TEXT NOT NULL,
  night TEXT NOT NULL,
  title TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drops_city ON flash_drops(city, starts_at);
CREATE TABLE IF NOT EXISTS sensitive_zones (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m REAL NOT NULL
);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; roll back if it throws. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
