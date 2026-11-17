// PostgreSQL access layer.
//
// The pool logs in as fcis_app, a NOINHERIT role with no table rights of
// its own. Every request runs inside one transaction that first does
//     SET LOCAL ROLE fcis_viewer | fcis_analyst | fcis_admin
// so the database, not the JavaScript, decides what the user may do.
import pg from 'pg';

// NUMERIC -> number, BIGINT -> number, DATE -> 'YYYY-MM-DD' (no timezone shifts)
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1082, (v) => v);

const DB_ROLE = { admin: 'fcis_admin', analyst: 'fcis_analyst', viewer: 'fcis_viewer' };

function makePool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    options: '-c search_path=fcis,public',
  });
}

export function getPool() {
  if (!globalThis.__fcisPool) globalThis.__fcisPool = makePool();
  return globalThis.__fcisPool;
}

/**
 * Run `fn(client)` in a transaction under the PostgreSQL role that matches
 * the signed-in user. Commits on success, rolls back on any error.
 */
export async function withSession(session, fn) {
  const dbRole = DB_ROLE[session?.role];
  if (!dbRole) throw Object.assign(new Error('Not signed in'), { status: 401 });

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${dbRole}`);
    await client.query("SELECT set_config('app.user_id', $1, TRUE)", [String(session.userId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience: one read-only query under the user's role. */
export async function queryAs(session, text, params = []) {
  return withSession(session, async (c) => (await c.query(text, params)).rows);
}

/** Login is the only call made before a role is known. */
export async function verifyLogin(email, password) {
  const { rows } = await getPool().query('SELECT * FROM fcis.fn_verify_login($1, $2)', [email, password]);
  return rows[0] ?? null;
}

const CONSTRAINT_MESSAGES = {
  uq_users_email: 'A user with this e-mail already exists.',
  ck_users_email: 'That does not look like a valid e-mail address.',
  ck_users_name: 'Name must be at least 2 characters.',
  ck_users_role: 'Role must be admin, analyst or viewer.',
  uq_bank_accounts_name: 'An account with this name already exists.',
  ck_account_last4: 'Account number suffix must be exactly 4 digits.',
  ck_account_buffer: 'Minimum buffer cannot be negative.',
  ck_account_od_limit: 'Overdraft limit cannot be negative.',
  ck_account_od_type: 'Only an overdraft account can have an overdraft limit.',
  ck_account_balance_floor: 'This would take the account below its permitted balance.',
  uq_commitments_title: 'A commitment with this title already exists.',
  ck_commitments_title: 'Title must be at least 3 characters.',
  ck_commitments_amount: 'Amount must be greater than zero.',
  ck_commitments_dates: 'End date cannot be before the start date.',
  ck_commitments_priority: 'Priority must be between 1 and 5.',
  ck_commitments_frequency: 'Unknown frequency.',
  ck_commitments_status: 'Unknown status.',
  fk_commitments_category: 'That category does not exist or is still used by commitments.',
  fk_commitments_cparty: 'That counterparty does not exist or is still used by commitments.',
  fk_commitments_account: 'That account does not exist or still has commitments.',
  fk_transactions_schedule: 'This commitment has payment history and cannot be deleted. Close it instead.',
  fk_transactions_account: 'This account has ledger entries and cannot be deleted.',
  uq_counterparties_name: 'A counterparty with this name already exists.',
  ck_counterparty_reliability: 'Reliability must be between 0 and 1.',
  ck_counterparty_email: 'That does not look like a valid e-mail address.',
  ck_counterparty_phone: 'Phone must be 10 to 14 digits, with an optional leading +.',
  ck_transactions_amount: 'Amount must be greater than zero.',
  ck_transactions_narr: 'Narration must be at least 3 characters.',
  ck_transactions_dir: 'Direction must be credit or debit.',
  ck_schedule_defer_forward: 'An instalment cannot be moved before its original due date.',
};

/** Turn a PostgreSQL error into { status, message } for the API. */
export function describeDbError(err) {
  if (err?.status) return { status: err.status, message: err.message };
  const code = err?.code;
  if (!code || typeof code !== 'string') return null;
  if (code === 'P0001') return { status: 400, message: err.message };
  if (code === '42501') {
    return { status: 403, message: 'Your database role does not have permission for this action.' };
  }
  if (code.startsWith('23')) {
    const friendly = CONSTRAINT_MESSAGES[err.constraint];
    const status = code === '23505' || code === '23503' ? 409 : 400;
    return { status, message: friendly ?? `Rejected by the database (${err.constraint ?? code}).` };
  }
  if (code.startsWith('22')) return { status: 400, message: 'One of the values has an invalid format.' };
  return null;
}
