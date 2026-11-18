export const CATEGORIES = [
  'Smartphone',
  'Laptop & PC',
  'AC',
  'Refrigerator',
  'TV',
  'Washing Machine',
  'Electrical',
];
export const MODES = ['Home Visit', 'Shop Drop-off'];
export const ACTIVE_STATUSES = ['requested', 'accepted', 'in-progress'];

/** Wraps an async route handler so errors reach the error middleware. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Escapes user input before it is used inside a RegExp. */
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only accept real strings from req.query / req.body (blocks NoSQL operator injection). */
export const str = (v) => (typeof v === 'string' ? v.trim() : '');

export const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Safe public shape of a user document. */
export const publicUser = (u) => ({
  _id: String(u._id),
  name: u.name,
  email: u.email,
  image: u.image || null,
  role: u.role || 'customer',
  phone: u.phone || '',
  area: u.area || '',
  bio: u.bio || '',
  createdAt: u.createdAt,
});
