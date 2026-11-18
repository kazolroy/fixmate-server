import { Router } from 'express';
import { getDb, toId } from '../db.js';
import {
  verifyToken,
  verifyCustomer,
  verifyTechnician,
} from '../middlewares/auth.js';
import { ACTIVE_STATUSES, h, str, startOfToday } from '../utils/helpers.js';

const router = Router();

/**
 * Job status pipeline (Challenge 3).
 * Only these transitions exist - everything else is rejected with 400.
 */
const NEXT = {
  requested: ['accepted', 'rejected'],
  accepted: ['in-progress'],
  'in-progress': ['completed'],
};

/** POST /api/bookings  (customer) - create a repair request */
router.post(
  '/',
  verifyToken,
  verifyCustomer,
  h(async (req, res) => {
    const serviceId = str(req.body.serviceId);
    const customerPhone = str(req.body.customerPhone);
    const address = str(req.body.address);
    const problemDescription = str(req.body.problemDescription);
    const preferredDate = new Date(str(req.body.preferredDate));

    const _id = toId(serviceId);
    if (!_id) return res.status(404).json({ message: 'Service not found' });
    if (customerPhone.length < 6) return res.status(400).json({ message: 'A valid phone number is required' });
    if (address.length < 5) return res.status(400).json({ message: 'Address is required' });
    if (problemDescription.length < 20)
      return res.status(400).json({ message: 'Problem description must be at least 20 characters' });
    if (Number.isNaN(preferredDate.getTime()))
      return res.status(400).json({ message: 'Preferred date must be a valid date' });

    const db = await getDb();
    const service = await db
      .collection('services')
      .findOne({ _id, approvalStatus: 'approved', isAvailable: true });
    if (!service) return res.status(404).json({ message: 'Service not found or unavailable' });

    if (service.technicianEmail === req.user.email)
      return res.status(403).json({ message: 'You cannot request your own service' });

    const bookings = db.collection('bookings');
    const duplicate = await bookings.findOne({
      serviceId,
      customerEmail: req.user.email,
      status: { $in: ACTIVE_STATUSES },
    });
    if (duplicate)
      return res.status(409).json({ message: 'You already have an active request for this service' });

    const now = new Date();
    const doc = {
      serviceId,
      serviceTitle: service.title,
      serviceImage: service.image,
      category: service.category,
      basePrice: service.basePrice,
      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
      customerName: req.user.name,
      customerEmail: req.user.email,
      customerPhone,
      address,
      preferredDate,
      problemDescription,
      status: 'requested',
      finalAmount: service.basePrice,
      paymentStatus: 'unpaid',
      statusHistory: [{ status: 'requested', changedAt: now }],
      createdAt: now,
    };
    const result = await bookings.insertOne(doc);
    res.status(201).json({ ...doc, _id: result.insertedId });
  })
);

/** GET /api/bookings/my  (customer) - ONLY the caller's own bookings */
router.get(
  '/my',
  verifyToken,
  verifyCustomer,
  h(async (req, res) => {
    const db = await getDb();
    const items = await db
      .collection('bookings')
      .find({ customerEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ items });
  })
);

/** GET /api/bookings/technician  (technician) - ONLY jobs assigned to the caller */
router.get(
  '/technician',
  verifyToken,
  verifyTechnician,
  h(async (req, res) => {
    const db = await getDb();
    const filter = { technicianEmail: req.user.email };
    const status = str(req.query.status);
    if (status) filter.status = status;
    const items = await db.collection('bookings').find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ items });
  })
);

/** PATCH /api/bookings/:id/cancel  (customer, owner, only while "requested") */
router.patch(
  '/:id/cancel',
  verifyToken,
  verifyCustomer,
  h(async (req, res) => {
    const _id = toId(req.params.id);
    if (!_id) return res.status(404).json({ message: 'Booking not found' });
    const db = await getDb();
    const bookings = db.collection('bookings');

    const booking = await bookings.findOne({ _id });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.customerEmail !== req.user.email)
      return res.status(403).json({ message: 'Forbidden: this is not your booking' });
    if (booking.status !== 'requested')
      return res.status(400).json({ message: 'Only a requested job can be cancelled' });

    // Atomic: the status filter guards against a technician accepting at the same moment.
    const updated = await bookings.findOneAndUpdate(
      { _id, customerEmail: req.user.email, status: 'requested' },
      {
        $set: { status: 'cancelled' },
        $push: { statusHistory: { status: 'cancelled', changedAt: new Date() } },
      },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'This request was just updated. Please refresh.' });
    res.json({ success: true, booking: updated });
  })
);

/**
 * PATCH /api/bookings/:id/status  (technician, owner)
 * body: { status, finalAmount? }
 */
router.patch(
  '/:id/status',
  verifyToken,
  verifyTechnician,
  h(async (req, res) => {
    const _id = toId(req.params.id);
    if (!_id) return res.status(404).json({ message: 'Booking not found' });
    const status = str(req.body.status);

    const db = await getDb();
    const bookings = db.collection('bookings');
    const booking = await bookings.findOne({ _id });
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.technicianEmail !== req.user.email)
      return res.status(403).json({ message: 'Forbidden: this job belongs to another technician' });

    if (!NEXT[booking.status]?.includes(status))
      return res
        .status(400)
        .json({ message: `Invalid status change: ${booking.status} → ${status || '?'}` });

    const set = { status };
    if (status === 'completed') {
      const amount = Number(req.body.finalAmount);
      if (!Number.isFinite(amount) || amount <= 0)
        return res.status(400).json({ message: 'finalAmount must be a number greater than 0' });
      set.finalAmount = Math.round(amount * 100) / 100;
    }

    // Atomic compare-and-set on the previous status.
    const updated = await bookings.findOneAndUpdate(
      { _id, technicianEmail: req.user.email, status: booking.status },
      { $set: set, $push: { statusHistory: { status, changedAt: new Date() } } },
      { returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'This job was just updated. Please refresh.' });
    res.json({ success: true, booking: updated });
  })
);

export default router;
