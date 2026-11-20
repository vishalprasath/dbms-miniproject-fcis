-- =====================================================================
-- FCIS  02_functions_procedures.sql
-- Stored functions and procedures (PL/pgSQL and SQL)
-- =====================================================================
SET search_path = fcis, public;

-- ---------------------------------------------------------------------
-- fn_app_user : id of the application user behind the current request.
-- The API sets it per transaction with set_config('app.user_id', ...).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_app_user() RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', TRUE), '')::INT
$$;

-- ---------------------------------------------------------------------
-- fn_nth_due_date : n-th occurrence of a recurrence, counted from the
-- start date (so 31 Jan + 1 month = 28 Feb, + 2 months = 31 Mar).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_nth_due_date(p_start DATE, p_frequency TEXT, p_n INT)
RETURNS DATE
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_frequency
        WHEN 'once'      THEN p_start
        WHEN 'weekly'    THEN p_start + 7 * p_n
        WHEN 'monthly'   THEN (p_start + make_interval(months => p_n))::DATE
        WHEN 'quarterly' THEN (p_start + make_interval(months => 3 * p_n))::DATE
        WHEN 'yearly'    THEN (p_start + make_interval(years  => p_n))::DATE
    END
$$;

-- ---------------------------------------------------------------------
-- fn_alert_severity : how urgent is a shortfall?
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_alert_severity(p_start DATE, p_min_balance NUMERIC, p_floor NUMERIC)
RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN p_min_balance < p_floor AND p_start - CURRENT_DATE <= 14 THEN 'critical'  -- account would bounce payments soon
        WHEN p_min_balance < p_floor OR  p_start - CURRENT_DATE <= 7  THEN 'high'
        WHEN p_start - CURRENT_DATE <= 30                             THEN 'medium'
        ELSE 'low'
    END
$$;

-- ---------------------------------------------------------------------
-- sp_generate_schedule : expand a commitment's recurrence rule into
-- instalment rows up to p_until. Safe to call repeatedly.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_generate_schedule(
    p_commitment_id INT,
    p_until         DATE DEFAULT (CURRENT_DATE + 365)
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    c       commitments%ROWTYPE;
    v_last  DATE;
    v_due   DATE;
    n       INT := 0;
BEGIN
    SELECT * INTO c FROM commitments WHERE commitment_id = p_commitment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Commitment % does not exist', p_commitment_id;
    END IF;

    v_last := LEAST(COALESCE(c.end_date, p_until), p_until);

    LOOP
        v_due := fn_nth_due_date(c.start_date, c.frequency, n);
        EXIT WHEN v_due > v_last;

        INSERT INTO commitment_schedule (commitment_id, due_date, original_due_date, amount_due)
        VALUES (c.commitment_id, v_due, v_due, c.amount)
        ON CONFLICT (commitment_id, original_due_date) DO NOTHING;

        EXIT WHEN c.frequency = 'once';
        n := n + 1;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- sp_mark_overdue : flag instalments whose due date has passed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_mark_overdue()
LANGUAGE sql SECURITY DEFINER SET search_path = fcis, public AS $$
    UPDATE commitment_schedule
       SET status = 'overdue'
     WHERE status = 'pending'
       AND due_date < CURRENT_DATE;
$$;

-- ---------------------------------------------------------------------
-- sp_post_transaction : a manual ledger entry (deposit, bank charge ...)
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_post_transaction(
    p_account_id INT,
    p_direction  TEXT,
    p_amount     NUMERIC,
    p_narration  TEXT,
    p_txn_date   DATE DEFAULT CURRENT_DATE,
    p_kind       TEXT DEFAULT 'manual'
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    v_balance NUMERIC;
    v_limit   NUMERIC;
    v_name    TEXT;
BEGIN
    IF p_kind NOT IN ('manual', 'opening') THEN
        RAISE EXCEPTION 'Only manual and opening entries can be posted directly';
    END IF;
    IF p_txn_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'A transaction cannot be dated in the future (%)', p_txn_date;
    END IF;

    SELECT current_balance, overdraft_limit, account_name
      INTO v_balance, v_limit, v_name
      FROM bank_accounts WHERE account_id = p_account_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Account % does not exist', p_account_id;
    END IF;
    IF p_direction = 'debit' AND v_balance + v_limit < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds in %: available %, required %',
            v_name, to_char(v_balance + v_limit, 'FM99,99,99,990.00'), to_char(p_amount, 'FM99,99,99,990.00');
    END IF;

    INSERT INTO transactions (account_id, txn_date, direction, amount, narration, recorded_by, txn_kind)
    VALUES (p_account_id, p_txn_date, p_direction, p_amount, p_narration, fn_app_user(), p_kind);
END;
$$;

-- ---------------------------------------------------------------------
-- sp_record_payment : settle (fully or partly) one instalment.
-- Runs inside the caller's transaction: the ledger insert, the balance
-- update (trigger) and the instalment update succeed or fail together.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_record_payment(
    p_schedule_id BIGINT,
    p_amount      NUMERIC,
    p_txn_date    DATE DEFAULT CURRENT_DATE,
    p_narration   TEXT DEFAULT NULL
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    s            commitment_schedule%ROWTYPE;
    c            commitments%ROWTYPE;
    v_balance    NUMERIC;
    v_limit      NUMERIC;
    v_acct_name  TEXT;
    v_remaining  NUMERIC;
BEGIN
    -- lock the instalment so two users cannot pay it at the same time
    SELECT * INTO s FROM commitment_schedule WHERE schedule_id = p_schedule_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instalment % does not exist', p_schedule_id;
    END IF;
    SELECT * INTO c FROM commitments WHERE commitment_id = s.commitment_id;

    IF s.status IN ('paid', 'waived') THEN
        RAISE EXCEPTION 'Instalment % is already %', p_schedule_id, s.status;
    END IF;
    IF c.status = 'closed' THEN
        RAISE EXCEPTION 'Commitment "%" is closed', c.title;
    END IF;
    IF p_txn_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'A payment cannot be dated in the future (%)', p_txn_date;
    END IF;

    v_remaining := s.amount_due - s.amount_paid;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Payment amount must be greater than zero';
    END IF;
    IF p_amount > v_remaining THEN
        RAISE EXCEPTION 'Payment of % exceeds the outstanding amount of %',
            to_char(p_amount, 'FM99,99,99,990.00'), to_char(v_remaining, 'FM99,99,99,990.00');
    END IF;

    -- lock the account row, then make sure an outflow is affordable
    SELECT current_balance, overdraft_limit, account_name
      INTO v_balance, v_limit, v_acct_name
      FROM bank_accounts WHERE account_id = c.account_id FOR UPDATE;

    IF c.direction = 'outflow' AND v_balance + v_limit < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds in %: available %, required %',
            v_acct_name, to_char(v_balance + v_limit, 'FM99,99,99,990.00'), to_char(p_amount, 'FM99,99,99,990.00');
    END IF;

    INSERT INTO transactions (account_id, schedule_id, txn_date, direction, amount, narration, recorded_by, txn_kind)
    VALUES (
        c.account_id, s.schedule_id, p_txn_date,
        CASE c.direction WHEN 'outflow' THEN 'debit' ELSE 'credit' END,
        p_amount,
        COALESCE(NULLIF(btrim(p_narration), ''),
                 CASE c.direction WHEN 'outflow' THEN 'Paid: ' ELSE 'Received: ' END
                 || c.title || ' (due ' || to_char(s.original_due_date, 'DD Mon YYYY') || ')'),
        fn_app_user(), 'commitment'
    );

    -- status and paid_on are derived by trg_schedule_status
    UPDATE commitment_schedule
       SET amount_paid = amount_paid + p_amount,
           paid_on     = CASE WHEN amount_paid + p_amount = amount_due THEN p_txn_date END
     WHERE schedule_id = p_schedule_id;
END;
$$;

-- ---------------------------------------------------------------------
-- sp_transfer_funds : move money between two accounts atomically.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_transfer_funds(
    p_from_account INT,
    p_to_account   INT,
    p_amount       NUMERIC,
    p_narration    TEXT DEFAULT NULL
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    v_from  bank_accounts%ROWTYPE;
    v_to    bank_accounts%ROWTYPE;
    v_note  TEXT;
BEGIN
    IF p_from_account = p_to_account THEN
        RAISE EXCEPTION 'Source and destination accounts must be different';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Transfer amount must be greater than zero';
    END IF;

    -- lock both rows in a fixed order (lowest id first) to avoid deadlocks
    PERFORM 1 FROM bank_accounts
     WHERE account_id IN (p_from_account, p_to_account)
     ORDER BY account_id FOR UPDATE;

    SELECT * INTO v_from FROM bank_accounts WHERE account_id = p_from_account;
    IF NOT FOUND THEN RAISE EXCEPTION 'Source account % does not exist', p_from_account; END IF;
    SELECT * INTO v_to   FROM bank_accounts WHERE account_id = p_to_account;
    IF NOT FOUND THEN RAISE EXCEPTION 'Destination account % does not exist', p_to_account; END IF;

    IF v_from.current_balance + v_from.overdraft_limit < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds in %: available %, required %',
            v_from.account_name,
            to_char(v_from.current_balance + v_from.overdraft_limit, 'FM99,99,99,990.00'),
            to_char(p_amount, 'FM99,99,99,990.00');
    END IF;

    v_note := COALESCE(NULLIF(btrim(p_narration), ''), 'Internal transfer');

    INSERT INTO transactions (account_id, direction, amount, narration, recorded_by, txn_kind)
    VALUES (p_from_account, 'debit',  p_amount, v_note || ' -> ' || v_to.account_name,   fn_app_user(), 'transfer'),
           (p_to_account,   'credit', p_amount, v_note || ' <- ' || v_from.account_name, fn_app_user(), 'transfer');
END;
$$;

-- ---------------------------------------------------------------------
-- sp_defer_schedule : push a flexible instalment to a later date.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_defer_schedule(p_schedule_id BIGINT, p_new_date DATE)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    s commitment_schedule%ROWTYPE;
    c commitments%ROWTYPE;
BEGIN
    SELECT * INTO s FROM commitment_schedule WHERE schedule_id = p_schedule_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instalment % does not exist', p_schedule_id;
    END IF;
    SELECT * INTO c FROM commitments WHERE commitment_id = s.commitment_id;

    IF NOT c.is_flexible THEN
        RAISE EXCEPTION '"%" is not marked flexible and cannot be deferred', c.title;
    END IF;
    IF s.status IN ('paid', 'waived') THEN
        RAISE EXCEPTION 'Instalment % is already %', p_schedule_id, s.status;
    END IF;
    IF p_new_date IS NULL OR p_new_date <= s.due_date THEN
        RAISE EXCEPTION 'The new date must be later than the current due date (%)', s.due_date;
    END IF;
    IF p_new_date > s.original_due_date + 90 THEN
        RAISE EXCEPTION 'An instalment cannot be deferred more than 90 days past its original date (%)', s.original_due_date;
    END IF;

    UPDATE commitment_schedule
       SET due_date = p_new_date,
           status   = CASE WHEN status = 'overdue' THEN 'pending' ELSE status END
     WHERE schedule_id = p_schedule_id;
END;
$$;

-- ---------------------------------------------------------------------
-- fn_project_cashflow : day-by-day projected balance of one account.
--   * recursive CTE builds the calendar
--   * inflows are weighted by the payer's reliability score
--   * overdue items are assumed to hit today
--   * optional what-if: move one instalment to another date
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_project_cashflow(
    p_account_id         INT,
    p_horizon            INT    DEFAULT 60,
    p_defer_schedule_id  BIGINT DEFAULT NULL,
    p_defer_to           DATE   DEFAULT NULL
)
RETURNS TABLE (
    day                DATE,
    expected_inflow    NUMERIC,
    committed_outflow  NUMERIC,
    net_flow           NUMERIC,
    projected_balance  NUMERIC,
    threshold          NUMERIC,
    is_shortfall       BOOLEAN
)
LANGUAGE sql STABLE SET search_path = fcis, public AS $$
    WITH RECURSIVE calendar (d) AS (
        SELECT CURRENT_DATE
        UNION ALL
        SELECT d + 1 FROM calendar WHERE d < CURRENT_DATE + p_horizon
    ),
    acct AS (
        SELECT a.current_balance,
               a.min_buffer - a.overdraft_limit AS floor_amount
          FROM bank_accounts a
         WHERE a.account_id = p_account_id
    ),
    dues AS (
        SELECT CASE
                   WHEN s.schedule_id = p_defer_schedule_id AND p_defer_to IS NOT NULL THEN p_defer_to
                   ELSE GREATEST(s.due_date, CURRENT_DATE)
               END AS eff_date,
               c.direction,
               ROUND((s.amount_due - s.amount_paid)
                     * CASE c.direction WHEN 'inflow' THEN cp.reliability_score ELSE 1 END, 2) AS amt
          FROM commitment_schedule s
          JOIN commitments    c  ON c.commitment_id    = s.commitment_id
          JOIN counterparties cp ON cp.counterparty_id = c.counterparty_id
         WHERE c.account_id = p_account_id
           AND c.status = 'active'
           AND s.status IN ('pending', 'partial', 'overdue')
    ),
    daily AS (
        SELECT cal.d,
               COALESCE(SUM(u.amt) FILTER (WHERE u.direction = 'inflow'),  0) AS inflow,
               COALESCE(SUM(u.amt) FILTER (WHERE u.direction = 'outflow'), 0) AS outflow
          FROM calendar cal
          LEFT JOIN dues u ON u.eff_date = cal.d
         GROUP BY cal.d
    ),
    running AS (
        SELECT dl.d, dl.inflow, dl.outflow,
               a.current_balance + SUM(dl.inflow - dl.outflow) OVER (ORDER BY dl.d) AS balance,
               a.floor_amount
          FROM daily dl CROSS JOIN acct a
    )
    SELECT r.d, r.inflow, r.outflow, r.inflow - r.outflow,
           r.balance, r.floor_amount, r.balance < r.floor_amount
      FROM running r
     ORDER BY r.d
$$;

-- ---------------------------------------------------------------------
-- fn_days_until_empty : how many days until an account runs out of money.
--   * "empty" = projected balance falls below -overdraft_limit, i.e. the
--     balance plus the permitted overdraft is used up
--   * reuses fn_project_cashflow, so the same reliability weighting applies
--   * 0  = already empty today (or an overdue payment empties it today)
--   * NULL = it does not run out within the horizon
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_days_until_empty(
    p_account_id INT,
    p_horizon    INT DEFAULT 365
)
RETURNS INT
LANGUAGE sql STABLE SET search_path = fcis, public AS $$
    SELECT MIN(p.day) - CURRENT_DATE
      FROM fn_project_cashflow(p_account_id, p_horizon) p
      JOIN bank_accounts a ON a.account_id = p_account_id
     WHERE p.projected_balance < -a.overdraft_limit
$$;

-- ---------------------------------------------------------------------
-- sp_run_forecast : project every active account, store one run row per
-- account and one alert per continuous shortfall episode.
-- p_batch_id is INOUT: the caller gets the batch number back.
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_run_forecast(p_horizon INT, INOUT p_batch_id BIGINT DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    acc        RECORD;
    v_run_id   BIGINT;
    v_min      NUMERIC;
    v_min_day  DATE;
    v_days     INT;
BEGIN
    IF p_horizon IS NULL OR p_horizon NOT BETWEEN 7 AND 365 THEN
        RAISE EXCEPTION 'Forecast horizon must be between 7 and 365 days';
    END IF;

    CALL sp_mark_overdue();
    p_batch_id := nextval('forecast_batch_seq');

    FOR acc IN
        SELECT account_id, current_balance, min_buffer, overdraft_limit
          FROM bank_accounts WHERE is_active ORDER BY account_id
    LOOP
        SELECT MIN(p.projected_balance),
               (ARRAY_AGG(p.day ORDER BY p.projected_balance, p.day))[1],
               COUNT(*) FILTER (WHERE p.is_shortfall)
          INTO v_min, v_min_day, v_days
          FROM fn_project_cashflow(acc.account_id, p_horizon) p;

        INSERT INTO forecast_runs (batch_id, account_id, run_by, horizon_days, opening_balance,
                                   threshold, min_projected_balance, min_balance_date, shortfall_days)
        VALUES (p_batch_id, acc.account_id, fn_app_user(), p_horizon, acc.current_balance,
                acc.min_buffer - acc.overdraft_limit, v_min, v_min_day, v_days)
        RETURNING run_id INTO v_run_id;

        -- alerts from earlier runs are replaced by this run's view of the future
        UPDATE shortfall_alerts
           SET status = 'superseded'
         WHERE account_id = acc.account_id
           AND status IN ('open', 'acknowledged');

        -- gaps-and-islands: consecutive shortfall days collapse into one episode
        INSERT INTO shortfall_alerts (run_id, account_id, shortfall_start, shortfall_end,
                                      min_projected_balance, deficit, severity)
        WITH flagged AS (
            SELECT p.day, p.projected_balance, p.threshold,
                   p.day - (ROW_NUMBER() OVER (ORDER BY p.day))::INT AS island
              FROM fn_project_cashflow(acc.account_id, p_horizon) p
             WHERE p.is_shortfall
        ),
        episodes AS (
            SELECT MIN(day) AS first_day, MAX(day) AS last_day,
                   MIN(projected_balance) AS min_balance, MAX(threshold) AS threshold
              FROM flagged
             GROUP BY island
        )
        SELECT v_run_id, acc.account_id, e.first_day, e.last_day, e.min_balance,
               e.threshold - e.min_balance,
               fn_alert_severity(e.first_day, e.min_balance, -acc.overdraft_limit)
          FROM episodes e
         ORDER BY e.first_day;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- fn_suggest_deferrals : which flexible payments, if deferred, would
-- close the gap behind an alert? Least important first, with a running
-- total so the caller can see where the deficit is covered.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_suggest_deferrals(p_alert_id BIGINT)
RETURNS TABLE (
    schedule_id        BIGINT,
    commitment_id      INT,
    title              TEXT,
    counterparty       TEXT,
    due_date           DATE,
    outstanding        NUMERIC,
    priority           SMALLINT,
    suggested_date     DATE,
    cumulative_relief  NUMERIC,
    deficit            NUMERIC,
    covers_deficit     BOOLEAN
)
LANGUAGE sql STABLE SET search_path = fcis, public AS $$
    WITH alert AS (
        SELECT account_id, shortfall_start, shortfall_end, deficit
          FROM shortfall_alerts WHERE alert_id = p_alert_id
    ),
    candidates AS (
        SELECT s.schedule_id, c.commitment_id, c.title::TEXT, cp.name::TEXT AS counterparty,
               s.due_date, s.amount_due - s.amount_paid AS outstanding, c.priority,
               LEAST(a.shortfall_end + 7, s.original_due_date + 90) AS suggested_date,
               a.deficit,
               SUM(s.amount_due - s.amount_paid) OVER (
                   ORDER BY c.priority DESC, (s.amount_due - s.amount_paid) DESC, s.schedule_id
               ) AS cumulative_relief
          FROM alert a
          JOIN commitments c          ON c.account_id = a.account_id
          JOIN commitment_schedule s  ON s.commitment_id = c.commitment_id
          JOIN counterparties cp      ON cp.counterparty_id = c.counterparty_id
         WHERE c.direction = 'outflow'
           AND c.is_flexible
           AND c.status = 'active'
           AND s.status IN ('pending', 'partial', 'overdue')
           AND s.due_date <= a.shortfall_end
           AND LEAST(a.shortfall_end + 7, s.original_due_date + 90) > GREATEST(s.due_date, a.shortfall_end)
    )
    SELECT k.schedule_id, k.commitment_id, k.title, k.counterparty, k.due_date, k.outstanding,
           k.priority, k.suggested_date, k.cumulative_relief, k.deficit,
           k.cumulative_relief >= k.deficit
      FROM candidates k
     WHERE k.cumulative_relief - k.outstanding < k.deficit      -- stop once the gap is closed
     ORDER BY k.cumulative_relief
$$;

-- ---------------------------------------------------------------------
-- User management and authentication (passwords never leave the DB)
-- ---------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE sp_create_user(p_full_name TEXT, p_email TEXT, p_password TEXT, p_role TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
BEGIN
    IF p_password IS NULL OR length(p_password) < 8 THEN
        RAISE EXCEPTION 'Password must be at least 8 characters long';
    END IF;
    INSERT INTO users (full_name, email, password_hash, role)
    VALUES (btrim(p_full_name), lower(btrim(p_email)), crypt(p_password, gen_salt('bf', 10)), p_role);
END;
$$;

CREATE OR REPLACE PROCEDURE sp_reset_password(p_user_id INT, p_password TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
BEGIN
    IF p_password IS NULL OR length(p_password) < 8 THEN
        RAISE EXCEPTION 'Password must be at least 8 characters long';
    END IF;
    UPDATE users SET password_hash = crypt(p_password, gen_salt('bf', 10)) WHERE user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % does not exist', p_user_id;
    END IF;
END;
$$;

-- Returns the user row only when the e-mail exists, the account is
-- active and the bcrypt hash matches. The login role can execute this
-- function but cannot read the users table.
CREATE OR REPLACE FUNCTION fn_verify_login(p_email TEXT, p_password TEXT)
RETURNS TABLE (user_id INT, full_name TEXT, email TEXT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = fcis, public AS $$
    SELECT u.user_id, u.full_name::TEXT, u.email::TEXT, u.role::TEXT
      FROM users u
     WHERE u.email = lower(btrim(p_email))
       AND u.is_active
       AND u.password_hash = crypt(p_password, u.password_hash)
$$;
