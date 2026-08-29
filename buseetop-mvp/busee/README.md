# Busee — MVP

Inter-state ride booking with an escrow wallet, driver check-in window, and live location sharing.

This package contains:
- `backend/` — Node.js + Express + SQLite API (escrow ledger, trips, bookings, check-in logic)
- `frontend/` — a single static HTML/JS page that talks to the API (works on desktop and mobile browsers)

The core loop is fully implemented and tested end-to-end: **post a trip → book a seat (funds held) → driver arrives → traveler checks in within 2 hours → driver confirms departure → held funds release to the driver, no-shows get refunded.**

---

## 1. Run it locally first

```bash
cd backend
npm install
cp .env.example .env      # then edit .env — set a real JWT_SECRET and admin password
npm run seed               # creates an admin account + starter route prices
npm start                  # starts the API on http://localhost:4000
```

Open `frontend/index.html` directly in a browser (or serve it with any static file server). It talks to `http://localhost:4000` by default.

To point the frontend at a different backend URL (e.g. after deploying), open the browser console on the page once and run:
```js
localStorage.setItem('busee_api', 'https://your-backend-url.com')
```
then reload. (Or edit the `API` constant at the top of `frontend/index.html` before deploying it.)

---

## 2. Deploying the backend

The backend is a plain Node/Express app with a file-based SQLite database — it needs **persistent disk**, so pick a host that gives you that (not a purely serverless/stateless platform, since the DB file would get wiped on redeploy).

**Recommended: Render.com (free tier available)**
1. Push this `backend/` folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo, root directory `backend`.
3. Build command: `npm install`. Start command: `npm start`.
4. Add a **persistent disk** (Render calls this "Disks") mounted at `/opt/render/project/src` (or wherever your repo lives) so `busee.db` survives restarts.
5. Add environment variables: `JWT_SECRET`, `ADMIN_PHONE`, `ADMIN_PASSWORD`.
6. After first deploy, open the Render shell and run `npm run seed` once.

**Alternative: Railway.app** — similar flow, Railway volumes give you persistent storage for the SQLite file.

**If you outgrow SQLite** (more concurrent writers, multiple server instances): swap `better-sqlite3` for `pg` and point it at a managed Postgres instance (Render, Railway, and Supabase all offer one). The schema in `db.js` translates almost directly — this is a later step, not needed for MVP launch.

---

## 3. Deploying the frontend

It's a single static HTML file — the easiest options:
- **Netlify / Vercel**: drag-and-drop the `frontend/` folder, or connect the repo.
- **GitHub Pages**: push `frontend/index.html` to a repo and enable Pages.

Before deploying, set the `API` constant near the top of the `<script>` in `index.html` to your deployed backend URL.

---

## 4. Running your business (manual/off-app parts, per MVP scope)

- **Driver verification**: a driver cannot post trips until `driver_verified = 1` on their user row. Do this by logging in as the seeded admin account and calling:
  ```
  POST /admin/verify-driver/:userId
  Authorization: Bearer <admin token>
  ```
  Get the driver's `userId` from your database (`busee.db`) directly, e.g. `sqlite3 busee.db "select id,name,phone from users where role='driver';"`.

- **Setting route prices**: trips can only be posted for routes that have a platform price set. Add one:
  ```
  POST /admin/route-price
  Authorization: Bearer <admin token>
  Body: { "origin": "Lagos", "destination": "Kano", "price_per_seat": 900000 }
  ```
  (`price_per_seat` is in kobo — ₦9,000.00 → `900000`.) A few starter routes are already seeded — see `backend/seed.js`.

---

## 5. What's deliberately NOT in this MVP

Per the agreed scope: ratings/reviews, an admin dashboard UI (use the API/DB directly for now), automated re-marketing of under-filled trips, SMS/push notifications, in-app chat, and multiple payment processors. The wallet-funding endpoint (`POST /wallet/fund`) is a mock — swap it for a real Paystack/Flutterwave integration (webhook confirms payment → credits `wallets.balance`) when you're ready to take real money in.

## 6. Next after this deploys

- Real payment gateway integration (replace mock `/wallet/fund`)
- GPS geofence auto-detection for departure (currently self-report only — the release logic already supports either trigger, see the note in `server.js` above `/trips/:id/depart`)
- Driver payout flow (withdraw `wallets.balance` to a bank account)
