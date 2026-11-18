import { Router } from 'express';
import { getDb, toId, USERS } from '../db.js';
import { verifyToken, verifyAdmin } from '../middlewares/auth.js';
import { h, str, publicUser } from '../utils/helpers.js';

const router = Router();
router.use(verifyToken, verifyAdmin);

/** GET /api/admin/users */
router.get(
  '/users',
  h(async (_req, res) => {
    const db = await getDb();
    const users = await db.collection(USERS).find({}).sort({ createdAt: -1 }).toArray();
    res.json({ items: users.map(publicUser) });
  })
);

/** PATCH /api/admin/users/:id/role  - an admin cannot change their own role */
router.patch(
  '/users/:id/role',
  h(async (req, res) => {
    const role = str(req.body.role);
    if (!['customer', 'technician', 'admin'].includes(role))
      return res.status(400).json({ message: 'Invalid role' });

    const id = req.params.id;
    const oid = toId(id);
    const db = await getDb();
    const users = db.collection(USERS);
    const filter = { $or: [...(oid ? [{ _id: oid }] : []), { _id: id }, { id }] };

    const target = await users.findOne(filter);
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target.email === req.user.email)
      return res.status(403).json({ message: 'You cannot change your own role' });

    await users.updateOne({ _id: target._id }, { $set: { role } });
    res.json({ success: true, role });
  })
);

/** GET /api/admin/services?status=pending|approved|rejected */
router.get(
  '/services',
  h(async (req, res) => {
    const db = await getDb();
    const status = str(req.query.status);
    const filter = ['pending', 'approved', 'rejected'].includes(status) ? { approvalStatus: status } : {};
    const items = await db.collection('services').find(filter).sort({ createdAt: -1 }).toArray();
    // pending first so moderators see them immediately
    const rank = { pending: 0, approved: 1, rejected: 2 };
    items.sort((a, b) => rank[a.approvalStatus] - rank[b.approvalStatus]);
    res.json({ items });
  })
);

/** PATCH /api/admin/services/:id/approval */
router.patch(
  '/services/:id/approval',
  h(async (req, res) => {
    const _id = toId(req.params.id);
    const approvalStatus = str(req.body.approvalStatus);
    if (!_id) return res.status(404).json({ message: 'Service not found' });
    if (!['approved', 'rejected'].includes(approvalStatus))
      return res.status(400).json({ message: 'approvalStatus must be approved or rejected' });

    const db = await getDb();
    const result = await db.collection('services').updateOne({ _id }, { $set: { approvalStatus } });
    if (!result.matchedCount) return res.status(404).json({ message: 'Service not found' });
    res.json({ success: true, approvalStatus });
  })
);

/** GET /api/admin/bookings?status= */
router.get(
  '/bookings',
  h(async (req, res) => {
    const db = await getDb();
    const status = str(req.query.status);
    const filter = status ? { status } : {};
    const items = await db.collection('bookings').find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ items });
  })
);

/** GET /api/admin/payments  (+ total revenue) */
router.get(
  '/payments',
  h(async (_req, res) => {
    const db = await getDb();
    const payments = db.collection('payments');
    const [items, agg] = await Promise.all([
      payments.find({}).sort({ paidAt: -1 }).toArray(),
      payments.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]).toArray(),
    ]);
    res.json({ items, totalRevenue: agg[0]?.total || 0 });
  })
);

export default router;
