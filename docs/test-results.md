# FCIS test results

Run on 2026-11-20 06:45 UTC with `npm test`.

**58 passed, 0 failed** out of 58 test cases.

Database tests run inside transactions that are rolled back, so the demo data is unchanged.


## Authentication

| ID | Test case | Result | Observed |
|---|---|---|---|
| A01 | fn_verify_login accepts the correct password | PASS | e-mail is trimmed and case-insensitive; returns role = analyst |
| A02 | fn_verify_login rejects a wrong password | PASS | zero rows |
| A03 | Passwords are stored as bcrypt hashes, never plain text | PASS | hash starts with $2a$10$ |
| A04 | Login role fcis_app cannot read any table before SET ROLE | PASS | permission denied (42501) on users and commitments |

## Role-based access

| ID | Test case | Result | Observed |
|---|---|---|---|
| R01 | Viewer can read but cannot INSERT a commitment | PASS | read 29 rows; INSERT denied (42501) |
| R02 | Viewer cannot execute sp_record_payment | PASS | EXECUTE denied (42501) |
| R03 | Analyst cannot DELETE a commitment; admin can | PASS | analyst: 42501; admin: 1 row deleted, instalments cascade |
| R04 | Column-level grant: analyst may change min_buffer but not current_balance | PASS | min_buffer updated; current_balance denied (42501) |
| R05 | Nobody can write the ledger directly, not even admin | PASS | INSERT denied for analyst and admin; only procedures write transactions |
| R06 | Admin cannot select the password hash column | PASS | password_hash denied; other columns readable |
| R07 | Analyst cannot read the audit log or create users | PASS | both denied (42501) |

## Constraints

| ID | Test case | Result | Observed |
|---|---|---|---|
| C01 | CHECK: commitment amount must be positive | PASS | ck_commitments_amount |
| C02 | CHECK: end date cannot precede start date | PASS | ck_commitments_dates |
| C03 | CHECK: unknown frequency is rejected | PASS | ck_commitments_frequency |
| C04 | UNIQUE: duplicate commitment title | PASS | uq_commitments_title |
| C05 | FOREIGN KEY: commitment must reference an existing account | PASS | fk_commitments_account |
| C06 | CHECK (regex): invalid e-mail and short password for a new user | PASS | ck_users_email, password rule, uq_users_email |
| C07 | CHECK: counterparty reliability must lie between 0 and 1 | PASS | ck_counterparty_reliability |
| C08 | FOREIGN KEY RESTRICT: a commitment with payment history cannot be deleted | PASS | fk_transactions_schedule blocks the cascade |

## Triggers

| ID | Test case | Result | Observed |
|---|---|---|---|
| T01 | AFTER INSERT trigger generates the instalments of a new commitment | PASS | 6 rows: 2027-01-31, 2027-02-28, 2027-03-31, 2027-04-30, 2027-05-31, 2027-06-30 |
| T02 | BEFORE trigger rejects a category whose direction differs from the commitment | PASS | raised: category direction does not match |
| T03 | Recurrence rule is frozen after creation | PASS | raised: frequency, start date and direction cannot be changed |
| T04 | Changing the amount re-prices only future unpaid instalments | PASS | 13 future instalments now 40,000; 6 paid ones untouched |
| T05 | Closing a commitment waives every unpaid instalment | PASS | 12 instalments waived, 0 left open; reopening refused |
| T06 | Ledger rows are immutable (BEFORE UPDATE trigger) | PASS | even the table owner is refused |
| T07 | The last active administrator cannot be demoted, disabled or deleted | PASS | all three refused |
| T08 | Audit trigger records who changed what, with old and new values | PASS | UPDATE by user 2: priority 4 -> 5 |

## Procedures & transactions

| ID | Test case | Result | Observed |
|---|---|---|---|
| P01 | sp_record_payment: full payment updates ledger, balance and instalment together | PASS | balance 327000 -> 291000; instalment paid; debit entry by analyst |
| P02 | sp_record_payment: part payment sets status to partial | PASS | status = partial, amount_paid = 1000 |
| P03 | sp_record_payment: over-payment and double payment are refused | PASS | both raise P0001 |
| P04 | Insufficient funds: the payment is rolled back completely | PASS | balance 327000 < 950000: refused; balance, ledger and instalment unchanged |
| P05 | sp_transfer_funds is atomic and conserves money | PASS | failed transfer changes nothing; good transfer: -150,000 / +150,000, total unchanged |
| P06 | CHECK on balance floor stops any entry below the overdraft limit | PASS | ck_account_balance_floor fires from the balance trigger |
| P07 | Deleting a ledger entry reverses the balance and reopens the instalment | PASS | balance restored, instalment back to pending |
| P08 | sp_defer_schedule: only flexible instalments, forward only, max 90 days | PASS | three invalid requests refused; valid deferral moves due_date by 20 days, original date kept |

## Forecast

| ID | Test case | Result | Observed |
|---|---|---|---|
| F01 | fn_project_cashflow: running balance equals opening balance plus net flows | PASS | 61 calendar days from the recursive CTE; 327000 + 352200 = 679200 |
| F02 | Inflows are weighted by the payer reliability score | PASS | invoice 900000 x reliability 0.55 = 495000.00000000006 counted |
| F03 | sp_run_forecast stores one run per account and one alert per shortfall episode | PASS | batch 6: 3 runs; alert episodes match an independent LAG() recomputation; older alerts superseded |
| F04 | What-if: deferring a suggested payment raises the lowest projected balance | PASS | 2 suggestions, least important first; moving "Paper and board supply" lifts the low point -867200 -> -547200 |

## Queries

| ID | Test case | Result | Observed |
|---|---|---|---|
| Q01 | Recursive CTE returns every descendant of a category | PASS | 15 categories under Operating Expenses, two levels deep |
| Q02 | Full-text search uses stemming and ranks the title above the description | PASS | "leasing presses" matches 1 commitment(s), first: Office rent - Peenya unit |
| Q03 | Partial index is used for the open-instalment scan | PASS | EXPLAIN shows idx_schedule_open_due |
| Q04 | View v_account_health agrees with the base tables | PASS | outflow_30d = 2334500 both ways |
| Q05 | Ledger and balances reconcile: balance = sum(credits) - sum(debits) | PASS | 3 accounts reconcile to the paisa |

## MongoDB

| ID | Test case | Result | Observed |
|---|---|---|---|
| M01 | $jsonSchema validator rejects a note without a title | PASS | Document failed validation (code 121) |
| M02 | Validator rejects a badly formed tag and a wrong type | PASS | tag pattern, bsonType int and uniqueItems all enforced |
| M03 | Create, read, update ($set, $addToSet, $currentDate) and delete a note | PASS | insertOne -> findOne -> findOneAndUpdate -> deleteOne |
| M04 | Text index search ranks by relevance | PASS | 4 notes; top: "Estimate for the December instalment" (score 3.52); plan uses notes_text |
| M05 | Aggregation: $unwind + $group counts tags across notes | PASS | top tag "negotiable" appears in 4 notes (matches a plain find) |
| M06 | Snapshot documents match PostgreSQL and the unique index blocks duplicates | PASS | run 10: 61 embedded days, summary equals forecast_runs; duplicate runId rejected (E11000) |
| M07 | Aggregation over the nested daily array reproduces the SQL shortfall count | PASS | 3 accounts with shortfall days; counts equal forecast_runs.shortfall_days |
| M08 | Expected indexes exist, including the TTL index | PASS | ttl_180_days (15,552,000 s), run_unique, latest_per_account, partial runs_with_shortfall |

## HTTP API

| ID | Test case | Result | Observed |
|---|---|---|---|
| H01 | Login sets an httpOnly session cookie; a wrong password returns 401 | PASS | 401 for bad password; 200 + HttpOnly cookie for good one |
| H02 | Unauthenticated requests: API returns 401, pages redirect to /login | PASS | API 401; page 307 -> /login |
| H03 | Viewer: reads succeed, writes are refused by the database role (403) | PASS | GET 200; POST commitment 403; POST payment 403; /admin redirects away |
| H04 | Analyst creates a commitment (instalments generated), edits it; only admin can delete it | PASS | create 200 (3 instalments) -> patch 200 (re-priced) -> invalid amount 400 -> analyst delete 403 -> admin delete 200 |
| H05 | Note CRUD through the API (MongoDB) with validation | PASS | bad tag 400; viewer 403; create -> update -> find by tag -> delete |
| H06 | Admin-only endpoints refuse the analyst | PASS | analyst 403 on list and create; admin 200, no password hash in the response |
