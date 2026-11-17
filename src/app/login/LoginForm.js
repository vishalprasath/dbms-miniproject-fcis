'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/components/client';

const DEMO = [
  { role: 'Admin', email: 'admin@fcis.local', note: 'users, accounts, deletes, audit' },
  { role: 'Analyst', email: 'analyst@fcis.local', note: 'commitments, payments, forecasts' },
  { role: 'Viewer', email: 'viewer@fcis.local', note: 'read only' },
];

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/auth/login', { email, password });
      router.push('/');
      router.refresh();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={submit} className="stack" style={{ gap: 12 }}>
        <label className="field">
          E-mail
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error ? <div className="msg err" role="alert">{error}</div> : null}
        <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="demo-accounts">
        <div className="small muted">Demo accounts (passwords are in the README). Click to fill the e-mail.</div>
        {DEMO.map((d) => (
          <button key={d.email} type="button" className="btn sm" onClick={() => setEmail(d.email)}>
            <span><b>{d.role}</b> · {d.email}</span>
            <span className="muted">{d.note}</span>
          </button>
        ))}
      </div>
    </>
  );
}
