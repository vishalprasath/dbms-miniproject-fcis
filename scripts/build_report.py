#!/usr/bin/env python3
"""Assembles docs/FCIS_Project_Report.md from the project's own files and
the live database catalogue, then converts it to .docx with pandoc.

    python3 scripts/build_report.py

Needs: psql on PATH with access to the fcis database, and pandoc.
"""
import os
import re
import subprocess
import struct

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
DOCS = os.path.join(ROOT, 'docs')


def read(rel):
    with open(os.path.join(ROOT, rel)) as f:
        return f.read()


def psql(sql):
    out = subprocess.run(['psql', '-d', 'fcis', '-At', '-F', '\t', '-c', sql], capture_output=True, text=True, check=True)
    return [line.split('\t') for line in out.stdout.rstrip('\n').split('\n') if line]


def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    return struct.unpack('>II', head[16:24])


def image(rel, caption, max_w=6.3, max_h=8.4):
    w, h = png_size(os.path.join(DOCS, rel))
    width = max_w
    if h / w * width > max_h:
        width = max_h * w / h
    return f'![{caption}]({rel}){{width={width:.2f}in}}\n'


def code(text, lang=''):
    return f'```{lang}\n{text.rstrip()}\n```\n'


def section(sql_text, start, end=None):
    """Slice of a SQL file between two marker strings."""
    a = sql_text.index(start)
    b = sql_text.index(end, a) if end else len(sql_text)
    return sql_text[a:b].rstrip()



def mongo(js):
    out = subprocess.run(['mongosh', 'fcis', '--quiet', '--eval', js], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def sample_documents():
    note = mongo("""print(EJSON.stringify(db.commitment_notes.findOne({ title: 'Lease renewal terms' }, { _id: 0 }), null, 2))""")
    snap = mongo("""
      const d = db.forecast_snapshots.aggregate([
        { $match: { accountName: 'Operating Account' } }, { $sort: { generatedAt: -1 } }, { $limit: 1 },
        { $set: { daily: { $slice: [{ $filter: { input: '$daily', cond: '$$this.shortfall' } }, 1] } } },
        { $unset: '_id' } ]).next();
      print(EJSON.stringify(d, null, 2))""")
    return ('A `commitment_notes` document from the demo database:\n\n' + code(note, 'json') +
            '\nA `forecast_snapshots` document from the demo database. The `daily` array holds one element per day '
            'of the horizon; only the first shortfall day is shown here.\n\n' + code(snap, 'json') + '\n')

# ---------------------------------------------------------------- data dictionary
def data_dictionary():
    tables = psql("""
        SELECT c.relname, COALESCE(obj_description(c.oid), '')
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'fcis' AND c.relkind = 'r'
         ORDER BY array_position(ARRAY['users','bank_accounts','categories','counterparties','commitments',
                  'commitment_schedule','transactions','forecast_runs','shortfall_alerts','audit_log'], c.relname::text)""")
    out = []
    for row in tables:
        name, comment = (row + [''])[:2]
        cols = psql(f"""
            SELECT a.attname,
                   format_type(a.atttypid, a.atttypmod),
                   CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE 'NULL' END,
                   COALESCE(CASE WHEN a.attidentity <> '' THEN 'identity'
                                 WHEN a.attgenerated <> '' THEN 'generated'
                                 ELSE pg_get_expr(d.adbin, d.adrelid) END, ''),
                   COALESCE((SELECT string_agg(CASE con.contype WHEN 'p' THEN 'PK' WHEN 'u' THEN 'UNIQUE'
                                                    WHEN 'f' THEN 'FK -> ' || confrelid::regclass::text END, ', ')
                               FROM pg_constraint con
                              WHERE con.conrelid = a.attrelid AND a.attnum = ANY (con.conkey)
                                AND con.contype IN ('p', 'u', 'f')), '')
              FROM pg_attribute a
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = 'fcis.{name}'::regclass AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum""")
        checks = psql(f"""
            SELECT conname, pg_get_constraintdef(oid)
              FROM pg_constraint WHERE conrelid = 'fcis.{name}'::regclass AND contype = 'c' ORDER BY conname""")
        out.append(f'### {name}\n')
        if comment:
            out.append(comment + '\n')
        out.append('| Column | Type | Null | Default | Key |\n|---|---|---|---|---|')
        for row in cols:
            col, typ, null, default, key = (row + [''] * 5)[:5]
            default = default.replace('|', '\\|')
            out.append(f'| {col} | {typ} | {null} | {default} | {key} |')
        if checks:
            out.append('\nCHECK constraints:\n')
            for cname, cdef in checks:
                cdef = re.sub(r'::(text|character varying|numeric|bpchar)(\[\])?', '', cdef)
                out.append(f'- `{cname}`: `{cdef}`')
        out.append('')
    return '\n'.join(out)


def object_lists():
    idx = psql("""SELECT tablename, indexname, regexp_replace(indexdef, '^.* USING ', '')
                    FROM pg_indexes WHERE schemaname = 'fcis' AND indexname LIKE 'idx%' ORDER BY 1, 2""")
    rows = ['| Table | Index | Definition |', '|---|---|---|']
    rows += [f'| {t} | {i} | `{d}` |' for t, i, d in idx]
    return '\n'.join(rows)


def tree():
    keep = []
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in ('node_modules', '.next', '.git', '.claude', 'screenshots'))
        rel = os.path.relpath(base, ROOT)
        depth = 0 if rel == '.' else rel.count(os.sep) + 1
        if rel != '.':
            keep.append('    ' * (depth - 1) + os.path.basename(base) + '/')
        for f in sorted(files):
            if f.startswith('.') and f not in ('.env.example', '.gitignore'):
                continue
            if f.lower().endswith(('.pdf', '.docx')) or f.startswith('Screenshot') or f == 'package-lock.json':
                continue
            keep.append('    ' * depth + f)
    return '\n'.join(keep)


schema = read('db/sql/01_schema.sql')
funcs = read('db/sql/02_functions_procedures.sql')
trigs = read('db/sql/03_triggers.sql')
views = read('db/sql/04_views.sql')
roles = read('db/sql/05_roles.sql')
queries = read('db/sql/07_queries.sql')
mongo_cmd = read('db/mongo/commands.mongosh.js')
tests = read('docs/test-results.md')
tests = re.sub(r'^# FCIS test results\n', '', tests)
tests = re.sub(r'^## ', '#### ', tests, flags=re.M)
tests_body = tests[tests.index('####'):]
summary = re.search(r'\*\*(\d+ passed.*?)\*\*', tests).group(1)

counts = dict(zip(
    ['commitments', 'instalments', 'transactions', 'alerts', 'categories', 'counterparties'],
    psql("""SELECT (SELECT COUNT(*) FROM fcis.commitments), (SELECT COUNT(*) FROM fcis.commitment_schedule),
                   (SELECT COUNT(*) FROM fcis.transactions), (SELECT COUNT(*) FROM fcis.v_live_alerts),
                   (SELECT COUNT(*) FROM fcis.categories), (SELECT COUNT(*) FROM fcis.counterparties)""")[0]))

R = []
add = R.append

add(f'''---
title: "Financial Commitment Intelligence System for Early Detection of Cash-Flow Shortfalls"
subtitle: "DBMS Experiential Learning, Level 3 Mini Project Report"
author:
  - "PES1UG24CS536  Vishal Prasath"
  - "PES1UG24CS526  Vibha Vasisht"
date: "Team 27 · Department of Computer Science and Engineering, PES University · Aug to Dec 2026"
---

# 1. Title

**Financial Commitment Intelligence System for Early Detection of Cash-Flow Shortfalls (FCIS)**

# 2. Students

| SRN | Name |
|---|---|
| PES1UG24CS536 | Vishal Prasath |
| PES1UG24CS526 | Vibha Vasisht |

GitHub repository: *add the repository link here before submission*

# 3. Abstract

Small businesses rarely fail because they are unprofitable; they fail because cash runs out on the wrong day.
Rent, loan EMIs, salaries, statutory dues and supplier bills are each simple to track, but they fall on different
dates and are funded by receipts that often arrive late. A shortfall is usually noticed only when a payment bounces.

FCIS is a web application that detects such shortfalls in advance. Every financial commitment, whether a payment
or an expected receipt, is recorded once with a recurrence rule. A trigger expands it into dated instalments. A
forecasting routine written in SQL then projects the balance of each bank account day by day: a recursive common
table expression builds the calendar, expected receipts are discounted by a reliability score of the payer, overdue
items are assumed to fall due today, and a window function accumulates the running balance. Each continuous run of
days below the account's safe level is stored as a shortfall alert with a severity. For every alert the system
suggests which negotiable payments could be deferred to close the gap, least important first, and can simulate the
effect of a deferral before it is applied.

PostgreSQL holds the transactional core, where correctness matters most: the ledger is immutable, balances are
maintained by triggers, money moves only through stored procedures, and role-based access is enforced by the
database through roles and column-level grants. MongoDB holds data that does not suit tables: free-form contract
terms and notes that differ for every commitment, the complete forecast curve of each run as a single nested
document, and an activity stream that expires through a TTL index. The interface is built with Next.js and talks to
both databases through route handlers. A suite of 58 automated test cases verifies constraints, triggers,
transactions, privileges, forecast correctness, MongoDB validation and the API.

## 3.1 Objectives

1. Keep a single, consistent record of every recurring and one-off financial commitment of a business.
2. Project the balance of each bank account day by day and detect, weeks ahead, when it will fall below a safe level.
3. Account for uncertainty in receipts by weighting them with the payment reliability of each customer.
4. Recommend concrete actions for each shortfall, and let the user test an action before committing to it.
5. Guarantee the integrity of financial data at the database level, independent of the application code.
6. Restrict what each class of user can do, with the restriction enforced inside the database.
7. Use a relational and a document database, each for the data it suits.

## 3.2 Functional requirements

| # | Requirement | Where it is met |
|---|---|---|
| FR1 | Sign in with e-mail and password; three roles (admin, analyst, viewer) | `fn_verify_login`, `/login`, `/api/auth/*` |
| FR2 | Create, search, filter, edit, pause, close and delete commitments | `/commitments`, `/api/commitments` |
| FR3 | Generate the instalments of a commitment automatically | trigger `trg_commitment_generate` |
| FR4 | Record full or part payments and receipts against an instalment | `sp_record_payment`, `/api/schedule/:id/pay` |
| FR5 | Maintain account balances from the ledger; refuse overdrawing | triggers `trg_txn_apply_balance`, `ck_account_balance_floor` |
| FR6 | Post manual ledger entries and transfer funds between accounts atomically | `sp_post_transaction`, `sp_transfer_funds` |
| FR7 | Project each account and raise shortfall alerts with a severity | `fn_project_cashflow`, `sp_run_forecast` |
| FR8 | Suggest deferrals for an alert and simulate their effect | `fn_suggest_deferrals`, `/api/forecast/simulate` |
| FR9 | Defer a negotiable instalment, keeping its original date | `sp_defer_schedule` |
| FR10 | Attach notes with free-form contract terms and tags to a commitment; search them | MongoDB `commitment_notes`, `/notes` |
| FR11 | Keep the full curve of every forecast run; annotate, pin and delete snapshots | MongoDB `forecast_snapshots` |
| FR12 | Dashboard with key figures, chart, alerts and upcoming dues | `/` |
| FR13 | Analytical reports over both databases | `/insights` |
| FR14 | Manage users; view the audit trail and the activity stream | `/admin` |
| FR15 | Audit every change to commitments, accounts, users and due dates | trigger `trg_fn_audit` |

# 4. Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, plain CSS, hand-written SVG chart |
| Backend / API | Next.js Route Handlers, `pg` and `mongodb` Node.js drivers |
| SQL database | PostgreSQL 17 with the `pgcrypto` extension |
| NoSQL database | MongoDB 8 |
| Authentication | bcrypt verification inside PostgreSQL; HS256 JWT in an httpOnly cookie (`jose`) |
| Configuration | environment variables in `.env.local`; nothing is hard-coded |
| Version control | Git and GitHub |

## 4.1 Database choice and justification

| Data | Nature of the data | Store | Why |
|---|---|---|---|
| Users, accounts, categories, counterparties, commitments, instalments, ledger, forecast runs, alerts, audit log | Structured, highly related, must always be consistent | PostgreSQL | A payment has to change the ledger, the account balance and the instalment together or not at all, which needs ACID transactions. Foreign keys and CHECK constraints keep invalid data out no matter which client writes. Forecasting is a join plus aggregation over these tables, which SQL expresses directly. |
| Notes and contract terms | Text-heavy; every commitment has a different set of terms | MongoDB | A lease has `graceDays` and `escalationPercent`; a loan has `penalInterestPercent` and `bounceCharge`. In SQL this would be a wide sparse table or an entity-attribute-value design. A document with a flexible `terms` sub-document stores each note naturally, and one weighted text index searches title, tags and body. |
| Forecast snapshots | Nested time series, written once, read whole | MongoDB | One run yields 61 days per account, each day carrying the list of instalments behind it. It is never joined or updated in place; it is fetched as a unit to draw a chart. One document per account per run replaces several hundred rows and keeps history cheap. |
| Activity stream | High-volume, append-only, payload differs per event type, short-lived | MongoDB | Schema flexibility for the payload, and a TTL index removes events after 180 days without a cleanup job. |

The two stores are linked by keys, not by duplication: a note stores `commitmentId`, a snapshot stores `runId` and
`accountId`. When a forecast is run, the snapshot is written before the PostgreSQL transaction commits, so a failure
in MongoDB rolls the relational run back as well.

## 4.2 System architecture

```
 Browser (React client components)
        |   fetch() JSON, session cookie (httpOnly JWT)
        v
 Next.js server
   - Server Components  src/app/(app)/**      render pages, read through src/lib/data.js and docs.js
   - Route Handlers     src/app/api/**        24 endpoints; src/lib/api.js adds auth, role check, error mapping
        |                                   |
        |  src/lib/db.js                    |  src/lib/mongo.js
        |  one transaction per request:     |
        |    BEGIN                          |
        |    SET LOCAL ROLE fcis_<role>     |
        |    set_config('app.user_id')      |
        |    ... statements ...             |
        |    COMMIT / ROLLBACK              |
        v                                   v
 PostgreSQL  (schema fcis)                MongoDB  (database fcis)
   10 tables, 6 views                       commitment_notes
   15 functions and procedures              forecast_snapshots
   13 triggers                              activity_events
   4 roles with table and column grants     $jsonSchema validators, 9 indexes
```

# 5. Database design

## 5.1 ER diagram

''')
add(image('er-diagram.png', 'ER diagram of the FCIS relational schema (Chen notation)', 6.5, 5.2))
add('''
All relationships are one-to-many. `CATEGORIES` has a recursive relationship (a category has a parent category).
`COMMITMENT_SCHEDULE` depends on `COMMITMENTS` for its existence (ON DELETE CASCADE). `AUDIT_LOG` deliberately has
no foreign keys so that history survives the deletion of the rows it describes.

## 5.2 Relational schema

Primary keys are in **bold**; foreign keys are in *italics* with the table they reference.

- **users** (**user_id**, full_name, email, password_hash, role, is_active, created_at)
- **bank_accounts** (**account_id**, account_name, bank_name, account_last4, account_type, current_balance, min_buffer, overdraft_limit, is_active, created_at)
- **categories** (**category_id**, name, *parent_id* → categories, direction)
- **counterparties** (**counterparty_id**, name, kind, contact_email, phone, reliability_score)
- **commitments** (**commitment_id**, title, description, *category_id* → categories, *counterparty_id* → counterparties, *account_id* → bank_accounts, direction, amount, frequency, start_date, end_date, priority, is_flexible, status, *created_by* → users, created_at, search_doc)
- **commitment_schedule** (**schedule_id**, *commitment_id* → commitments, due_date, original_due_date, amount_due, amount_paid, status, paid_on)
- **transactions** (**txn_id**, *account_id* → bank_accounts, *schedule_id* → commitment_schedule, txn_date, direction, amount, narration, txn_kind, *recorded_by* → users, created_at)
- **forecast_runs** (**run_id**, batch_id, *account_id* → bank_accounts, *run_by* → users, run_at, horizon_days, opening_balance, threshold, min_projected_balance, min_balance_date, shortfall_days)
- **shortfall_alerts** (**alert_id**, *run_id* → forecast_runs, *account_id* → bank_accounts, shortfall_start, shortfall_end, min_projected_balance, deficit, severity, status, *acknowledged_by* → users, acknowledged_at, created_at)
- **audit_log** (**audit_id**, table_name, action, row_pk, changed_by, changed_at, old_data, new_data)

Candidate keys enforced with UNIQUE: users(email), bank_accounts(account_name), categories(name),
counterparties(name), commitments(title), commitment_schedule(commitment_id, original_due_date),
forecast_runs(batch_id, account_id).

**Normalisation.** Every table is in third normal form: each non-key attribute depends on the whole key and nothing
but the key. Category, counterparty and account details are held once and referenced by key. Two values are
derived and stored on purpose, and both are kept correct by triggers rather than by the application:
`bank_accounts.current_balance` (the sum of the ledger, checked by test Q05) and `commitment_schedule.status`
(derived from `amount_paid`, `amount_due` and `due_date`).

**Referential actions.** Deleting a commitment cascades to its instalments, but `transactions.schedule_id` is
ON DELETE RESTRICT, so a commitment with payment history cannot be deleted, only closed. Deleting a user sets
`created_by`, `recorded_by`, `run_by` and `acknowledged_by` to NULL so that financial history is never lost.

## 5.3 Data dictionary

Generated from the PostgreSQL catalogue.

''')
add(data_dictionary())
add('''
## 5.4 MongoDB data model

| Collection | One document is | Linked to PostgreSQL by | Indexes |
|---|---|---|---|
| `commitment_notes` | a note on a commitment: title, body, tags, free-form `terms`, author, pinned flag, timestamps | `commitmentId` | `by_commitment` (compound), `by_tag` (multikey), `notes_text` (weighted text: title 5, tags 3, body 1) |
| `forecast_snapshots` | the forecast of one account in one run: a `summary`, a `daily` array (date, inflow, outflow, balance, shortfall flag, and the `items` due that day), and an `annotations` array | `runId`, `accountId`, `batchId` | `run_unique` (unique), `latest_per_account` (compound), `runs_with_shortfall` (partial) |
| `activity_events` | one user action: type, actor, time, and a payload whose shape depends on the type | `actor.userId` | `ttl_180_days` (TTL), `by_type`, `by_actor` |

Every collection has a `$jsonSchema` validator with `validationLevel: strict` and `validationAction: error`, so the
required fields, types, tag pattern, array limits and the list of event types are enforced by MongoDB itself.

''')
add(sample_documents())
add('''
**Retrieval strategy.** Notes are fetched by `commitmentId` (compound index, pinned first), by tag (multikey
index) or by `$text` search ranked with `textScore`. The dashboard needs the newest snapshot of each account, which
is a `$sort` + `$group` + `$first` over the `latest_per_account` index. Snapshot lists exclude the heavy `daily`
array with a projection. Analytics `$unwind` the `daily` array (and the `items` inside it) and `$group` by week or by
commitment.

# 6. SQL database commands

All SQL is in `db/sql/`. The files run in order through `npm run db:setup`.

## 6.1 DDL: CREATE, ALTER, DROP, keys, constraints, indexes (`01_schema.sql`)

''')
add(code(schema, 'sql'))
add('\nIndexes present after setup:\n\n' + object_lists() + '\n')
add('''
## 6.2 Functions and stored procedures (`02_functions_procedures.sql`)

''')
add(code(funcs, 'sql'))
add('\n## 6.3 Triggers (`03_triggers.sql`)\n\n')
add(code(trigs, 'sql'))
add('\n## 6.4 Views (`04_views.sql`)\n\n')
add(code(views, 'sql'))
add('\n## 6.5 Roles and privileges (`05_roles.sql`)\n\n')
add(code(roles, 'sql'))
add(f'''
## 6.6 Seed data (`06_seed.sql`)

The seed describes a fictitious printing business. It inserts 3 users, 3 bank accounts, {counts['categories']} categories
in a three-level tree, {counts['counterparties']} counterparties and {counts['commitments']} commitments, from which the trigger generates
{counts['instalments']} instalments. Six months of history are then replayed through `sp_record_payment`, so each of the
{counts['transactions']} ledger entries and every balance was produced by the same procedures and triggers the application uses.
All dates are relative to `CURRENT_DATE`, so the demonstration always has live commitments ahead of it.

## 6.7 DML and important queries (`07_queries.sql`)

The file covers INSERT, UPDATE, DELETE and SELECT; inner, left, self and lateral joins; GROUP BY, HAVING and
ORDER BY with aggregates; nested, correlated, EXISTS and ALL subqueries; recursive and non-recursive CTEs; window
functions; views; full-text search; and index usage. Section A changes data and is wrapped in BEGIN ... ROLLBACK.

''')
add(code(queries, 'sql'))
add('''
# 7. NoSQL (MongoDB) database commands

The application issues these operations through the Node.js driver (`db/mongo/setup.mjs`, `src/lib/docs.js`,
`src/app/api/notes`, `src/app/api/snapshots`). The same commands in `mongosh` form are in
`db/mongo/commands.mongosh.js`, reproduced here. The script creates, reads, updates and deletes documents, runs
four aggregation pipelines, and cleans up after itself.

''')
add(code(mongo_cmd, 'javascript'))
add('''
The full validators (one per collection) are defined in `db/mongo/setup.mjs`. The validator for forecast snapshots,
for example, requires every element of `daily` to have a date, three numbers, a boolean and an array, and restricts
`horizonDays` to the range 7 to 365.

# 8. Next.js project tree structure

''')
add(code(tree()))
add('''
# 9. Sample screenshots of application code and demo

## 9.1 Application code

**Every request runs under the database role of the signed-in user** (`src/lib/db.js`):

''')
add(code(section(read('src/lib/db.js'), 'export async function withSession', '/** Convenience'), 'javascript'))
add('\n**A route handler: record a payment in one transaction** (`src/app/api/schedule/[id]/pay/route.js`):\n\n')
add(code(read('src/app/api/schedule/[id]/pay/route.js'), 'javascript'))
add('\n**Forecast run: PostgreSQL and MongoDB kept consistent** (`src/app/api/forecast/run/route.js`):\n\n')
add(code(read('src/app/api/forecast/run/route.js'), 'javascript'))
add('\n**MongoDB update and delete of a note** (`src/app/api/notes/[id]/route.js`):\n\n')
add(code(read('src/app/api/notes/[id]/route.js'), 'javascript'))
add('\n**A MongoDB aggregation pipeline used by the Insights page** (`src/lib/docs.js`):\n\n')
add(code(section(read('src/lib/docs.js'), '// Weekly cash pressure', '// Largest single payments'), 'javascript'))
add('\n## 9.2 Application screenshots\n\n')

SHOTS = [
    ('01-login.png', 'Sign-in page.'),
    ('02-dashboard.png', 'Dashboard for the analyst: key figures, projected balance chart read from the MongoDB snapshot, shortfall alerts, upcoming dues, account health and overdue items.'),
    ('03-commitments.png', 'Commitments list with full-text search and filters by status, flow, account and category (the category filter includes sub-categories through a recursive CTE).'),
    ('04-commitments-fulltext-search.png', 'Full-text search for "lease press" using the GIN index on the generated tsvector column.'),
    ('05-new-commitment-form.png', 'Form to create a commitment. The direction comes from the category and the trigger generates the instalments.'),
    ('06-commitment-detail.png', 'Commitment detail: instalments with record-payment and defer actions, edit form, and notes with free-form contract terms stored in MongoDB.'),
    ('07-accounts-ledger.png', 'Accounts and ledger: balances with safe levels, ledger entry and transfer forms, and the searchable ledger.'),
    ('13-insufficient-funds-rejected.png', 'A transfer larger than the available balance is refused by the stored procedure and the message is shown to the user; nothing is written.'),
    ('08-forecast.png', 'Forecast page: run a forecast and view the projected balance. Shaded bands are shortfall days; the dashed line is the safe level.'),
    ('09-alerts-deferral-suggestions.png', 'Live alerts with the deferral suggestions from fn_suggest_deferrals, and a what-if simulation showing the lowest balance before and after.'),
    ('10-forecast-full.png', 'Full forecast page including run history from PostgreSQL and stored snapshot documents from MongoDB with annotate, pin and delete actions.'),
    ('11-notes-text-search.png', 'Notes search using the MongoDB text index, with relevance scores and tag counts from an aggregation pipeline.'),
    ('12-insights.png', 'Insights: each card shows a live result with the SQL or the aggregation pipeline that produced it.'),
    ('14-admin.png', 'Administration (admin only): users, the live database privilege matrix, the trigger-written audit trail and the MongoDB activity stream.'),
    ('15-viewer-read-only.png', 'The same commitment as seen by a viewer: no action, edit or note buttons.'),
    ('16-viewer-denied-admin.png', 'A viewer who opens the administration URL is redirected with a notice.'),
]
for i, (f, cap) in enumerate(SHOTS, 1):
    add(image(f'screenshots/{f}', f'Figure {i}. {cap}', 6.4, 8.2))
    add('')

add(f'''
# 10. Testing results

The suite in `tests/run-tests.mjs` is run with `npm test`. Result of the latest run: **{summary}**.

{tests_body}

# 11. Evaluation rubrics: completion status

| # | Evaluation component | Max | Status | Evidence |
|---|---|---|---|---|
| 1 | ER diagram | 2 | Completed | Section 5.1, `docs/er-diagram.png`: 10 entities, attributes, primary keys, 14 relationships with cardinalities, one recursive |
| 2 | Relational schema with keys, relationships and constraints | 3 | Completed | Sections 5.2 and 5.3: primary, foreign and candidate keys, referential actions, all CHECK constraints, normalisation |
| 3 | SQL database implementation, DDL with constraints | 4 | Completed | Section 6.1: CREATE (tables, sequence, indexes, extension), ALTER (add column, add / drop constraint, change type, generated column), DROP (index, table, constraint), PK, FK, UNIQUE, NOT NULL, DEFAULT, CHECK |
| 4 | NoSQL database creation | 4 | Completed | Sections 5.4 and 7: three MongoDB collections with `$jsonSchema` validators and nine indexes (compound, multikey, text, unique, partial, TTL) |
| 5 | Technology justification | 1 | Completed | Section 4.1 |
| 6 | DML operations | 4 | Completed | Section 6.7 part A and the application: INSERT, INSERT ... SELECT, UPDATE, UPDATE with subquery, DELETE, SELECT, all reachable from the interface |
| 7 | Nested, correlated, recursive and join queries | 4 | Completed | Section 6.7 parts B to E and the Insights page: 5-table join, left / self / lateral joins, nested, correlated, EXISTS, ALL, recursive CTEs |
| 8 | Advanced SQL concepts (procedure / function, trigger, CTE) | 6 | Completed | Sections 6.2 to 6.4: 9 procedures, 6 functions, 13 triggers, recursive CTEs, window functions, views, transactions, full-text search, partial and GIN indexes |
| 9 | NoSQL feature, read / update / delete | 7 | Completed | Section 7 and the application: note CRUD, snapshot annotate / pin / delete, text search, five aggregation pipelines, schema validation |
| 10 | Next.js interface | 3 | Completed | Section 9.2: dashboard, forms, tables, search, filters, chart, nine pages |
| 11 | Backend / API and database integration | 2 | Completed | 24 route handlers; credentials only in environment variables; one transaction per request |
| 12 | Authentication, two or more roles, role-based access control in the database | 4 | Completed | Section 6.5: login verified in PostgreSQL; three application roles mapped to PostgreSQL roles with table and column-level grants; tests R01 to R07 and H01 to H06 |
| 13 | Documentation, Git / GitHub | 2 | Documentation completed; repository to be pushed by the team | This report, `README.md`, `docs/` |
| 14 | Originality, individual contribution, modification / viva | 4 | To be demonstrated by the team | Section 12 |

# 12. Individual contribution

*To be completed by the team before submission. Commits in the GitHub repository should reflect the same split.*

| Team member | Database work | Application work |
|---|---|---|
| Vishal Prasath (PES1UG24CS536) | | |
| Vibha Vasisht (PES1UG24CS526) | | |

# 13. Conclusion

FCIS shows that early warning of a cash-flow shortfall is largely a database problem. Once commitments are stored
with a recurrence rule and expanded into instalments, the projection of a balance is a join, an aggregation and a
running total, which PostgreSQL computes directly with a recursive CTE and a window function. Placing the rules in
the database, as constraints, triggers, procedures and role grants, means they hold for every client: the test
suite confirms that even the table owner cannot edit a ledger row and that no role can write to the ledger except
through a procedure.

Using two databases was justified by the data. The relational model gave atomic payments and referential
integrity; the document model gave flexible contract terms, a compact store for nested forecast curves and
self-expiring activity records. The two are joined by keys and kept consistent by writing the snapshot inside the
relational transaction.

Possible extensions are learning the reliability score of each payer from its payment history instead of setting
it by hand, importing bank statements to match receipts automatically, sending alert notifications by e-mail, and
supporting several organisations with row-level security.
''')

md = '\n'.join(R)
md_path = os.path.join(DOCS, 'FCIS_Project_Report.md')
with open(md_path, 'w') as f:
    f.write(md)
subprocess.run(['pandoc', 'FCIS_Project_Report.md', '-o', 'FCIS_Project_Report.docx', '--from', 'markdown',
                '--toc', '--toc-depth=2', '--resource-path=.', '--syntax-highlighting=tango'], cwd=DOCS, check=True)
print('wrote docs/FCIS_Project_Report.md and docs/FCIS_Project_Report.docx')
