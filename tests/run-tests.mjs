// FCIS test suite.  Run with:  npm test
//
// Every database test runs inside a transaction that is ROLLED BACK, so
// the suite never changes the demo data. API tests run only when the dev
// server is reachable (BASE_URL, default http://localhost:3000) and clean
// up what they create.
//
// Results are printed and written to docs/test-results.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MongoClient } from 'mongodb';

pg.types.setTypeParser(1700, parseFloat);
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1082, (v) => v);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ROLE = { admin: 'fcis_admin', analyst: 'fcis_analyst', viewer: 'fcis_viewer' };

const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=fcis,public', max: 2 });
const ownerUrl = new URL(process.env.PG_ADMIN_URL);
ownerUrl.pathname = `/${process.env.PG_DATABASE || 'fcis'}`;
const owner = new pg.Pool({ connectionString: ownerUrl.toString(), options: '-c search_path=fcis,public', max: 1 });
const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });

const results = [];
let userIds = {};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const near = (a, b) => Math.abs(a - b) < 0.005;

/** Run fn(client) as an application role inside a transaction that is always rolled back. */
async function asRole(role, fn) {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${ROLE[role]}`);
    await c.query("SELECT set_config('app.user_id', $1, TRUE)", [String(userIds[role])]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

/** Expect a statement to fail with a given SQLSTATE; the transaction stays usable (savepoint). */
async function expectFail(c, sql, params, code, messagePart) {
  await c.query('SAVEPOINT t');
  try {
    await c.query(sql, params);
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT t');
    assert(err.code === code, `expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
    if (messagePart) assert(err.message.includes(messagePart) || err.constraint === messagePart, `expected "${messagePart}" in: ${err.message} [${err.constraint ?? ''}]`);
    return err;
  }
  throw new Error(`statement succeeded but should have failed with ${code}`);
}

async function test(id, area, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ id, area, name, pass: true, detail: detail ?? '', ms: Date.now() - started });
  } catch (err) {
    results.push({ id, area, name, pass: false, detail: err.message, ms: Date.now() - started });
  }
}

const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];

// A flexible outflow instalment on the operating account that is still unpaid
const OPEN_FLEXIBLE = `
  SELECT s.schedule_id, s.amount_due - s.amount_paid AS outstanding, s.due_date, c.account_id, c.commitment_id
    FROM commitment_schedule s JOIN commitments c ON c.commitment_id = s.commitment_id
   WHERE c.title = 'Design software licences' AND s.status = 'pending'
   ORDER BY s.due_date LIMIT 1`;
const NEW_COMMITMENT = `
  INSERT INTO commitments (title, category_id, counterparty_id, account_id, direction, amount, frequency, start_date, end_date, created_by)
  SELECT $1, cat.category_id, cp.counterparty_id, a.account_id, $2, $3, $4, $5, $6, fn_app_user()
    FROM categories cat, counterparties cp, bank_accounts a
   WHERE cat.name = $7 AND cp.name = 'ACT Fibernet' AND a.account_name = 'Operating Account'
  RETURNING commitment_id`;

async function main() {
  const users = await owner.query('SELECT user_id, role FROM users WHERE email LIKE $1', ['%@fcis.local']);
  userIds = Object.fromEntries(users.rows.map((u) => [u.role, u.user_id]));

  // ============================================================ authentication
  await test('A01', 'Authentication', 'fn_verify_login accepts the correct password', async () => {
    const r = await one(app, "SELECT * FROM fcis.fn_verify_login('ANALYST@fcis.local ', 'Analyst@123')");
    assert(r?.role === 'analyst', 'no row returned');
    return 'e-mail is trimmed and case-insensitive; returns role = analyst';
  });
  await test('A02', 'Authentication', 'fn_verify_login rejects a wrong password', async () => {
    const r = await one(app, "SELECT * FROM fcis.fn_verify_login('analyst@fcis.local', 'wrong-password')");
    assert(!r, 'a row was returned');
    return 'zero rows';
  });
  await test('A03', 'Authentication', 'Passwords are stored as bcrypt hashes, never plain text', async () => {
    const r = await one(owner, "SELECT password_hash FROM users WHERE email = 'admin@fcis.local'");
    assert(/^\$2[aby]\$10\$/.test(r.password_hash) && !r.password_hash.includes('Admin@123'), 'not a bcrypt hash');
    return 'hash starts with $2a$10$';
  });
  await test('A04', 'Authentication', 'Login role fcis_app cannot read any table before SET ROLE', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await expectFail(c, 'SELECT * FROM fcis.users', [], '42501');
      await expectFail(c, 'SELECT * FROM fcis.commitments', [], '42501');
    } finally { await c.query('ROLLBACK'); c.release(); }
    return 'permission denied (42501) on users and commitments';
  });

  // ================================================== role-based access (DB)
  await test('R01', 'Role-based access', 'Viewer can read but cannot INSERT a commitment', () => asRole('viewer', async (c) => {
    const n = await one(c, 'SELECT COUNT(*)::int AS n FROM commitments');
    assert(n.n > 0, 'viewer could not read');
    await expectFail(c, NEW_COMMITMENT, ['T viewer', 'outflow', 100, 'once', '2030-01-01', null, 'Internet & Telecom'], '42501');
    return `read ${n.n} rows; INSERT denied (42501)`;
  }));
  await test('R02', 'Role-based access', 'Viewer cannot execute sp_record_payment', () => asRole('viewer', async (c) => {
    await expectFail(c, 'CALL sp_record_payment(1, 10)', [], '42501');
    return 'EXECUTE denied (42501)';
  }));
  await test('R03', 'Role-based access', 'Analyst cannot DELETE a commitment; admin can', async () => {
    await asRole('analyst', (c) => expectFail(c, 'DELETE FROM commitments WHERE commitment_id = 1', [], '42501'));
    return asRole('admin', async (c) => {
      const id = (await one(c, NEW_COMMITMENT, ['T delete me', 'outflow', 100, 'once', '2030-01-01', null, 'Internet & Telecom'])).commitment_id;
      const del = await c.query('DELETE FROM commitments WHERE commitment_id = $1', [id]);
      assert(del.rowCount === 1, 'admin delete failed');
      return 'analyst: 42501; admin: 1 row deleted, instalments cascade';
    });
  });
  await test('R04', 'Role-based access', 'Column-level grant: analyst may change min_buffer but not current_balance', () => asRole('analyst', async (c) => {
    const ok = await c.query('UPDATE bank_accounts SET min_buffer = min_buffer + 1 WHERE account_id = 1');
    assert(ok.rowCount === 1, 'min_buffer update failed');
    await expectFail(c, 'UPDATE bank_accounts SET current_balance = 99999999 WHERE account_id = 1', [], '42501');
    return 'min_buffer updated; current_balance denied (42501)';
  }));
  await test('R05', 'Role-based access', 'Nobody can write the ledger directly, not even admin', async () => {
    for (const role of ['analyst', 'admin']) {
      await asRole(role, (c) => expectFail(c,
        "INSERT INTO transactions (account_id, direction, amount, narration) VALUES (1, 'credit', 1000000, 'free money')", [], '42501'));
    }
    return 'INSERT denied for analyst and admin; only procedures write transactions';
  });
  await test('R06', 'Role-based access', 'Admin cannot select the password hash column', () => asRole('admin', async (c) => {
    await expectFail(c, 'SELECT password_hash FROM users', [], '42501');
    const r = await c.query('SELECT user_id, email, role FROM users');
    assert(r.rowCount >= 3, 'other columns unreadable');
    return 'password_hash denied; other columns readable';
  }));
  await test('R07', 'Role-based access', 'Analyst cannot read the audit log or create users', () => asRole('analyst', async (c) => {
    await expectFail(c, 'SELECT * FROM audit_log', [], '42501');
    await expectFail(c, "CALL sp_create_user('X Y', 'x@y.co', 'password1', 'admin')", [], '42501');
    return 'both denied (42501)';
  }));

  // ====================================================== constraints (DDL)
  await test('C01', 'Constraints', 'CHECK: commitment amount must be positive', () => asRole('analyst', async (c) => {
    await expectFail(c, NEW_COMMITMENT, ['T zero', 'outflow', 0, 'once', '2030-01-01', null, 'Internet & Telecom'], '23514', 'ck_commitments_amount');
    return 'ck_commitments_amount';
  }));
  await test('C02', 'Constraints', 'CHECK: end date cannot precede start date', () => asRole('analyst', async (c) => {
    await expectFail(c, NEW_COMMITMENT, ['T dates', 'outflow', 100, 'monthly', '2030-06-01', '2030-01-01', 'Internet & Telecom'], '23514', 'ck_commitments_dates');
    return 'ck_commitments_dates';
  }));
  await test('C03', 'Constraints', 'CHECK: unknown frequency is rejected', () => asRole('analyst', async (c) => {
    await expectFail(c, NEW_COMMITMENT, ['T freq', 'outflow', 100, 'daily', '2030-06-01', null, 'Internet & Telecom'], '23514', 'ck_commitments_frequency');
    return 'ck_commitments_frequency';
  }));
  await test('C04', 'Constraints', 'UNIQUE: duplicate commitment title', () => asRole('analyst', async (c) => {
    await expectFail(c, NEW_COMMITMENT, ['Staff salaries', 'outflow', 100, 'once', '2030-06-01', null, 'Internet & Telecom'], '23505', 'uq_commitments_title');
    return 'uq_commitments_title';
  }));
  await test('C05', 'Constraints', 'FOREIGN KEY: commitment must reference an existing account', () => asRole('analyst', async (c) => {
    await expectFail(c, `INSERT INTO commitments (title, category_id, counterparty_id, account_id, direction, amount, frequency, start_date)
                         SELECT 'T fk', category_id, 1, 999999, direction, 10, 'once', CURRENT_DATE FROM categories WHERE name = 'Internet & Telecom'`,
    [], '23503', 'fk_commitments_account');
    return 'fk_commitments_account';
  }));
  await test('C06', 'Constraints', 'CHECK (regex): invalid e-mail and short password for a new user', () => asRole('admin', async (c) => {
    await expectFail(c, "CALL sp_create_user('Bad Mail', 'not-an-email', 'password1', 'viewer')", [], '23514', 'ck_users_email');
    await expectFail(c, "CALL sp_create_user('Short Pw', 'short@fcis.local', 'abc', 'viewer')", [], 'P0001', 'at least 8 characters');
    await expectFail(c, "CALL sp_create_user('Dup', 'admin@fcis.local', 'password1', 'viewer')", [], '23505', 'uq_users_email');
    return 'ck_users_email, password rule, uq_users_email';
  }));
  await test('C07', 'Constraints', 'CHECK: counterparty reliability must lie between 0 and 1', () => asRole('analyst', async (c) => {
    await expectFail(c, 'UPDATE counterparties SET reliability_score = 1.5 WHERE counterparty_id = 1', [], '23514', 'ck_counterparty_reliability');
    return 'ck_counterparty_reliability';
  }));
  await test('C08', 'Constraints', 'FOREIGN KEY RESTRICT: a commitment with payment history cannot be deleted', () => asRole('admin', async (c) => {
    await expectFail(c, "DELETE FROM commitments WHERE title = 'Staff salaries'", [], '23503', 'fk_transactions_schedule');
    return 'fk_transactions_schedule blocks the cascade';
  }));

  // ================================================================ triggers
  await test('T01', 'Triggers', 'AFTER INSERT trigger generates the instalments of a new commitment', () => asRole('analyst', async (c) => {
    const id = (await one(c, NEW_COMMITMENT, ['T six months', 'outflow', 5000, 'monthly', '2027-01-31', '2027-06-30', 'Internet & Telecom'])).commitment_id;
    const rows = (await c.query('SELECT due_date FROM commitment_schedule WHERE commitment_id = $1 ORDER BY due_date', [id])).rows.map((r) => r.due_date);
    assert(rows.length === 6, `expected 6 instalments, got ${rows.length}`);
    assert(rows[1] === '2027-02-28' && rows[2] === '2027-03-31', `month-end handling wrong: ${rows.join(', ')}`);
    return `6 rows: ${rows.join(', ')}`;
  }));
  await test('T02', 'Triggers', 'BEFORE trigger rejects a category whose direction differs from the commitment', () => asRole('analyst', async (c) => {
    await expectFail(c, NEW_COMMITMENT, ['T mismatch', 'inflow', 100, 'once', '2030-01-01', null, 'Internet & Telecom'], 'P0001', 'does not match');
    return 'raised: category direction does not match';
  }));
  await test('T03', 'Triggers', 'Recurrence rule is frozen after creation', () => asRole('analyst', async (c) => {
    await expectFail(c, "UPDATE commitments SET frequency = 'weekly' WHERE title = 'Staff salaries'", [], 'P0001', 'cannot be changed');
    return 'raised: frequency, start date and direction cannot be changed';
  }));
  await test('T04', 'Triggers', 'Changing the amount re-prices only future unpaid instalments', () => asRole('analyst', async (c) => {
    const before = await one(c, `SELECT COUNT(*) FILTER (WHERE s.status = 'paid' AND s.amount_due = 36000)::int AS paid FROM commitment_schedule s
                                   JOIN commitments c ON c.commitment_id = s.commitment_id WHERE c.title = 'Design software licences'`);
    await c.query("UPDATE commitments SET amount = 40000 WHERE title = 'Design software licences'");
    const after = await one(c, `SELECT COUNT(*) FILTER (WHERE s.status = 'paid' AND s.amount_due = 36000)::int AS paid,
                                       COUNT(*) FILTER (WHERE s.status = 'pending' AND s.amount_due = 40000)::int AS repriced,
                                       COUNT(*) FILTER (WHERE s.status = 'pending' AND s.amount_due <> 40000)::int AS missed
                                  FROM commitment_schedule s JOIN commitments c ON c.commitment_id = s.commitment_id
                                 WHERE c.title = 'Design software licences'`);
    assert(after.paid === before.paid && after.repriced > 0 && after.missed === 0, JSON.stringify(after));
    return `${after.repriced} future instalments now 40,000; ${after.paid} paid ones untouched`;
  }));
  await test('T05', 'Triggers', 'Closing a commitment waives every unpaid instalment', () => asRole('analyst', async (c) => {
    await c.query("UPDATE commitments SET status = 'closed' WHERE title = 'Internet leased line'");
    const r = await one(c, `SELECT COUNT(*) FILTER (WHERE s.status = 'waived')::int AS waived,
                                   COUNT(*) FILTER (WHERE s.status IN ('pending', 'partial', 'overdue'))::int AS open
                              FROM commitment_schedule s JOIN commitments c ON c.commitment_id = s.commitment_id
                             WHERE c.title = 'Internet leased line'`);
    assert(r.waived > 0 && r.open === 0, JSON.stringify(r));
    await expectFail(c, "UPDATE commitments SET status = 'active' WHERE title = 'Internet leased line'", [], 'P0001', 'cannot be reopened');
    return `${r.waived} instalments waived, 0 left open; reopening refused`;
  }));
  await test('T06', 'Triggers', 'Ledger rows are immutable (BEFORE UPDATE trigger)', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await expectFail(c, 'UPDATE transactions SET amount = amount + 1 WHERE txn_id = (SELECT MIN(txn_id) FROM transactions)', [], 'P0001', 'immutable');
    } finally { await c.query('ROLLBACK'); c.release(); }
    return 'even the table owner is refused';
  });
  await test('T07', 'Triggers', 'The last active administrator cannot be demoted, disabled or deleted', () => asRole('admin', async (c) => {
    await expectFail(c, "UPDATE users SET role = 'viewer' WHERE email = 'admin@fcis.local'", [], 'P0001', 'last active administrator');
    await expectFail(c, "UPDATE users SET is_active = FALSE WHERE email = 'admin@fcis.local'", [], 'P0001', 'last active administrator');
    await expectFail(c, "DELETE FROM users WHERE email = 'admin@fcis.local'", [], 'P0001', 'last active administrator');
    return 'all three refused';
  }));
  await test('T08', 'Triggers', 'Audit trigger records who changed what, with old and new values', () => asRole('analyst', async (c) => {
    await c.query("UPDATE commitments SET priority = 5 WHERE title = 'Design software licences'");
    // only the admin role may read audit_log, so switch role inside the same transaction
    await c.query('SET LOCAL ROLE fcis_admin');
    const a = await one(c, `SELECT action, changed_by, old_data ->> 'priority' AS old_p, new_data ->> 'priority' AS new_p
                              FROM audit_log WHERE table_name = 'commitments' ORDER BY audit_id DESC LIMIT 1`);
    assert(a.action === 'UPDATE' && a.old_p === '4' && a.new_p === '5' && a.changed_by === userIds.analyst, JSON.stringify(a));
    return `UPDATE by user ${a.changed_by}: priority ${a.old_p} -> ${a.new_p}`;
  }));

  // ================================================ procedures / transactions
  await test('P01', 'Procedures & transactions', 'sp_record_payment: full payment updates ledger, balance and instalment together', () => asRole('analyst', async (c) => {
    const s = await one(c, OPEN_FLEXIBLE);
    const before = await one(c, 'SELECT current_balance FROM bank_accounts WHERE account_id = $1', [s.account_id]);
    await c.query('CALL sp_record_payment($1, $2)', [s.schedule_id, s.outstanding]);
    const after = await one(c, 'SELECT current_balance FROM bank_accounts WHERE account_id = $1', [s.account_id]);
    const inst = await one(c, 'SELECT status, amount_paid, paid_on FROM commitment_schedule WHERE schedule_id = $1', [s.schedule_id]);
    const txn = await one(c, "SELECT direction, amount, txn_kind, recorded_by FROM transactions WHERE schedule_id = $1", [s.schedule_id]);
    assert(near(before.current_balance - after.current_balance, s.outstanding), 'balance did not move by the payment');
    assert(inst.status === 'paid' && inst.paid_on, `instalment status ${inst.status}`);
    assert(txn.direction === 'debit' && txn.txn_kind === 'commitment' && txn.recorded_by === userIds.analyst, JSON.stringify(txn));
    return `balance ${before.current_balance} -> ${after.current_balance}; instalment paid; debit entry by analyst`;
  }));
  await test('P02', 'Procedures & transactions', 'sp_record_payment: part payment sets status to partial', () => asRole('analyst', async (c) => {
    const s = await one(c, OPEN_FLEXIBLE);
    await c.query('CALL sp_record_payment($1, $2)', [s.schedule_id, 1000]);
    const inst = await one(c, 'SELECT status, amount_paid FROM commitment_schedule WHERE schedule_id = $1', [s.schedule_id]);
    assert(inst.status === 'partial' && inst.amount_paid === 1000, JSON.stringify(inst));
    return 'status = partial, amount_paid = 1000';
  }));
  await test('P03', 'Procedures & transactions', 'sp_record_payment: over-payment and double payment are refused', () => asRole('analyst', async (c) => {
    const s = await one(c, OPEN_FLEXIBLE);
    await expectFail(c, 'CALL sp_record_payment($1, $2)', [s.schedule_id, s.outstanding + 1], 'P0001', 'exceeds the outstanding');
    await c.query('CALL sp_record_payment($1, $2)', [s.schedule_id, s.outstanding]);
    await expectFail(c, 'CALL sp_record_payment($1, $2)', [s.schedule_id, 1], 'P0001', 'already paid');
    return 'both raise P0001';
  }));
  await test('P04', 'Procedures & transactions', 'Insufficient funds: the payment is rolled back completely', () => asRole('analyst', async (c) => {
    const s = await one(c, `SELECT s.schedule_id, s.amount_due, c.account_id FROM commitment_schedule s
                              JOIN commitments c ON c.commitment_id = s.commitment_id
                             WHERE c.title = 'Staff salaries' AND s.status = 'pending' ORDER BY s.due_date LIMIT 1`);
    const before = await one(c, `SELECT (SELECT current_balance FROM bank_accounts WHERE account_id = $1) AS bal,
                                        (SELECT COUNT(*)::int FROM transactions) AS txns`, [s.account_id]);
    assert(before.bal < s.amount_due, 'seed balance unexpectedly covers salaries');
    await expectFail(c, 'CALL sp_record_payment($1, $2)', [s.schedule_id, s.amount_due], 'P0001', 'Insufficient funds');
    const after = await one(c, `SELECT (SELECT current_balance FROM bank_accounts WHERE account_id = $1) AS bal,
                                       (SELECT COUNT(*)::int FROM transactions) AS txns,
                                       (SELECT status FROM commitment_schedule WHERE schedule_id = $2) AS status`, [s.account_id, s.schedule_id]);
    assert(after.bal === before.bal && after.txns === before.txns && after.status === 'pending', JSON.stringify(after));
    return `balance ${before.bal} < ${s.amount_due}: refused; balance, ledger and instalment unchanged`;
  }));
  await test('P05', 'Procedures & transactions', 'sp_transfer_funds is atomic and conserves money', () => asRole('analyst', async (c) => {
    const total = async () => (await one(c, 'SELECT SUM(current_balance) AS t FROM bank_accounts')).t;
    const t0 = await total();
    await expectFail(c, 'CALL sp_transfer_funds(2, 1, 99999999)', [], 'P0001', 'Insufficient funds');
    assert(near(await total(), t0), 'failed transfer changed balances');
    const b0 = await one(c, 'SELECT (SELECT current_balance FROM bank_accounts WHERE account_id = 1) AS a, (SELECT current_balance FROM bank_accounts WHERE account_id = 2) AS b');
    await c.query("CALL sp_transfer_funds(1, 2, 150000, 'Top up tax reserve')");
    const b1 = await one(c, 'SELECT (SELECT current_balance FROM bank_accounts WHERE account_id = 1) AS a, (SELECT current_balance FROM bank_accounts WHERE account_id = 2) AS b');
    assert(near(b0.a - b1.a, 150000) && near(b1.b - b0.b, 150000) && near(await total(), t0), 'transfer not balanced');
    await expectFail(c, 'CALL sp_transfer_funds(1, 1, 10)', [], 'P0001', 'must be different');
    return 'failed transfer changes nothing; good transfer: -150,000 / +150,000, total unchanged';
  }));
  await test('P06', 'Procedures & transactions', 'CHECK on balance floor stops any entry below the overdraft limit', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await expectFail(c, "INSERT INTO transactions (account_id, direction, amount, narration) VALUES (3, 'debit', 5000000, 'beyond the OD limit')", [], '23514', 'ck_account_balance_floor');
    } finally { await c.query('ROLLBACK'); c.release(); }
    return 'ck_account_balance_floor fires from the balance trigger';
  });
  await test('P07', 'Procedures & transactions', 'Deleting a ledger entry reverses the balance and reopens the instalment', () => asRole('admin', async (c) => {
    const s = await one(c, OPEN_FLEXIBLE);
    const b0 = (await one(c, 'SELECT current_balance FROM bank_accounts WHERE account_id = $1', [s.account_id])).current_balance;
    await c.query('CALL sp_record_payment($1, $2)', [s.schedule_id, s.outstanding]);
    await c.query('DELETE FROM transactions WHERE schedule_id = $1', [s.schedule_id]);
    const b1 = (await one(c, 'SELECT current_balance FROM bank_accounts WHERE account_id = $1', [s.account_id])).current_balance;
    const inst = await one(c, 'SELECT status, amount_paid, paid_on FROM commitment_schedule WHERE schedule_id = $1', [s.schedule_id]);
    assert(near(b0, b1) && inst.status === 'pending' && inst.amount_paid === 0 && inst.paid_on === null, JSON.stringify({ b0, b1, inst }));
    return 'balance restored, instalment back to pending';
  }));
  await test('P08', 'Procedures & transactions', 'sp_defer_schedule: only flexible instalments, forward only, max 90 days', () => asRole('analyst', async (c) => {
    const fixed = await one(c, `SELECT s.schedule_id FROM commitment_schedule s JOIN commitments c ON c.commitment_id = s.commitment_id
                                 WHERE c.title = 'Office rent - Peenya unit' AND s.status = 'pending' ORDER BY s.due_date LIMIT 1`);
    await expectFail(c, "CALL sp_defer_schedule($1, CURRENT_DATE + 40)", [fixed.schedule_id], 'P0001', 'not marked flexible');
    const s = await one(c, OPEN_FLEXIBLE);
    await expectFail(c, 'CALL sp_defer_schedule($1, $2::date - 1)', [s.schedule_id, s.due_date], 'P0001', 'must be later');
    await expectFail(c, 'CALL sp_defer_schedule($1, $2::date + 120)', [s.schedule_id, s.due_date], 'P0001', 'more than 90 days');
    await c.query('CALL sp_defer_schedule($1, $2::date + 20)', [s.schedule_id, s.due_date]);
    const r = await one(c, 'SELECT due_date - $2::date AS moved FROM commitment_schedule WHERE schedule_id = $1', [s.schedule_id, s.due_date]);
    assert(r.moved === 20, `moved ${r.moved}`);
    return 'three invalid requests refused; valid deferral moves due_date by 20 days, original date kept';
  }));

  // ================================================================ forecast
  await test('F01', 'Forecast', 'fn_project_cashflow: running balance equals opening balance plus net flows', () => asRole('viewer', async (c) => {
    const r = await one(c, `SELECT COUNT(*)::int AS days, SUM(net_flow) AS net,
                                   (ARRAY_AGG(projected_balance ORDER BY day DESC))[1] AS closing,
                                   (SELECT current_balance FROM bank_accounts WHERE account_id = 1) AS opening
                              FROM fn_project_cashflow(1, 60)`);
    assert(r.days === 61, `expected 61 days, got ${r.days}`);
    assert(near(r.opening + r.net, r.closing), `opening ${r.opening} + net ${r.net} <> closing ${r.closing}`);
    return `61 calendar days from the recursive CTE; ${r.opening} + ${r.net} = ${r.closing}`;
  }));
  await test('F02', 'Forecast', 'Inflows are weighted by the payer reliability score', () => asRole('viewer', async (c) => {
    const s = await one(c, `SELECT s.due_date, s.amount_due, cp.reliability_score FROM commitment_schedule s
                              JOIN commitments c ON c.commitment_id = s.commitment_id JOIN counterparties cp ON cp.counterparty_id = c.counterparty_id
                             WHERE c.title = 'Zenith - catalogue project phase 2'`);
    const d = await one(c, 'SELECT expected_inflow FROM fn_project_cashflow(1, 60) WHERE day = $1', [s.due_date]);
    assert(d.expected_inflow >= s.amount_due * s.reliability_score - 0.01 && d.expected_inflow < s.amount_due, JSON.stringify({ s, d }));
    return `invoice ${s.amount_due} x reliability ${s.reliability_score} = ${s.amount_due * s.reliability_score} counted`;
  }));
  await test('F03', 'Forecast', 'sp_run_forecast stores one run per account and one alert per shortfall episode', () => asRole('analyst', async (c) => {
    const call = await c.query('CALL sp_run_forecast(60, NULL)');
    const batch = call.rows[0].p_batch_id;
    const runs = (await c.query('SELECT run_id, account_id, shortfall_days FROM forecast_runs WHERE batch_id = $1', [batch])).rows;
    const accounts = (await one(c, 'SELECT COUNT(*)::int AS n FROM bank_accounts WHERE is_active')).n;
    assert(runs.length === accounts, `runs ${runs.length} vs accounts ${accounts}`);
    for (const run of runs) {
      const manual = await one(c, `
        WITH f AS (SELECT day, is_shortfall, LAG(is_shortfall, 1, FALSE) OVER (ORDER BY day) AS prev FROM fn_project_cashflow($1, 60))
        SELECT COUNT(*) FILTER (WHERE is_shortfall AND NOT prev)::int AS episodes, COUNT(*) FILTER (WHERE is_shortfall)::int AS days FROM f`, [run.account_id]);
      const stored = await one(c, `SELECT COUNT(*)::int AS n, COALESCE(SUM(shortfall_end - shortfall_start + 1), 0)::int AS days
                                     FROM shortfall_alerts WHERE run_id = $1`, [run.run_id]);
      assert(stored.n === manual.episodes && stored.days === manual.days && run.shortfall_days === manual.days,
        `account ${run.account_id}: stored ${JSON.stringify(stored)} vs recomputed ${JSON.stringify(manual)}`);
    }
    const old = await one(c, "SELECT COUNT(*)::int AS n FROM shortfall_alerts WHERE status = 'open' AND run_id NOT IN (SELECT run_id FROM forecast_runs WHERE batch_id = $1)", [batch]);
    assert(old.n === 0, 'older alerts were not superseded');
    return `batch ${batch}: ${runs.length} runs; alert episodes match an independent LAG() recomputation; older alerts superseded`;
  }));
  await test('F04', 'Forecast', 'What-if: deferring a suggested payment raises the lowest projected balance', () => asRole('viewer', async (c) => {
    const alert = await one(c, "SELECT alert_id, account_id FROM v_live_alerts WHERE account_name = 'Operating Account' ORDER BY shortfall_start LIMIT 1");
    const sug = (await c.query('SELECT * FROM fn_suggest_deferrals($1)', [alert.alert_id])).rows;
    assert(sug.length > 0, 'no suggestions');
    assert(sug.every((x, i) => i === 0 || x.priority <= sug[i - 1].priority), 'not ordered least-important first');
    assert(sug[sug.length - 1].covers_deficit || sug.length > 0, 'no covering row');
    const pick = sug[sug.length - 1];
    const moved = await one(c, 'SELECT MIN(projected_balance) AS m FROM fn_project_cashflow($1, 60, $2, $3) WHERE day < $3', [alert.account_id, pick.schedule_id, pick.suggested_date]);
    const baseBefore = await one(c, 'SELECT MIN(projected_balance) AS m FROM fn_project_cashflow($1, 60) WHERE day < $2', [alert.account_id, pick.suggested_date]);
    assert(moved.m > baseBefore.m, `lowest balance did not improve: ${baseBefore.m} -> ${moved.m}`);
    return `${sug.length} suggestions, least important first; moving "${pick.title}" lifts the low point ${baseBefore.m} -> ${moved.m}`;
  }));

  // ================================================================= queries
  await test('Q01', 'Queries', 'Recursive CTE returns every descendant of a category', () => asRole('viewer', async (c) => {
    const r = await one(c, `
      WITH RECURSIVE sub AS (
        SELECT category_id, name FROM categories WHERE name = 'Operating Expenses'
        UNION ALL SELECT ch.category_id, ch.name FROM categories ch JOIN sub ON ch.parent_id = sub.category_id)
      SELECT COUNT(*)::int AS n, BOOL_OR(name = 'Salaries') AS has_leaf FROM sub`);
    assert(r.n === 15 && r.has_leaf, JSON.stringify(r));
    return '15 categories under Operating Expenses, two levels deep';
  }));
  await test('Q02', 'Queries', 'Full-text search uses stemming and ranks the title above the description', () => asRole('viewer', async (c) => {
    const rows = (await c.query(`SELECT title FROM commitments WHERE search_doc @@ websearch_to_tsquery('english', 'leasing presses')
                                  ORDER BY ts_rank(search_doc, websearch_to_tsquery('english', 'leasing presses')) DESC`)).rows;
    assert(rows.length >= 1, 'no match for stemmed terms');
    return `"leasing presses" matches ${rows.length} commitment(s), first: ${rows[0].title}`;
  }));
  await test('Q03', 'Queries', 'Partial index is used for the open-instalment scan', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL enable_seqscan = off');
      const plan = (await c.query(`EXPLAIN SELECT schedule_id FROM commitment_schedule
                                    WHERE status IN ('pending', 'partial', 'overdue') AND due_date <= CURRENT_DATE + 30`)).rows.map((r) => r['QUERY PLAN']).join(' ');
      assert(plan.includes('idx_schedule_open_due'), plan);
    } finally { await c.query('ROLLBACK'); c.release(); }
    return 'EXPLAIN shows idx_schedule_open_due';
  });
  await test('Q04', 'Queries', 'View v_account_health agrees with the base tables', () => asRole('viewer', async (c) => {
    const v = await one(c, 'SELECT outflow_30d FROM v_account_health WHERE account_id = 1');
    const b = await one(c, `SELECT SUM(s.amount_due - s.amount_paid) AS t FROM commitment_schedule s JOIN commitments c ON c.commitment_id = s.commitment_id
                             WHERE c.account_id = 1 AND c.status = 'active' AND c.direction = 'outflow'
                               AND s.status IN ('pending', 'partial', 'overdue') AND s.due_date <= CURRENT_DATE + 30`);
    assert(near(v.outflow_30d, b.t), `${v.outflow_30d} vs ${b.t}`);
    return `outflow_30d = ${v.outflow_30d} both ways`;
  }));
  await test('Q05', 'Queries', 'Ledger and balances reconcile: balance = sum(credits) - sum(debits)', () => asRole('viewer', async (c) => {
    const rows = (await c.query(`SELECT a.account_name, a.current_balance,
                                        COALESCE(SUM(CASE t.direction WHEN 'credit' THEN t.amount ELSE -t.amount END), 0) AS ledger
                                   FROM bank_accounts a LEFT JOIN transactions t ON t.account_id = a.account_id
                                  GROUP BY a.account_id`)).rows;
    for (const r of rows) assert(near(r.current_balance, r.ledger), `${r.account_name}: ${r.current_balance} vs ${r.ledger}`);
    return `${rows.length} accounts reconcile to the paisa`;
  }));

  // ================================================================= MongoDB
  await mongo.connect();
  const db = mongo.db(process.env.MONGODB_DB || 'fcis');
  const notes = db.collection('commitment_notes');
  const base = () => ({ commitmentId: 1, title: 'Test note', body: 'Body text', tags: ['test-tag'], terms: { graceDays: 3 },
    author: { userId: 1, name: 'Tester' }, pinned: false, createdAt: new Date(), updatedAt: new Date() });

  await test('M01', 'MongoDB', '$jsonSchema validator rejects a note without a title', async () => {
    const doc = base(); delete doc.title;
    try { await notes.insertOne(doc); } catch (err) { assert(err.code === 121, `code ${err.code}`); return 'Document failed validation (code 121)'; }
    throw new Error('insert succeeded');
  });
  await test('M02', 'MongoDB', 'Validator rejects a badly formed tag and a wrong type', async () => {
    for (const bad of [{ tags: ['Has Spaces'] }, { commitmentId: 'one' }, { tags: ['dup', 'dup'] }]) {
      try { await notes.insertOne({ ...base(), ...bad }); } catch (err) { assert(err.code === 121, `code ${err.code}`); continue; }
      throw new Error(`insert succeeded for ${JSON.stringify(bad)}`);
    }
    return 'tag pattern, bsonType int and uniqueItems all enforced';
  });
  await test('M03', 'MongoDB', 'Create, read, update ($set, $addToSet, $currentDate) and delete a note', async () => {
    const { insertedId } = await notes.insertOne({ ...base(), title: 'Lifecycle test note' });
    try {
      const read = await notes.findOne({ _id: insertedId });
      assert(read.terms.graceDays === 3, 'read failed');
      const upd = await notes.findOneAndUpdate({ _id: insertedId },
        { $set: { pinned: true, 'terms.lateFeePercent': 2 }, $addToSet: { tags: 'penalty' }, $currentDate: { updatedAt: true } },
        { returnDocument: 'after' });
      assert(upd.pinned && upd.tags.includes('penalty') && upd.terms.lateFeePercent === 2 && upd.updatedAt >= read.updatedAt, 'update failed');
    } finally {
      const del = await notes.deleteOne({ _id: insertedId });
      assert(del.deletedCount === 1, 'delete failed');
    }
    assert((await notes.countDocuments({ title: 'Lifecycle test note' })) === 0, 'still present');
    return 'insertOne -> findOne -> findOneAndUpdate -> deleteOne';
  });
  await test('M04', 'MongoDB', 'Text index search ranks by relevance', async () => {
    const hits = await notes.find({ $text: { $search: 'penalty interest' } }, { projection: { title: 1, score: { $meta: 'textScore' } } })
      .sort({ score: { $meta: 'textScore' } }).toArray();
    assert(hits.length >= 2, `only ${hits.length} hits`);
    assert(hits[0].score >= hits[hits.length - 1].score, 'not sorted by score');
    const plan = await notes.find({ $text: { $search: 'penalty' } }).explain('queryPlanner');
    assert(JSON.stringify(plan).includes('notes_text'), 'text index not used');
    return `${hits.length} notes; top: "${hits[0].title}" (score ${hits[0].score.toFixed(2)}); plan uses notes_text`;
  });
  await test('M05', 'MongoDB', 'Aggregation: $unwind + $group counts tags across notes', async () => {
    const agg = await notes.aggregate([{ $unwind: '$tags' }, { $group: { _id: '$tags', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
    const manual = (await notes.find({ tags: agg[0]._id }).toArray()).length;
    assert(agg[0].n === manual, `${agg[0].n} vs ${manual}`);
    return `top tag "${agg[0]._id}" appears in ${agg[0].n} notes (matches a plain find)`;
  });
  await test('M06', 'MongoDB', 'Snapshot documents match PostgreSQL and the unique index blocks duplicates', async () => {
    const snaps = db.collection('forecast_snapshots');
    const snap = await snaps.find().sort({ generatedAt: -1 }).limit(1).next();
    const run = await one(owner, 'SELECT min_projected_balance, shortfall_days, horizon_days FROM forecast_runs WHERE run_id = $1', [snap.runId]);
    assert(near(run.min_projected_balance, snap.summary.minBalance) && run.shortfall_days === snap.summary.shortfallDays, 'snapshot differs from forecast_runs');
    assert(snap.daily.length === run.horizon_days + 1, `daily has ${snap.daily.length} days`);
    const dup = { ...snap }; delete dup._id;
    try { await snaps.insertOne(dup); } catch (err) { assert(err.code === 11000, `code ${err.code}`); return `run ${snap.runId}: ${snap.daily.length} embedded days, summary equals forecast_runs; duplicate runId rejected (E11000)`; }
    throw new Error('duplicate insert succeeded');
  });
  await test('M07', 'MongoDB', 'Aggregation over the nested daily array reproduces the SQL shortfall count', async () => {
    const agg = await db.collection('forecast_snapshots').aggregate([
      { $sort: { accountId: 1, generatedAt: -1 } }, { $group: { _id: '$accountId', doc: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$doc' } },
      { $unwind: '$daily' }, { $match: { 'daily.shortfall': true } }, { $group: { _id: '$runId', days: { $sum: 1 } } }]).toArray();
    for (const a of agg) {
      const run = await one(owner, 'SELECT shortfall_days FROM forecast_runs WHERE run_id = $1', [a._id]);
      assert(run.shortfall_days === a.days, `run ${a._id}: mongo ${a.days} vs sql ${run.shortfall_days}`);
    }
    return `${agg.length} accounts with shortfall days; counts equal forecast_runs.shortfall_days`;
  });
  await test('M08', 'MongoDB', 'Expected indexes exist, including the TTL index', async () => {
    const idx = await db.collection('activity_events').indexes();
    const ttl = idx.find((i) => i.name === 'ttl_180_days');
    assert(ttl?.expireAfterSeconds === 15552000, 'TTL index missing');
    const names = (await db.collection('forecast_snapshots').indexes()).map((i) => i.name);
    assert(names.includes('run_unique') && names.includes('latest_per_account') && names.includes('runs_with_shortfall'), names.join(','));
    return 'ttl_180_days (15,552,000 s), run_unique, latest_per_account, partial runs_with_shortfall';
  });

  // ===================================================================== API
  let serverUp = false;
  try { serverUp = (await fetch(`${BASE}/api/auth/me`)).status === 401; } catch { serverUp = false; }
  if (!serverUp) {
    results.push({ id: 'H00', area: 'HTTP API', name: 'API tests', pass: null, detail: `skipped: no server at ${BASE} (start it with npm run dev)`, ms: 0 });
  } else {
    const login = async (role) => {
      const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${role}@fcis.local`, password: `${role[0].toUpperCase()}${role.slice(1)}@123` }) });
      return (res.headers.get('set-cookie') || '').split(';')[0];
    };
    const call = async (cookie, method, url, body) => {
      const res = await fetch(`${BASE}${url}`, { method, redirect: 'manual', headers: { cookie: cookie ?? '', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json().catch(() => ({})), location: res.headers.get('location') };
    };
    const cookies = {};
    await test('H01', 'HTTP API', 'Login sets an httpOnly session cookie; a wrong password returns 401', async () => {
      const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@fcis.local', password: 'nope' }) });
      assert(res.status === 401, `status ${res.status}`);
      const ok = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@fcis.local', password: 'Admin@123' }) });
      const sc = ok.headers.get('set-cookie') || '';
      assert(ok.status === 200 && /fcis_session=/.test(sc) && /HttpOnly/i.test(sc), sc);
      for (const r of ['admin', 'analyst', 'viewer']) cookies[r] = await login(r);
      return '401 for bad password; 200 + HttpOnly cookie for good one';
    });
    await test('H02', 'HTTP API', 'Unauthenticated requests: API returns 401, pages redirect to /login', async () => {
      const a = await call(null, 'GET', '/api/commitments');
      const p = await call(null, 'GET', '/commitments');
      assert(a.status === 401 && [302, 307].includes(p.status) && p.location.includes('/login'), `${a.status} / ${p.status} ${p.location}`);
      return 'API 401; page 307 -> /login';
    });
    await test('H03', 'HTTP API', 'Viewer: reads succeed, writes are refused by the database role (403)', async () => {
      const r = await call(cookies.viewer, 'GET', '/api/dashboard');
      assert(r.status === 200 && r.data.totals, 'dashboard failed');
      const w = await call(cookies.viewer, 'POST', '/api/commitments', { title: 'Viewer write', category_id: 1, counterparty_id: 1, account_id: 1, amount: 10, frequency: 'once', start_date: '2030-01-01' });
      const p = await call(cookies.viewer, 'POST', '/api/schedule/1/pay', { amount: 1 });
      const adminPage = await call(cookies.viewer, 'GET', '/admin');
      assert(w.status === 403 && p.status === 403, `${w.status} / ${p.status}`);
      assert([302, 307].includes(adminPage.status), `admin page ${adminPage.status}`);
      return 'GET 200; POST commitment 403; POST payment 403; /admin redirects away';
    });
    await test('H04', 'HTTP API', 'Analyst creates a commitment (instalments generated), edits it; only admin can delete it', async () => {
      const cats = await asRole('viewer', (c) => one(c, "SELECT category_id FROM categories WHERE name = 'Internet & Telecom'"));
      const title = `API test ${Date.now()}`;
      const created = await call(cookies.analyst, 'POST', '/api/commitments', { title, category_id: cats.category_id, counterparty_id: 1, account_id: 1, amount: 2500, frequency: 'monthly', start_date: '2027-03-01', end_date: '2027-05-31', priority: 4, is_flexible: true });
      assert(created.status === 200 && created.data.instalments === 3, JSON.stringify(created));
      const id = created.data.commitment_id;
      try {
        const patched = await call(cookies.analyst, 'PATCH', `/api/commitments/${id}`, { amount: 3000 });
        assert(patched.status === 200, JSON.stringify(patched));
        const detail = await call(cookies.analyst, 'GET', `/api/commitments/${id}`);
        assert(detail.data.schedule.every((s) => s.amount_due === 3000), 'instalments not re-priced');
        const bad = await call(cookies.analyst, 'PATCH', `/api/commitments/${id}`, { amount: -5 });
        assert(bad.status === 400 && /greater than zero/.test(bad.data.error), JSON.stringify(bad));
        const denied = await call(cookies.analyst, 'DELETE', `/api/commitments/${id}`);
        assert(denied.status === 403, `analyst delete ${denied.status}`);
      } finally {
        const del = await call(cookies.admin, 'DELETE', `/api/commitments/${id}`);
        assert(del.status === 200, `admin delete ${del.status}`);
      }
      return 'create 200 (3 instalments) -> patch 200 (re-priced) -> invalid amount 400 -> analyst delete 403 -> admin delete 200';
    });
    await test('H05', 'HTTP API', 'Note CRUD through the API (MongoDB) with validation', async () => {
      const bad = await call(cookies.analyst, 'POST', '/api/notes', { commitmentId: 1, title: 'API note', body: 'x', tags: 'not valid!' });
      assert(bad.status === 400, `bad tag ${bad.status}`);
      const viewer = await call(cookies.viewer, 'POST', '/api/notes', { commitmentId: 1, title: 'API note', body: 'x', tags: '' });
      assert(viewer.status === 403, `viewer ${viewer.status}`);
      const made = await call(cookies.analyst, 'POST', '/api/notes', { commitmentId: 1, title: 'API test note', body: 'Created by the test suite', tags: 'api-test, temporary', terms: [{ key: 'graceDays', value: '5' }] });
      assert(made.status === 200 && made.data.terms.graceDays === 5, JSON.stringify(made));
      const id = made.data._id;
      const upd = await call(cookies.analyst, 'PATCH', `/api/notes/${id}`, { pinned: true, tags: 'api-test' });
      assert(upd.status === 200 && upd.data.pinned && upd.data.tags.length === 1, JSON.stringify(upd));
      const found = await call(cookies.viewer, 'GET', '/api/notes?tag=api-test');
      assert(found.data.some((n) => n._id === id), 'not found by tag');
      const del = await call(cookies.analyst, 'DELETE', `/api/notes/${id}`);
      assert(del.status === 200, `delete ${del.status}`);
      return 'bad tag 400; viewer 403; create -> update -> find by tag -> delete';
    });
    await test('H06', 'HTTP API', 'Admin-only endpoints refuse the analyst', async () => {
      const u = await call(cookies.analyst, 'GET', '/api/users');
      const c = await call(cookies.analyst, 'POST', '/api/users', { full_name: 'X', email: 'x@fcis.local', password: 'password1', role: 'admin' });
      const ok = await call(cookies.admin, 'GET', '/api/users');
      assert(u.status === 403 && c.status === 403 && ok.status === 200 && !('password_hash' in ok.data[0]), `${u.status}/${c.status}/${ok.status}`);
      return 'analyst 403 on list and create; admin 200, no password hash in the response';
    });
  }

  // ================================================================== report
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;

  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n${area}`); }
    const mark = r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${r.id}  ${r.name}${r.pass === false ? `\n          ${r.detail}` : ''}`);
  }
  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} (${results.length} total)\n`);

  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    '# FCIS test results',
    '',
    `Run on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC with \`npm test\`.`,
    '',
    `**${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}** out of ${results.length} test cases.`,
    '',
    'Database tests run inside transactions that are rolled back, so the demo data is unchanged.',
    '',
  ];
  area = '';
  for (const r of results) {
    if (r.area !== area) {
      area = r.area;
      md.push('', `## ${area}`, '', '| ID | Test case | Result | Observed |', '|---|---|---|---|');
    }
    md.push(`| ${r.id} | ${esc(r.name)} | ${r.pass === null ? 'SKIP' : r.pass ? 'PASS' : '**FAIL**'} | ${esc(r.detail)} |`);
  }
  await fs.writeFile(path.join(root, 'docs', 'test-results.md'), `${md.join('\n')}\n`);
  return failed;
}

main()
  .then(async (failed) => { await app.end(); await owner.end(); await mongo.close(); process.exit(failed ? 1 : 0); })
  .catch(async (err) => { console.error(err); await mongo.close().catch(() => {}); process.exit(2); });
