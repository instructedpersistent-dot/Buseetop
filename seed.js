// seed.js — run once after first deploy: `npm run seed`
// Creates an admin account and a few starter route prices.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('./db');

const ADMIN_PHONE = process.env.ADMIN_PHONE || '+2340000000000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';

const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(ADMIN_PHONE);
if (!existing) {
  const id = nanoid();
  db.prepare(
    `INSERT INTO users (id,name,phone,password_hash,role,driver_verified) VALUES (?,?,?,?,?,1)`
  ).run(id, 'Admin', ADMIN_PHONE, bcrypt.hashSync(ADMIN_PASSWORD, 10), 'admin');
  db.prepare('INSERT INTO wallets (user_id,balance,held_balance) VALUES (?,0,0)').run(id);
  console.log(`Admin created — phone: ${ADMIN_PHONE}, password: ${ADMIN_PASSWORD} (change this!)`);
} else {
  console.log('Admin already exists, skipping.');
}

const routes = [
  ['Lagos', 'Abuja', 850000],   // ₦8,500.00 in kobo
  ['Lagos', 'Enugu', 700000],
  ['Lagos', 'Ibadan', 300000],
  ['Abuja', 'Kano', 600000],
];
const insertRoute = db.prepare(
  `INSERT INTO route_prices (origin,destination,price_per_seat) VALUES (?,?,?)
   ON CONFLICT(origin,destination) DO UPDATE SET price_per_seat=excluded.price_per_seat`
);
for (const [o, d, p] of routes) insertRoute.run(o, d, p);
console.log(`Seeded ${routes.length} route prices.`);
