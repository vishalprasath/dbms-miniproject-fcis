import { requireSession } from '@/lib/auth';
import { queryAs } from '@/lib/db';
import { LogoutButton, NavLinks } from '@/components/client';
import { StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }) {
  const session = await requireSession();
  const [{ n }] = await queryAs(session, 'SELECT COUNT(*)::int AS n FROM v_live_alerts');

  const items = [
    { href: '/', label: 'Dashboard' },
    { href: '/commitments', label: 'Commitments' },
    { href: '/accounts', label: 'Accounts & Ledger' },
    { href: '/forecast', label: 'Forecast & Alerts', count: n },
    { href: '/notes', label: 'Notes' },
    { href: '/insights', label: 'Insights' },
  ];
  if (session.role === 'admin') items.push({ href: '/admin', label: 'Administration' });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">FC</div>
          <div>
            <div className="brand-name">FCIS</div>
            <div className="brand-sub">Kaveri Print Works</div>
          </div>
        </div>
        <NavLinks items={items} />
        <div className="sidebar-foot">
          <div className="who">{session.name}</div>
          <div className="who-mail">{session.email}</div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <StatusBadge value={session.role} />
            <LogoutButton />
          </div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
