import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { withSession } from '@/lib/db';
import { adminPage } from '@/lib/data';
import { recentActivity } from '@/lib/docs';
import { fmtDate, fmtDateTime, titleCase } from '@/lib/format';
import { ActionButton, ApiForm } from '@/components/client';
import { Card, PageHead, StatusBadge } from '@/components/ui';
import UserRowActions from '@/components/UserRowActions';

const EVENT_TYPES = ['login', 'login_failed', 'payment_recorded', 'forecast_run', 'commitment_created', 'commitment_updated',
  'schedule_deferred', 'transaction_posted', 'funds_transferred', 'alert_updated', 'note_created', 'user_created', 'user_updated'];

export default async function AdminPage({ searchParams }) {
  const session = await requireSession(['admin']);
  const sp = await searchParams;
  const { users, audit, matrix } = await withSession(session, (c) => adminPage(c));
  const events = await recentActivity({ type: sp.type || undefined, limit: 30 }).catch(() => []);

  const tables = [...new Set(matrix.map((m) => m.table_name))];
  const cell = (t, r) => matrix.find((m) => m.table_name === t && m.role_name === r)?.privileges || '';

  return (
    <div className="stack">
      <PageHead title="Administration">
        Users, the privileges PostgreSQL grants to each role, the trigger-written audit trail and the activity stream.
      </PageHead>

      <div className="grid-side">
        <Card title="Users" sub="read through v_user_directory; the password hash is never selectable" flush>
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Role</th><th>State</th><th>Since</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.user_id}>
                    <td><b>{u.full_name}</b><div className="sub">{u.email}</div></td>
                    <td><StatusBadge value={u.role} /></td>
                    <td>{u.is_active ? <span className="badge b-good">Active</span> : <span className="badge b-neutral">Disabled</span>}</td>
                    <td className="nowrap">{fmtDate(u.created_at)}</td>
                    <td><UserRowActions user={u} isSelf={u.user_id === session.userId} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Add a user" sub="sp_create_user · bcrypt in the database">
          <ApiForm
            url="/api/users"
            submitLabel="Create user"
            success="User created."
            fields={[
              { name: 'full_name', label: 'Full name', required: true, wide: true },
              { name: 'email', label: 'E-mail', type: 'email', required: true, wide: true },
              { name: 'password', label: 'Password', type: 'password', required: true, hint: 'min 8 characters' },
              { name: 'role', label: 'Role', type: 'select', required: true, defaultValue: 'viewer',
                options: ['viewer', 'analyst', 'admin'].map((r) => ({ value: r, label: titleCase(r) })) },
            ]}
          />
        </Card>
      </div>

      <Card title="Database privilege matrix" sub="live from has_table_privilege() · S select, I insert, U update, u update on some columns, D delete" flush>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Table</th><th>fcis_viewer</th><th>fcis_analyst</th><th>fcis_admin</th></tr></thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t}>
                  <td><code>{t}</code></td>
                  {['fcis_viewer', 'fcis_analyst', 'fcis_admin'].map((r) => (
                    <td key={r}><code>{cell(t, r) || <span className="muted">none</span>}</code></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ padding: '10px 18px' }}>
          Nobody holds INSERT or UPDATE on <code>transactions</code>, <code>commitment_schedule</code>, <code>forecast_runs</code> or
          <code> audit_log</code>: those rows are written only by SECURITY DEFINER procedures and triggers.
        </p>
      </Card>

      <div className="grid-2">
        <Card title="Audit trail" sub="PostgreSQL · audit_log, written by triggers" flush>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Table</th><th>Action</th><th>Row</th><th>By</th></tr></thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.audit_id}>
                    <td className="nowrap">{fmtDateTime(a.changed_at)}</td>
                    <td><code>{a.table_name}</code></td>
                    <td><StatusBadge value={a.action} /></td>
                    <td>#{a.row_pk}{a.title ? <div className="sub">{a.title}</div> : null}{a.changed_fields ? <div className="sub">changed: {a.changed_fields}</div> : null}</td>
                    <td className="small">{a.changed_by_name ?? 'system'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          title="Activity stream"
          sub="MongoDB · activity_events (TTL 180 days)"
          flush
        >
          <form className="filters" style={{ padding: '12px 18px', borderBottom: '1px solid var(--line)' }}>
            <label className="field">
              Event type
              <select name="type" defaultValue={sp.type ?? ''}>
                <option value="">All</option>
                {EVENT_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
              </select>
            </label>
            <button className="btn primary">Filter</button>
            <Link href="/admin" className="btn">Clear</Link>
          </form>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Event</th><th>Who</th><th>Details</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e._id}>
                    <td className="nowrap">{fmtDateTime(e.at)}</td>
                    <td><span className={`badge plain ${e.type === 'login_failed' ? 'b-critical' : 'b-neutral'}`}>{titleCase(e.type)}</span></td>
                    <td className="small">{e.actor.name}<div className="sub">{e.actor.role}</div></td>
                    <td className="small muted">{Object.entries(e.payload ?? {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
