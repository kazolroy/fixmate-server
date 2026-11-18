# FixMate — Server

REST API for **FixMate**, the smart device & home appliance repair platform (Assignment 9 · Category 006).

- **Live API:** `https://fixmate-server-plum.vercel.app`
- **Client repo:** `https://github.com/kazolroy/fixmate-client`
- **Live site:** `https://fixmate-client-chi.vercel.app`

**Admin login (seeded from the client repo):** `admin@fixmate.test` / `Admin123`

## Key features

- Express + MongoDB native driver, exactly 4 data collections: `user` (BetterAuth users), `services`, `bookings`, `payments`.
- **Custom JWT middlewares:** `verifyToken` (401), `verifyCustomer`, `verifyTechnician`, `verifyAdmin` (403). The role is read from the database on every request. Users can only reach their own data (bookings are always filtered by the caller's email, never by an email in the URL).
- **Server-side search / filter / sort / pagination** on `GET /api/services` (regex on title + category, category and mode filters, `price_asc | price_desc | newest`, `skip/limit`). Input is escaped and type-checked (no regex or NoSQL operator injection).
- **Job status pipeline enforced server-side** with a transition map and an atomic compare-and-set update (`requested → accepted | rejected`, `accepted → in-progress`, `in-progress → completed` with `finalAmount > 0`). Only the owning technician can update; customers can cancel only while `requested`.
- **Business rules:** no second active request for the same service (409), technicians/admins cannot book, services only visible when `approved && isAvailable`.
- **Stripe pay-after-service:** checkout session only for a `completed` + `unpaid` booking owned by the caller; amount always taken from the database (`finalAmount`).
- **Never saves a payment twice:** unique indexes on `stripeSessionId` and `bookingId`, one shared `savePayment()` used by both the verify endpoint and the webhook, duplicate-key errors treated as "already saved".
- Admin API for users, service approval, bookings and payments (admins cannot change their own role). Stats endpoints for the dashboard charts.

## API overview

| Endpoint | Access |
| --- | --- |
| `GET /api/services`, `GET /api/services/:id` | Public |
| `POST /api/services`, `PATCH/DELETE /api/services/:id`, `GET /api/services/mine`, `GET /api/bookings/technician`, `PATCH /api/bookings/:id/status` | Technician |
| `POST /api/bookings`, `GET /api/bookings/my`, `PATCH /api/bookings/:id/cancel`, `POST /api/payments/create-checkout-session`, `GET /api/payments/verify`, `GET /api/payments/my` | Customer |
| `GET /api/admin/users`, `PATCH /api/admin/users/:id/role`, `GET /api/admin/services`, `PATCH /api/admin/services/:id/approval`, `GET /api/admin/bookings`, `GET /api/admin/payments` | Admin |
| `PATCH /api/users/profile` | Any logged-in user |
| `GET /api/stats/customer \| technician \| admin` | Matching role |
| `POST /api/payments/webhook` | Stripe (signature verified) |

## npm packages

`express` · `cors` · `mongodb` · `jsonwebtoken` · `stripe` · `dotenv`

## Run locally

```bash
npm install
cp .env.example .env     # fill in the values
npm run dev              # http://localhost:5000
```

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI`, `DB_NAME` | MongoDB connection (same DB as the client) |
| `JWT_SECRET` | **Must equal** the client's `JWT_SECRET` |
| `STRIPE_SECRET_KEY` | Stripe secret key (test mode) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint |
| `CLIENT_URL` | Production client URL (CORS + Stripe redirect URLs) |
| `EXTRA_ORIGINS` | Extra allowed origins, comma separated |

## Stripe webhook

- Local: `stripe listen --forward-to localhost:5000/api/payments/webhook` and copy the printed `whsec_…` into `.env`.
- Production: in the Stripe Dashboard (test mode) add endpoint `https://YOUR-SERVER.vercel.app/api/payments/webhook`, event `checkout.session.completed`, then put its signing secret in the server env and redeploy.

## Deploy (Vercel)

`vercel.json` + `api/index.js` run the Express app as a serverless function. Add all env variables, set `CLIENT_URL` to the production client domain, and open `/` to confirm `{"status":"ok"}`.
