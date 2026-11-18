import { Router } from 'express';
import { getDb, USERS } from '../db.js';
import { verifyToken } from '../middlewares/auth.js';
import { h, str, publicUser } from '../utils/helpers.js';

const router = Router();

/**
 * PATCH /api/users/profile  (any logged-in user)
 * Only name / phone / area / bio / image can change. Email and role never can.
 */
router.patch(
  '/profile',
  verifyToken,
  h(async (req, res) => {
    const name = str(req.body.name);
    if (name.length < 2) return res.status(400).json({ message: 'Name must be at least 2 characters' });

    const update = {
      name,
      phone: str(req.body.phone).slice(0, 30),
      area: str(req.body.area).slice(0, 80),
      bio: str(req.body.bio).slice(0, 500),
      updatedAt: new Date(),
    };
    const image = str(req.body.image);
    if (image) update.image = image;

    const db = await getDb();
    await db.collection(USERS).updateOne({ email: req.user.email }, { $set: update });

    // keep denormalised technician name on their services in sync
    if (req.user.role === 'technician') {
      await db
        .collection('services')
        .updateMany({ technicianEmail: req.user.email }, { $set: { technicianName: name } });
    }

    const user = await db.collection(USERS).findOne({ email: req.user.email });
    res.json({ success: true, user: publicUser(user) });
  })
);

export default router;
