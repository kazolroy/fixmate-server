import { Router } from 'express';
import Stripe from 'stripe';
import { getDb, toId } from '../db.js';
import { verifyToken, verifyCustomer } from '../middlewares/auth.js';
import { h, str } from '../utils/helpers.js';

const router = Router();

let stripeClient = null;
const getStripe = () => {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
};

const clientUrl = () => (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '');

/**
 * Single place where a paid Checkout Session becomes a payment record.
 * Used by BOTH the success-page verification and the webhook, so the same
 * payment can never be saved twice:
 *   - unique indexes on payments.stripeSessionId and payments.bookingId
 *   - duplicate-key errors (11000) are treated as "already saved"
 *   - the booking update only matches paymentStatus: 'unpaid'
 */
export async function savePayment(session) {
  const db = await getDb();
  const bookings = db.collection('bookings');
  const payments = db.collection('payments');

  const bookingId = toId(session.metadata?.bookingId);
  if (!bookingId) throw Object.assign(new Error('Session has no valid bookingId'), { status: 400 });

  const booking = await bookings.findOne({ _id: bookingId });
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (booking.status !== 'completed')
    throw Object.assign(new Error('Booking is not completed'), { status: 400 });

  const doc = {
    bookingId: String(booking._id),
    serviceTitle: booking.serviceTitle,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    technicianName: booking.technicianName,
    technicianEmail: booking.technicianEmail,
    amount: (session.amount_total ?? Math.round(booking.finalAmount * 100)) / 100,
    currency: 'usd',
    transactionId:
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
    stripeSessionId: session.id,
    paymentStatus: 'paid',
    paidAt: new Date(),
  };

  let payment;
  try {
    const result = await payments.insertOne(doc);
    payment = { ...doc, _id: result.insertedId };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    payment = await payments.findOne({
      $or: [{ stripeSessionId: session.id }, { bookingId: doc.bookingId }],
    });
  }

  // Idempotent: only flips unpaid -> paid once. Also repairs a half-finished earlier attempt.
  await bookings.updateOne(
    { _id: booking._id, paymentStatus: 'unpaid' },
    { $set: { paymentStatus: 'paid' }, $push: { statusHistory: { status: 'paid', changedAt: new Date() } } }
  );
  return payment;
}

/** POST /api/payments/create-checkout-session  (customer) */
router.post(
  '/create-checkout-session',
  verifyToken,
  verifyCustomer,
  h(async (req, res) => {
    const _id = toId(str(req.body.bookingId));
    if (!_id) return res.status(404).json({ message: 'Booking not found' });

    const db = await getDb();
    const booking = await db.collection('bookings').findOne({ _id });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.customerEmail !== req.user.email)
      return res.status(403).json({ message: 'Forbidden: this is not your booking' });
    // Payment gate: only completed + unpaid jobs can be paid.
    if (booking.status !== 'completed')
      return res.status(400).json({ message: 'You can only pay for a completed job' });
    if (booking.paymentStatus !== 'unpaid')
      return res.status(400).json({ message: 'This job is already paid' });

    // The amount ALWAYS comes from the database, never from the client.
    const amount = Number(booking.finalAmount ?? booking.basePrice);
    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      customer_email: booking.customerEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: booking.serviceTitle,
              description: `Repair job by ${booking.technicianName}`,
            },
          },
        },
      ],
      metadata: { bookingId: String(booking._id), customerEmail: booking.customerEmail },
      success_url: `${clientUrl()}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl()}/payment/cancel`,
    });

    res.json({ url: session.url, sessionId: session.id });
  })
);

/** GET /api/payments/verify?session_id=...  (customer) */
router.get(
  '/verify',
  verifyToken,
  verifyCustomer,
  h(async (req, res) => {
    const sessionId = str(req.query.session_id);
    if (!sessionId) return res.status(400).json({ message: 'session_id is required' });

    let session;
    try {
      session = await getStripe().checkout.sessions.retrieve(sessionId);
    } catch {
      return res.status(404).json({ message: 'Checkout session not found' });
    }
    if (session.metadata?.customerEmail !== req.user.email)
      return res.status(403).json({ message: 'Forbidden: this payment is not yours' });
    if (session.payment_status !== 'paid')
      return res.status(400).json({ message: 'Payment has not been completed' });

    const payment = await savePayment(session);
    res.json({ success: true, payment });
  })
);

/** GET /api/payments/my  (customer) - payment history */
router.get(
  '/my',
  verifyToken,
  verifyCustomer,
  h(async (req, res) => {
    const db = await getDb();
    const items = await db
      .collection('payments')
      .find({ customerEmail: req.user.email })
      .sort({ paidAt: -1 })
      .toArray();
    res.json({ items });
  })
);

/**
 * POST /api/payments/webhook  (Stripe -> server)
 * Mounted in index.js with express.raw() BEFORE express.json(), because the
 * signature is computed over the raw request body.
 */
export const webhookHandler = async (req, res) => {
  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid') await savePayment(session);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing failed:', err);
    // 500 makes Stripe retry; retries are safe because savePayment is idempotent.
    res.status(500).json({ message: 'Webhook processing failed' });
  }
};

export default router;
