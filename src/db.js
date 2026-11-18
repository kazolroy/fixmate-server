import { MongoClient, ObjectId } from 'mongodb';

let dbPromise = null;

async function ensureIndexes(db) {
  // A Stripe session / booking can only ever produce ONE payment document.
  await db.collection('payments').createIndex({ stripeSessionId: 1 }, { unique: true });
  await db.collection('payments').createIndex({ bookingId: 1 }, { unique: true });
  await db.collection('services').createIndex({ approvalStatus: 1, isAvailable: 1, createdAt: -1 });
  await db.collection('services').createIndex({ technicianEmail: 1 });
  await db.collection('bookings').createIndex({ customerEmail: 1 });
  await db.collection('bookings').createIndex({ technicianEmail: 1 });
  await db.collection('bookings').createIndex({ serviceId: 1, customerEmail: 1 });
}

/** Lazily connects once and re-uses the connection (works for serverless too). */
export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const client = new MongoClient(process.env.MONGODB_URI);
      await client.connect();
      const db = client.db(process.env.DB_NAME || 'fixmate');
      await ensureIndexes(db);
      return db;
    })().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/** Returns an ObjectId or null when the string is not a valid id. */
export function toId(id) {
  return typeof id === 'string' && ObjectId.isValid(id) && String(new ObjectId(id)) === id
    ? new ObjectId(id)
    : null;
}

// BetterAuth stores its users in the "user" collection (this is our "users").
export const USERS = 'user';
