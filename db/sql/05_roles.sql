-- =====================================================================
-- FCIS  05_roles.sql
-- Role-based access control enforced by PostgreSQL itself.
--
--   fcis_viewer   read-only: can look, cannot change anything
--   fcis_analyst  viewer + manage commitments, record payments, run forecasts
--   fcis_admin    analyst + accounts, users, deletes, audit trail
--   fcis_app      the only LOGIN role. NOINHERIT: it has no rights of its
--                 own and must SET ROLE to the role of the signed-in user
--                 at the start of every request.
-- =====================================================================
SET search_path = fcis, public;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcis_viewer')  THEN CREATE ROLE fcis_viewer  NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcis_analyst') THEN CREATE ROLE fcis_analyst NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcis_admin')   THEN CREATE ROLE fcis_admin   NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fcis_app')     THEN CREATE ROLE fcis_app LOGIN NOINHERIT; END IF;
END $$;

-- role hierarchy: admin > analyst > viewer
GRANT fcis_viewer  TO fcis_analyst;
GRANT fcis_analyst TO fcis_admin;
-- the login role may switch to any of them, but inherits nothing
GRANT fcis_viewer, fcis_analyst, fcis_admin TO fcis_app;

-- start from zero: nothing is public
REVOKE ALL ON SCHEMA fcis FROM PUBLIC;
REVOKE ALL ON ALL TABLES    IN SCHEMA fcis FROM PUBLIC;
REVOKE ALL ON ALL ROUTINES  IN SCHEMA fcis FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA fcis FROM PUBLIC;

GRANT USAGE ON SCHEMA fcis TO fcis_app, fcis_viewer;

-- ------------------------- login (before a role is known) -------------
GRANT EXECUTE ON FUNCTION fn_verify_login(TEXT, TEXT) TO fcis_app;

-- ------------------------- VIEWER : read only -------------------------
GRANT SELECT ON bank_accounts, categories, counterparties, commitments, commitment_schedule,
                transactions, forecast_runs, shortfall_alerts
      TO fcis_viewer;
GRANT SELECT ON v_upcoming_dues, v_account_health, v_monthly_cashflow, v_counterparty_exposure,
                v_user_directory, v_live_alerts
      TO fcis_viewer;
GRANT EXECUTE ON FUNCTION fn_app_user(),
                          fn_nth_due_date(DATE, TEXT, INT),
                          fn_alert_severity(DATE, NUMERIC, NUMERIC),
                          fn_project_cashflow(INT, INT, BIGINT, DATE),
                          fn_days_until_empty(INT, INT),
                          fn_suggest_deferrals(BIGINT)
      TO fcis_viewer;

-- ------------------------- ANALYST : day-to-day work ------------------
GRANT INSERT, UPDATE ON commitments, counterparties, categories TO fcis_analyst;
-- column-level privileges: an analyst may tune the buffer but not the balance
GRANT UPDATE (min_buffer) ON bank_accounts TO fcis_analyst;
GRANT UPDATE (status, acknowledged_by, acknowledged_at) ON shortfall_alerts TO fcis_analyst;
-- money only moves through procedures: no direct DML on the ledger
GRANT EXECUTE ON PROCEDURE sp_record_payment(BIGINT, NUMERIC, DATE, TEXT),
                           sp_post_transaction(INT, TEXT, NUMERIC, TEXT, DATE, TEXT),
                           sp_transfer_funds(INT, INT, NUMERIC, TEXT),
                           sp_defer_schedule(BIGINT, DATE),
                           sp_run_forecast(INT, BIGINT),
                           sp_mark_overdue(),
                           sp_generate_schedule(INT, DATE)
      TO fcis_analyst;

-- ------------------------- ADMIN : everything else --------------------
GRANT DELETE ON commitments, counterparties, categories, transactions, forecast_runs, shortfall_alerts
      TO fcis_admin;
GRANT INSERT, UPDATE (account_name, bank_name, account_last4, account_type, min_buffer, overdraft_limit, is_active)
      ON bank_accounts TO fcis_admin;
GRANT SELECT ON audit_log TO fcis_admin;
-- users: the password hash column is never granted to anyone
GRANT SELECT (user_id, full_name, email, role, is_active, created_at) ON users TO fcis_admin;
GRANT UPDATE (full_name, role, is_active) ON users TO fcis_admin;
GRANT DELETE ON users TO fcis_admin;
GRANT EXECUTE ON PROCEDURE sp_create_user(TEXT, TEXT, TEXT, TEXT),
                           sp_reset_password(INT, TEXT)
      TO fcis_admin;
