-- =====================================================================
-- FCIS  07_queries.sql
-- Reference queries for the demonstration and the report.
-- Run with:  psql -d fcis -f db/sql/07_queries.sql
-- Section A changes data, so it is wrapped in BEGIN ... ROLLBACK and
-- leaves the database exactly as it found it.
-- =====================================================================
SET search_path = fcis, public;

-- =====================================================================
-- A. DML : INSERT, UPDATE, DELETE, SELECT
-- =====================================================================
BEGIN;
SELECT set_config('app.user_id', (SELECT user_id::TEXT FROM users WHERE email = 'analyst@fcis.local'), TRUE);

-- A1. INSERT one row
INSERT INTO counterparties (name, kind, contact_email, phone, reliability_score)
VALUES ('Coimbatore Ink Suppliers', 'vendor', 'orders@cbeink.example', '+914220009001', 1.00);

-- A2. INSERT several rows in one statement
INSERT INTO categories (name, parent_id, direction)
VALUES ('Consumables', (SELECT category_id FROM categories WHERE name = 'Procurement'), 'outflow'),
       ('Scrap Sales', (SELECT category_id FROM categories WHERE name = 'Other Income'), 'inflow');

-- A3. INSERT ... SELECT with joins. The AFTER INSERT trigger then
--     generates the instalments (shown by the SELECT that follows).
INSERT INTO commitments (title, description, category_id, counterparty_id, account_id, direction,
                         amount, frequency, start_date, end_date, priority, is_flexible, created_by)
SELECT 'Ink and chemicals supply', 'Monthly standing order for process inks.',
       cat.category_id, cp.counterparty_id, a.account_id, cat.direction,
       58000, 'monthly', CURRENT_DATE + 10, CURRENT_DATE + 200, 3, TRUE, fn_app_user()
  FROM categories cat, counterparties cp, bank_accounts a
 WHERE cat.name = 'Consumables'
   AND cp.name  = 'Coimbatore Ink Suppliers'
   AND a.account_name = 'Operating Account';

SELECT s.schedule_id, s.due_date, s.amount_due, s.status
  FROM commitment_schedule s
  JOIN commitments c ON c.commitment_id = s.commitment_id
 WHERE c.title = 'Ink and chemicals supply'
 ORDER BY s.due_date;

-- A4. UPDATE one row (trigger re-prices the unpaid instalments)
UPDATE commitments
   SET amount = 61000, priority = 2
 WHERE title = 'Ink and chemicals supply';

-- A5. UPDATE with a subquery: lower the reliability of every customer
--     whose receipts arrive more than 15 days late on average
UPDATE counterparties cp
   SET reliability_score = GREATEST(reliability_score - 0.05, 0)
 WHERE cp.kind = 'customer'
   AND cp.counterparty_id IN (
        SELECT c.counterparty_id
          FROM commitments c
          JOIN commitment_schedule s ON s.commitment_id = c.commitment_id
         WHERE s.status = 'paid'
         GROUP BY c.counterparty_id
        HAVING AVG(s.paid_on - s.original_due_date) > 15)
RETURNING cp.name, cp.reliability_score;

-- A6. Procedure call inside the transaction: record a payment
--     (CALL arguments cannot be subqueries, so the id is looked up first)
DO $$
DECLARE
    v_schedule BIGINT;
BEGIN
    SELECT s.schedule_id INTO v_schedule
      FROM commitment_schedule s JOIN commitments c ON c.commitment_id = s.commitment_id
     WHERE c.title = 'Design software licences' AND s.status = 'pending'
     ORDER BY s.due_date LIMIT 1;
    CALL sp_record_payment(v_schedule, 36000);
END $$;

SELECT t.txn_date, t.direction, t.amount, t.narration, a.current_balance AS balance_after
  FROM transactions t JOIN bank_accounts a ON a.account_id = t.account_id
 ORDER BY t.txn_id DESC LIMIT 1;

-- A7. DELETE with a subquery: remove superseded alerts of old forecast runs
DELETE FROM shortfall_alerts
 WHERE status = 'superseded'
   AND run_id IN (SELECT run_id FROM forecast_runs WHERE run_at < now() - INTERVAL '90 days');

-- A8. DELETE one row (instalments go with it: ON DELETE CASCADE)
DELETE FROM commitments WHERE title = 'Ink and chemicals supply';

ROLLBACK;

-- A9. A transaction that fails half-way leaves no trace
BEGIN;
SELECT account_name, current_balance FROM bank_accounts ORDER BY account_id;
SAVEPOINT before_transfer;
DO $$
BEGIN
    CALL sp_transfer_funds(2, 1, 99999999, 'More than the account holds');
EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'Transfer refused: %', SQLERRM;
END $$;
ROLLBACK TO SAVEPOINT before_transfer;
SELECT account_name, current_balance FROM bank_accounts ORDER BY account_id;   -- unchanged
ROLLBACK;

-- =====================================================================
-- B. JOIN queries
-- =====================================================================

-- B1. Five-table INNER JOIN: everything due in the next 14 days
SELECT s.due_date, c.title, cat.name AS category, cp.name AS counterparty, a.account_name,
       c.direction, s.amount_due - s.amount_paid AS outstanding
  FROM commitment_schedule s
  JOIN commitments    c   ON c.commitment_id    = s.commitment_id
  JOIN categories     cat ON cat.category_id    = c.category_id
  JOIN counterparties cp  ON cp.counterparty_id = c.counterparty_id
  JOIN bank_accounts  a   ON a.account_id       = c.account_id
 WHERE c.status = 'active'
   AND s.status IN ('pending', 'partial', 'overdue')
   AND s.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
 ORDER BY s.due_date, c.priority;

-- B2. LEFT JOIN + COALESCE: every counterparty, including those with no commitments
SELECT cp.name, cp.kind, COUNT(c.commitment_id) AS commitments, COALESCE(SUM(c.amount), 0) AS total_per_cycle
  FROM counterparties cp
  LEFT JOIN commitments c ON c.counterparty_id = cp.counterparty_id AND c.status = 'active'
 GROUP BY cp.counterparty_id, cp.name, cp.kind
 ORDER BY total_per_cycle DESC;

-- B3. Self join: each category with its parent
SELECT child.name AS category, parent.name AS parent_category, child.direction
  FROM categories child
  LEFT JOIN categories parent ON parent.category_id = child.parent_id
 ORDER BY parent.name NULLS FIRST, child.name;

-- B4. LATERAL join: the next unpaid instalment of every active commitment
SELECT c.title, nx.due_date AS next_due, nx.outstanding
  FROM commitments c
  CROSS JOIN LATERAL (
        SELECT s.due_date, s.amount_due - s.amount_paid AS outstanding
          FROM commitment_schedule s
         WHERE s.commitment_id = c.commitment_id
           AND s.status IN ('pending', 'partial', 'overdue')
         ORDER BY s.due_date
         LIMIT 1) nx
 WHERE c.status = 'active'
 ORDER BY nx.due_date;

-- =====================================================================
-- C. Aggregates, GROUP BY, HAVING, ORDER BY
-- =====================================================================

-- C1. Cash in and out by month with a running net (window over an aggregate)
SELECT to_char(month, 'Mon YYYY') AS month,
       SUM(total_in) AS cash_in, SUM(total_out) AS cash_out, SUM(net_flow) AS net,
       SUM(SUM(net_flow)) OVER (ORDER BY month) AS running_net
  FROM v_monthly_cashflow
 GROUP BY month
 ORDER BY v_monthly_cashflow.month;

-- C2. Accounts whose commitments for the next 30 days exceed 5 lakh
SELECT a.account_name, COUNT(*) AS instalments, SUM(s.amount_due - s.amount_paid) AS due_30d,
       MIN(s.due_date) AS first_due, MAX(s.amount_due) AS largest
  FROM commitment_schedule s
  JOIN commitments c   ON c.commitment_id = s.commitment_id
  JOIN bank_accounts a ON a.account_id = c.account_id
 WHERE c.direction = 'outflow' AND c.status = 'active'
   AND s.status IN ('pending', 'partial', 'overdue')
   AND s.due_date <= CURRENT_DATE + 30
 GROUP BY a.account_id, a.account_name
HAVING SUM(s.amount_due - s.amount_paid) > 500000
 ORDER BY due_30d DESC;

-- =====================================================================
-- D. Nested and correlated subqueries
-- =====================================================================

-- D1. Nested (non-correlated) subquery in HAVING:
--     customers who pay later than the average customer
SELECT cp.name, ROUND(AVG(s.paid_on - s.original_due_date), 1) AS avg_days_late, COUNT(*) AS receipts
  FROM counterparties cp
  JOIN commitments c         ON c.counterparty_id = cp.counterparty_id
  JOIN commitment_schedule s ON s.commitment_id   = c.commitment_id
 WHERE c.direction = 'inflow' AND s.status = 'paid'
 GROUP BY cp.counterparty_id, cp.name
HAVING AVG(s.paid_on - s.original_due_date) >
       (SELECT AVG(s2.paid_on - s2.original_due_date)
          FROM commitment_schedule s2
          JOIN commitments c2 ON c2.commitment_id = s2.commitment_id
         WHERE c2.direction = 'inflow' AND s2.status = 'paid')
 ORDER BY avg_days_late DESC;

-- D2. Correlated subquery: outflows costlier than the average of their own parent category
SELECT c.title, cat.name AS category, c.amount
  FROM commitments c
  JOIN categories cat ON cat.category_id = c.category_id
 WHERE c.direction = 'outflow' AND c.status = 'active'
   AND c.amount > (SELECT AVG(c2.amount)
                     FROM commitments c2
                     JOIN categories cat2 ON cat2.category_id = c2.category_id
                    WHERE cat2.parent_id IS NOT DISTINCT FROM cat.parent_id
                      AND c2.status = 'active')
 ORDER BY c.amount DESC;

-- D3. EXISTS / NOT EXISTS: critical payables that have never been late
SELECT c.title, c.amount
  FROM commitments c
 WHERE c.direction = 'outflow' AND c.status = 'active' AND c.priority = 1
   AND EXISTS     (SELECT 1 FROM commitment_schedule s WHERE s.commitment_id = c.commitment_id AND s.status = 'paid')
   AND NOT EXISTS (SELECT 1 FROM commitment_schedule s
                    WHERE s.commitment_id = c.commitment_id
                      AND (s.status IN ('overdue', 'partial') OR s.paid_on > s.original_due_date));

-- D4. Subquery with ALL: the single largest instalment due on each account
SELECT a.account_name, c.title, s.due_date, s.amount_due
  FROM commitment_schedule s
  JOIN commitments c   ON c.commitment_id = s.commitment_id
  JOIN bank_accounts a ON a.account_id = c.account_id
 WHERE c.direction = 'outflow' AND s.status = 'pending' AND s.due_date <= CURRENT_DATE + 60
   AND s.amount_due >= ALL (SELECT s2.amount_due
                              FROM commitment_schedule s2
                              JOIN commitments c2 ON c2.commitment_id = s2.commitment_id
                             WHERE c2.account_id = c.account_id AND c2.direction = 'outflow'
                               AND s2.status = 'pending' AND s2.due_date <= CURRENT_DATE + 60)
 ORDER BY a.account_name, s.due_date;

-- =====================================================================
-- E. Common table expressions, recursive queries, window functions
-- =====================================================================

-- E1. Recursive CTE: walk the category tree and roll monthly cost up to every ancestor
WITH RECURSIVE tree AS (
    SELECT category_id, name, parent_id, name::TEXT AS path, 0 AS depth
      FROM categories WHERE parent_id IS NULL
    UNION ALL
    SELECT c.category_id, c.name, c.parent_id, t.path || ' > ' || c.name, t.depth + 1
      FROM categories c JOIN tree t ON c.parent_id = t.category_id
),
monthly AS (
    SELECT category_id,
           SUM(amount * CASE frequency WHEN 'weekly' THEN 52.0 / 12 WHEN 'monthly' THEN 1
                                       WHEN 'quarterly' THEN 1.0 / 3 WHEN 'yearly' THEN 1.0 / 12 ELSE 0 END) AS per_month
      FROM commitments WHERE status = 'active'
     GROUP BY category_id
)
SELECT repeat('    ', a.depth) || a.name AS category,
       ROUND((SELECT COALESCE(SUM(m.per_month), 0)
                FROM tree d JOIN monthly m ON m.category_id = d.category_id
               WHERE d.path = a.path OR d.path LIKE a.path || ' > %')) AS monthly_equivalent
  FROM tree a
 ORDER BY a.path;

-- E2. Recursive CTE as a calendar + window running total (inside fn_project_cashflow)
SELECT day, expected_inflow, committed_outflow, projected_balance, is_shortfall
  FROM fn_project_cashflow((SELECT account_id FROM bank_accounts WHERE account_name = 'Operating Account'), 30)
 WHERE expected_inflow > 0 OR committed_outflow > 0;

-- E3. Gaps and islands: collapse consecutive shortfall days into episodes
WITH flagged AS (
    SELECT day, projected_balance,
           day - (ROW_NUMBER() OVER (ORDER BY day))::INT AS island
      FROM fn_project_cashflow((SELECT account_id FROM bank_accounts WHERE account_name = 'Operating Account'), 60)
     WHERE is_shortfall
)
SELECT MIN(day) AS shortfall_start, MAX(day) AS shortfall_end, COUNT(*) AS days, MIN(projected_balance) AS lowest_balance
  FROM flagged
 GROUP BY island
 ORDER BY shortfall_start;

-- E4. Window ranking in a CTE: the three largest outflows in each top-level category
WITH RECURSIVE roots AS (
    SELECT category_id, category_id AS root_id, name AS root_name FROM categories WHERE parent_id IS NULL
    UNION ALL
    SELECT c.category_id, r.root_id, r.root_name FROM categories c JOIN roots r ON c.parent_id = r.category_id
),
ranked AS (
    SELECT r.root_name, c.title, c.amount,
           RANK() OVER (PARTITION BY r.root_id ORDER BY c.amount DESC) AS rnk
      FROM commitments c JOIN roots r ON r.category_id = c.category_id
     WHERE c.direction = 'outflow' AND c.status = 'active'
)
SELECT root_name AS top_category, rnk, title, amount
  FROM ranked WHERE rnk <= 3
 ORDER BY root_name, rnk;

-- =====================================================================
-- F. Views, full-text search, index usage, function calls
-- =====================================================================

-- F1. Views
SELECT account_name, current_balance, threshold, outflow_30d, expected_inflow_30d, coverage_ratio, live_alerts
  FROM v_account_health;
SELECT account_name, severity, shortfall_start, shortfall_end, deficit FROM v_live_alerts ORDER BY shortfall_start;

-- F2. Full-text search with ranking (GIN index on a generated tsvector column)
SELECT title, ts_rank(search_doc, q) AS rank,
       ts_headline('english', coalesce(description, ''), q, 'MaxFragments=1, MinWords=5, MaxWords=12') AS matched
  FROM commitments, websearch_to_tsquery('english', 'lease OR press') AS q
 WHERE search_doc @@ q
 ORDER BY rank DESC;

-- F3. The partial index serves the forecast scan. The demo table is only a
--     few hundred rows, where the planner rightly prefers a sequential scan,
--     so sequential scans are switched off for this one statement to show
--     that the index matches the predicate.
BEGIN;
SET LOCAL enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT schedule_id FROM commitment_schedule
 WHERE status IN ('pending', 'partial', 'overdue') AND due_date <= CURRENT_DATE + 30;
ROLLBACK;

-- F4. Function call: which payments to defer for the earliest live alert
SELECT title, counterparty, due_date, outstanding, priority, suggested_date, cumulative_relief, covers_deficit
  FROM fn_suggest_deferrals((SELECT alert_id FROM v_live_alerts ORDER BY shortfall_start LIMIT 1));

-- F5. What the database grants to each role
SELECT grantee, table_name, string_agg(DISTINCT privilege_type, ', ' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE table_schema = 'fcis' AND grantee LIKE 'fcis\_%'
 GROUP BY grantee, table_name
 ORDER BY table_name, grantee;
