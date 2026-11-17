-- =====================================================================
-- FCIS : Financial Commitment Intelligence System
-- 01_schema.sql  -  DDL: CREATE / ALTER / DROP, keys, constraints, indexes
-- Target: PostgreSQL 15+
-- =====================================================================

DROP SCHEMA IF EXISTS fcis CASCADE;
CREATE SCHEMA fcis;
SET search_path = fcis, public;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;   -- crypt() / gen_salt() for password hashing

-- ---------------------------------------------------------------------
-- 1. USERS  (application users; role drives the PostgreSQL role used)
-- ---------------------------------------------------------------------
CREATE TABLE users (
    user_id        INT GENERATED ALWAYS AS IDENTITY,
    full_name      VARCHAR(80)  NOT NULL,
    email          VARCHAR(120) NOT NULL,
    password_hash  TEXT         NOT NULL,
    role           VARCHAR(10)  NOT NULL DEFAULT 'viewer',
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT pk_users        PRIMARY KEY (user_id),
    CONSTRAINT uq_users_email  UNIQUE (email),
    CONSTRAINT ck_users_name   CHECK (length(btrim(full_name)) >= 2),
    CONSTRAINT ck_users_email  CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
    CONSTRAINT ck_users_role   CHECK (role IN ('admin', 'analyst', 'viewer'))
);

-- ---------------------------------------------------------------------
-- 2. BANK_ACCOUNTS  (where cash sits; balance is maintained by trigger)
-- ---------------------------------------------------------------------
CREATE TABLE bank_accounts (
    account_id       INT GENERATED ALWAYS AS IDENTITY,
    account_name     VARCHAR(60)   NOT NULL,
    bank_name        VARCHAR(60)   NOT NULL,
    account_last4    CHAR(4)       NOT NULL,
    account_type     VARCHAR(10)   NOT NULL DEFAULT 'current',
    current_balance  NUMERIC(14,2) NOT NULL DEFAULT 0,
    min_buffer       NUMERIC(14,2) NOT NULL DEFAULT 0,
    overdraft_limit  NUMERIC(14,2) NOT NULL DEFAULT 0,
    is_active        BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT pk_bank_accounts      PRIMARY KEY (account_id),
    CONSTRAINT uq_bank_accounts_name UNIQUE (account_name),
    CONSTRAINT ck_account_last4      CHECK (account_last4 ~ '^[0-9]{4}$'),
    CONSTRAINT ck_account_type       CHECK (account_type IN ('current', 'savings', 'overdraft')),
    CONSTRAINT ck_account_buffer     CHECK (min_buffer >= 0),
    CONSTRAINT ck_account_od_limit   CHECK (overdraft_limit >= 0),
    CONSTRAINT ck_account_od_type    CHECK (overdraft_limit = 0 OR account_type = 'overdraft'),
    -- the balance may never go below what the bank allows
    CONSTRAINT ck_account_balance_floor CHECK (current_balance >= -overdraft_limit)
);

-- ---------------------------------------------------------------------
-- 3. CATEGORIES  (self-referencing hierarchy -> recursive CTE roll-ups)
-- ---------------------------------------------------------------------
CREATE TABLE categories (
    category_id  INT GENERATED ALWAYS AS IDENTITY,
    name         VARCHAR(60) NOT NULL,
    parent_id    INT,
    direction    VARCHAR(7)  NOT NULL,
    CONSTRAINT pk_categories        PRIMARY KEY (category_id),
    CONSTRAINT uq_categories_name   UNIQUE (name),
    CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id)
        REFERENCES categories (category_id) ON DELETE RESTRICT,
    CONSTRAINT ck_categories_dir    CHECK (direction IN ('inflow', 'outflow')),
    CONSTRAINT ck_categories_self   CHECK (parent_id IS NULL OR parent_id <> category_id)
);

-- ---------------------------------------------------------------------
-- 4. COUNTERPARTIES  (who we owe / who owes us)
-- ---------------------------------------------------------------------
CREATE TABLE counterparties (
    counterparty_id  INT GENERATED ALWAYS AS IDENTITY,
    name             VARCHAR(80) NOT NULL,
    kind             VARCHAR(12) NOT NULL,
    contact_email    VARCHAR(120),
    phone            VARCHAR(15),
    CONSTRAINT pk_counterparties      PRIMARY KEY (counterparty_id),
    CONSTRAINT uq_counterparties_name UNIQUE (name),
    CONSTRAINT ck_counterparty_kind   CHECK (kind IN ('vendor', 'lender', 'customer', 'landlord', 'government', 'employees')),
    CONSTRAINT ck_counterparty_email  CHECK (contact_email IS NULL OR contact_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
    CONSTRAINT ck_counterparty_phone  CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{10,14}$')
);

-- ---------------------------------------------------------------------
-- 5. COMMITMENTS  (a recurring or one-off promise to pay or be paid)
-- ---------------------------------------------------------------------
CREATE TABLE commitments (
    commitment_id    INT GENERATED ALWAYS AS IDENTITY,
    title            VARCHAR(120)  NOT NULL,
    description      TEXT,
    category_id      INT           NOT NULL,
    counterparty_id  INT           NOT NULL,
    account_id       INT           NOT NULL,
    direction        VARCHAR(7)    NOT NULL,
    amount           NUMERIC(14,2) NOT NULL,
    frequency        VARCHAR(10)   NOT NULL,
    start_date       DATE          NOT NULL,
    end_date         DATE,
    priority         SMALLINT      NOT NULL DEFAULT 3,   -- 1 = critical ... 5 = discretionary
    is_flexible      BOOLEAN       NOT NULL DEFAULT FALSE, -- can a due date be negotiated?
    status           VARCHAR(8)    NOT NULL DEFAULT 'active',
    created_by       INT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT pk_commitments           PRIMARY KEY (commitment_id),
    CONSTRAINT uq_commitments_title     UNIQUE (title),
    CONSTRAINT fk_commitments_category  FOREIGN KEY (category_id)
        REFERENCES categories (category_id) ON DELETE RESTRICT,
    CONSTRAINT fk_commitments_cparty    FOREIGN KEY (counterparty_id)
        REFERENCES counterparties (counterparty_id) ON DELETE RESTRICT,
    CONSTRAINT fk_commitments_account   FOREIGN KEY (account_id)
        REFERENCES bank_accounts (account_id) ON DELETE RESTRICT,
    CONSTRAINT fk_commitments_creator   FOREIGN KEY (created_by)
        REFERENCES users (user_id) ON DELETE SET NULL,
    CONSTRAINT ck_commitments_title     CHECK (length(btrim(title)) >= 3),
    CONSTRAINT ck_commitments_direction CHECK (direction IN ('inflow', 'outflow')),
    CONSTRAINT ck_commitments_amount    CHECK (amount > 0),
    CONSTRAINT ck_commitments_frequency CHECK (frequency IN ('once', 'weekly', 'monthly', 'quarterly', 'yearly')),
    CONSTRAINT ck_commitments_dates     CHECK (end_date IS NULL OR end_date >= start_date),
    CONSTRAINT ck_commitments_priority  CHECK (priority BETWEEN 1 AND 5),
    CONSTRAINT ck_commitments_status    CHECK (status IN ('active', 'paused', 'closed'))
);

-- ---------------------------------------------------------------------
-- 6. COMMITMENT_SCHEDULE  (one row per due date; generated by trigger)
-- ---------------------------------------------------------------------
CREATE TABLE commitment_schedule (
    schedule_id    BIGINT GENERATED ALWAYS AS IDENTITY,
    commitment_id  INT           NOT NULL,
    due_date       DATE          NOT NULL,
    amount_due     NUMERIC(14,2) NOT NULL,
    amount_paid    NUMERIC(14,2) NOT NULL DEFAULT 0,
    status         VARCHAR(8)    NOT NULL DEFAULT 'pending',
    paid_on        DATE,
    CONSTRAINT pk_schedule             PRIMARY KEY (schedule_id),
    CONSTRAINT fk_schedule_commitment  FOREIGN KEY (commitment_id)
        REFERENCES commitments (commitment_id) ON DELETE CASCADE,
    CONSTRAINT uq_schedule_commitment_due UNIQUE (commitment_id, due_date),
    CONSTRAINT ck_schedule_amount_due  CHECK (amount_due > 0),
    CONSTRAINT ck_schedule_amount_paid CHECK (amount_paid >= 0 AND amount_paid <= amount_due),
    CONSTRAINT ck_schedule_status      CHECK (status IN ('pending', 'partial', 'paid', 'overdue', 'waived')),
    CONSTRAINT ck_schedule_paid_full   CHECK (status <> 'paid' OR amount_paid = amount_due)
);

-- ---------------------------------------------------------------------
-- 7. TRANSACTIONS  (immutable ledger; every row moves an account balance)
-- ---------------------------------------------------------------------
CREATE TABLE transactions (
    txn_id       BIGINT GENERATED ALWAYS AS IDENTITY,
    account_id   INT           NOT NULL,
    schedule_id  BIGINT,
    txn_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
    direction    VARCHAR(6)    NOT NULL,
    amount       NUMERIC(14,2) NOT NULL,
    narration    VARCHAR(200)  NOT NULL,
    recorded_by  INT,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT pk_transactions         PRIMARY KEY (txn_id),
    CONSTRAINT fk_transactions_account FOREIGN KEY (account_id)
        REFERENCES bank_accounts (account_id) ON DELETE RESTRICT,
    CONSTRAINT fk_transactions_user    FOREIGN KEY (recorded_by)
        REFERENCES users (user_id) ON DELETE SET NULL,
    CONSTRAINT ck_transactions_dir     CHECK (direction IN ('credit', 'debit')),
    CONSTRAINT ck_transactions_amount  CHECK (amount > 0),
    CONSTRAINT ck_transactions_narr    CHECK (length(btrim(narration)) >= 3)
);

-- ---------------------------------------------------------------------
-- 8. FORECAST_RUNS  (one row per account per forecast batch)
-- ---------------------------------------------------------------------
CREATE SEQUENCE forecast_batch_seq START 1;

CREATE TABLE forecast_runs (
    run_id                 BIGINT GENERATED ALWAYS AS IDENTITY,
    batch_id               BIGINT        NOT NULL,
    account_id             INT           NOT NULL,
    run_by                 INT,
    run_at                 TIMESTAMPTZ   NOT NULL DEFAULT now(),
    horizon_days           INT           NOT NULL,
    opening_balance        NUMERIC(14,2) NOT NULL,
    threshold              NUMERIC(14,2) NOT NULL,
    min_projected_balance  NUMERIC(14,2) NOT NULL,
    min_balance_date       DATE          NOT NULL,
    shortfall_days         INT           NOT NULL DEFAULT 0,
    CONSTRAINT pk_forecast_runs         PRIMARY KEY (run_id),
    CONSTRAINT uq_forecast_batch_acct   UNIQUE (batch_id, account_id),
    CONSTRAINT fk_forecast_runs_account FOREIGN KEY (account_id)
        REFERENCES bank_accounts (account_id) ON DELETE CASCADE,
    CONSTRAINT fk_forecast_runs_user    FOREIGN KEY (run_by)
        REFERENCES users (user_id) ON DELETE SET NULL,
    CONSTRAINT ck_forecast_horizon      CHECK (horizon_days BETWEEN 7 AND 365),
    CONSTRAINT ck_forecast_short_days   CHECK (shortfall_days >= 0)
);

-- ---------------------------------------------------------------------
-- 9. SHORTFALL_ALERTS  (one row per continuous shortfall episode)
-- ---------------------------------------------------------------------
CREATE TABLE shortfall_alerts (
    alert_id               BIGINT GENERATED ALWAYS AS IDENTITY,
    run_id                 BIGINT        NOT NULL,
    account_id             INT           NOT NULL,
    shortfall_start        DATE          NOT NULL,
    shortfall_end          DATE          NOT NULL,
    min_projected_balance  NUMERIC(14,2) NOT NULL,
    deficit                NUMERIC(14,2) NOT NULL,
    severity               VARCHAR(8)    NOT NULL,
    status                 VARCHAR(12)   NOT NULL DEFAULT 'open',
    acknowledged_by        INT,
    acknowledged_at        TIMESTAMPTZ,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT pk_shortfall_alerts   PRIMARY KEY (alert_id),
    CONSTRAINT fk_alerts_run         FOREIGN KEY (run_id)
        REFERENCES forecast_runs (run_id) ON DELETE CASCADE,
    CONSTRAINT fk_alerts_account     FOREIGN KEY (account_id)
        REFERENCES bank_accounts (account_id) ON DELETE CASCADE,
    CONSTRAINT fk_alerts_ack_user    FOREIGN KEY (acknowledged_by)
        REFERENCES users (user_id) ON DELETE SET NULL,
    CONSTRAINT ck_alerts_period      CHECK (shortfall_end >= shortfall_start),
    CONSTRAINT ck_alerts_deficit     CHECK (deficit > 0),
    CONSTRAINT ck_alerts_severity    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    CONSTRAINT ck_alerts_status      CHECK (status IN ('open', 'acknowledged', 'resolved', 'superseded')),
    CONSTRAINT ck_alerts_ack         CHECK (status <> 'acknowledged' OR acknowledged_at IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- 10. AUDIT_LOG  (written only by triggers)
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    audit_id    BIGINT GENERATED ALWAYS AS IDENTITY,
    table_name  VARCHAR(40) NOT NULL,
    action      VARCHAR(6)  NOT NULL,
    row_pk      TEXT        NOT NULL,
    changed_by  INT,                       -- deliberately not a FK: history must survive user deletion
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    old_data    JSONB,
    new_data    JSONB,
    CONSTRAINT pk_audit_log    PRIMARY KEY (audit_id),
    CONSTRAINT ck_audit_action CHECK (action IN ('INSERT', 'UPDATE', 'DELETE'))
);

-- =====================================================================
-- ALTER TABLE : schema evolution after the first design review
-- =====================================================================

-- (a) Customers do not always pay on time. A reliability score (0..1)
--     lets the forecast discount inflows we are not sure of.
ALTER TABLE counterparties
    ADD COLUMN reliability_score NUMERIC(3,2) NOT NULL DEFAULT 1.00;
ALTER TABLE counterparties
    ADD CONSTRAINT ck_counterparty_reliability CHECK (reliability_score BETWEEN 0 AND 1);

-- (b) Deferring a due date must not lose the date originally agreed.
ALTER TABLE commitment_schedule ADD COLUMN original_due_date DATE;
UPDATE commitment_schedule SET original_due_date = due_date;
ALTER TABLE commitment_schedule ALTER COLUMN original_due_date SET NOT NULL;
--     Uniqueness now belongs to the original date, so two instalments of
--     one commitment may be deferred to the same day.
ALTER TABLE commitment_schedule DROP CONSTRAINT uq_schedule_commitment_due;
ALTER TABLE commitment_schedule
    ADD CONSTRAINT uq_schedule_commitment_original UNIQUE (commitment_id, original_due_date);
ALTER TABLE commitment_schedule
    ADD CONSTRAINT ck_schedule_defer_forward CHECK (due_date >= original_due_date);

-- (c) The ledger needs to tell commitment payments from transfers and
--     opening balances, and to point back at the instalment it settled.
ALTER TABLE transactions
    ADD COLUMN txn_kind VARCHAR(10) NOT NULL DEFAULT 'manual';
ALTER TABLE transactions
    ADD CONSTRAINT ck_transactions_kind CHECK (txn_kind IN ('commitment', 'manual', 'transfer', 'opening'));
ALTER TABLE transactions
    ADD CONSTRAINT fk_transactions_schedule FOREIGN KEY (schedule_id)
        REFERENCES commitment_schedule (schedule_id) ON DELETE RESTRICT;
ALTER TABLE transactions
    ADD CONSTRAINT ck_transactions_kind_link
        CHECK ((txn_kind = 'commitment') = (schedule_id IS NOT NULL));

-- (d) Full-text search document for commitments (generated column).
ALTER TABLE commitments
    ADD COLUMN search_doc tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', title), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED;

-- (e) Widen a column that proved too short for real bank names.
ALTER TABLE bank_accounts ALTER COLUMN bank_name TYPE VARCHAR(80);

-- =====================================================================
-- INDEXES
-- =====================================================================
CREATE INDEX idx_commitments_account_status ON commitments (account_id, status);
CREATE INDEX idx_commitments_category       ON commitments (category_id);
CREATE INDEX idx_commitments_counterparty   ON commitments (counterparty_id);
CREATE INDEX idx_commitments_search         ON commitments USING GIN (search_doc);      -- full-text
CREATE INDEX idx_categories_parent          ON categories (parent_id);

CREATE INDEX idx_schedule_due_all           ON commitment_schedule (due_date);
-- partial index: the forecast only ever scans unsettled instalments
CREATE INDEX idx_schedule_open_due          ON commitment_schedule (due_date, commitment_id)
    WHERE status IN ('pending', 'partial', 'overdue');

CREATE INDEX idx_transactions_account_date  ON transactions (account_id, txn_date DESC);
CREATE INDEX idx_transactions_schedule      ON transactions (schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_transactions_narration_fts ON transactions USING GIN (to_tsvector('english', narration));

CREATE INDEX idx_alerts_live                ON shortfall_alerts (account_id, shortfall_start)
    WHERE status IN ('open', 'acknowledged');
CREATE INDEX idx_forecast_runs_account_time ON forecast_runs (account_id, run_at DESC);
CREATE INDEX idx_audit_table_time           ON audit_log (table_name, changed_at DESC);

-- =====================================================================
-- DROP : remove objects that are no longer needed
-- =====================================================================

-- idx_schedule_due_all is fully covered by the partial index above for
-- every query the application runs, so it only costs write time.
DROP INDEX IF EXISTS idx_schedule_due_all;

-- Staging table used once to load the legacy spreadsheet of commitments.
CREATE TABLE stg_legacy_commitments (
    raw_title   TEXT,
    raw_amount  TEXT,
    raw_due     TEXT
);
DROP TABLE IF EXISTS stg_legacy_commitments;

-- =====================================================================
-- Catalogue comments (appear in \d+ and in the data dictionary)
-- =====================================================================
COMMENT ON TABLE  commitments              IS 'A recurring or one-off promise to pay (outflow) or to be paid (inflow).';
COMMENT ON TABLE  commitment_schedule      IS 'Individual instalments of a commitment; generated by trigger from the recurrence rule.';
COMMENT ON TABLE  transactions             IS 'Immutable cash ledger. Triggers keep bank_accounts.current_balance in step.';
COMMENT ON TABLE  shortfall_alerts         IS 'Continuous periods where the projected balance falls below the account threshold.';
COMMENT ON COLUMN counterparties.reliability_score IS 'Probability weight applied to inflows expected from this party (0 to 1).';
COMMENT ON COLUMN commitments.priority     IS '1 = critical (statutory, payroll) ... 5 = discretionary.';
COMMENT ON COLUMN commitments.is_flexible  IS 'TRUE when the due date can be negotiated; only flexible items are offered for deferral.';
