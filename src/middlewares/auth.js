import jwt from 'jsonwebtoken';
import { getDb, USERS } from '../db.js';

/**
 * verifyToken
 * - 401 when the Bearer token is missing / invalid / expired
 * - loads the user from the database so the ROLE always comes from the DB,
 *   never from the token (an admin demoting a user takes effect immediately).
 */
export async function verifyToken(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Unauthorized: token missing' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ message: 'Unauthorized: invalid or expired token' });
    }

    const db = await getDb();
    const user = await db.collection(USERS).findOne({ email: String(payload.email) });
    if (!user) return res.status(401).json({ message: 'Unauthorized: user not found' });

    req.user = {
      _id: String(user._id),
      email: user.email,
      name: user.name,
      image: user.image || null,
      role: user.role || 'customer',
    };
    next();
  } catch (err) {
    next(err);
  }
}

const requireRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
  if (req.user.role !== role) {
    return res.status(403).json({ message: `Forbidden: ${role}s only` });
  }
  next();
};

export const verifyCustomer = requireRole('customer');
export const verifyTechnician = requireRole('technician');
export const verifyAdmin = requireRole('admin');
