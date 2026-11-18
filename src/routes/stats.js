import { Router } from 'express';
import { getDb, USERS } from '../db.js';
import {
  verifyToken,
  verifyCustomer,
  verifyTechnician,
  verifyAdmin,
} from '../middlewares/auth.js';
import { h } from '../utils/helpers.js';

const router = Router();

const toPairs = (arr) => arr.map((r) => ({ name: r._id || 'unknown', value: r.count }));

/** GET /api/stats/customer */
router.get(
  '/customer',
  verifyToken,
  verifyCustomer,
  h(async (req, res) => {
    const db = await getDb();
    const byStatus = await db
      .collection('bookings')
      .aggregate([
        { $match: { customerEmail: req.user.email } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();
    const get = (s) => byStatus.find((r) => r._id === s)?.count || 0;
    const spent = await db
      .collection('payments')
      .aggregate([
        { $match: { customerEmail: req.user.email } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .toArray();
    res.json({
      total: byStatus.reduce((n, r) => n + r.count, 0),
      active: get('requested') + get('accepted') + get('in-progress'),
      completed: get('completed'),
      spent: spent[0]?.total || 0,
      byStatus: toPairs(byStatus),
    });
  })
);

/** GET /api/stats/technician */
router.get(
  '/technician',
  verifyToken,
  verifyTechnician,
  h(async (req, res) => {
    const db = await getDb();
    const email = req.user.email;
    const [totalServices, approvedServices, pendingRequests, byStatus, byCategory, earnings] =
      await Promise.all([
        db.collection('services').countDocuments({ technicianEmail: email }),
        db.collection('services').countDocuments({ technicianEmail: email, approvalStatus: 'approved' }),
        db.collection('bookings').countDocuments({ technicianEmail: email, status: 'requested' }),
        db
          .collection('bookings')
          .aggregate([
            { $match: { technicianEmail: email } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .toArray(),
        db
          .collection('services')
          .aggregate([
            { $match: { technicianEmail: email } },
            { $group: { _id: '$category', count: { $sum: 1 } } },
          ])
          .toArray(),
        db
          .collection('payments')
          .aggregate([
            { $match: { technicianEmail: email } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
          ])
          .toArray(),
      ]);
    res.json({
      totalServices,
      approvedServices,
      pendingRequests,
      earnings: earnings[0]?.total || 0,
      byStatus: toPairs(byStatus),
      byCategory: toPairs(byCategory),
    });
  })
);

/** GET /api/stats/admin */
router.get(
  '/admin',
  verifyToken,
  verifyAdmin,
  h(async (_req, res) => {
    const db = await getDb();
    const since = new Date();
    since.setDate(since.getDate() - 29);
    since.setHours(0, 0, 0, 0);

    const [totalUsers, totalTechnicians, pendingServices, revenue, byStatus, byRole, daily] =
      await Promise.all([
        db.collection(USERS).countDocuments({}),
        db.collection(USERS).countDocuments({ role: 'technician' }),
        db.collection('services').countDocuments({ approvalStatus: 'pending' }),
        db
          .collection('payments')
          .aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
          .toArray(),
        db.collection('bookings').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
        db.collection(USERS).aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]).toArray(),
        db
          .collection('payments')
          .aggregate([
            { $match: { paidAt: { $gte: since } } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } },
                amount: { $sum: '$amount' },
              },
            },
            { $sort: { _id: 1 } },
          ])
          .toArray(),
      ]);

    res.json({
      totalUsers,
      totalTechnicians,
      pendingServices,
      totalRevenue: revenue[0]?.total || 0,
      bookingsByStatus: toPairs(byStatus),
      usersByRole: toPairs(byRole),
      revenueByDay: daily.map((d) => ({ date: d._id, amount: d.amount })),
    });
  })
);

export default router;
