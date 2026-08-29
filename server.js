// server.js — Busee API
// Core loop: post trip -> book seat (funds held) -> check in -> driver departs -> funds released.
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('./db');
const { signToken, requireAuth, requireRole } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());

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
app.post('/auth/signup', (req, res) => {
  const { name, phone, password, role, license_number } = req.body;
  if (!name || !phone || !password || !role) {
    return res.status(400).json({ error: 'name, phone, password, role are required' });
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

app.post('/auth/login', (req, res) => {
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
// Mock funding — in production, swap this for a real Paystack/Flutterwave webhook.
app.post('/wallet/fund', requireAuth, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });
  db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(amount, req.user.id);
  recordTxn(req.user.id, 'fund', amount, null, 'Wallet top-up');
  res.json(getWallet(req.user.id));
});

// ---------- vehicles (driver) ----------
app.post('/vehicles', requireAuth, requireRole('driver'), (req, res) => {
  const { plate_number, model, seat_capacity } = req.body;
  if (!plate_number || !model || !seat_capacity) {
    return res.status(400).json({ error: 'plate_number, model, seat_capacity required' });
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

// List / search trips — homepage + "going to" search
app.get('/trips', (req, res) => {
  const { destination } = req.query;
  let trips;
  if (destination) {
    trips = db
      .prepare(`SELECT * FROM trips WHERE status = 'scheduled' AND destination LIKE ? ORDER BY departure_time ASC`)
      .all(`%${destination}%`);
  } else {
    trips = db.prepare(`SELECT * FROM trips WHERE status = 'scheduled' ORDER BY departure_time ASC`).all();
  }
  trips.forEach(expireStaleBookings);
  // attach driver + vehicle summary
  const withDetails = trips.map((t) => {
    const driver = db.prepare('SELECT id,name FROM users WHERE id = ?').get(t.driver_id);
    const vehicle = db.prepare('SELECT model,plate_number FROM vehicles WHERE id = ?').get(t.vehicle_id);
    return { ...t, driver, vehicle };
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
// NOTE: MVP does self-report only. To add the GPS-geofence backup, have the driver app
// send periodic /trips/:id/location pings and auto-fire this once the vehicle exits
// a radius around the pickup point — the release logic below stays the same either way.
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
        // Never checked in, but window hasn't been lazily expired yet -> refund now.
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

// Traveler checks in within the 2-hour window
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
