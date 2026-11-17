// MongoDB access layer (document store for notes, forecast snapshots and
// the activity stream).
import { MongoClient } from 'mongodb';

export async function getMongo() {
  if (!globalThis.__fcisMongo) {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (see .env.example)');
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
    globalThis.__fcisMongo = client.connect().catch((err) => {
      globalThis.__fcisMongo = null;
      throw err;
    });
  }
  const client = await globalThis.__fcisMongo;
  return client.db(process.env.MONGODB_DB || 'fcis');
}

/** Append one event to the activity stream. Never fails the request. */
export async function logEvent(session, type, payload = {}) {
  try {
    const db = await getMongo();
    await db.collection('activity_events').insertOne({
      type,
      actor: session
        ? { userId: session.userId, name: session.name, role: session.role }
        : { userId: null, name: 'unknown', role: 'none' },
      at: new Date(),
      payload,
    });
  } catch (err) {
    console.error('activity log failed:', err.message);
  }
}

/** Make a Mongo document safe to pass to a client component. */
export function plain(doc) {
  return JSON.parse(JSON.stringify(doc));
}
