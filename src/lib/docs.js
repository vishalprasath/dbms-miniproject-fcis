// MongoDB read queries and aggregation pipelines.
// Pipelines are exported as data so the Insights page can show the exact
// pipeline next to its result.
import { getMongo, plain } from './mongo';

// ---------------------------------------------------------------- snapshots
export const LATEST_SNAPSHOT_PIPELINE = [
  { $sort: { accountId: 1, generatedAt: -1 } },
  { $group: { _id: '$accountId', doc: { $first: '$$ROOT' } } },
  { $replaceRoot: { newRoot: '$doc' } },
  { $sort: { accountId: 1 } },
];

/** Latest snapshot per account (uses the latest_per_account index). */
export async function latestSnapshots() {
  const db = await getMongo();
  return plain(await db.collection('forecast_snapshots').aggregate(LATEST_SNAPSHOT_PIPELINE).toArray());
}

/** Snapshot list without the heavy `daily` array. */
export async function snapshotHistory(limit = 12) {
  const db = await getMongo();
  return plain(await db.collection('forecast_snapshots')
    .find({}, { projection: { daily: 0 } })
    .sort({ generatedAt: -1, accountId: 1 })
    .limit(limit)
    .toArray());
}

// -------------------------------------------------------------------- notes
export async function notesFor(commitmentId) {
  const db = await getMongo();
  return plain(await db.collection('commitment_notes')
    .find({ commitmentId })
    .sort({ pinned: -1, updatedAt: -1 })
    .toArray());
}

export async function searchNotes({ q, tag }) {
  const db = await getMongo();
  const filter = {};
  if (q) filter.$text = { $search: q };
  if (tag) filter.tags = tag;
  const cursor = db.collection('commitment_notes').find(filter, q ? { projection: { score: { $meta: 'textScore' } } } : {});
  cursor.sort(q ? { score: { $meta: 'textScore' } } : { pinned: -1, updatedAt: -1 });
  return plain(await cursor.limit(50).toArray());
}

export const TAG_COUNT_PIPELINE = [
  { $unwind: '$tags' },
  { $group: { _id: '$tags', notes: { $sum: 1 }, commitments: { $addToSet: '$commitmentId' } } },
  { $project: { _id: 0, tag: '$_id', notes: 1, commitments: { $size: '$commitments' } } },
  { $sort: { notes: -1, tag: 1 } },
];

export async function tagCounts() {
  const db = await getMongo();
  return db.collection('commitment_notes').aggregate(TAG_COUNT_PIPELINE).toArray();
}

// ----------------------------------------------------------------- activity
export async function recentActivity({ type, limit = 40 } = {}) {
  const db = await getMongo();
  return plain(await db.collection('activity_events')
    .find(type ? { type } : {})
    .sort({ at: -1 })
    .limit(limit)
    .toArray());
}

export const activityByTypePipeline = (since) => [
  { $match: { at: { $gte: since } } },
  { $group: { _id: '$type', events: { $sum: 1 }, users: { $addToSet: '$actor.name' }, last: { $max: '$at' } } },
  { $project: { _id: 0, type: '$_id', events: 1, distinct_users: { $size: '$users' }, last_seen: '$last' } },
  { $sort: { events: -1 } },
];

export const activityByUserPipeline = (since) => [
  { $match: { at: { $gte: since }, 'actor.userId': { $ne: null } } },
  {
    $group: {
      _id: { user: '$actor.name', role: '$actor.role' },
      events: { $sum: 1 },
      payments: { $sum: { $cond: [{ $eq: ['$type', 'payment_recorded'] }, 1, 0] } },
      amount_handled: { $sum: { $cond: [{ $eq: ['$type', 'payment_recorded'] }, '$payload.amount', 0] } },
      active_days: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$at' } } },
    },
  },
  {
    $project: {
      _id: 0, user: '$_id.user', role: '$_id.role', events: 1, payments: 1, amount_handled: 1,
      active_days: { $size: '$active_days' },
    },
  },
  { $sort: { events: -1 } },
];

// Weekly cash pressure, computed from the nested daily array of the
// latest snapshot of every account.
export const WEEKLY_PRESSURE_PIPELINE = [
  ...LATEST_SNAPSHOT_PIPELINE.slice(0, 3),
  { $unwind: '$daily' },
  {
    $group: {
      _id: { account: '$accountName', week: { $dateTrunc: { date: '$daily.date', unit: 'week', startOfWeek: 'monday' } } },
      inflow: { $sum: '$daily.inflow' },
      outflow: { $sum: '$daily.outflow' },
      lowest_balance: { $min: '$daily.balance' },
      shortfall_days: { $sum: { $cond: ['$daily.shortfall', 1, 0] } },
      items_due: { $sum: { $size: '$daily.items' } },
    },
  },
  {
    $project: {
      _id: 0, account: '$_id.account',
      week_starting: { $dateToString: { format: '%Y-%m-%d', date: '$_id.week' } },
      inflow: { $round: ['$inflow', 0] }, outflow: { $round: ['$outflow', 0] },
      lowest_balance: { $round: ['$lowest_balance', 0] }, shortfall_days: 1, items_due: 1,
    },
  },
  { $sort: { account: 1, week_starting: 1 } },
];

// Largest single payments falling inside shortfall days (nested array of a nested array)
export const SHORTFALL_DRIVERS_PIPELINE = [
  ...LATEST_SNAPSHOT_PIPELINE.slice(0, 3),
  { $unwind: '$daily' },
  { $match: { 'daily.shortfall': true } },
  { $unwind: '$daily.items' },
  { $match: { 'daily.items.direction': 'outflow' } },
  {
    $group: {
      _id: { account: '$accountName', title: '$daily.items.title' },
      amount: { $sum: '$daily.items.amount' },
      flexible: { $first: '$daily.items.flexible' },
      priority: { $first: '$daily.items.priority' },
    },
  },
  { $project: { _id: 0, account: '$_id.account', commitment: '$_id.title', amount: 1, priority: 1, flexible: 1 } },
  { $sort: { amount: -1 } },
  { $limit: 8 },
];

export async function runPipeline(collection, pipeline) {
  const db = await getMongo();
  return plain(await db.collection(collection).aggregate(pipeline).toArray());
}
