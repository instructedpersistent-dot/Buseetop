// server.js — Busee API
// Core loop: post trip -> book seat (funds held) -> check in -> driver departs -> funds released.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('./db');
const { signToken, requireAuth, requireRole } = require('./auth');

const app = express();

// Render (and most hosts) sit behind a reverse proxy — this makes req.protocol,
// req.ip, and the rate limiter reflect the real client instead of the proxy hop.
app.set('trust proxy', 1);

app.use(helmet());

// Restrict CORS to your actual frontend domain(s) instead of allowing any website
// to call this API. Set FRONTEND_ORIGIN in Render's environment variables to your
// Netlify URL (e.g. https://your-app.netlify.app). Comma-separate multiple origins.
// If FRONTEND_ORIGIN isn't set, falls back to allowing all origins (fine for early
// testing, but set this before real users arrive).
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));

app.use(express.json({ limit: '100kb' })); // caps request body size against abuse

// General rate limit across the whole API — generous, just a backstop against abuse.
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Tighter limit specifically on auth endpoints — the classic brute-force target.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const CHECKIN_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours, per spec

// ---------- helpers ----------
function getWallet(userId) {
  return db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
}
function recordTxn(userId, type, amount, bookingId, note) {
  db.prepare(
    `INSERT INTO transactions (id,user_id,type,amount,related_booking_id,note) VALUES (?,?,?,?,?,?)`
  ).run(nanoid(), userId, type, amount, bookingId || null, note || null);
}
function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

// Auto-expire bookings that missed the check-in window on a trip that hasn't departed yet.
// Called lazily whenever a trip is read, since there's no cron in this MVP.
function expireStaleBookings(trip) {
  if (!trip.checkin_deadline || trip.status === 'departed' || trip.status === 'cancelled') return;
  if (new Date() < new Date(trip.checkin_deadline)) return;

  const stale = db
    .prepare(`SELECT * FROM bookings WHERE trip_id = ? AND status = 'confirmed'`)
    .all(trip.id);

  const refund = db.transaction(() => {
    for (const b of stale) {
      db.prepare(`UPDATE bookings SET status = 'refunded' WHERE id = ?`).run(b.id);
      db.prepare(
        `UPDATE wallets SET held_balance = held_balance - ?, balance = balance + ? WHERE user_id = ?`
      ).run(b.amount_held, b.amount_held, b.traveler_id);
      recordTxn(b.traveler_id, 'refund', b.amount_held, b.id, 'Missed 2-hour check-in window');
      db.prepare(`UPDATE trips SET seats_available = seats_available + ? WHERE id = ?`).run(
        b.seat_count,
        trip.id
      );
    }
  });
  if (stale.length) refund();
}

// ---------- auth ----------
app.post('/auth/signup', authLimiter, (req, res) => {
  const { name, phone, password, role, license_number } = req.body;
  if (!name || !phone || !password || !role) {
    return res.status(400).json({ error: 'name, phone, password, role are required' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (!/^\+?[0-9]{7,15}$/.test(phone)) {
    return res.status(400).json({ error: 'phone must be a valid number (digits only, optional leading +)' });
  }
  if (!['traveler', 'driver'].includes(role)) {
    return res.status(400).json({ error: "role must be 'traveler' or 'driver'" });
  }
  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) return res.status(409).json({ error: 'Phone already registered' });

  const id = nanoid();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare(
    `INSERT INTO users (id,name,phone,password_hash,role,license_number,driver_verified)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, name, phone, password_hash, role, license_number || null, 0);
  db.prepare('INSERT INTO wallets (user_id, balance, held_balance) VALUES (?,0,0)').run(id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/auth/login', authLimiter, (req, res) => {
  const { phone, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid phone or password' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const wallet = getWallet(user.id);
  res.json({ user: publicUser(user), wallet });
});

// ---------- wallet ----------
// Mock instant funding — used for the demo card flow. In production, swap this
// for a real Paystack/Flutterwave webhook rather than crediting on request.
app.post('/wallet/fund', requireAuth, (req, res) => {
  const { amount } = req.body;
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive whole number (in kobo)' });
  if (amount > 500000000) return res.status(400).json({ error: 'amount exceeds the maximum allowed per top-up' }); // ₦5,000,000 cap
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amount, req.user.id);
  recordTxn(req.user.id, 'fund', amount, null, 'Wallet top-up');
  res.json(getWallet(req.user.id));
});

// Bank transfer: doesn't credit instantly. Creates a pending request that sits until
// an admin manually confirms the money actually landed (see /admin/pending-deposits below).
app.post('/wallet/fund/request', requireAuth, (req, res) => {
  const { amount, reference } = req.body;
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive whole number (in kobo)' });
  if (amount > 500000000) return res.status(400).json({ error: 'amount exceeds the maximum allowed per top-up' });
  const id = nanoid();
  db.prepare(
    `INSERT INTO deposit_requests (id,user_id,amount,method,reference,status) VALUES (?,?,?,?,?,'pending')`
  ).run(id, req.user.id, amount, 'bank_transfer', reference || null);
  res.json(db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(id));
});

app.get('/wallet/fund/requests/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM deposit_requests WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows);
});

// Admin-only — manual verification, per the MVP decision to keep admin tooling off-app for now.
app.get('/admin/pending-deposits', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT * FROM deposit_requests WHERE status = 'pending' ORDER BY created_at ASC`).all();
  const withUser = rows.map(r => ({ ...r, user: db.prepare('SELECT name,phone FROM users WHERE id = ?').get(r.user_id) }));
  res.json(withUser);
});

app.post('/admin/pending-deposits/:id/approve', requireAuth, requireRole('admin'), (req, res) => {
  const dep = db.prepare(`SELECT * FROM deposit_requests WHERE id = ? AND status = 'pending'`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Pending deposit not found' });
  const approve = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(dep.amount, dep.user_id);
    db.prepare(`UPDATE deposit_requests SET status='approved', resolved_at=? WHERE id = ?`).run(new Date().toISOString(), dep.id);
    recordTxn(dep.user_id, 'fund', dep.amount, null, 'Bank transfer verified by admin');
  });
  approve();
  res.json({ ok: true });
});

app.post('/admin/pending-deposits/:id/reject', requireAuth, requireRole('admin'), (req, res) => {
  const dep = db.prepare(`SELECT * FROM deposit_requests WHERE id = ? AND status = 'pending'`).get(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Pending deposit not found' });
  db.prepare(`UPDATE deposit_requests SET status='rejected', resolved_at=? WHERE id = ?`).run(new Date().toISOString(), dep.id);
  res.json({ ok: true });
});

// ---------- vehicles (driver) ----------
app.post('/vehicles', requireAuth, requireRole('driver'), (req, res) => {
  const { plate_number, model, seat_capacity } = req.body;
  if (!plate_number || !model || !seat_capacity) {
    return res.status(400).json({ error: 'plate_number, model, seat_capacity required' });
  }
  if (!Number.isInteger(seat_capacity) || seat_capacity < 1 || seat_capacity > 60) {
    return res.status(400).json({ error: 'seat_capacity must be a whole number between 1 and 60' });
  }
  const id = nanoid();
  db.prepare(
    `INSERT INTO vehicles (id,driver_id,plate_number,model,seat_capacity) VALUES (?,?,?,?,?)`
  ).run(id, req.user.id, plate_number, model, seat_capacity);
  res.json(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id));
});

app.get('/vehicles/mine', requireAuth, requireRole('driver'), (req, res) => {
  res.json(db.prepare('SELECT * FROM vehicles WHERE driver_id = ?').all(req.user.id));
});

// ---------- route prices (platform-set; read-only via API, managed off-app) ----------
app.get('/route-prices', (req, res) => {
  res.json(db.prepare('SELECT * FROM route_prices').all());
});

// ---------- trips ----------
app.post('/trips', requireAuth, requireRole('driver'), (req, res) => {
  const driver = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!driver.driver_verified) {
    return res.status(403).json({ error: 'Driver not yet verified. Verification is handled manually for now — contact the platform admin.' });
  }
  const { vehicle_id, origin, destination, departure_time, seats_total } = req.body;
  if (!vehicle_id || !origin || !destination || !departure_time || !seats_total) {
    return res.status(400).json({ error: 'vehicle_id, origin, destination, departure_time, seats_total required' });
  }
  if (!Number.isInteger(seats_total) || seats_total < 1) {
    return res.status(400).json({ error: 'seats_total must be a positive whole number' });
  }
  if (isNaN(Date.parse(departure_time)) || new Date(departure_time) < new Date()) {
    return res.status(400).json({ error: 'departure_time must be a valid date in the future' });
  }
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND driver_id = ?').get(vehicle_id, req.user.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found for this driver' });
  if (seats_total > vehicle.seat_capacity) {
    return res.status(400).json({ error: 'seats_total exceeds vehicle capacity' });
  }

  // Price is platform-set, not driver-set — look it up from route_prices.
  const rate = db.prepare('SELECT * FROM route_prices WHERE origin = ? AND destination = ?').get(origin, destination);
  if (!rate) {
    return res.status(400).json({ error: `No platform rate set for ${origin} -> ${destination}. Ask admin to add one to route_prices.` });
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO trips (id,driver_id,vehicle_id,origin,destination,departure_time,price_per_seat,seats_total,seats_available,status)
     VALUES (?,?,?,?,?,?,?,?,?,'scheduled')`
  ).run(id, req.user.id, vehicle_id, origin, destination, departure_time, rate.price_per_seat, seats_total, seats_total);

  res.json(db.prepare('SELECT * FROM trips WHERE id = ?').get(id));
});

// Driver's own trips, ALL statuses (scheduled/arrived/departed) — unlike the public
// /trips search which only shows 'scheduled' trips still open for booking.
app.get('/trips/mine', requireAuth, requireRole('driver'), (req, res) => {
  const trips = db.prepare(`SELECT * FROM trips WHERE driver_id = ? ORDER BY departure_time DESC`).all(req.user.id);
  trips.forEach(expireStaleBookings);
  const fresh = db.prepare(`SELECT * FROM trips WHERE driver_id = ? ORDER BY departure_time DESC`).all(req.user.id);
  res.json(fresh);
});

// List / search trips — homepage + "going to" search + Book a Trip flow filters
app.get('/trips', (req, res) => {
  const { destination, origin, date, min_seats } = req.query;
  const clauses = [`status = 'scheduled'`];
  const params = [];
  if (destination) { clauses.push('destination LIKE ?'); params.push(`%${destination}%`); }
  if (origin) { clauses.push('origin LIKE ?'); params.push(`%${origin}%`); }
  if (date) { clauses.push(`substr(departure_time,1,10) = ?`); params.push(date); } // date as YYYY-MM-DD
  if (min_seats) { clauses.push('seats_available >= ?'); params.push(Number(min_seats)); }
  const trips = db
    .prepare(`SELECT * FROM trips WHERE ${clauses.join(' AND ')} ORDER BY departure_time ASC`)
    .all(...params);
  trips.forEach(expireStaleBookings);
  // attach driver + vehicle summary, plus occupied seat count for display
  const withDetails = trips.map((t) => {
    const driver = db.prepare('SELECT id,name FROM users WHERE id = ?').get(t.driver_id);
    const vehicle = db.prepare('SELECT model,plate_number,seat_capacity FROM vehicles WHERE id = ?').get(t.vehicle_id);
    return { ...t, driver, vehicle, seats_occupied: t.seats_total - t.seats_available };
  });
  res.json(withDetails);
});

app.get('/trips/:id', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  expireStaleBookings(trip);
  const fresh = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  const driver = db.prepare('SELECT id,name FROM users WHERE id = ?').get(fresh.driver_id);
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(fresh.vehicle_id);
  res.json({ ...fresh, driver, vehicle });
});

// Driver marks arrival at pickup point -> opens 2-hour check-in window
app.post('/trips/:id/arrive', requireAuth, requireRole('driver'), (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ? AND driver_id = ?').get(req.params.id, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (trip.status !== 'scheduled') return res.status(400).json({ error: `Trip is already ${trip.status}` });

  const now = new Date();
  const deadline = new Date(now.getTime() + CHECKIN_WINDOW_MS);
  db.prepare(`UPDATE trips SET status='arrived', arrived_at=?, checkin_deadline=? WHERE id = ?`)
    .run(now.toISOString(), deadline.toISOString(), trip.id);
  res.json(db.prepare('SELECT * FROM trips WHERE id = ?').get(trip.id));
});

// Driver confirms departure -> releases funds for checked-in bookings, refunds no-shows
app.post('/trips/:id/depart', requireAuth, requireRole('driver'), (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ? AND driver_id = ?').get(req.params.id, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (trip.status !== 'arrived') return res.status(400).json({ error: 'Driver must mark arrival before departure' });

  const bookings = db.prepare(`SELECT * FROM bookings WHERE trip_id = ?`).all(trip.id);

  const settle = db.transaction(() => {
    for (const b of bookings) {
      if (b.status === 'checked_in') {
        db.prepare(`UPDATE bookings SET status='released' WHERE id = ?`).run(b.id);
        db.prepare(`UPDATE wallets SET held_balance = held_balance - ? WHERE user_id = ?`).run(b.amount_held, b.traveler_id);
        db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(b.amount_held, trip.driver_id);
        recordTxn(b.traveler_id, 'release', b.amount_held, b.id, 'Funds released to driver on departure');
        recordTxn(trip.driver_id, 'payout', b.amount_held, b.id, 'Trip payout');
      } else if (b.status === 'confirmed') {
        db.prepare(`UPDATE bookings SET status='refunded' WHERE id = ?`).run(b.id);
        db.prepare(`UPDATE wallets SET held_balance = held_balance - ?, balance = balance + ? WHERE user_id = ?`)
          .run(b.amount_held, b.amount_held, b.traveler_id);
        recordTxn(b.traveler_id, 'refund', b.amount_held, b.id, 'Not checked in before departure');
      }
    }
    db.prepare(`UPDATE trips SET status='departed', departed_at=? WHERE id = ?`).run(new Date().toISOString(), trip.id);
  });
  settle();

  res.json(db.prepare('SELECT * FROM trips WHERE id = ?').get(trip.id));
});

// ---------- bookings ----------
app.post('/bookings', requireAuth, requireRole('traveler'), (req, res) => {
  const { trip_id, seat_count } = req.body;
  const seats = seat_count || 1;
  if (!Number.isInteger(seats) || seats < 1 || seats > 10) {
    return res.status(400).json({ error: 'seat_count must be a whole number between 1 and 10' });
  }
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(trip_id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  expireStaleBookings(trip);
  const fresh = db.prepare('SELECT * FROM trips WHERE id = ?').get(trip_id);
  if (fresh.status !== 'scheduled') return res.status(400).json({ error: 'Trip is no longer open for booking' });
  if (fresh.seats_available < seats) return res.status(400).json({ error: 'Not enough seats available' });

  const wallet = getWallet(req.user.id);
  const cost = fresh.price_per_seat * seats;
  if (wallet.balance < cost) return res.status(402).json({ error: 'Insufficient wallet balance. Fund your wallet first.' });

  const id = nanoid();
  const book = db.transaction(() => {
    db.prepare(`UPDATE wallets SET balance = balance - ?, held_balance = held_balance + ? WHERE user_id = ?`)
      .run(cost, cost, req.user.id);
    db.prepare(
      `INSERT INTO bookings (id,trip_id,traveler_id,seat_count,amount_held,status) VALUES (?,?,?,?,?,'confirmed')`
    ).run(id, trip_id, req.user.id, seats, cost);
    db.prepare(`UPDATE trips SET seats_available = seats_available - ? WHERE id = ?`).run(seats, trip_id);
    recordTxn(req.user.id, 'hold', cost, id, 'Seat booking — funds held in escrow');
  });
  book();

  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(id));
});

// Traveler cancels before departure day -> full refund (per policy)
app.post('/bookings/:id/cancel', requireAuth, requireRole('traveler'), (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND traveler_id = ?').get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!['confirmed', 'checked_in'].includes(booking.status)) {
    return res.status(400).json({ error: `Cannot cancel a booking with status ${booking.status}` });
  }
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(booking.trip_id);
  if (trip.status !== 'scheduled' && trip.status !== 'arrived') {
    return res.status(400).json({ error: 'Cannot cancel once the trip has departed' });
  }

  const doCancel = db.transaction(() => {
    db.prepare(`UPDATE bookings SET status='cancelled' WHERE id = ?`).run(booking.id);
    db.prepare(`UPDATE wallets SET held_balance = held_balance - ?, balance = balance + ? WHERE user_id = ?`)
      .run(booking.amount_held, booking.amount_held, req.user.id);
    db.prepare(`UPDATE trips SET seats_available = seats_available + ? WHERE id = ?`).run(booking.seat_count, trip.id);
    recordTxn(req.user.id, 'refund', booking.amount_held, booking.id, 'Traveler-initiated cancellation — full refund');
  });
  doCancel();

  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id));
});

// Traveler checks in within the 2-hour window (self-service fallback)
app.post('/bookings/:id/checkin', requireAuth, requireRole('traveler'), (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND traveler_id = ?').get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: `Booking is ${booking.status}, cannot check in` });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(booking.trip_id);
  if (trip.status !== 'arrived') return res.status(400).json({ error: 'Driver has not marked arrival yet' });
  if (new Date() > new Date(trip.checkin_deadline)) {
    return res.status(400).json({ error: 'Check-in window has expired' });
  }

  db.prepare(`UPDATE bookings SET status='checked_in', checked_in_at=? WHERE id = ?`).run(new Date().toISOString(), booking.id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id));
});

// Driver-side check-in: the driver enters/scans the passenger's booking ID (their "boarding
// pass" code) instead of relying on the passenger to self-check-in. Same underlying rules
// as the traveler endpoint above, just triggered from the driver's side with an ownership check.
app.post('/trips/:tripId/scan', requireAuth, requireRole('driver'), (req, res) => {
  const { booking_id } = req.body;
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ? AND driver_id = ?').get(req.params.tripId, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found for this driver' });
  if (trip.status !== 'arrived') return res.status(400).json({ error: 'Mark arrival before scanning passengers' });
  if (new Date() > new Date(trip.checkin_deadline)) return res.status(400).json({ error: 'Check-in window has expired' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND trip_id = ?').get(booking_id, trip.id);
  if (!booking) return res.status(404).json({ error: 'No matching booking for this trip. Check the code and try again.' });
  if (booking.status !== 'confirmed') return res.status(400).json({ error: `This booking is already ${booking.status}` });

  db.prepare(`UPDATE bookings SET status='checked_in', checked_in_at=? WHERE id = ?`).run(new Date().toISOString(), booking.id);
  const traveler = db.prepare('SELECT name FROM users WHERE id = ?').get(booking.traveler_id);
  res.json({ ok: true, traveler_name: traveler?.name, seat_count: booking.seat_count });
});

app.get('/bookings/mine', requireAuth, requireRole('traveler'), (req, res) => {
  const bookings = db.prepare('SELECT * FROM bookings WHERE traveler_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(bookings);
});

app.get('/trips/:id/bookings', requireAuth, requireRole('driver'), (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ? AND driver_id = ?').get(req.params.id, req.user.id);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const bookings = db.prepare('SELECT * FROM bookings WHERE trip_id = ?').all(trip.id);
  res.json(bookings);
});

// ---------- location + sharing ----------
app.post('/location', requireAuth, (req, res) => {
  const { lat, lng } = req.body;
  db.prepare(
    `INSERT INTO locations (user_id,lat,lng,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at`
  ).run(req.user.id, lat, lng, new Date().toISOString());
  res.json({ ok: true });
});

app.post('/location/share', requireAuth, requireRole('traveler'), (req, res) => {
  const { trip_id } = req.body;
  const token = nanoid(10);
  db.prepare(`INSERT INTO location_shares (token,traveler_id,trip_id) VALUES (?,?,?)`).run(token, req.user.id, trip_id || null);
  res.json({ token, share_url: `${req.protocol}://${req.get('host')}/share/${token}` });
});

// Public — no auth — for the person the traveler shared their trip with
app.get('/share/:token', (req, res) => {
  const share = db.prepare('SELECT * FROM location_shares WHERE token = ?').get(req.params.token);
  if (!share) return res.status(404).json({ error: 'Invalid or expired share link' });
  const loc = db.prepare('SELECT lat,lng,updated_at FROM locations WHERE user_id = ?').get(share.traveler_id);
  const traveler = db.prepare('SELECT name FROM users WHERE id = ?').get(share.traveler_id);
  res.json({ traveler: traveler?.name, location: loc || null });
});

// ---------- admin (manual, off-app for MVP — call directly with an admin-role account) ----------
app.get('/admin/drivers/pending', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT id, name, phone, license_number, created_at FROM users WHERE role='driver' AND driver_verified = 0 ORDER BY created_at ASC`).all();
  res.json(rows);
});

app.post('/admin/verify-driver/:userId', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('UPDATE users SET driver_verified = 1 WHERE id = ?').run(req.params.userId);
  res.json({ ok: true });
});
app.post('/admin/route-price', requireAuth, requireRole('admin'), (req, res) => {
  const { origin, destination, price_per_seat } = req.body;
  db.prepare(
    `INSERT INTO route_prices (origin,destination,price_per_seat) VALUES (?,?,?)
     ON CONFLICT(origin,destination) DO UPDATE SET price_per_seat=excluded.price_per_seat`
  ).run(origin, destination, price_per_seat);
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'busee-backend' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Busee backend running on port ${PORT}`));
