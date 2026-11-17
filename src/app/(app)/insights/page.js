import { requireSession } from '@/lib/auth';
import { withSession } from '@/lib/db';
import { SQL_SHOWCASE } from '@/lib/showcase';
import {
  activityByTypePipeline, activityByUserPipeline, runPipeline, SHORTFALL_DRIVERS_PIPELINE,
  TAG_COUNT_PIPELINE, WEEKLY_PRESSURE_PIPELINE,
} from '@/lib/docs';
import { fmtDateTime, money } from '@/lib/format';
import { Card, PageHead, ResultTable } from '@/components/ui';

const MONEY_COLS = ['amount', 'cash_in', 'cash_out', 'net', 'running_net', 'received', 'monthly_equivalent',
  'parent_category_average', 'outstanding_90d', 'committed_outflow', 'expected_inflow', 'projected_balance',
  'inflow', 'outflow', 'lowest_balance', 'amount_handled'];
const format = Object.fromEntries(MONEY_COLS.map((c) => [c, (v) => (v == null ? '-' : <span className={v < 0 ? 'neg' : ''}>{money(v)}</span>)]));
format.category = (v) => <span style={{ whiteSpace: 'pre' }}>{v}</span>;
format.last_seen = (v) => fmtDateTime(v);
format.flexible = (v) => (v ? 'yes' : 'no');

export default async function InsightsPage() {
  const session = await requireSession();

  const sqlResults = await withSession(session, async (c) => {
    const out = [];
    for (const q of SQL_SHOWCASE) out.push({ ...q, rows: (await c.query(q.sql)).rows });
    return out;
  });

  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  const mongoQueries = [
    { title: 'Weekly cash pressure per account', concept: '$unwind of the daily array · $dateTrunc · $group', collection: 'forecast_snapshots', pipeline: WEEKLY_PRESSURE_PIPELINE },
    { title: 'Payments that fall inside shortfall days', concept: 'double $unwind (array inside array) · $match · $group', collection: 'forecast_snapshots', pipeline: SHORTFALL_DRIVERS_PIPELINE },
    { title: 'Most used note tags', concept: '$unwind · $group · $addToSet · $size', collection: 'commitment_notes', pipeline: TAG_COUNT_PIPELINE },
    { title: 'Activity by event type, last 14 days', concept: '$match on the TTL-indexed date · $group', collection: 'activity_events', pipeline: activityByTypePipeline(since) },
    { title: 'Activity by user, last 14 days', concept: '$cond inside $sum · $dateToString', collection: 'activity_events', pipeline: activityByUserPipeline(since) },
  ];
  const mongoResults = [];
  for (const q of mongoQueries) {
    mongoResults.push({ ...q, rows: await runPipeline(q.collection, q.pipeline).catch(() => null) });
  }

  return (
    <div className="stack">
      <PageHead title="Insights">
        Analytical queries over both databases. Each card shows the live result and the exact SQL or aggregation
        pipeline that produced it.
      </PageHead>

      <h2>PostgreSQL</h2>
      {sqlResults.map((q) => (
        <Card key={q.id} title={q.title} sub={q.concept} flush>
          <ResultTable rows={q.rows} format={format} />
          <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line)' }}>
            <details className="disclosure">
              <summary>Show SQL</summary>
              <pre className="sql">{q.sql}</pre>
            </details>
          </div>
        </Card>
      ))}

      <h2>MongoDB aggregation pipelines</h2>
      {mongoResults.map((q) => (
        <Card key={q.title} title={q.title} sub={`${q.collection} · ${q.concept}`} flush>
          {q.rows === null ? <div className="empty">MongoDB is not reachable.</div> : <ResultTable rows={q.rows} format={format} />}
          <div style={{ padding: '12px 18px', borderTop: '1px solid var(--line)' }}>
            <details className="disclosure">
              <summary>Show pipeline</summary>
              <pre className="sql">{`db.${q.collection}.aggregate(${JSON.stringify(q.pipeline, null, 2)})`}</pre>
            </details>
          </div>
        </Card>
      ))}
    </div>
  );
}
