// MongoDB side of FCIS: collections, $jsonSchema validators, indexes and
// seed documents. Run through `npm run db:setup` or `npm run db:mongo`.
//
// Collections
//   commitment_notes    free-form notes and contract terms attached to a commitment
//   forecast_snapshots  the full projected-balance curve of one account for one forecast run
//   activity_events     who did what in the application (expires after 180 days)

import { buildSnapshots } from '../../src/lib/snapshot.mjs';

const num = { bsonType: ['int', 'long', 'double', 'decimal'] };

export const COLLECTIONS = {
  commitment_notes: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['commitmentId', 'title', 'body', 'tags', 'author', 'pinned', 'createdAt', 'updatedAt'],
        properties: {
          commitmentId: { bsonType: 'int', minimum: 1, description: 'commitments.commitment_id in PostgreSQL' },
          title: { bsonType: 'string', minLength: 3, maxLength: 120 },
          body: { bsonType: 'string', minLength: 1, maxLength: 5000 },
          tags: {
            bsonType: 'array', maxItems: 8, uniqueItems: true,
            items: { bsonType: 'string', pattern: '^[a-z0-9-]{2,24}$' },
          },
          terms: { bsonType: 'object', description: 'contract terms; keys differ from one commitment to the next' },
          author: {
            bsonType: 'object', required: ['userId', 'name'],
            properties: { userId: { bsonType: 'int' }, name: { bsonType: 'string' } },
          },
          pinned: { bsonType: 'bool' },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' },
        },
      },
    },
    indexes: [
      { key: { commitmentId: 1, pinned: -1, updatedAt: -1 }, name: 'by_commitment' },
      { key: { tags: 1 }, name: 'by_tag' }, // multikey
      {
        key: { title: 'text', body: 'text', tags: 'text' },
        name: 'notes_text', weights: { title: 5, tags: 3, body: 1 }, default_language: 'english',
      },
    ],
  },

  forecast_snapshots: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['batchId', 'runId', 'accountId', 'accountName', 'generatedAt', 'horizonDays',
          'openingBalance', 'threshold', 'summary', 'daily', 'annotations', 'pinned'],
        properties: {
          batchId: { bsonType: 'int' },
          runId: { bsonType: 'int', description: 'forecast_runs.run_id in PostgreSQL' },
          accountId: { bsonType: 'int' },
          accountName: { bsonType: 'string' },
          generatedAt: { bsonType: 'date' },
          horizonDays: { bsonType: 'int', minimum: 7, maximum: 365 },
          openingBalance: num,
          threshold: num,
          summary: {
            bsonType: 'object', required: ['minBalance', 'minBalanceDate', 'shortfallDays'],
            properties: {
              minBalance: num,
              minBalanceDate: { bsonType: 'date' },
              shortfallDays: { bsonType: 'int', minimum: 0 },
              firstShortfallDate: { bsonType: ['date', 'null'] },
              totalInflow: num,
              totalOutflow: num,
            },
          },
          daily: {
            bsonType: 'array', minItems: 1,
            items: {
              bsonType: 'object', required: ['date', 'inflow', 'outflow', 'balance', 'shortfall', 'items'],
              properties: {
                date: { bsonType: 'date' },
                inflow: num, outflow: num, balance: num,
                shortfall: { bsonType: 'bool' },
                items: { bsonType: 'array' },
              },
            },
          },
          annotations: {
            bsonType: 'array',
            items: {
              bsonType: 'object', required: ['text', 'by', 'at'],
              properties: {
                text: { bsonType: 'string', minLength: 2, maxLength: 500 },
                by: { bsonType: 'string' },
                at: { bsonType: 'date' },
              },
            },
          },
          pinned: { bsonType: 'bool' },
        },
      },
    },
    indexes: [
      { key: { runId: 1 }, name: 'run_unique', unique: true },
      { key: { accountId: 1, generatedAt: -1 }, name: 'latest_per_account' },
      {
        key: { 'summary.firstShortfallDate': 1 }, name: 'runs_with_shortfall',
        partialFilterExpression: { 'summary.shortfallDays': { $gt: 0 } },
      },
    ],
  },

  activity_events: {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['type', 'actor', 'at'],
        properties: {
          type: {
            enum: ['login', 'login_failed', 'logout', 'commitment_created', 'commitment_updated', 'commitment_deleted',
              'payment_recorded', 'schedule_deferred', 'transaction_posted', 'funds_transferred', 'forecast_run',
              'alert_updated', 'note_created', 'note_updated', 'note_deleted', 'snapshot_updated',
              'snapshot_deleted', 'user_created', 'user_updated', 'user_deleted', 'account_updated'],
          },
          actor: {
            bsonType: 'object', required: ['name', 'role'],
            properties: { userId: { bsonType: ['int', 'null'] }, name: { bsonType: 'string' }, role: { bsonType: 'string' } },
          },
          at: { bsonType: 'date' },
          payload: { bsonType: 'object', description: 'shape depends on the event type' },
        },
      },
    },
    indexes: [
      { key: { at: 1 }, name: 'ttl_180_days', expireAfterSeconds: 180 * 24 * 3600 }, // TTL index
      { key: { type: 1, at: -1 }, name: 'by_type' },
      { key: { 'actor.userId': 1, at: -1 }, name: 'by_actor' },
    ],
  },
};

const NOTES = [
  {
    commitment: 'Office rent - Peenya unit', title: 'Lease renewal terms', pinned: true,
    body: 'Lease renewed for 3 years. Rent escalates 5% every April. Landlord allows a 3-day grace period; after that a late fee of 2% per month applies. Security deposit of 10 months is held and is refundable.',
    tags: ['lease', 'escalation', 'grace-period'],
    terms: { graceDays: 3, lateFeePercentPerMonth: 2, escalationPercent: 5, escalationMonth: 'April', securityDepositMonths: 10, lockInMonths: 18 },
  },
  {
    commitment: 'Term loan EMI - Heidelberg press', title: 'Sanction letter summary', pinned: true,
    body: 'Term loan of 1.2 crore at a floating rate, 60 EMIs. EMI is auto-debited by NACH on the 10th. A bounced mandate costs 590 plus 2% penal interest and is reported to the credit bureau, so this instalment must never be short.',
    tags: ['loan', 'auto-debit', 'penalty'],
    terms: { principal: 12000000, tenureMonths: 60, rateType: 'floating', currentRatePercent: 10.75, bounceCharge: 590, penalInterestPercent: 2, prepaymentPenaltyPercent: 0 },
  },
  {
    commitment: 'Paper and board supply', title: 'Credit extension agreed over phone', pinned: false,
    body: 'Spoke to the sales manager at Balaji. They are willing to extend credit up to 30 days in a tight month if we tell them a week ahead. No interest for the first 15 days, 1.5% after that. Good candidate to defer when the operating account is short.',
    tags: ['negotiable', 'credit-period', 'supplier'],
    terms: { maxCreditDays: 30, interestFreeDays: 15, interestPercentAfter: 1.5, noticeDays: 7, contact: 'Regional sales manager' },
  },
  {
    commitment: 'Zenith - catalogue project phase 2', title: 'Payment follow-up history', pinned: true,
    body: 'Phase 1 was paid more than three weeks late after two reminders. Their accounts team releases payments only on the last Friday of the month. Expect the phase 2 invoice to slip as well; do not count on it for salary day.',
    tags: ['late-payer', 'follow-up', 'receivable'],
    terms: { paymentRunDay: 'last Friday', remindersSentPhase1: 2, creditDays: 30 },
  },
  {
    commitment: 'Staff salaries', title: 'Payroll cut-off', pinned: false,
    body: 'Salary file must reach the bank by 11 am on the 27th for credit on the 28th. Funds must be in the operating account one working day earlier.',
    tags: ['payroll', 'cut-off'],
    terms: { fileCutoff: '27th 11:00', headcount: 38 },
  },
  {
    commitment: 'Advance tax instalment', title: 'Estimate for the December instalment', pinned: false,
    body: 'Auditor estimates the third instalment at about 3.1 lakh based on first-half profit. Interest under sections 234B and 234C applies at 1% per month on any shortfall, so the tax reserve must be topped up before the 15th.',
    tags: ['tax', 'penalty', 'estimate'],
    terms: { interestPercentPerMonth: 1, sections: ['234B', '234C'], cumulativePercentDue: 75 },
  },
  {
    commitment: 'Fire and machinery insurance', title: 'Renewal quote', pinned: false,
    body: 'Renewal quote received. Insurer offers payment in two halves 30 days apart at no extra cost if requested before the due date.',
    tags: ['insurance', 'negotiable', 'renewal'],
    terms: { sumInsured: 45000000, splitPaymentAllowed: true, splitGapDays: 30 },
  },
  {
    commitment: 'Freelance design retainer', title: 'Retainer scope', pinned: false,
    body: 'Covers up to 60 hours of packaging design a month. Either side can pause the retainer with 15 days notice. Invoice is raised on the 27th with 7-day terms.',
    tags: ['retainer', 'negotiable'],
    terms: { hoursIncluded: 60, noticeDays: 15, paymentTermsDays: 7 },
  },
  {
    commitment: 'Press upgrade instalment', title: 'Supplier payment plan', pinned: false,
    body: 'UV coating unit upgrade is paid in 18 equal instalments. Supplier has confirmed in writing that one instalment per year may be moved by up to 45 days without penalty.',
    tags: ['instalment', 'negotiable', 'supplier'],
    terms: { instalments: 18, freeDeferralsPerYear: 1, maxDeferralDays: 45 },
  },
];

function seedEvents(users, now) {
  const [admin, analyst, viewer] = ['admin', 'analyst', 'viewer'].map((r) => users.find((u) => u.role === r));
  const actor = (u) => ({ userId: u.user_id, name: u.full_name, role: u.role });
  const at = (daysAgo, hour, minute) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  const events = [];
  for (let day = 13; day >= 0; day -= 1) {
    events.push({ type: 'login', actor: actor(analyst), at: at(day, 9, 10 + day), payload: { ip: '10.0.4.21' } });
    if (day % 2 === 0) events.push({ type: 'login', actor: actor(viewer), at: at(day, 10, 5), payload: { ip: '10.0.4.37' } });
    if (day % 3 === 0) events.push({ type: 'login', actor: actor(admin), at: at(day, 11, 30), payload: { ip: '10.0.4.2' } });
    if (day % 4 === 1) {
      events.push({ type: 'payment_recorded', actor: actor(analyst), at: at(day, 12, 15), payload: { scheduleId: 100 + day, amount: 42000 + day * 1500, direction: 'outflow' } });
    }
    if (day % 5 === 2) {
      events.push({ type: 'payment_recorded', actor: actor(analyst), at: at(day, 15, 40), payload: { scheduleId: 200 + day, amount: 210000, direction: 'inflow' } });
    }
    if (day % 7 === 0) events.push({ type: 'forecast_run', actor: actor(analyst), at: at(day, 9, 45), payload: { horizonDays: 60 } });
  }
  events.push(
    { type: 'login_failed', actor: { userId: null, name: 'unknown', role: 'none' }, at: at(8, 2, 14), payload: { email: 'admin@fcis.local', reason: 'bad password' } },
    { type: 'login_failed', actor: { userId: null, name: 'unknown', role: 'none' }, at: at(8, 2, 15), payload: { email: 'admin@fcis.local', reason: 'bad password' } },
    { type: 'transaction_posted', actor: actor(analyst), at: at(9, 16, 0), payload: { account: 'Operating Account', direction: 'debit', amount: 1180 } },
    { type: 'transaction_posted', actor: actor(analyst), at: at(6, 13, 20), payload: { account: 'Operating Account', direction: 'credit', amount: 26500 } },
    { type: 'account_updated', actor: actor(admin), at: at(5, 17, 5), payload: { account: 'Tax Reserve', field: 'min_buffer', from: 25000, to: 50000 } },
    { type: 'note_created', actor: actor(analyst), at: at(4, 14, 30), payload: { commitment: 'Paper and board supply', tags: ['negotiable', 'credit-period'] } },
    { type: 'commitment_updated', actor: actor(analyst), at: at(3, 10, 50), payload: { commitment: 'Design software licences', field: 'is_flexible', to: true } },
    { type: 'user_created', actor: actor(admin), at: at(12, 11, 45), payload: { email: 'viewer@fcis.local', role: 'viewer' } },
  );
  return events;
}

export async function setupMongo({ db, pg, log = () => {} }) {
  // 1. collections with validators (drop first so the script is repeatable)
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    if (existing.has(name)) await db.collection(name).drop();
    await db.createCollection(name, { validator: spec.validator, validationLevel: 'strict', validationAction: 'error' });
    await db.collection(name).createIndexes(spec.indexes);
    log(`created ${name} (${spec.indexes.length} indexes)`);
  }

  // 2. notes, linked to commitments by their PostgreSQL id
  const commitments = await pg.query('SELECT commitment_id, title FROM fcis.commitments');
  const idByTitle = new Map(commitments.rows.map((r) => [r.title, r.commitment_id]));
  const users = (await pg.query('SELECT user_id, full_name, role FROM fcis.users ORDER BY user_id')).rows;
  const analyst = users.find((u) => u.role === 'analyst');
  const now = new Date();

  const notes = NOTES.filter((n) => idByTitle.has(n.commitment)).map((n, i) => {
    const when = new Date(now.getTime() - (NOTES.length - i) * 36 * 3600 * 1000);
    return {
      commitmentId: idByTitle.get(n.commitment),
      title: n.title,
      body: n.body,
      tags: n.tags,
      terms: n.terms,
      author: { userId: analyst.user_id, name: analyst.full_name },
      pinned: n.pinned,
      createdAt: when,
      updatedAt: when,
    };
  });
  await db.collection('commitment_notes').insertMany(notes);
  log(`inserted ${notes.length} commitment notes`);

  // 3. activity history
  const events = seedEvents(users, now);
  await db.collection('activity_events').insertMany(events);
  log(`inserted ${events.length} activity events`);

  // 4. a snapshot for every forecast batch already in PostgreSQL
  const batches = await pg.query('SELECT DISTINCT batch_id::int AS batch_id FROM fcis.forecast_runs ORDER BY 1');
  let total = 0;
  for (const b of batches.rows) {
    total += await buildSnapshots({
      pg, db, batchId: b.batch_id,
      actor: { userId: analyst.user_id, name: analyst.full_name },
    });
  }
  log(`built ${total} forecast snapshots`);
}
