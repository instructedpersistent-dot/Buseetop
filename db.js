// db.js — SQLite database setup and schema
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'busee.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('traveler','driver','admin')),
  license_number TEXT,
  driver_verified INTEGER DEFAULT 0,       -- manual/off-app flag, admin flips this directly in DB or via /admin route
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  balance INTEGER DEFAULT 0,        -- kobo/cents, avoid float math
  held_balance INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  driver_id TEXT REFERENCES users(id),
  plate_number TEXT NOT NULL,
  model TEXT NOT NULL,
  seat_capacity INTEGER NOT NULL
);

-- Platform-set price table. Admin manages this manually (off-app for MVP) by
-- inserting rows directly, e.g. via sqlite3 CLI or a future admin tool.
CREATE TABLE IF NOT EXISTS route_prices (
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  price_per_seat INTEGER NOT NULL,   -- in kobo/cents
  PRIMARY KEY (origin, destination)
);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  driver_id TEXT REFERENCES users(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_time TEXT NOT NULL,
  price_per_seat INTEGER NOT NULL,
  seats_total INTEGER NOT NULL,
  seats_available INTEGER NOT NULL,
  status TEXT DEFAULT 'scheduled',  -- scheduled | arrived | departed | cancelled
  arrived_at TEXT,
  checkin_deadline TEXT,
  departed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  trip_id TEXT REFERENCES trips(id),
  traveler_id TEXT REFERENCES users(id),
  seat_count INTEGER NOT NULL,
  amount_held INTEGER NOT NULL,
  status TEXT DEFAULT 'confirmed', -- confirmed | checked_in | released | refunded | no_show | cancelled
  checked_in_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL, -- fund | hold | release | refund | payout
  amount INTEGER NOT NULL,
  related_booking_id TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  lat REAL,
  lng REAL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS location_shares (
  token TEXT PRIMARY KEY,
  traveler_id TEXT REFERENCES users(id),
  trip_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

module.exports = db;
