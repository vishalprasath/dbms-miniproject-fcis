'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './client';

/** Inline "record payment" and "defer" controls for one instalment. */
export default function ScheduleActions({ scheduleId, outstanding, dueDate, today, canPay, canDefer, verb }) {
  const router = useRouter();
  const [mode, setMode] = useState(null); // 'pay' | 'defer'
  const [amount, setAmount] = useState(String(outstanding));
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'pay') await api('POST', `/api/schedule/${scheduleId}/pay`, { amount, txn_date: date || today });
      else await api('POST', `/api/schedule/${scheduleId}/defer`, { new_date: date });
      setMode(null);
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!mode) {
    return (
      <div className="row" style={{ gap: 6 }}>
        {canPay ? <button className="btn sm" onClick={() => { setMode('pay'); setDate(today); }}>{verb}</button> : null}
        {canDefer ? <button className="btn sm" onClick={() => { setMode('defer'); setDate(''); }}>Defer</button> : null}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 6, minWidth: 210 }}>
      {mode === 'pay' ? (
        <>
          <input type="number" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
          <input type="date" required max={today} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        </>
      ) : (
        <input type="date" required min={dueDate} value={date} onChange={(e) => setDate(e.target.value)} aria-label="New due date" />
      )}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm primary" disabled={busy}>{busy ? 'Saving…' : mode === 'pay' ? 'Confirm' : 'Move due date'}</button>
        <button type="button" className="btn sm" onClick={() => { setMode(null); setError(''); }}>Cancel</button>
      </div>
      {error ? <div className="msg err" role="alert">{error}</div> : null}
    </form>
  );
}
