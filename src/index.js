import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import servicesRouter from './routes/services.js';
import bookingsRouter from './routes/bookings.js';
import paymentsRouter, { webhookHandler } from './routes/payments.js';
import adminRouter from './routes/admin.js';
import usersRouter from './routes/users.js';
import statsRouter from './routes/stats.js';

const app = express();

const allowedOrigins = [
  process.env.CLIENT_URL,
  ...(process.env.EXTRA_ORIGINS || '').split(','),
  'http://localhost:3000',
]
  .map((o) => (o || '').trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // allow server-to-server calls (no Origin header) and whitelisted browsers
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Stripe needs the RAW body to verify the signature, so this goes BEFORE express.json()
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => res.json({ name: 'FixMate API', status: 'ok' }));

app.use('/api/services', servicesRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/users', usersRouter);
app.use('/api/stats', statsRouter);

app.use((_req, res) => res.status(404).json({ message: 'Route not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status && err.status < 600 ? err.status : 500;
  res.status(status).json({ message: status === 500 ? 'Internal server error' : err.message });
});

const port = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`FixMate API running on http://localhost:${port}`));
}

export default app;
