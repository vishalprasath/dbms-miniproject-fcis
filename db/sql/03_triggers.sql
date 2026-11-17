-- =====================================================================
-- FCIS  03_triggers.sql
-- Triggers that keep the data consistent without help from the app
-- =====================================================================
SET search_path = fcis, public;

-- ---------------------------------------------------------------------
-- T1. New commitment -> generate its instalments automatically
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_commitment_generate() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
BEGIN
    CALL sp_generate_schedule(NEW.commitment_id);
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_commitment_generate
AFTER INSERT ON commitments
FOR EACH ROW EXECUTE FUNCTION trg_fn_commitment_generate();

-- ---------------------------------------------------------------------
-- T2. Commitment rules on UPDATE
--     * the recurrence rule and direction are frozen once created
--     * a category must flow the same way as the commitment
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_commitment_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    v_cat_direction TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.frequency  IS DISTINCT FROM OLD.frequency
        OR NEW.start_date IS DISTINCT FROM OLD.start_date
        OR NEW.direction  IS DISTINCT FROM OLD.direction THEN
            RAISE EXCEPTION 'Frequency, start date and direction cannot be changed; close this commitment and create a new one';
        END IF;
        IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
            RAISE EXCEPTION 'A closed commitment cannot be reopened';
        END IF;
    END IF;

    SELECT direction INTO v_cat_direction FROM categories WHERE category_id = NEW.category_id;
    -- (a missing category is reported by the foreign key, not here)
    IF v_cat_direction IS NOT NULL AND v_cat_direction <> NEW.direction THEN
        RAISE EXCEPTION 'Category direction (%) does not match commitment direction (%)',
            v_cat_direction, NEW.direction;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_commitment_guard
BEFORE INSERT OR UPDATE ON commitments
FOR EACH ROW EXECUTE FUNCTION trg_fn_commitment_guard();

-- ---------------------------------------------------------------------
-- T3. Commitment changes ripple into the unpaid instalments
--     * new amount   -> future untouched instalments are re-priced
--     * closed       -> everything still unpaid is waived
--     * longer term  -> extra instalments are generated
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_commitment_ripple() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
BEGIN
    IF NEW.amount <> OLD.amount THEN
        UPDATE commitment_schedule
           SET amount_due = NEW.amount
         WHERE commitment_id = NEW.commitment_id
           AND status IN ('pending', 'overdue')
           AND amount_paid = 0
           AND due_date >= CURRENT_DATE;
    END IF;

    IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
        UPDATE commitment_schedule
           SET status = 'waived'
         WHERE commitment_id = NEW.commitment_id
           AND status IN ('pending', 'partial', 'overdue');
    END IF;

    IF NEW.end_date IS DISTINCT FROM OLD.end_date AND NEW.status = 'active' THEN
        -- instalments beyond a shortened end date are removed if untouched
        DELETE FROM commitment_schedule
         WHERE commitment_id = NEW.commitment_id
           AND NEW.end_date IS NOT NULL
           AND original_due_date > NEW.end_date
           AND amount_paid = 0;
        CALL sp_generate_schedule(NEW.commitment_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_commitment_ripple
AFTER UPDATE OF amount, status, end_date ON commitments
FOR EACH ROW EXECUTE FUNCTION trg_fn_commitment_ripple();

-- ---------------------------------------------------------------------
-- T4. Instalment status is derived, never typed in
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_schedule_status() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.amount_due IS DISTINCT FROM OLD.amount_due THEN
        IF NEW.amount_paid = NEW.amount_due THEN
            NEW.status  := 'paid';
            NEW.paid_on := COALESCE(NEW.paid_on, CURRENT_DATE);
        ELSIF NEW.amount_paid > 0 THEN
            NEW.status  := 'partial';
            NEW.paid_on := NULL;
        ELSE
            NEW.status  := CASE WHEN NEW.due_date < CURRENT_DATE THEN 'overdue' ELSE 'pending' END;
            NEW.paid_on := NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_schedule_status
BEFORE UPDATE ON commitment_schedule
FOR EACH ROW EXECUTE FUNCTION trg_fn_schedule_status();

-- ---------------------------------------------------------------------
-- T5. Ledger guard: no posting to inactive accounts, no edits ever
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_txn_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Ledger entries are immutable; delete the entry or post a reversing one';
    END IF;
    IF NOT (SELECT is_active FROM bank_accounts WHERE account_id = NEW.account_id) THEN
        RAISE EXCEPTION 'Account % is inactive; no transactions can be posted to it', NEW.account_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_txn_guard
BEFORE INSERT OR UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION trg_fn_txn_guard();

-- ---------------------------------------------------------------------
-- T6. Ledger -> balance. Inserting a row moves the account balance;
--     deleting it (admin only) reverses the balance and the instalment.
--     ck_account_balance_floor aborts the statement if this would take
--     the account below its overdraft limit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_txn_apply_balance() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE bank_accounts
           SET current_balance = current_balance
               + CASE NEW.direction WHEN 'credit' THEN NEW.amount ELSE -NEW.amount END
         WHERE account_id = NEW.account_id;
        RETURN NEW;
    END IF;

    -- DELETE
    UPDATE bank_accounts
       SET current_balance = current_balance
           - CASE OLD.direction WHEN 'credit' THEN OLD.amount ELSE -OLD.amount END
     WHERE account_id = OLD.account_id;

    IF OLD.schedule_id IS NOT NULL THEN
        UPDATE commitment_schedule
           SET amount_paid = amount_paid - OLD.amount,
               paid_on     = NULL
         WHERE schedule_id = OLD.schedule_id;
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER trg_txn_apply_balance
AFTER INSERT OR DELETE ON transactions
FOR EACH ROW EXECUTE FUNCTION trg_fn_txn_apply_balance();

-- ---------------------------------------------------------------------
-- T7. There must always be at least one active administrator
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_users_last_admin() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    v_other_admins INT;
BEGIN
    IF OLD.role = 'admin' AND OLD.is_active
       AND (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NOT NEW.is_active) THEN
        SELECT COUNT(*) INTO v_other_admins
          FROM users
         WHERE role = 'admin' AND is_active AND user_id <> OLD.user_id;
        IF v_other_admins = 0 THEN
            RAISE EXCEPTION 'The last active administrator cannot be removed, demoted or deactivated';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_users_last_admin
BEFORE UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION trg_fn_users_last_admin();

-- ---------------------------------------------------------------------
-- T8. Generic audit trail. TG_ARGV[0] names the primary-key column.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_fn_audit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = fcis, public AS $$
DECLARE
    v_old JSONB;
    v_new JSONB;
BEGIN
    IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD) - 'password_hash' - 'search_doc'; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW) - 'password_hash' - 'search_doc'; END IF;

    IF TG_OP = 'UPDATE' AND v_old = v_new THEN
        RETURN NULL;                                  -- nothing actually changed
    END IF;

    INSERT INTO audit_log (table_name, action, row_pk, changed_by, old_data, new_data)
    VALUES (TG_TABLE_NAME, TG_OP, COALESCE(v_new, v_old) ->> TG_ARGV[0], fn_app_user(), v_old, v_new);
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_audit_users
AFTER INSERT OR DELETE OR UPDATE OF full_name, email, role, is_active, password_hash ON users
FOR EACH ROW EXECUTE FUNCTION trg_fn_audit('user_id');

CREATE TRIGGER trg_audit_commitments
AFTER INSERT OR UPDATE OR DELETE ON commitments
FOR EACH ROW EXECUTE FUNCTION trg_fn_audit('commitment_id');

-- balance changes are already in the ledger, so only settings are audited
CREATE TRIGGER trg_audit_accounts
AFTER INSERT OR DELETE OR UPDATE OF account_name, bank_name, min_buffer, overdraft_limit, is_active ON bank_accounts
FOR EACH ROW EXECUTE FUNCTION trg_fn_audit('account_id');

CREATE TRIGGER trg_audit_schedule_defer
AFTER UPDATE OF due_date ON commitment_schedule
FOR EACH ROW EXECUTE FUNCTION trg_fn_audit('schedule_id');

CREATE TRIGGER trg_audit_alerts
AFTER UPDATE OF status ON shortfall_alerts
FOR EACH ROW WHEN (NEW.status IN ('acknowledged', 'resolved'))
EXECUTE FUNCTION trg_fn_audit('alert_id');

CREATE TRIGGER trg_audit_txn_delete
AFTER DELETE ON transactions
FOR EACH ROW EXECUTE FUNCTION trg_fn_audit('txn_id');
