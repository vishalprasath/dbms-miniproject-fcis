import Link from 'next/link';
import { can, requireSession } from '@/lib/auth';
import { withSession } from '@/lib/db';
import { accountHealth, listTransactions } from '@/lib/data';
import { fmtDate, money, moneyExact, titleCase } from '@/lib/format';
import { ActionButton, ApiForm } from '@/components/client';
import { Card, PageHead, StatusBadge } from '@/components/ui';

export default async function AccountsPage({ searchParams }) {
  const session = await requireSession();
  const f = await searchParams;
  const { accounts, txns } = await withSession(session, async (c) => ({
    accounts: await accountHealth(c),
    txns: await listTransactions(c, f),
  }));
  const writable = can.write(session);
  const admin = can.admin(session);
  const options = accounts.filter((a) => a.is_active).map((a) => ({ value: a.account_id, label: a.account_name }));

  return (
    <div className="stack">
      <PageHead title="Accounts & Ledger">
        Balances are never typed in. Every ledger entry moves its account balance through a trigger, and the
        database refuses any entry that would take an account below its permitted floor.
      </PageHead>

      <div className="grid-3">
        {accounts.map((a) => (
          <Card
            key={a.account_id}
            title={a.account_name}
            sub={`${a.bank_name} ··${a.account_last4}`}
            actions={<span className="badge plain b-neutral">{titleCase(a.account_type)}{a.is_active ? '' : ' · inactive'}</span>}
          >
            <div className={`stat-value ${a.current_balance < 0 ? 'neg' : ''}`}>{moneyExact(a.current_balance)}</div>
            <dl className="kv small" style={{ marginTop: 10 }}>
              <dt>Safe level</dt><dd>{money(a.threshold)} <span className="muted">(buffer {money(a.min_buffer)}{a.overdraft_limit ? `, OD limit ${money(a.overdraft_limit)}` : ''})</span></dd>
              <dt>To pay in 30 days</dt><dd>{money(a.outflow_30d)}</dd>
              <dt>Expected in 30 days</dt><dd>{money(a.expected_inflow_30d)}</dd>
              <dt>Cover</dt><dd className={a.coverage_ratio != null && a.coverage_ratio < 1 ? 'neg' : ''}>{a.coverage_ratio == null ? '-' : `${a.coverage_ratio.toFixed(2)}×`}</dd>
              <dt>Runs out of money</dt>
              <dd className={a.days_until_empty != null && a.days_until_empty <= 30 ? 'neg' : ''}>
                {a.days_until_empty == null ? 'not within a year'
                  : a.days_until_empty === 0 ? 'today'
                  : `in ${a.days_until_empty} day${a.days_until_empty === 1 ? '' : 's'}`}
              </dd>
              <dt>Alerts</dt><dd>{a.live_alerts ? <Link href="/forecast">{a.live_alerts} live, first {fmtDate(a.next_shortfall, { year: false })}</Link> : 'none'}</dd>
            </dl>
            {writable ? (
              <details className="disclosure" style={{ marginTop: 12 }}>
                <summary>Change safety buffer</summary>
                <ApiForm
                  method="PATCH"
                  url={`/api/accounts/${a.account_id}`}
                  reset={false}
                  submitLabel="Update"
                  success="Updated. Run a forecast to refresh alerts."
                  fields={[
                    { name: 'min_buffer', label: 'Minimum buffer (₹)', type: 'number', min: '0', step: '1000', required: true, defaultValue: String(a.min_buffer) },
                    ...(admin ? [{ name: 'is_active', label: 'Account is active', type: 'checkbox', defaultValue: a.is_active }] : []),
                  ]}
                />
              </details>
            ) : null}
          </Card>
        ))}
      </div>

      {writable ? (
        <div className="grid-2">
          <Card title="Post a ledger entry" sub="sp_post_transaction">
            <ApiForm
              url="/api/transactions"
              submitLabel="Post entry"
              success="Entry posted and balance updated."
              fields={[
                { name: 'account_id', label: 'Account', type: 'select', required: true, options },
                { name: 'direction', label: 'Type', type: 'select', required: true, defaultValue: 'debit',
                  options: [{ value: 'debit', label: 'Debit (money out)' }, { value: 'credit', label: 'Credit (money in)' }] },
                { name: 'amount', label: 'Amount (₹)', type: 'number', step: '0.01', min: '0.01', required: true },
                { name: 'txn_date', label: 'Date', type: 'date', hint: 'today if blank' },
                { name: 'narration', label: 'Narration', required: true, wide: true, placeholder: 'e.g. Bank charges for November' },
              ]}
            />
          </Card>
          <Card title="Transfer between accounts" sub="sp_transfer_funds · one transaction">
            <ApiForm
              url="/api/transfers"
              submitLabel="Transfer"
              success="Transfer completed: one debit and one credit."
              fields={[
                { name: 'from_account', label: 'From', type: 'select', required: true, options },
                { name: 'to_account', label: 'To', type: 'select', required: true, options },
                { name: 'amount', label: 'Amount (₹)', type: 'number', step: '0.01', min: '0.01', required: true },
                { name: 'narration', label: 'Narration', placeholder: 'e.g. Top up tax reserve', wide: true },
              ]}
            />
          </Card>
        </div>
      ) : null}

      {admin ? (
        <Card>
          <details className="disclosure">
            <summary>Add a bank account (admin)</summary>
            <ApiForm
              url="/api/accounts"
              submitLabel="Add account"
              success="Account added."
              fields={[
                { name: 'account_name', label: 'Account name', required: true },
                { name: 'bank_name', label: 'Bank', required: true },
                { name: 'account_last4', label: 'Last 4 digits', required: true, placeholder: '1234' },
                { name: 'account_type', label: 'Type', type: 'select', required: true, defaultValue: 'current',
                  options: ['current', 'savings', 'overdraft'].map((v) => ({ value: v, label: titleCase(v) })) },
                { name: 'min_buffer', label: 'Minimum buffer (₹)', type: 'number', min: '0', defaultValue: '0' },
                { name: 'overdraft_limit', label: 'Overdraft limit (₹)', type: 'number', min: '0', defaultValue: '0' },
              ]}
            />
          </details>
        </Card>
      ) : null}

      <Card title="Ledger" sub={`latest ${txns.length} entries`} flush>
        <form className="filters" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <label className="field grow">
            Search narration <span className="hint">full-text</span>
            <input name="q" defaultValue={f.q ?? ''} placeholder="e.g. rent, salaries, bank charges" />
          </label>
          <label className="field">
            Account
            <select name="account" defaultValue={f.account ?? ''}>
              <option value="">Any</option>
              {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_name}</option>)}
            </select>
          </label>
          <label className="field">
            Type
            <select name="direction" defaultValue={f.direction ?? ''}>
              <option value="">Any</option><option value="credit">Credit</option><option value="debit">Debit</option>
            </select>
          </label>
          <label className="field">From<input type="date" name="from" defaultValue={f.from ?? ''} /></label>
          <label className="field">To<input type="date" name="to" defaultValue={f.to ?? ''} /></label>
          <button className="btn primary">Apply</button>
          <Link href="/accounts" className="btn">Clear</Link>
        </form>
        {txns.length === 0 ? <div className="empty">No ledger entries match.</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Date</th><th>Narration</th><th>Account</th><th>Kind</th><th className="num">Debit</th><th className="num">Credit</th><th>By</th>{admin ? <th></th> : null}</tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.txn_id}>
                    <td className="nowrap">{fmtDate(t.txn_date)}</td>
                    <td>{t.commitment_id ? <Link href={`/commitments/${t.commitment_id}`}>{t.narration}</Link> : t.narration}</td>
                    <td>{t.account_name}</td>
                    <td><span className="badge plain b-neutral">{titleCase(t.txn_kind)}</span></td>
                    <td className="num">{t.direction === 'debit' ? moneyExact(t.amount) : ''}</td>
                    <td className="num pos">{t.direction === 'credit' ? moneyExact(t.amount) : ''}</td>
                    <td className="small muted">{t.recorded_by_name ?? '-'}</td>
                    {admin ? (
                      <td>
                        {t.txn_kind !== 'opening' ? (
                          <ActionButton
                            method="DELETE"
                            url={`/api/transactions/${t.txn_id}`}
                            label="Reverse"
                            className="btn sm danger"
                            confirm="Delete this entry? The balance and any linked instalment will be reversed."
                          />
                        ) : null}
                      </td>
                    ) : null}
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
