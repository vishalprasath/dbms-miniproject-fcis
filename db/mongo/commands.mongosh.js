// =====================================================================
// FCIS : MongoDB command reference (mongosh)
//
//   mongosh fcis db/mongo/commands.mongosh.js
//
// The application issues the same operations through the Node.js driver
// (see db/mongo/setup.mjs, src/lib/docs.js and src/app/api/notes|snapshots).
// Everything this script creates is tagged 'demo-script' and removed at
// the end, so it is safe to run against the demo database.
// =====================================================================

// ---------------------------------------------------------------------
// 1. Collections with $jsonSchema validation
//    (full validators are in db/mongo/setup.mjs; this is the short form)
// ---------------------------------------------------------------------
// db.createCollection('commitment_notes', {
//   validator: { $jsonSchema: {
//     bsonType: 'object',
//     required: ['commitmentId', 'title', 'body', 'tags', 'author', 'pinned', 'createdAt', 'updatedAt'],
//     properties: {
//       commitmentId: { bsonType: 'int', minimum: 1 },
//       title: { bsonType: 'string', minLength: 3, maxLength: 120 },
//       body:  { bsonType: 'string', minLength: 1, maxLength: 5000 },
//       tags:  { bsonType: 'array', maxItems: 8, uniqueItems: true,
//                items: { bsonType: 'string', pattern: '^[a-z0-9-]{2,24}$' } },
//       terms: { bsonType: 'object' },            // free-form, differs per note
//       author: { bsonType: 'object', required: ['userId', 'name'] },
//       pinned: { bsonType: 'bool' },
//       createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' } } } },
//   validationLevel: 'strict', validationAction: 'error' });

print('\n== collections =='); printjson(db.getCollectionNames());
print('\n== validator of commitment_notes (required fields) ==');
printjson(db.getCollectionInfos({ name: 'commitment_notes' })[0].options.validator.$jsonSchema.required);

// ---------------------------------------------------------------------
// 2. Indexes
// ---------------------------------------------------------------------
// db.commitment_notes.createIndex({ commitmentId: 1, pinned: -1, updatedAt: -1 }, { name: 'by_commitment' });
// db.commitment_notes.createIndex({ tags: 1 }, { name: 'by_tag' });                        // multikey
// db.commitment_notes.createIndex({ title: 'text', body: 'text', tags: 'text' },
//                                 { name: 'notes_text', weights: { title: 5, tags: 3, body: 1 } });
// db.forecast_snapshots.createIndex({ runId: 1 }, { name: 'run_unique', unique: true });
// db.forecast_snapshots.createIndex({ accountId: 1, generatedAt: -1 }, { name: 'latest_per_account' });
// db.forecast_snapshots.createIndex({ 'summary.firstShortfallDate': 1 },
//        { name: 'runs_with_shortfall', partialFilterExpression: { 'summary.shortfallDays': { $gt: 0 } } });
// db.activity_events.createIndex({ at: 1 }, { name: 'ttl_180_days', expireAfterSeconds: 15552000 }); // TTL
// db.activity_events.createIndex({ type: 1, at: -1 }, { name: 'by_type' });

print('\n== indexes ==');
['commitment_notes', 'forecast_snapshots', 'activity_events'].forEach((c) =>
  printjson({ [c]: db.getCollection(c).getIndexes().map((i) => i.name) }));

// ---------------------------------------------------------------------
// 3. CREATE
// ---------------------------------------------------------------------
const now = new Date();
const inserted = db.commitment_notes.insertOne({
  commitmentId: NumberInt(1),
  title: 'Supplier agreed to a split payment',
  body: 'Half on the due date, half 20 days later, no interest. Confirmed by e-mail.',
  tags: ['negotiable', 'demo-script'],
  terms: { splitParts: 2, gapDays: 20, interestPercent: 0, confirmedBy: 'e-mail' },
  author: { userId: NumberInt(2), name: 'Rohan Iyer' },
  pinned: false, createdAt: now, updatedAt: now,
});
print('\n== insertOne =='); printjson(inserted);

// the validator refuses a document that breaks the schema
try {
  db.commitment_notes.insertOne({ commitmentId: 'one', title: 'x', tags: ['Bad Tag'] });
} catch (e) { print('\n== validator rejected a bad document: ' + e.message + ' (code ' + e.code + ')'); }

// ---------------------------------------------------------------------
// 4. READ
// ---------------------------------------------------------------------
print('\n== notes of one commitment, pinned first ==');
printjson(db.commitment_notes.find({ commitmentId: 1 }, { title: 1, tags: 1, pinned: 1, _id: 0 })
  .sort({ pinned: -1, updatedAt: -1 }).toArray());

print('\n== query on a nested, optional field (only some notes have it) ==');
printjson(db.commitment_notes.find({ 'terms.graceDays': { $exists: true } }, { title: 1, 'terms.graceDays': 1, _id: 0 }).toArray());

print('\n== multikey index: notes tagged negotiable or penalty ==');
printjson(db.commitment_notes.find({ tags: { $in: ['negotiable', 'penalty'] } }, { title: 1, tags: 1, _id: 0 }).toArray());

print('\n== text search, ranked by relevance ==');
printjson(db.commitment_notes.find({ $text: { $search: 'penalty interest' } }, { title: 1, score: { $meta: 'textScore' }, _id: 0 })
  .sort({ score: { $meta: 'textScore' } }).toArray());

print('\n== latest snapshot of account 1, without the heavy daily array ==');
printjson(db.forecast_snapshots.find({ accountId: 1 }, { daily: 0, _id: 0 }).sort({ generatedAt: -1 }).limit(1).toArray());

print('\n== $elemMatch on the embedded array: days where the balance is below zero ==');
printjson(db.forecast_snapshots.find({ daily: { $elemMatch: { shortfall: true, balance: { $lt: 0 } } } },
  { accountName: 1, 'summary.minBalance': 1, _id: 0 }).toArray());

// ---------------------------------------------------------------------
// 5. UPDATE
// ---------------------------------------------------------------------
print('\n== updateOne: $set, $addToSet, $currentDate ==');
printjson(db.commitment_notes.updateOne(
  { _id: inserted.insertedId },
  { $set: { pinned: true, 'terms.gapDays': 25 }, $addToSet: { tags: 'supplier' }, $currentDate: { updatedAt: true } }));

print('\n== updateOne: $push into the annotations array of a snapshot, then $pull it back out ==');
const snap = db.forecast_snapshots.findOne({}, { _id: 1 });
printjson(db.forecast_snapshots.updateOne({ _id: snap._id },
  { $push: { annotations: { text: 'demo-script annotation', by: 'mongosh', at: new Date() } } }));
printjson(db.forecast_snapshots.updateOne({ _id: snap._id }, { $pull: { annotations: { by: 'mongosh' } } }));

print('\n== updateMany: $rename a term on every note that has it, and put it back ==');
printjson(db.commitment_notes.updateMany({ 'terms.noticeDays': { $exists: true } }, { $rename: { 'terms.noticeDays': 'terms.noticePeriodDays' } }));
printjson(db.commitment_notes.updateMany({ 'terms.noticePeriodDays': { $exists: true } }, { $rename: { 'terms.noticePeriodDays': 'terms.noticeDays' } }));

// ---------------------------------------------------------------------
// 6. AGGREGATION
// ---------------------------------------------------------------------
print('\n== tag frequency: $unwind, $group, $addToSet, $size ==');
printjson(db.commitment_notes.aggregate([
  { $unwind: '$tags' },
  { $group: { _id: '$tags', notes: { $sum: 1 }, commitments: { $addToSet: '$commitmentId' } } },
  { $project: { _id: 0, tag: '$_id', notes: 1, commitments: { $size: '$commitments' } } },
  { $sort: { notes: -1, tag: 1 } },
]).toArray());

print('\n== weekly cash pressure from the latest snapshot of each account ==');
printjson(db.forecast_snapshots.aggregate([
  { $sort: { accountId: 1, generatedAt: -1 } },
  { $group: { _id: '$accountId', doc: { $first: '$$ROOT' } } },
  { $replaceRoot: { newRoot: '$doc' } },
  { $unwind: '$daily' },
  { $group: {
      _id: { account: '$accountName', week: { $dateTrunc: { date: '$daily.date', unit: 'week', startOfWeek: 'monday' } } },
      inflow: { $sum: '$daily.inflow' }, outflow: { $sum: '$daily.outflow' },
      lowestBalance: { $min: '$daily.balance' },
      shortfallDays: { $sum: { $cond: ['$daily.shortfall', 1, 0] } } } },
  { $project: { _id: 0, account: '$_id.account', week: { $dateToString: { format: '%Y-%m-%d', date: '$_id.week' } },
                inflow: 1, outflow: 1, lowestBalance: 1, shortfallDays: 1 } },
  { $sort: { account: 1, week: 1 } },
  { $limit: 6 },
]).toArray());

print('\n== payments that fall on shortfall days: double $unwind ==');
printjson(db.forecast_snapshots.aggregate([
  { $sort: { accountId: 1, generatedAt: -1 } },
  { $group: { _id: '$accountId', doc: { $first: '$$ROOT' } } },
  { $replaceRoot: { newRoot: '$doc' } },
  { $unwind: '$daily' }, { $match: { 'daily.shortfall': true } },
  { $unwind: '$daily.items' }, { $match: { 'daily.items.direction': 'outflow' } },
  { $group: { _id: { account: '$accountName', title: '$daily.items.title' }, amount: { $sum: '$daily.items.amount' } } },
  { $sort: { amount: -1 } }, { $limit: 5 },
]).toArray());

print('\n== activity per user: $cond inside $sum, $dateToString ==');
printjson(db.activity_events.aggregate([
  { $match: { 'actor.userId': { $ne: null } } },
  { $group: { _id: '$actor.name', events: { $sum: 1 },
              payments: { $sum: { $cond: [{ $eq: ['$type', 'payment_recorded'] }, 1, 0] } },
              days: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$at' } } } } },
  { $project: { _id: 0, user: '$_id', events: 1, payments: 1, activeDays: { $size: '$days' } } },
  { $sort: { events: -1 } },
]).toArray());

print('\n== explain: the text index is used ==');
print(JSON.stringify(db.commitment_notes.find({ $text: { $search: 'penalty' } }).explain().queryPlanner.winningPlan).includes('notes_text')
  ? 'winning plan uses index notes_text' : 'text index NOT used');

// ---------------------------------------------------------------------
// 7. DELETE
// ---------------------------------------------------------------------
print('\n== deleteOne ==');
printjson(db.commitment_notes.deleteOne({ _id: inserted.insertedId }));
print('\n== deleteMany: anything else this script left behind ==');
printjson(db.commitment_notes.deleteMany({ tags: 'demo-script' }));
// Housekeeping the application offers to admins:
// db.forecast_snapshots.deleteMany({ pinned: false, generatedAt: { $lt: new Date(Date.now() - 90 * 864e5) } });
