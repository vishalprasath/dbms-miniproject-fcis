-- =====================================================================
-- FCIS  06_seed.sql
-- Demo data for "Kaveri Print Works Pvt Ltd", a small printing business.
-- All dates are relative to CURRENT_DATE, so the demo always has six
-- months of history behind it and live commitments ahead of it.
-- =====================================================================
SET search_path = fcis, public;

-- ---------------------------------------------------------------------
-- Demo users (documented in README; change the passwords after setup)
-- ---------------------------------------------------------------------
CALL sp_create_user('Asha Menon',   'admin@fcis.local',   'Admin@123',   'admin');
CALL sp_create_user('Rohan Iyer',   'analyst@fcis.local', 'Analyst@123', 'analyst');
CALL sp_create_user('Meera Nair',   'viewer@fcis.local',  'Viewer@123',  'viewer');

-- every row below is attributed to the analyst
SELECT set_config('app.user_id', (SELECT user_id::TEXT FROM users WHERE email = 'analyst@fcis.local'), FALSE);

-- ---------------------------------------------------------------------
-- Bank accounts (balances start at zero and are built by the ledger)
-- ---------------------------------------------------------------------
INSERT INTO bank_accounts (account_name, bank_name, account_last4, account_type, min_buffer, overdraft_limit) VALUES
    ('Operating Account',  'HDFC Bank',           '4821', 'current',   300000,      0),
    ('Tax Reserve',        'State Bank of India', '1190', 'savings',    50000,      0),
    ('Working Capital OD', 'Axis Bank',           '3306', 'overdraft', 100000, 500000);

-- ---------------------------------------------------------------------
-- Category tree
-- ---------------------------------------------------------------------
INSERT INTO categories (name, parent_id, direction) VALUES
    ('Operating Expenses', NULL, 'outflow'),
    ('Financing',          NULL, 'outflow'),
    ('Statutory Dues',     NULL, 'outflow'),
    ('Revenue',            NULL, 'inflow'),
    ('Other Income',       NULL, 'inflow');

INSERT INTO categories (name, parent_id, direction)
SELECT v.name, p.category_id, p.direction
  FROM (VALUES
        ('Premises & Utilities',   'Operating Expenses'),
        ('Payroll',                'Operating Expenses'),
        ('Procurement',            'Operating Expenses'),
        ('Software Subscriptions', 'Operating Expenses'),
        ('Insurance',              'Operating Expenses'),
        ('Loan EMI',               'Financing'),
        ('Equipment Lease',        'Financing'),
        ('Overdraft Interest',     'Financing'),
        ('GST',                    'Statutory Dues'),
        ('TDS',                    'Statutory Dues'),
        ('Advance Tax',            'Statutory Dues'),
        ('Client Retainers',       'Revenue'),
        ('Project Milestones',     'Revenue'),
        ('Marketplace Payouts',    'Revenue'),
        ('Interest Income',        'Other Income')
       ) AS v (name, parent_name)
  JOIN categories p ON p.name = v.parent_name;

INSERT INTO categories (name, parent_id, direction)
SELECT v.name, p.category_id, p.direction
  FROM (VALUES
        ('Office Rent',          'Premises & Utilities'),
        ('Electricity',          'Premises & Utilities'),
        ('Internet & Telecom',   'Premises & Utilities'),
        ('Salaries',             'Payroll'),
        ('Provident Fund & ESI', 'Payroll'),
        ('Contractor Fees',      'Payroll'),
        ('Raw Materials',        'Procurement'),
        ('Logistics',            'Procurement'),
        ('Machine Maintenance',  'Procurement')
       ) AS v (name, parent_name)
  JOIN categories p ON p.name = v.parent_name;

-- ---------------------------------------------------------------------
-- Counterparties
-- ---------------------------------------------------------------------
INSERT INTO counterparties (name, kind, contact_email, phone, reliability_score) VALUES
    ('Prestige Estates',            'landlord',   'leasing@prestige.example',    '+918040001001', 1.00),
    ('HDFC Bank Term Loans',        'lender',     'sme.loans@hdfc.example',      '+918040001002', 1.00),
    ('BESCOM',                      'government', NULL,                          NULL,            1.00),
    ('ACT Fibernet',                'vendor',     'billing@act.example',         '+918040001004', 1.00),
    ('Adobe Systems India',         'vendor',     'accounts@adobe.example',      NULL,            1.00),
    ('Sri Balaji Paper Mills',      'vendor',     'sales@balajipaper.example',   '+914440001006', 1.00),
    ('BlueDart Express',            'vendor',     'corp@bluedart.example',       '+912240001007', 1.00),
    ('Heidelberg India Leasing',    'lender',     'lease@heidelberg.example',    '+914440001008', 1.00),
    ('Pixel Crew Freelancers',      'vendor',     'hello@pixelcrew.example',     '+919840001009', 1.00),
    ('Staff Payroll',               'employees',  NULL,                          NULL,            1.00),
    ('EPFO / ESIC',                 'government', NULL,                          NULL,            1.00),
    ('GST Department',              'government', NULL,                          NULL,            1.00),
    ('Income Tax Department',       'government', NULL,                          NULL,            1.00),
    ('New India Assurance',         'vendor',     'renewals@newindia.example',   '+912240001014', 1.00),
    ('Axis Bank Overdraft Desk',    'lender',     'od.desk@axis.example',        '+912240001015', 1.00),
    ('Lakshmi Textiles',            'customer',   'ap@lakshmitextiles.example',  '+914220001016', 0.95),
    ('Orbit Retail',                'customer',   'payables@orbitretail.example','+918040001017', 0.90),
    ('Zenith Infra Projects',       'customer',   'finance@zenithinfra.example', '+914040001018', 0.55),
    ('Amazon Seller Services',      'customer',   NULL,                          NULL,            0.98);

-- ---------------------------------------------------------------------
-- Commitments. trg_commitment_generate expands each one into instalments.
-- "dom" = day of month of the first instalment, six months ago.
-- INSERT ... SELECT with joins resolves names to surrogate keys.
-- ---------------------------------------------------------------------
INSERT INTO commitments (title, description, category_id, counterparty_id, account_id, direction,
                         amount, frequency, start_date, priority, is_flexible, created_by)
SELECT v.title, v.description, cat.category_id, cp.counterparty_id, a.account_id, cat.direction,
       v.amount, v.frequency,
       (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::DATE + (v.dom - 1),
       v.priority, v.is_flexible, fn_app_user()
  FROM (VALUES
    ('Office rent - Peenya unit',        'Monthly rent for the 6,000 sq ft press floor and office. Lease has a 5% yearly escalation and a 3-day grace period.',
        'Office Rent',          'Prestige Estates',         'Operating Account',  185000, 'monthly',  5, 1, FALSE),
    ('Term loan EMI - Heidelberg press', 'EMI on the term loan taken to buy the Speedmaster offset press. Auto-debited; a bounce attracts penal interest.',
        'Loan EMI',             'HDFC Bank Term Loans',     'Operating Account',  240000, 'monthly', 10, 1, FALSE),
    ('Electricity - BESCOM HT connection','High-tension industrial power bill. Disconnection notice after 15 days of delay.',
        'Electricity',          'BESCOM',                   'Operating Account',   42000, 'monthly', 18, 2, FALSE),
    ('Internet leased line',             'Dedicated 200 Mbps leased line for prepress file transfers.',
        'Internet & Telecom',   'ACT Fibernet',             'Operating Account',    8500, 'monthly', 12, 3, TRUE),
    ('Design software licences',         'Creative Cloud team licences for the prepress and design desk.',
        'Software Subscriptions','Adobe Systems India',     'Operating Account',   36000, 'monthly', 20, 4, TRUE),
    ('Paper and board supply',           'Standing monthly order of coated paper and duplex board. Supplier allows up to 30 days credit on request.',
        'Raw Materials',        'Sri Balaji Paper Mills',   'Operating Account',  320000, 'monthly', 22, 2, TRUE),
    ('Logistics - courier contract',     'Outbound delivery of finished print jobs to client warehouses.',
        'Logistics',            'BlueDart Express',         'Operating Account',   65000, 'monthly', 25, 3, TRUE),
    ('Equipment lease - binding line',   'Operating lease for the perfect-binding and lamination line.',
        'Equipment Lease',      'Heidelberg India Leasing', 'Operating Account',   95000, 'monthly', 15, 1, FALSE),
    ('Freelance design retainer',        'Retainer for outsourced packaging design work.',
        'Contractor Fees',      'Pixel Crew Freelancers',   'Operating Account',  120000, 'monthly', 27, 3, TRUE),
    ('Staff salaries',                   'Net salaries for 38 employees, credited on the 28th of every month.',
        'Salaries',             'Staff Payroll',            'Operating Account',  950000, 'monthly', 28, 1, FALSE),
    ('Provident fund and ESI',           'Employer and employee PF / ESI contribution. Statutory due date is the 15th.',
        'Provident Fund & ESI', 'EPFO / ESIC',              'Operating Account',  114000, 'monthly', 15, 1, FALSE),
    ('Retainer - Lakshmi Textiles',      'Monthly packaging and label printing retainer.',
        'Client Retainers',     'Lakshmi Textiles',         'Operating Account',  650000, 'monthly',  7, 2, FALSE),
    ('Retainer - Orbit Retail',          'Monthly retainer for in-store promotional print.',
        'Client Retainers',     'Orbit Retail',             'Operating Account',  480000, 'monthly', 12, 2, FALSE),
    ('Marketplace settlement',           'Weekly payout for stationery sold through the online storefront.',
        'Marketplace Payouts',  'Amazon Seller Services',   'Operating Account',  210000, 'weekly',   3, 3, FALSE),
    ('GST payment (GSTR-3B)',            'Monthly GST liability, due on the 20th.',
        'GST',                  'GST Department',           'Tax Reserve',        145000, 'monthly', 20, 1, FALSE),
    ('TDS deposit',                      'Tax deducted at source on rent, contractors and salaries, due on the 7th.',
        'TDS',                  'Income Tax Department',    'Tax Reserve',         38000, 'monthly',  7, 1, FALSE),
    ('Overdraft interest',               'Monthly interest on the utilised overdraft limit.',
        'Overdraft Interest',   'Axis Bank Overdraft Desk', 'Working Capital OD',   9500, 'monthly',  3, 2, FALSE),
    ('Press upgrade instalment',         'Instalments for the UV coating unit upgrade, payable to the supplier over 18 months.',
        'Machine Maintenance',  'Heidelberg India Leasing', 'Working Capital OD', 110000, 'monthly', 26, 3, TRUE)
  ) AS v (title, description, category, counterparty, account, amount, frequency, dom, priority, is_flexible)
  JOIN categories     cat ON cat.name = v.category
  JOIN counterparties cp  ON cp.name  = v.counterparty
  JOIN bank_accounts  a   ON a.account_name = v.account;

-- Commitments with their own calendar
INSERT INTO commitments (title, description, category_id, counterparty_id, account_id, direction,
                         amount, frequency, start_date, priority, is_flexible, created_by)
SELECT v.title, v.description, cat.category_id, cp.counterparty_id, a.account_id, cat.direction,
       v.amount, v.frequency, v.start_date, v.priority, v.is_flexible, fn_app_user()
  FROM (VALUES
    ('Advance tax instalment',           'Quarterly advance income tax (15 Jun, 15 Sep, 15 Dec, 15 Mar).',
        'Advance Tax',        'Income Tax Department', 'Tax Reserve',        310000::NUMERIC, 'quarterly',
        ((SELECT MIN(make_date(y, m, 15))
            FROM generate_series(EXTRACT(YEAR FROM CURRENT_DATE)::INT, EXTRACT(YEAR FROM CURRENT_DATE)::INT + 1) AS y,
                 unnest(ARRAY[3, 6, 9, 12]) AS m
           WHERE make_date(y, m, 15) >= CURRENT_DATE + 7) - INTERVAL '9 months')::DATE,
        1, FALSE),
    ('Annual maintenance contract - press', 'Quarterly AMC for the offset press, includes two preventive visits.',
        'Machine Maintenance','Heidelberg India Leasing', 'Working Capital OD', 85000, 'quarterly',
        (CURRENT_DATE - INTERVAL '5 months')::DATE + 9, 2, TRUE),
    ('Fire and machinery insurance',     'Yearly premium for the fire, burglary and machinery breakdown policy.',
        'Insurance',          'New India Assurance',   'Operating Account',  210000, 'yearly',
        CURRENT_DATE + 20, 2, TRUE),
    ('Zenith - catalogue project phase 1', 'First milestone invoice for the 40,000-copy product catalogue.',
        'Project Milestones', 'Zenith Infra Projects', 'Operating Account',  700000, 'once',
        CURRENT_DATE - 75, 2, FALSE),
    ('Zenith - catalogue project phase 2', 'Second milestone invoice, payable on delivery sign-off. Zenith has paid late before.',
        'Project Milestones', 'Zenith Infra Projects', 'Operating Account',  900000, 'once',
        CURRENT_DATE + 12, 2, FALSE),
    ('Lakshmi - festive packaging order', 'One-off festive season packaging order, 30-day credit.',
        'Project Milestones', 'Lakshmi Textiles',      'Operating Account',  400000, 'once',
        CURRENT_DATE + 35, 3, FALSE)
  ) AS v (title, description, category, counterparty, account, amount, frequency, start_date, priority, is_flexible)
  JOIN categories     cat ON cat.name = v.category
  JOIN counterparties cp  ON cp.name  = v.counterparty
  JOIN bank_accounts  a   ON a.account_name = v.account;

-- ---------------------------------------------------------------------
-- Opening balances, dated the day before the history starts
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_open DATE := (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::DATE - 1;
    r RECORD;
BEGIN
    FOR r IN
        SELECT a.account_id, v.opening
          FROM (VALUES ('Operating Account', 3200000), ('Tax Reserve', 2600000), ('Working Capital OD', 900000)) AS v (name, opening)
          JOIN bank_accounts a ON a.account_name = v.name
    LOOP
        CALL sp_post_transaction(r.account_id, 'credit', r.opening, 'Opening balance brought forward', v_open, 'opening');
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Replay six months of history through sp_record_payment, so that every
-- past instalment has a real ledger entry and balances are trigger-made.
--   * customers pay late in proportion to (1 - reliability)
--   * the latest logistics bill is left unpaid (overdue)
--   * the latest electricity bill is only half paid (partial)
-- ---------------------------------------------------------------------
DO $$
DECLARE
    r           RECORD;
    v_delay     INT;
    v_pay_date  DATE;
    v_amount    NUMERIC;
BEGIN
    FOR r IN
        SELECT s.schedule_id, s.due_date, s.amount_due, c.title, c.direction, cp.reliability_score,
               s.due_date = MAX(s.due_date) OVER (PARTITION BY s.commitment_id) AS is_latest
          FROM commitment_schedule s
          JOIN commitments    c  ON c.commitment_id    = s.commitment_id
          JOIN counterparties cp ON cp.counterparty_id = c.counterparty_id
         WHERE s.due_date < CURRENT_DATE
         ORDER BY s.due_date, s.schedule_id
    LOOP
        v_delay := CASE r.direction
                       WHEN 'inflow' THEN ROUND((1 - r.reliability_score) * 45)::INT + (r.schedule_id % 4)::INT
                       ELSE 0
                   END;
        v_pay_date := r.due_date + v_delay;

        CONTINUE WHEN v_pay_date > CURRENT_DATE;                       -- money not received yet
        CONTINUE WHEN r.is_latest AND r.title LIKE 'Logistics%';       -- left overdue on purpose

        v_amount := CASE WHEN r.is_latest AND r.title LIKE 'Electricity%'
                         THEN ROUND(r.amount_due / 2) ELSE r.amount_due END;

        CALL sp_record_payment(r.schedule_id, v_amount, v_pay_date, NULL);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Bring each account to its present-day balance with one explicit entry
-- (surplus swept to a fixed deposit, or drawn down, the day before today)
-- ---------------------------------------------------------------------
DO $$
DECLARE
    r       RECORD;
    v_diff  NUMERIC;
BEGIN
    FOR r IN
        SELECT a.account_id, a.current_balance, v.target
          FROM (VALUES ('Operating Account', 520000), ('Tax Reserve', 420000), ('Working Capital OD', -160000)) AS v (name, target)
          JOIN bank_accounts a ON a.account_name = v.name
    LOOP
        v_diff := r.target - r.current_balance;
        IF v_diff < 0 THEN
            INSERT INTO transactions (account_id, txn_date, direction, amount, narration, recorded_by, txn_kind)
            VALUES (r.account_id, CURRENT_DATE - 1, 'debit', -v_diff, 'Surplus swept to fixed deposit', fn_app_user(), 'transfer');
        ELSIF v_diff > 0 THEN
            INSERT INTO transactions (account_id, txn_date, direction, amount, narration, recorded_by, txn_kind)
            VALUES (r.account_id, CURRENT_DATE - 1, 'credit', v_diff, 'Fixed deposit proceeds credited', fn_app_user(), 'transfer');
        END IF;
    END LOOP;
END $$;

-- A few manual entries so the ledger is not only commitment payments
DO $$
DECLARE
    v_op  INT := (SELECT account_id FROM bank_accounts WHERE account_name = 'Operating Account');
    v_tax INT := (SELECT account_id FROM bank_accounts WHERE account_name = 'Tax Reserve');
BEGIN
    CALL sp_post_transaction(v_tax, 'credit',  4320, 'Savings account interest credited',        CURRENT_DATE - 14);
    CALL sp_post_transaction(v_op,  'debit',   1180, 'Bank charges - NEFT and cheque book',      CURRENT_DATE - 9);
    CALL sp_post_transaction(v_op,  'credit', 26500, 'Walk-in job work - cash deposited',        CURRENT_DATE - 6);
    CALL sp_post_transaction(v_op,  'debit',  25320, 'Diesel for generator - petty cash top-up', CURRENT_DATE - 3);
END $$;

-- ---------------------------------------------------------------------
-- First forecast: marks overdue items and raises the shortfall alerts
-- ---------------------------------------------------------------------
CALL sp_run_forecast(60);

ANALYZE;
