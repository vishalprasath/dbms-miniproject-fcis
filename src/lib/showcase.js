// The analytical SQL shown on the Insights page. Each entry is run as-is
// under the viewer's database role, and the page prints the SQL next to
// the result, so what you read is what was executed.

export const SQL_SHOWCASE = [
  {
    id: 'category-rollup',
    title: 'Monthly commitments rolled up the category tree',
    concept: 'Recursive CTE · self-referencing table',
    sql: `WITH RECURSIVE tree AS (
    SELECT category_id, name, parent_id, category_id AS root_id, name::TEXT AS path, 0 AS depth
      FROM categories
     WHERE parent_id IS NULL
    UNION ALL
    SELECT c.category_id, c.name, c.parent_id, t.root_id, t.path || ' > ' || c.name, t.depth + 1
      FROM categories c
      JOIN tree t ON c.parent_id = t.category_id
),
monthly AS (
    SELECT category_id,
           SUM(amount * CASE frequency WHEN 'weekly' THEN 52.0 / 12 WHEN 'monthly' THEN 1
                                       WHEN 'quarterly' THEN 1.0 / 3 WHEN 'yearly' THEN 1.0 / 12
                                       ELSE 0 END) AS per_month,
           COUNT(*) AS commitments
      FROM commitments
     WHERE status = 'active'
     GROUP BY category_id
)
SELECT repeat('    ', a.depth) || a.name            AS category,
       (SELECT COUNT(*) FROM tree d JOIN monthly m ON m.category_id = d.category_id
         WHERE d.path = a.path OR d.path LIKE a.path || ' > %') AS commitments,
       ROUND((SELECT COALESCE(SUM(m.per_month), 0)
                FROM tree d JOIN monthly m ON m.category_id = d.category_id
               WHERE d.path = a.path OR d.path LIKE a.path || ' > %')) AS monthly_equivalent
  FROM tree a
 ORDER BY a.path`,
  },
  {
    id: 'monthly-cashflow',
    title: 'Operating cash in and out by month, with a running net',
    concept: 'GROUP BY · aggregate FILTER · window function',
    sql: `SELECT to_char(month, 'Mon YYYY')                    AS month,
       SUM(total_in)                                 AS cash_in,
       SUM(total_out)                                AS cash_out,
       SUM(net_flow)                                 AS net,
       SUM(SUM(net_flow)) OVER (ORDER BY month)      AS running_net,
       SUM(txn_count)                                AS entries
  FROM v_monthly_cashflow
 GROUP BY month
 ORDER BY v_monthly_cashflow.month`,
  },
  {
    id: 'late-payers',
    title: 'Customers who pay later than the average customer',
    concept: 'JOIN · GROUP BY · HAVING · nested subquery',
    sql: `SELECT cp.name                                              AS customer,
       cp.reliability_score                                 AS reliability,
       COUNT(*)                                             AS receipts,
       ROUND(AVG(s.paid_on - s.original_due_date), 1)       AS avg_days_late,
       MAX(s.paid_on - s.original_due_date)                 AS worst_delay,
       SUM(s.amount_paid)                                   AS received
  FROM counterparties cp
  JOIN commitments c         ON c.counterparty_id = cp.counterparty_id
  JOIN commitment_schedule s ON s.commitment_id   = c.commitment_id
 WHERE c.direction = 'inflow'
   AND s.status = 'paid'
 GROUP BY cp.counterparty_id, cp.name, cp.reliability_score
HAVING AVG(s.paid_on - s.original_due_date) >
       (SELECT AVG(s2.paid_on - s2.original_due_date)
          FROM commitment_schedule s2
          JOIN commitments c2 ON c2.commitment_id = s2.commitment_id
         WHERE c2.direction = 'inflow' AND s2.status = 'paid')
 ORDER BY avg_days_late DESC`,
  },
  {
    id: 'above-category-average',
    title: 'Outflows that cost more than the average of their own parent category',
    concept: 'Correlated subquery',
    sql: `SELECT c.title,
       cat.name   AS category,
       c.amount,
       (SELECT ROUND(AVG(c2.amount))
          FROM commitments c2
          JOIN categories cat2 ON cat2.category_id = c2.category_id
         WHERE cat2.parent_id IS NOT DISTINCT FROM cat.parent_id
           AND c2.status = 'active')                 AS parent_category_average
  FROM commitments c
  JOIN categories cat ON cat.category_id = c.category_id
 WHERE c.direction = 'outflow'
   AND c.status = 'active'
   AND c.amount > (SELECT AVG(c2.amount)
                     FROM commitments c2
                     JOIN categories cat2 ON cat2.category_id = c2.category_id
                    WHERE cat2.parent_id IS NOT DISTINCT FROM cat.parent_id
                      AND c2.status = 'active')
 ORDER BY c.amount DESC`,
  },
  {
    id: 'exposure',
    title: 'Largest exposure by counterparty over the next 90 days',
    concept: 'View over LEFT JOINs · ORDER BY · LIMIT',
    sql: `SELECT name, kind, active_commitments, outstanding_90d, overdue_instalments, avg_days_late
  FROM v_counterparty_exposure
 WHERE outstanding_90d > 0
 ORDER BY outstanding_90d DESC
 LIMIT 8`,
  },
  {
    id: 'never-late',
    title: 'Active payables with an unbroken record, and those with something overdue',
    concept: 'EXISTS / NOT EXISTS · UNION ALL',
    sql: `SELECT 'Always on time' AS record, c.title, c.amount
  FROM commitments c
 WHERE c.direction = 'outflow' AND c.status = 'active'
   AND EXISTS     (SELECT 1 FROM commitment_schedule s WHERE s.commitment_id = c.commitment_id AND s.status = 'paid')
   AND NOT EXISTS (SELECT 1 FROM commitment_schedule s
                    WHERE s.commitment_id = c.commitment_id
                      AND (s.status IN ('overdue', 'partial') OR s.paid_on > s.original_due_date))
   AND c.priority = 1
UNION ALL
SELECT 'Has overdue or part-paid', c.title, c.amount
  FROM commitments c
 WHERE c.status = 'active'
   AND EXISTS (SELECT 1 FROM commitment_schedule s
                WHERE s.commitment_id = c.commitment_id AND s.status IN ('overdue', 'partial'))
 ORDER BY record, amount DESC`,
  },
  {
    id: 'pressure-days',
    title: 'The five heaviest payment days ahead on the operating account',
    concept: 'Table function · recursive calendar · window ranking in a CTE',
    sql: `WITH ranked AS (
    SELECT p.day, p.committed_outflow, p.expected_inflow, p.projected_balance, p.is_shortfall,
           DENSE_RANK() OVER (ORDER BY p.committed_outflow DESC) AS rnk
      FROM fn_project_cashflow(
               (SELECT account_id FROM bank_accounts WHERE account_name = 'Operating Account'), 60) p
)
SELECT to_char(day, 'DD Mon') AS day, committed_outflow, expected_inflow, projected_balance,
       CASE WHEN is_shortfall THEN 'below safe level' ELSE 'ok' END AS state
  FROM ranked
 WHERE rnk <= 5
 ORDER BY committed_outflow DESC`,
  },
];
