import Link from 'next/link';
import { can, requireSession } from '@/lib/auth';
import { withSession } from '@/lib/db';
import { deferralSuggestions, forecastPage } from '@/lib/data';
import { latestSnapshots, snapshotHistory } from '@/lib/docs';
import { daysLabel, fmtDate, fmtDateTime, money } from '@/lib/format';
import BalanceChart from '@/components/BalanceChart';
import { ActionButton, ApiForm } from '@/components/client';
import { Card, PageHead, PriorityBadge, SeverityBadge, StatusBadge } from '@/components/ui';
import DeferralRow from '@/components/DeferralRow';

export default async function ForecastPage({ searchParams }) {
  const session = await requireSession();
  const sp = await searchParams;
  const writable = can.write(session);

  const { alerts, runs, past, suggestions } = await withSession(session, async (c) => {
    const page = await forecastPage(c);
    const suggestions = {};
    for (const a of page.alerts) suggestions[a.alert_id] = await deferralSuggestions(c, a.alert_id);
    return { ...page, suggestions };
  });
  const [snapshots, history] = await Promise.all([latestSnapshots().catch(() => []), snapshotHistory(9).catch(() => [])]);
  const selected = snapshots.find((s) => String(s.accountId) === sp.account) ?? snapshots[0];

  return (
    <div className="stack">
      <PageHead title="Forecast & Alerts">
        A forecast projects every account day by day from its unsettled instalments. Receipts are discounted by
        the payer&apos;s reliability, overdue items are assumed to hit today, and each continuous run of days below
        the safe level becomes one alert.
      </PageHead>

      {writable ? (
        <Card title="Run a new forecast" sub="sp_run_forecast → PostgreSQL alerts + MongoDB snapshot">
          <ApiForm
            url="/api/forecast/run"
            submitLabel="Run forecast"
            success="Forecast complete. Alerts and snapshots refreshed."
            reset={false}
            fields={[
              { name: 'horizon', label: 'Horizon', type: 'select', required: true, defaultValue: '60',
                options: [30, 45, 60, 90, 120].map((d) => ({ value: String(d), label: `${d} days` })) },
            ]}
          />
        </Card>
      ) : null}

      <Card
        title="Projected balance"
        sub={selected ? `${selected.accountName} · generated ${fmtDateTime(selected.generatedAt)}` : ''}
        actions={
          <div className="tabs">
            {snapshots.map((s) => (
              <Link key={s.accountId} href={`/forecast?account=${s.accountId}`} className={s === selected ? 'active' : ''}>
                {s.accountName}{s.summary.shortfallDays ? ` · ${s.summary.shortfallDays}d short` : ''}
              </Link>
            ))}
          </div>
        }
      >
        {selected ? <BalanceChart points={selected.daily} threshold={selected.threshold} /> : <div className="empty">No snapshot yet.</div>}
        {selected ? (
          <details className="disclosure" style={{ marginTop: 14 }}>
            <summary>Day-by-day table</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Day</th><th className="num">Expected in</th><th className="num">Committed out</th><th className="num">Balance</th><th>What is due</th></tr></thead>
                <tbody>
                  {selected.daily.filter((d) => d.inflow || d.outflow).map((d) => (
                    <tr key={d.date}>
                      <td className="nowrap">{fmtDate(d.date, { year: false })}</td>
                      <td className="num pos">{d.inflow ? money(d.inflow) : ''}</td>
                      <td className="num">{d.outflow ? money(d.outflow) : ''}</td>
                      <td className={`num ${d.shortfall ? 'neg' : ''}`}>{money(d.balance)}</td>
                      <td className="small">{d.items.map((i) => i.title).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </Card>

      <h2>Live alerts</h2>
      {alerts.length === 0 ? <Card><div className="empty">No shortfall is projected within the forecast horizon.</div></Card> : null}
      {alerts.map((a) => (
        <Card
          key={a.alert_id}
          title={`${a.account_name}: short by ${money(a.deficit)}`}
          actions={
            <div className="row">
              <SeverityBadge value={a.severity} />
              <StatusBadge value={a.status} />
              {writable && a.status === 'open' ? (
                <ActionButton method="PATCH" url={`/api/alerts/${a.alert_id}`} body={{ status: 'acknowledged' }} label="Acknowledge" />
              ) : null}
              {writable ? (
                <ActionButton method="PATCH" url={`/api/alerts/${a.alert_id}`} body={{ status: 'resolved' }} label="Mark resolved"
                  confirm="Mark this alert as resolved? Run a forecast afterwards to confirm the gap is closed." />
              ) : null}
            </div>
          }
        >
          <p>
            Balance is projected to stay below the safe level from <b>{fmtDate(a.shortfall_start)}</b>
            {a.shortfall_days > 1 ? <> to <b>{fmtDate(a.shortfall_end)}</b> ({a.shortfall_days} days)</> : null}, starting {daysLabel(a.days_until)}.
            Lowest point: <b className={a.min_projected_balance < 0 ? 'neg' : ''}>{money(a.min_projected_balance)}</b>.
            {a.acknowledged_by_name ? <span className="muted"> Acknowledged by {a.acknowledged_by_name}, {fmtDateTime(a.acknowledged_at)}.</span> : null}
          </p>
          <h3 style={{ margin: '14px 0 8px' }}>Payments that could be deferred <span className="muted" style={{ fontWeight: 400 }}>fn_suggest_deferrals · least important first</span></h3>
          {suggestions[a.alert_id].length === 0 ? (
            <p className="muted">No negotiable payment falls before this shortfall. Consider a transfer from another account or chasing a receivable.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Payment</th><th>Priority</th><th>Due</th><th className="num">Amount</th><th className="num">Running relief</th><th>Move to</th><th></th></tr></thead>
                <tbody>
                  {suggestions[a.alert_id].map((s) => (
                    <tr key={s.schedule_id}>
                      <td><Link href={`/commitments/${s.commitment_id}`}>{s.title}</Link><div className="sub">{s.counterparty}</div></td>
                      <td><PriorityBadge value={s.priority} /></td>
                      <td className="nowrap">{fmtDate(s.due_date, { year: false })}</td>
                      <td className="num">{money(s.outstanding)}</td>
                      <td className="num">{money(s.cumulative_relief)}{s.covers_deficit ? <div className="sub pos">covers the gap</div> : null}</td>
                      <td className="nowrap">{fmtDate(s.suggested_date, { year: false })}</td>
                      <td><DeferralRow alertId={a.alert_id} scheduleId={s.schedule_id} toDate={s.suggested_date} canApply={writable} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ))}

      <div className="grid-2">
        <Card title="Forecast runs" sub="PostgreSQL · forecast_runs" flush>
          <table>
            <thead><tr><th>Batch</th><th>Run at</th><th>By</th><th className="num">Horizon</th><th className="num">Short days</th><th className="num">Worst balance</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.batch_id}>
                  <td>#{r.batch_id}</td><td className="nowrap">{fmtDateTime(r.run_at)}</td><td>{r.run_by_name ?? 'system'}</td>
                  <td className="num">{r.horizon_days} d</td><td className="num">{r.shortfall_days}</td>
                  <td className={`num ${r.worst_balance < 0 ? 'neg' : ''}`}>{money(r.worst_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Earlier alerts" sub="resolved or replaced by a newer run" flush>
          {past.length === 0 ? <div className="empty">None yet.</div> : (
            <table>
              <thead><tr><th>Account</th><th>From</th><th className="num">Deficit</th><th>Severity</th><th>Status</th></tr></thead>
              <tbody>
                {past.map((p) => (
                  <tr key={p.alert_id}>
                    <td>{p.account_name}</td><td className="nowrap">{fmtDate(p.shortfall_start, { year: false })}</td>
                    <td className="num">{money(p.deficit)}</td><td><SeverityBadge value={p.severity} /></td><td><StatusBadge value={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Stored snapshots" sub="MongoDB · forecast_snapshots (one document per account per run)" flush>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Generated</th><th>Account</th><th className="num">Lowest balance</th><th className="num">Short days</th><th>Annotations</th><th></th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h._id}>
                  <td className="nowrap">{h.pinned ? '★ ' : ''}{fmtDateTime(h.generatedAt)}<div className="sub">batch #{h.batchId} · {h.horizonDays} d</div></td>
                  <td>{h.accountName}</td>
                  <td className={`num ${h.summary.minBalance < 0 ? 'neg' : ''}`}>{money(h.summary.minBalance)}<div className="sub">{fmtDate(h.summary.minBalanceDate, { year: false })}</div></td>
                  <td className="num">{h.summary.shortfallDays}</td>
                  <td>
                    {h.annotations.length === 0 ? <span className="muted">-</span> : h.annotations.map((n, i) => (
                      <div key={i} className="small">{n.text} <span className="muted">· {n.by}</span></div>
                    ))}
                    {writable ? (
                      <details className="disclosure" style={{ marginTop: 4 }}>
                        <summary>Annotate</summary>
                        <ApiForm method="PATCH" url={`/api/snapshots/${h._id}`} submitLabel="Add" success="Added."
                          fields={[{ name: 'annotation', label: 'Annotation', required: true, wide: true, placeholder: 'e.g. Shown to the director on Monday' }]} />
                      </details>
                    ) : null}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {writable ? <ActionButton method="PATCH" url={`/api/snapshots/${h._id}`} body={{ pinned: !h.pinned }} label={h.pinned ? 'Unpin' : 'Pin'} /> : null}
                      {can.admin(session) ? (
                        <ActionButton method="DELETE" url={`/api/snapshots/${h._id}`} label="Delete" className="btn sm danger" confirm="Delete this snapshot document?" />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
