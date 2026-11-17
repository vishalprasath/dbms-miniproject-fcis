-- =====================================================================
-- FCIS  04_views.sql
-- =====================================================================
SET search_path = fcis, public;

-- Every unsettled instalment of an active commitment, ready for display
CREATE OR REPLACE VIEW v_upcoming_dues AS
SELECT s.schedule_id,
       s.commitment_id,
       c.title,
       c.direction,
       c.priority,
       c.is_flexible,
       cat.name                       AS category,
       cp.name                        AS counterparty,
       cp.reliability_score,
       a.account_id,
       a.account_name,
       s.due_date,
       s.original_due_date,
       s.amount_due,
       s.amount_paid,
       s.amount_due - s.amount_paid   AS outstanding,
       s.status,
       s.due_date - CURRENT_DATE      AS days_until
  FROM commitment_schedule s
  JOIN commitments    c   ON c.commitment_id    = s.commitment_id
  JOIN categories     cat ON cat.category_id    = c.category_id
  JOIN counterparties cp  ON cp.counterparty_id = c.counterparty_id
  JOIN bank_accounts  a   ON a.account_id       = c.account_id
 WHERE c.status = 'active'
   AND s.status IN ('pending', 'partial', 'overdue');

-- One line per account: can the next 30 days be covered?
CREATE OR REPLACE VIEW v_account_health AS
SELECT a.account_id,
       a.account_name,
       a.bank_name,
       a.account_last4,
       a.account_type,
       a.is_active,
       a.current_balance,
       a.min_buffer,
       a.overdraft_limit,
       a.min_buffer - a.overdraft_limit                 AS threshold,
       COALESCE(d.outflow_30d, 0)                       AS outflow_30d,
       COALESCE(d.expected_inflow_30d, 0)               AS expected_inflow_30d,
       ROUND((a.current_balance + a.overdraft_limit + COALESCE(d.expected_inflow_30d, 0))
             / NULLIF(d.outflow_30d, 0), 2)             AS coverage_ratio,
       COALESCE(al.live_alerts, 0)                      AS live_alerts,
       al.next_shortfall
  FROM bank_accounts a
  LEFT JOIN (
        SELECT u.account_id,
               SUM(u.outstanding) FILTER (WHERE u.direction = 'outflow')                      AS outflow_30d,
               SUM(u.outstanding * u.reliability_score) FILTER (WHERE u.direction = 'inflow') AS expected_inflow_30d
          FROM v_upcoming_dues u
         WHERE u.due_date <= CURRENT_DATE + 30
         GROUP BY u.account_id
       ) d  ON d.account_id = a.account_id
  LEFT JOIN (
        SELECT account_id, COUNT(*) AS live_alerts, MIN(shortfall_start) AS next_shortfall
          FROM shortfall_alerts
         WHERE status IN ('open', 'acknowledged')
         GROUP BY account_id
       ) al ON al.account_id = a.account_id;

-- Operating cash in and out per account per month (transfers excluded)
CREATE OR REPLACE VIEW v_monthly_cashflow AS
SELECT t.account_id,
       a.account_name,
       date_trunc('month', t.txn_date)::DATE                     AS month,
       SUM(t.amount) FILTER (WHERE t.direction = 'credit')       AS total_in,
       SUM(t.amount) FILTER (WHERE t.direction = 'debit')        AS total_out,
       SUM(CASE t.direction WHEN 'credit' THEN t.amount ELSE -t.amount END) AS net_flow,
       COUNT(*)                                                  AS txn_count
  FROM transactions t
  JOIN bank_accounts a ON a.account_id = t.account_id
 WHERE t.txn_kind IN ('commitment', 'manual')
 GROUP BY t.account_id, a.account_name, date_trunc('month', t.txn_date);

-- What each counterparty still owes / is owed, and how late they settle
CREATE OR REPLACE VIEW v_counterparty_exposure AS
SELECT cp.counterparty_id,
       cp.name,
       cp.kind,
       cp.reliability_score,
       COUNT(DISTINCT c.commitment_id) FILTER (WHERE c.status = 'active')          AS active_commitments,
       COALESCE(SUM(s.amount_due - s.amount_paid)
                FILTER (WHERE s.status IN ('pending', 'partial', 'overdue')
                          AND c.status = 'active'
                          AND s.due_date <= CURRENT_DATE + 90), 0)                 AS outstanding_90d,
       COUNT(*) FILTER (WHERE s.status = 'overdue' AND c.status = 'active')        AS overdue_instalments,
       ROUND(AVG(s.paid_on - s.original_due_date) FILTER (WHERE s.status = 'paid'), 1) AS avg_days_late
  FROM counterparties cp
  LEFT JOIN commitments c         ON c.counterparty_id = cp.counterparty_id
  LEFT JOIN commitment_schedule s ON s.commitment_id   = c.commitment_id
 GROUP BY cp.counterparty_id, cp.name, cp.kind, cp.reliability_score;

-- Users without the password hash: the only way non-owners read users
CREATE OR REPLACE VIEW v_user_directory AS
SELECT user_id, full_name, email, role, is_active, created_at
  FROM users;

-- Live alerts with the account they belong to
CREATE OR REPLACE VIEW v_live_alerts AS
SELECT al.alert_id, al.run_id, al.account_id, a.account_name,
       al.shortfall_start, al.shortfall_end,
       al.shortfall_end - al.shortfall_start + 1 AS shortfall_days,
       al.shortfall_start - CURRENT_DATE         AS days_until,
       al.min_projected_balance, al.deficit, al.severity, al.status,
       al.acknowledged_by, u.full_name           AS acknowledged_by_name,
       al.acknowledged_at, al.created_at
  FROM shortfall_alerts al
  JOIN bank_accounts a ON a.account_id = al.account_id
  LEFT JOIN users u    ON u.user_id = al.acknowledged_by
 WHERE al.status IN ('open', 'acknowledged');
