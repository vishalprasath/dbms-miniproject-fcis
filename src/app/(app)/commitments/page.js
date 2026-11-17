import Link from 'next/link';
import { can, requireSession } from '@/lib/auth';
import { withSession } from '@/lib/db';
import { listCommitments, lookups } from '@/lib/data';
import { fmtDate, money, titleCase } from '@/lib/format';
import { ApiForm } from '@/components/client';
import { Card, DirectionLabel, PageHead, PriorityBadge, StatusBadge } from '@/components/ui';

export default async function CommitmentsPage({ searchParams }) {
  const session = await requireSession();
  const f = await searchParams;
  const { list, look } = await withSession(session, async (c) => ({
    list: await listCommitments(c, f),
    look: await lookups(c),
  }));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="stack">
      <PageHead title="Commitments">
        Every recurring or one-off promise to pay or be paid. Creating one generates its instalments automatically.
      </PageHead>

      {can.write(session) ? (
        <Card>
          <details className="disclosure">
            <summary>New commitment</summary>
            <ApiForm
              url="/api/commitments"
              submitLabel="Create commitment"
              success="Commitment created and instalments generated."
              fields={[
                { name: 'title', label: 'Title', required: true, wide: true, placeholder: 'e.g. Warehouse rent - Hosur' },
                { name: 'category_id', label: 'Category', type: 'select', required: true, hint: 'sets inflow / outflow',
                  options: look.categories.map((c) => ({ value: c.category_id, label: `${c.direction === 'inflow' ? 'In' : 'Out'} · ${c.parent ? `${c.parent} / ` : ''}${c.name}` })) },
                { name: 'counterparty_id', label: 'Counterparty', type: 'select', required: true,
                  options: look.counterparties.map((c) => ({ value: c.counterparty_id, label: c.name })) },
                { name: 'account_id', label: 'Bank account', type: 'select', required: true,
                  options: look.accounts.filter((a) => a.is_active).map((a) => ({ value: a.account_id, label: a.account_name })) },
                { name: 'amount', label: 'Amount per instalment (₹)', type: 'number', step: '0.01', min: '0.01', required: true },
                { name: 'frequency', label: 'Frequency', type: 'select', required: true, defaultValue: 'monthly',
                  options: ['once', 'weekly', 'monthly', 'quarterly', 'yearly'].map((v) => ({ value: v, label: titleCase(v) })) },
                { name: 'start_date', label: 'First due date', type: 'date', required: true, defaultValue: today },
                { name: 'end_date', label: 'Last due date', type: 'date', hint: 'optional' },
                { name: 'priority', label: 'Priority', type: 'select', required: true, defaultValue: '3',
                  options: [1, 2, 3, 4, 5].map((p) => ({ value: String(p), label: `P${p}` })) },
                { name: 'is_flexible', label: 'Due date is negotiable', type: 'checkbox', hint: 'can be offered for deferral' },
                { name: 'description', label: 'Description', type: 'textarea', wide: true },
              ]}
            />
          </details>
        </Card>
      ) : null}

      <Card
        title="All commitments"
        sub={`${list.length} shown`}
        flush
      >
        <form className="filters" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <label className="field grow">
            Search <span className="hint">full-text over title and description</span>
            <input name="q" defaultValue={f.q ?? ''} placeholder="e.g. lease press, tax, retainer" />
          </label>
          <label className="field">
            Status
            <select name="status" defaultValue={f.status ?? ''}>
              <option value="">Any</option><option value="active">Active</option><option value="paused">Paused</option><option value="closed">Closed</option>
            </select>
          </label>
          <label className="field">
            Flow
            <select name="direction" defaultValue={f.direction ?? ''}>
              <option value="">Any</option><option value="outflow">Outflow</option><option value="inflow">Inflow</option>
            </select>
          </label>
          <label className="field">
            Account
            <select name="account" defaultValue={f.account ?? ''}>
              <option value="">Any</option>
              {look.accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_name}</option>)}
            </select>
          </label>
          <label className="field">
            Category <span className="hint">incl. sub-categories</span>
            <select name="category" defaultValue={f.category ?? ''}>
              <option value="">Any</option>
              {look.categories.map((c) => <option key={c.category_id} value={c.category_id}>{c.parent ? `${c.parent} / ` : ''}{c.name}</option>)}
            </select>
          </label>
          <button className="btn primary">Apply</button>
          <Link href="/commitments" className="btn">Clear</Link>
        </form>
        {list.length === 0 ? <div className="empty">No commitments match these filters.</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Commitment</th><th>Category</th><th>Account</th><th>Flow</th><th>Frequency</th>
                  <th>Priority</th><th>Next due</th><th className="num">Amount</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.commitment_id}>
                    <td>
                      <Link href={`/commitments/${r.commitment_id}`}><b>{r.title}</b></Link>
                      <div className="sub">{r.counterparty}{r.is_flexible ? ' · negotiable' : ''}</div>
                    </td>
                    <td>{r.category}</td>
                    <td>{r.account_name}</td>
                    <td><DirectionLabel value={r.direction} /></td>
                    <td>{titleCase(r.frequency)}</td>
                    <td><PriorityBadge value={r.priority} /></td>
                    <td className="nowrap">
                      {r.next_due ? fmtDate(r.next_due, { year: false }) : <span className="muted">-</span>}
                      {r.overdue_count > 0 ? <div className="sub neg">{r.overdue_count} overdue</div> : null}
                    </td>
                    <td className="num">{money(r.amount)}</td>
                    <td><StatusBadge value={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
