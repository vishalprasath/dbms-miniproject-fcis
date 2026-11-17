// Builds one MongoDB "forecast snapshot" document per account for a
// forecast batch that PostgreSQL has just produced (sp_run_forecast).
//
// The relational side keeps the facts (runs, alerts). The snapshot keeps
// the whole 60-day curve, with the instalments behind each day nested
// inside it, exactly as it looked at the moment of the run. It is read
// back as one document to draw a chart, and never joined to anything.
//
// Used by both the API (src/app/api/forecast/run) and scripts/setup-db.mjs,
// so it takes its connections as arguments and has no framework imports.

const utcDate = (ymd) => new Date(`${ymd}T00:00:00.000Z`);

export async function buildSnapshots({ pg, db, batchId, actor }) {
  const runs = await pg.query(
    `SELECT r.run_id::int, r.account_id, a.account_name, r.horizon_days,
            r.opening_balance::float8 AS opening_balance,
            r.threshold::float8       AS threshold,
            r.run_at
       FROM fcis.forecast_runs r
       JOIN fcis.bank_accounts a ON a.account_id = r.account_id
      WHERE r.batch_id = $1
      ORDER BY r.account_id`,
    [batchId],
  );

  const docs = [];
  for (const run of runs.rows) {
    const daily = await pg.query(
      `SELECT day::text AS day,
              expected_inflow::float8   AS inflow,
              committed_outflow::float8 AS outflow,
              projected_balance::float8 AS balance,
              is_shortfall
         FROM fcis.fn_project_cashflow($1, $2)`,
      [run.account_id, run.horizon_days],
    );
    const items = await pg.query(
      `SELECT GREATEST(due_date, CURRENT_DATE)::text AS day,
              schedule_id::int, commitment_id, title, direction, priority, is_flexible,
              ROUND(outstanding * CASE direction WHEN 'inflow' THEN reliability_score ELSE 1 END, 2)::float8 AS amount,
              counterparty, status
         FROM fcis.v_upcoming_dues
        WHERE account_id = $1 AND due_date <= CURRENT_DATE + $2::int
        ORDER BY due_date, priority`,
      [run.account_id, run.horizon_days],
    );

    const byDay = new Map();
    for (const it of items.rows) {
      if (!byDay.has(it.day)) byDay.set(it.day, []);
      byDay.get(it.day).push({
        scheduleId: it.schedule_id,
        commitmentId: it.commitment_id,
        title: it.title,
        counterparty: it.counterparty,
        direction: it.direction,
        amount: it.amount,
        priority: it.priority,
        flexible: it.is_flexible,
        status: it.status,
      });
    }

    const days = daily.rows.map((d) => ({
      date: utcDate(d.day),
      inflow: d.inflow,
      outflow: d.outflow,
      balance: d.balance,
      shortfall: d.is_shortfall,
      items: byDay.get(d.day) ?? [],
    }));

    const lowest = days.reduce((m, d) => (d.balance < m.balance ? d : m), days[0]);
    const firstShort = days.find((d) => d.shortfall);

    docs.push({
      batchId: Number(batchId),
      runId: run.run_id,
      accountId: run.account_id,
      accountName: run.account_name,
      generatedAt: run.run_at,
      generatedBy: actor ?? { userId: 0, name: 'system' },
      horizonDays: run.horizon_days,
      openingBalance: run.opening_balance,
      threshold: run.threshold,
      summary: {
        minBalance: lowest.balance,
        minBalanceDate: lowest.date,
        shortfallDays: days.filter((d) => d.shortfall).length,
        firstShortfallDate: firstShort ? firstShort.date : null,
        totalInflow: Math.round(days.reduce((s, d) => s + d.inflow, 0) * 100) / 100,
        totalOutflow: Math.round(days.reduce((s, d) => s + d.outflow, 0) * 100) / 100,
      },
      daily: days,
      annotations: [],
      pinned: false,
    });
  }

  if (docs.length) await db.collection('forecast_snapshots').insertMany(docs);
  return docs.length;
}
