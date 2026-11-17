import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, requireSession } from '@/lib/auth';
import { withSession } from '@/lib/db';
import { getCommitment } from '@/lib/data';
import { notesFor } from '@/lib/docs';
import { daysLabel, fmtDate, money, PRIORITY, titleCase } from '@/lib/format';
import { ActionButton, ApiForm } from '@/components/client';
import { Card, DirectionLabel, PageHead, PriorityBadge, Stat, StatusBadge } from '@/components/ui';
import NotesPanel from '@/components/NotesPanel';
import ScheduleActions from '@/components/ScheduleActions';

export default async function CommitmentPage({ params }) {
  const session = await requireSession();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const data = await withSession(session, (c) => getCommitment(c, id));
  if (!data) notFound();
  const { commitment: c, schedule, totals } = data;
  const notes = await notesFor(id).catch(() => []);
  const writable = can.write(session);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="stack">
      <PageHead
        title={c.title}
        actions={
          <div className="row">
            <StatusBadge value={c.status} />
            <PriorityBadge value={c.priority} />
            <Link href="/commitments" className="btn sm">Back to list</Link>
          </div>
        }
      >
        {c.description}
      </PageHead>

      <div className="stats">
        <Stat label={`${titleCase(c.frequency)} amount`} value={money(c.amount)} note={<DirectionLabel value={c.direction} />} />
        <Stat label="Settled so far" value={money(totals.paid_total)} note={`${totals.paid_count} instalments`} />
        <Stat label="Open instalments" value={totals.open_count} note="generated up to 12 months ahead" />
        <Stat
          label="Average delay"
          value={totals.avg_days_late == null ? '-' : `${totals.avg_days_late} d`}
          note="paid date minus original due date"
        />
      </div>

      <div className="grid-side">
        <Card title="Instalments" sub="last 4 months to next 5 months" flush>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Due</th><th className="num">Due amount</th><th className="num">Settled</th><th>Status</th><th>Settled on</th>{writable ? <th>Action</th> : null}</tr>
              </thead>
              <tbody>
                {schedule.map((s) => (
                  <tr key={s.schedule_id}>
                    <td className="nowrap">
                      {fmtDate(s.due_date)}
                      {s.due_date !== s.original_due_date ? <div className="sub">deferred from {fmtDate(s.original_due_date, { year: false })}</div> : null}
                      {['pending', 'partial', 'overdue'].includes(s.status) ? <div className="sub">{daysLabel(s.days_until)}</div> : null}
                    </td>
                    <td className="num">{money(s.amount_due)}</td>
                    <td className="num">{s.amount_paid ? money(s.amount_paid) : <span className="muted">-</span>}</td>
                    <td><StatusBadge value={s.status} /></td>
                    <td className="nowrap">{s.paid_on ? fmtDate(s.paid_on, { year: false }) : <span className="muted">-</span>}</td>
                    {writable ? (
                      <td>
                        {['pending', 'partial', 'overdue'].includes(s.status) && c.status !== 'closed' ? (
                          <ScheduleActions
                            scheduleId={s.schedule_id}
                            outstanding={s.outstanding}
                            dueDate={s.due_date}
                            today={today}
                            canPay={s.due_date <= today || s.days_until <= 31}
                            canDefer={c.is_flexible}
                            verb={c.direction === 'inflow' ? 'Record receipt' : 'Record payment'}
                          />
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Details">
            <dl className="kv">
              <dt>Counterparty</dt><dd>{c.counterparty} <span className="muted">({c.counterparty_kind})</span></dd>
              <dt>Category</dt><dd>{c.category}</dd>
              <dt>Bank account</dt><dd>{c.account_name}</dd>
              <dt>Schedule</dt><dd>{titleCase(c.frequency)} from {fmtDate(c.start_date)}{c.end_date ? ` to ${fmtDate(c.end_date)}` : ''}</dd>
              <dt>Negotiable</dt><dd>{c.is_flexible ? 'Yes, due dates can be deferred' : 'No, fixed due date'}</dd>
              {c.direction === 'inflow' ? (<><dt>Payer reliability</dt><dd>{Math.round(c.reliability_score * 100)}% of the amount is counted in forecasts</dd></>) : null}
              <dt>Created by</dt><dd>{c.created_by_name ?? '-'} on {fmtDate(c.created_at)}</dd>
            </dl>
          </Card>

          {writable ? (
            <Card title="Edit">
              <ApiForm
                method="PATCH"
                url={`/api/commitments/${id}`}
                reset={false}
                submitLabel="Save changes"
                success="Saved. Unpaid future instalments follow the new values."
                fields={[
                  { name: 'amount', label: 'Amount (₹)', type: 'number', step: '0.01', min: '0.01', required: true, defaultValue: String(c.amount) },
                  { name: 'priority', label: 'Priority', type: 'select', required: true, defaultValue: String(c.priority),
                    options: [1, 2, 3, 4, 5].map((p) => ({ value: String(p), label: `P${p} ${PRIORITY[p]}` })) },
                  { name: 'status', label: 'Status', type: 'select', required: true, defaultValue: c.status,
                    options: ['active', 'paused', 'closed'].map((v) => ({ value: v, label: titleCase(v) })) },
                  { name: 'end_date', label: 'Last due date', type: 'date', defaultValue: c.end_date ?? '' },
                  { name: 'is_flexible', label: 'Due date is negotiable', type: 'checkbox', defaultValue: c.is_flexible },
                  { name: 'description', label: 'Description', type: 'textarea', wide: true, defaultValue: c.description ?? '' },
                ]}
              />
              <p className="small muted" style={{ marginTop: 10 }}>
                Paused commitments are left out of forecasts. Closing waives every unpaid instalment and cannot be undone.
              </p>
              {can.admin(session) ? (
                <div style={{ marginTop: 12 }}>
                  <ActionButton
                    method="DELETE"
                    url={`/api/commitments/${id}`}
                    label="Delete commitment"
                    className="btn sm danger"
                    confirm={`Delete "${c.title}" and all its instalments? This cannot be undone.`}
                    redirectTo="/commitments"
                  />
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>
      </div>

      <NotesPanel commitmentId={id} initial={notes} canWrite={writable} isAdmin={can.admin(session)} userId={session.userId} />
    </div>
  );
}
