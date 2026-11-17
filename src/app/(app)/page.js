import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { withSession } from '@/lib/db';
import { dashboard } from '@/lib/data';
import { latestSnapshots } from '@/lib/docs';
import { daysLabel, fmtDate, fmtDateTime, money } from '@/lib/format';
import BalanceChart from '@/components/BalanceChart';
import { Card, DirectionLabel, PageHead, PriorityBadge, SeverityBadge, Stat, StatusBadge } from '@/components/ui';

export default async function DashboardPage({ searchParams }) {
  const session = await requireSession();
  const sp = await searchParams;
  const { totals, health, alerts, upcoming, overdue } = await withSession(session, (c) => dashboard(c));
  const snapshots = await latestSnapshots().catch(() => []);
  const selected = snapshots.find((s) => String(s.accountId) === sp.account) ?? snapshots[0];

  return (
    <div className="stack">
      <PageHead title="Dashboard">
        Position as of {fmtDate(new Date().toISOString())}. Last forecast run {fmtDateTime(totals.last_run)}.
      </PageHead>

      {sp.denied ? <div className="banner warn">Your role does not have access to that page.</div> : null}

      <div className="stats">
        <Stat label="Cash across accounts" value={money(totals.liquidity)} note={`${health.length} bank accounts`} />
        <Stat label="Due to pay, next 30 days" value={money(totals.out_30d)} note="committed outflows" />
        <Stat label="Expected to receive, 30 days" value={money(totals.in_30d)} note="weighted by payer reliability" />
        <Stat
          label="Shortfall alerts"
          value={totals.live_alerts}
          note={totals.next_shortfall ? `first on ${fmtDate(totals.next_shortfall)}` : 'none projected'}
          alert={totals.live_alerts > 0}
        />
        <Stat
          label="Overdue instalments"
          value={totals.overdue_count}
          note={totals.overdue_count ? `${money(totals.overdue_amount)} outstanding` : 'all settled'}
          alert={totals.overdue_count > 0}
        />
      </div>

      <div className="grid-side">
        <Card
          title="Projected balance"
          sub={selected ? `${selected.accountName} · next ${selected.horizonDays} days` : ''}
          actions={
            <div className="tabs">
              {snapshots.map((s) => (
                <Link key={s.accountId} href={`/?account=${s.accountId}`} className={s === selected ? 'active' : ''}>
                  {s.accountName}
                </Link>
              ))}
            </div>
          }
        >
          {selected ? (
            <BalanceChart points={selected.daily} threshold={selected.threshold} />
          ) : (
            <div className="empty">No forecast snapshot yet. Run a forecast from the Forecast page.</div>
          )}
        </Card>

        <Card title="Shortfall alerts" actions={<Link href="/forecast" className="btn sm">Open forecast</Link>} flush>
          {alerts.length === 0 ? (
            <div className="empty">No shortfall projected. Every account stays above its safe balance.</div>
          ) : (
            <table>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.alert_id}>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <SeverityBadge value={a.severity} />
                        <b>{a.account_name}</b>
                      </div>
                      <div className="sub">
                        {fmtDate(a.shortfall_start, { year: false })}
                        {a.shortfall_days > 1 ? ` to ${fmtDate(a.shortfall_end, { year: false })}` : ''} · {daysLabel(a.days_until)}
                      </div>
                    </td>
                    <td className="num">
                      <div className="neg">{money(a.deficit)}</div>
                      <div className="sub">short</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid-side">
        <Card title="Due in the next 14 days" actions={<Link href="/commitments" className="btn sm">All commitments</Link>} flush>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Due</th><th>Commitment</th><th>Account</th><th>Priority</th><th>Flow</th><th className="num">Amount</th></tr>
              </thead>
              <tbody>
                {upcoming.map((u) => (
                  <tr key={u.schedule_id}>
                    <td className="nowrap">{fmtDate(u.due_date, { year: false })}<div className="sub">{daysLabel(u.days_until)}</div></td>
                    <td><Link href={`/commitments/${u.commitment_id}`}>{u.title}</Link><div className="sub">{u.counterparty}</div></td>
                    <td>{u.account_name}</td>
                    <td><PriorityBadge value={u.priority} /></td>
                    <td><DirectionLabel value={u.direction} /></td>
                    <td className="num">{money(u.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Account health" sub="next 30 days" flush>
            <table>
              <thead><tr><th>Account</th><th className="num">Balance</th><th className="num">Cover</th></tr></thead>
              <tbody>
                {health.map((h) => (
                  <tr key={h.account_id}>
                    <td>{h.account_name}<div className="sub">safe level {money(h.threshold)}</div></td>
                    <td className={`num ${h.current_balance < 0 ? 'neg' : ''}`}>{money(h.current_balance)}</td>
                    <td className="num">
                      {h.coverage_ratio == null ? '-' : (
                        <span className={h.coverage_ratio < 1 ? 'neg' : ''}>{h.coverage_ratio.toFixed(2)}×</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Overdue" flush>
            {overdue.length === 0 ? <div className="empty">Nothing overdue.</div> : (
              <table>
                <tbody>
                  {overdue.map((o) => (
                    <tr key={o.schedule_id}>
                      <td><Link href={`/commitments/${o.commitment_id}`}>{o.title}</Link>
                        <div className="sub">{o.direction === 'inflow' ? 'receivable' : 'payable'} · due {fmtDate(o.due_date, { year: false })} · <StatusBadge value={o.status} /></div></td>
                      <td className="num">{money(o.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
