'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './client';

export default function UserRowActions({ user, isSelf }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn) {
    setBusy(true);
    setError('');
    try { await fn(); router.refresh(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const patch = (body) => run(() => api('PATCH', `/api/users/${user.user_id}`, body));

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <select aria-label="Role" value={user.role} disabled={busy} onChange={(e) => patch({ role: e.target.value })} style={{ width: 'auto' }}>
          <option value="viewer">Viewer</option><option value="analyst">Analyst</option><option value="admin">Admin</option>
        </select>
        <button className="btn sm" disabled={busy} onClick={() => patch({ is_active: !user.is_active })}>
          {user.is_active ? 'Disable' : 'Enable'}
        </button>
        {!isSelf ? (
          <button className="btn sm danger" disabled={busy}
            onClick={() => window.confirm(`Delete ${user.email}?`) && run(() => api('DELETE', `/api/users/${user.user_id}`))}>
            Delete
          </button>
        ) : null}
      </div>
      {error ? <div className="msg err" role="alert">{error}</div> : null}
    </div>
  );
}
