import { Router } from 'express';
import { getDb, toId, USERS } from '../db.js';
import { verifyToken, verifyTechnician } from '../middlewares/auth.js';
import { CATEGORIES, MODES, h, escapeRegex, str } from '../utils/helpers.js';

const router = Router();

/** Validates a service payload coming from the technician form. */
function parseService(body = {}) {
  const data = {
    title: str(body.title),
    category: str(body.category),
    description: str(body.description),
    image: str(body.image),
    basePrice: Number(body.basePrice),
    estimatedDuration: str(body.estimatedDuration),
    serviceMode: str(body.serviceMode),
    serviceArea: str(body.serviceArea),
  };
  if (data.title.length < 3) return { error: 'Title must be at least 3 characters' };
  if (!CATEGORIES.includes(data.category)) return { error: 'Invalid category' };
  if (data.description.length < 20) return { error: 'Description must be at least 20 characters' };
  if (!data.image) return { error: 'Service image is required' };
  if (!Number.isFinite(data.basePrice) || data.basePrice <= 0)
    return { error: 'Base price must be a positive number' };
  if (!data.estimatedDuration) return { error: 'Estimated duration is required' };
  if (!MODES.includes(data.serviceMode)) return { error: 'Invalid service mode' };
  if (!data.serviceArea) return { error: 'Service area is required' };
  return { data };
}

/**
 * GET /api/services  (public)
 * Server-side search / filter / sort / pagination - nothing is filtered in JS.
 * ?q=&category=&mode=&sort=price_asc|price_desc|newest&page=&limit=
 */
router.get(
  '/',
  h(async (req, res) => {
    const db = await getDb();
    const q = str(req.query.q).slice(0, 60);
    const category = str(req.query.category);
    const mode = str(req.query.mode);
    const sort = str(req.query.sort) || 'newest';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);

    const filter = { approvalStatus: 'approved', isAvailable: true };
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ title: rx }, { category: rx }];
    }
    if (CATEGORIES.includes(category)) filter.category = category;
    if (MODES.includes(mode)) filter.serviceMode = mode;

    const sortMap = {
      price_asc: { basePrice: 1, _id: -1 },
      price_desc: { basePrice: -1, _id: -1 },
      newest: { createdAt: -1, _id: -1 },
    };

    const services = db.collection('services');
    const [items, total] = await Promise.all([
      services
        .find(filter)
        .sort(sortMap[sort] || sortMap.newest)
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      services.countDocuments(filter),
    ]);

    res.json({ items, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) });
  })
);

/** GET /api/services/mine  (technician) - declared before /:id */
router.get(
  '/mine',
  verifyToken,
  verifyTechnician,
  h(async (req, res) => {
    const db = await getDb();
    const items = await db
      .collection('services')
      .find({ technicianEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ items });
  })
);

/** GET /api/services/:id  (public) - only approved + available services */
router.get(
  '/:id',
  h(async (req, res) => {
    const _id = toId(req.params.id);
    if (!_id) return res.status(404).json({ message: 'Service not found' });
    const db = await getDb();
    const service = await db
      .collection('services')
      .findOne({ _id, approvalStatus: 'approved', isAvailable: true });
    if (!service) return res.status(404).json({ message: 'Service not found' });

    const tech = await db.collection(USERS).findOne({ email: service.technicianEmail });
    res.json({
      ...service,
      technician: {
        name: tech?.name || service.technicianName,
        image: tech?.image || null,
        area: tech?.area || service.serviceArea,
        bio: tech?.bio || '',
      },
    });
  })
);

/** POST /api/services  (technician) */
router.post(
  '/',
  verifyToken,
  verifyTechnician,
  h(async (req, res) => {
    const { data, error } = parseService(req.body);
    if (error) return res.status(400).json({ message: error });

    const doc = {
      ...data,
      technicianName: req.user.name,
      technicianEmail: req.user.email,
      approvalStatus: 'pending',
      isAvailable: true,
      createdAt: new Date(),
    };
    const db = await getDb();
    const result = await db.collection('services').insertOne(doc);
    res.status(201).json({ ...doc, _id: result.insertedId });
  })
);

/**
 * PATCH /api/services/:id  (technician, owner)
 * - body { isAvailable } only  -> availability toggle (approval stays as is)
 * - full body                  -> edit, approval goes back to "pending"
 */
router.patch(
  '/:id',
  verifyToken,
  verifyTechnician,
  h(async (req, res) => {
    const _id = toId(req.params.id);
    if (!_id) return res.status(404).json({ message: 'Service not found' });
    const db = await getDb();
    const services = db.collection('services');

    const service = await services.findOne({ _id });
    if (!service) return res.status(404).json({ message: 'Service not found' });
    if (service.technicianEmail !== req.user.email)
      return res.status(403).json({ message: 'Forbidden: this is not your service' });

    const keys = Object.keys(req.body || {});
    if (keys.length === 1 && keys[0] === 'isAvailable') {
      if (typeof req.body.isAvailable !== 'boolean')
        return res.status(400).json({ message: 'isAvailable must be true or false' });
      await services.updateOne({ _id }, { $set: { isAvailable: req.body.isAvailable } });
      return res.json({ success: true, isAvailable: req.body.isAvailable });
    }

    const { data, error } = parseService(req.body);
    if (error) return res.status(400).json({ message: error });
    await services.updateOne({ _id }, { $set: { ...data, approvalStatus: 'pending' } });
    res.json({ success: true, approvalStatus: 'pending' });
  })
);

/** DELETE /api/services/:id  (technician, owner) */
router.delete(
  '/:id',
  verifyToken,
  verifyTechnician,
  h(async (req, res) => {
    const _id = toId(req.params.id);
    if (!_id) return res.status(404).json({ message: 'Service not found' });
    const db = await getDb();
    const service = await db.collection('services').findOne({ _id });
    if (!service) return res.status(404).json({ message: 'Service not found' });
    if (service.technicianEmail !== req.user.email)
      return res.status(403).json({ message: 'Forbidden: this is not your service' });
    await db.collection('services').deleteOne({ _id });
    res.json({ success: true });
  })
);

export default router;
