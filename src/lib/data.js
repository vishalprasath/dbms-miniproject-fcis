// Read queries used by pages and GET route handlers.
// Every function takes a pg client that is already inside withSession(),
// i.e. running under the signed-in user's PostgreSQL role.

const rows = async (c, text, params = []) => (await c.query(text, params)).rows;
const one = async (c, text, params = []) => (await c.query(text, params)).rows[0] ?? null;
// node-postgres runs one query at a time per client, so run them in order
const series = async (thunks) => { const out = []; for (const t of thunks) out.push(await t()); return out; };
const orNull = (v) => (v === undefined || v === null || v === '' ? null : v);

// ------------------------------------------------------------------ lookups
export async function lookups(c) {
  const [categories, counterparties, accounts] = await series([
    () => rows(c, `SELECT c.category_id, c.name, c.direction, p.name AS parent
               FROM categories c LEFT JOIN categories p ON p.category_id = c.parent_id
              ORDER BY c.direction DESC, p.name NULLS FIRST, c.name`),
    () => rows(c, 'SELECT counterparty_id, name, kind, reliability_score FROM counterparties ORDER BY name'),
    () => rows(c, `SELECT account_id, account_name, current_balance, is_active FROM bank_accounts ORDER BY account_id`),
  ]);
  return { categories, counterparties, accounts };
}

// ---------------------------------------------------------------- dashboard
export async function dashboard(c) {
  const [totals, health, alerts, upcoming, overdue] = await series([
    () => one(c, `
      SELECT (SELECT COALESCE(SUM(current_balance), 0) FROM bank_accounts WHERE is_active)                   AS liquidity,
             (SELECT COALESCE(SUM(outstanding), 0) FROM v_upcoming_dues
               WHERE direction = 'outflow' AND due_date <= CURRENT_DATE + 30)                                AS out_30d,
             (SELECT COALESCE(SUM(outstanding * reliability_score), 0) FROM v_upcoming_dues
               WHERE direction = 'inflow' AND due_date <= CURRENT_DATE + 30)                                 AS in_30d,
             (SELECT COUNT(*) FROM v_live_alerts)                                                            AS live_alerts,
             (SELECT MIN(shortfall_start) FROM v_live_alerts)                                                AS next_shortfall,
             (SELECT COUNT(*) FROM v_upcoming_dues WHERE status = 'overdue')                                 AS overdue_count,
             (SELECT COALESCE(SUM(outstanding), 0) FROM v_upcoming_dues WHERE status = 'overdue')            AS overdue_amount,
             (SELECT MAX(run_at) FROM forecast_runs)                                                         AS last_run`),
    () => rows(c, 'SELECT * FROM v_account_health ORDER BY account_id'),
    () => rows(c, `SELECT * FROM v_live_alerts
              ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
                       shortfall_start`),
    () => rows(c, `SELECT * FROM v_upcoming_dues
              WHERE due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
              ORDER BY due_date, priority LIMIT 14`),
    () => rows(c, `SELECT * FROM v_upcoming_dues WHERE status = 'overdue' ORDER BY due_date`),
  ]);
  return { totals, health, alerts, upcoming, overdue };
}

// -------------------------------------------------------------- commitments
export async function listCommitments(c, f = {}) {
  const q = orNull(f.q?.trim());
  return rows(c, `
    SELECT c.commitment_id, c.title, c.direction, c.amount, c.frequency, c.priority, c.is_flexible,
           c.status, c.start_date, c.end_date,
           cat.name AS category, cp.name AS counterparty, a.account_name,
           nx.next_due, nx.overdue_count, nx.outstanding
      FROM commitments c
      JOIN categories     cat ON cat.category_id    = c.category_id
      JOIN counterparties cp  ON cp.counterparty_id = c.counterparty_id
      JOIN bank_accounts  a   ON a.account_id       = c.account_id
      LEFT JOIN LATERAL (
            SELECT MIN(s.due_date) FILTER (WHERE s.status IN ('pending', 'partial', 'overdue'))  AS next_due,
                   COUNT(*)        FILTER (WHERE s.status = 'overdue')                           AS overdue_count,
                   COALESCE(SUM(s.amount_due - s.amount_paid)
                            FILTER (WHERE s.status IN ('pending', 'partial', 'overdue')
                                      AND s.due_date <= CURRENT_DATE + 30), 0)                  AS outstanding
              FROM commitment_schedule s
             WHERE s.commitment_id = c.commitment_id
           ) nx ON TRUE
     WHERE ($1::TEXT IS NULL
            OR c.search_doc @@ websearch_to_tsquery('english', $1)
            OR c.title ILIKE '%' || $1 || '%'
            OR cp.name ILIKE '%' || $1 || '%')
       AND ($2::TEXT IS NULL OR c.status = $2)
       AND ($3::TEXT IS NULL OR c.direction = $3)
       AND ($4::INT  IS NULL OR c.account_id = $4)
       AND ($5::INT  IS NULL OR c.category_id IN (
              WITH RECURSIVE sub AS (
                  SELECT category_id FROM categories WHERE category_id = $5
                  UNION ALL
                  SELECT ch.category_id FROM categories ch JOIN sub ON ch.parent_id = sub.category_id
              ) SELECT category_id FROM sub))
     ORDER BY CASE WHEN $1::TEXT IS NULL THEN 0
                   ELSE ts_rank(c.search_doc, websearch_to_tsquery('english', $1)) END DESC,
              CASE c.status WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
              nx.next_due NULLS LAST, c.title`,
  [q, orNull(f.status), orNull(f.direction), orNull(f.account) && Number(f.account), orNull(f.category) && Number(f.category)]);
}

export async function getCommitment(c, id) {
  const commitment = await one(c, `
    SELECT c.commitment_id, c.title, c.description, c.direction, c.amount, c.frequency, c.start_date, c.end_date,
           c.priority, c.is_flexible, c.status, c.created_at, c.category_id, c.counterparty_id, c.account_id,
           cat.name AS category, cp.name AS counterparty, cp.kind AS counterparty_kind, cp.reliability_score,
           a.account_name, a.current_balance, u.full_name AS created_by_name
      FROM commitments c
      JOIN categories     cat ON cat.category_id    = c.category_id
      JOIN counterparties cp  ON cp.counterparty_id = c.counterparty_id
      JOIN bank_accounts  a   ON a.account_id       = c.account_id
      LEFT JOIN v_user_directory u ON u.user_id = c.created_by
     WHERE c.commitment_id = $1`, [id]);
  if (!commitment) return null;

  const schedule = await rows(c, `
    SELECT s.schedule_id, s.due_date, s.original_due_date, s.amount_due, s.amount_paid,
           s.amount_due - s.amount_paid AS outstanding, s.status, s.paid_on,
           s.due_date - CURRENT_DATE AS days_until
      FROM commitment_schedule s
     WHERE s.commitment_id = $1
       AND s.due_date BETWEEN CURRENT_DATE - 120 AND CURRENT_DATE + 150
     ORDER BY s.due_date`, [id]);

  const totals = await one(c, `
    SELECT COUNT(*) FILTER (WHERE status = 'paid')                                  AS paid_count,
           COALESCE(SUM(amount_paid), 0)                                            AS paid_total,
           COUNT(*) FILTER (WHERE status IN ('pending', 'partial', 'overdue'))      AS open_count,
           ROUND(AVG(paid_on - original_due_date) FILTER (WHERE status = 'paid'), 1) AS avg_days_late
      FROM commitment_schedule WHERE commitment_id = $1`, [id]);

  return { commitment, schedule, totals };
}

// ----------------------------------------------------------------- accounts
export async function listTransactions(c, f = {}) {
  const q = orNull(f.q?.trim());
  return rows(c, `
    SELECT t.txn_id, t.txn_date, t.direction, t.amount, t.narration, t.txn_kind, t.schedule_id,
           a.account_name, u.full_name AS recorded_by_name, cs.commitment_id
      FROM transactions t
      JOIN bank_accounts a ON a.account_id = t.account_id
      LEFT JOIN v_user_directory u    ON u.user_id = t.recorded_by
      LEFT JOIN commitment_schedule cs ON cs.schedule_id = t.schedule_id
     WHERE ($1::INT  IS NULL OR t.account_id = $1)
       AND ($2::TEXT IS NULL OR t.direction = $2)
       AND ($3::TEXT IS NULL OR to_tsvector('english', t.narration) @@ websearch_to_tsquery('english', $3)
                             OR t.narration ILIKE '%' || $3 || '%')
       AND ($4::DATE IS NULL OR t.txn_date >= $4)
       AND ($5::DATE IS NULL OR t.txn_date <= $5)
     ORDER BY t.txn_date DESC, t.txn_id DESC
     LIMIT 60`,
  [orNull(f.account) && Number(f.account), orNull(f.direction), q, orNull(f.from), orNull(f.to)]);
}

export const accountHealth = (c) => rows(c, 'SELECT * FROM v_account_health ORDER BY account_id');

// ----------------------------------------------------------------- forecast
export async function forecastPage(c) {
  const [alerts, runs, past] = await series([
    () => rows(c, `SELECT * FROM v_live_alerts ORDER BY shortfall_start, account_id`),
    () => rows(c, `SELECT r.batch_id, MAX(r.run_at) AS run_at, MAX(r.horizon_days) AS horizon_days,
                    MAX(u.full_name) AS run_by_name, COUNT(*) AS accounts,
                    SUM(r.shortfall_days) AS shortfall_days, MIN(r.min_projected_balance) AS worst_balance
               FROM forecast_runs r LEFT JOIN v_user_directory u ON u.user_id = r.run_by
              GROUP BY r.batch_id ORDER BY r.batch_id DESC LIMIT 8`),
    () => rows(c, `SELECT al.alert_id, a.account_name, al.shortfall_start, al.deficit, al.severity, al.status, al.created_at
               FROM shortfall_alerts al JOIN bank_accounts a ON a.account_id = al.account_id
              WHERE al.status IN ('resolved', 'superseded')
              ORDER BY al.created_at DESC, al.alert_id DESC LIMIT 8`),
  ]);
  return { alerts, runs, past };
}

export const deferralSuggestions = (c, alertId) =>
  rows(c, 'SELECT * FROM fn_suggest_deferrals($1)', [alertId]);

export async function simulateDeferral(c, { accountId, horizon, scheduleId, toDate }) {
  return one(c, `
    SELECT MIN(projected_balance)                          AS min_balance,
           COUNT(*) FILTER (WHERE is_shortfall)            AS shortfall_days,
           MIN(day) FILTER (WHERE is_shortfall)            AS first_shortfall
      FROM fn_project_cashflow($1, $2, $3, $4)`, [accountId, horizon, scheduleId, toDate]);
}

// -------------------------------------------------------------------- admin
export async function adminPage(c) {
  const [users, audit, matrix] = await series([
    () => rows(c, 'SELECT * FROM v_user_directory ORDER BY user_id'),
    () => rows(c, `SELECT a.audit_id, a.table_name, a.action, a.row_pk, a.changed_at, u.full_name AS changed_by_name,
                    (SELECT string_agg(k, ', ' ORDER BY k)
                       FROM jsonb_object_keys(COALESCE(a.new_data, '{}'::jsonb)) k
                      WHERE a.action = 'UPDATE' AND a.new_data -> k IS DISTINCT FROM a.old_data -> k) AS changed_fields,
                    COALESCE(a.new_data, a.old_data) ->> 'title' AS title
               FROM audit_log a LEFT JOIN v_user_directory u ON u.user_id = a.changed_by
              ORDER BY a.audit_id DESC LIMIT 40`),
    () => rows(c, `
      SELECT t.table_name,
             r.role_name,
             concat_ws(' ',
               CASE WHEN has_table_privilege(r.role_name, 'fcis.' || t.table_name, 'SELECT')
                      OR has_any_column_privilege(r.role_name, 'fcis.' || t.table_name, 'SELECT') THEN 'S' END,
               CASE WHEN has_table_privilege(r.role_name, 'fcis.' || t.table_name, 'INSERT') THEN 'I' END,
               CASE WHEN has_table_privilege(r.role_name, 'fcis.' || t.table_name, 'UPDATE') THEN 'U'
                    WHEN has_any_column_privilege(r.role_name, 'fcis.' || t.table_name, 'UPDATE') THEN 'u' END,
               CASE WHEN has_table_privilege(r.role_name, 'fcis.' || t.table_name, 'DELETE') THEN 'D' END) AS privileges
        FROM information_schema.tables t
       CROSS JOIN (VALUES ('fcis_viewer'), ('fcis_analyst'), ('fcis_admin')) AS r (role_name)
       WHERE t.table_schema = 'fcis' AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name, r.role_name`),
  ]);
  return { users, audit, matrix };
}
