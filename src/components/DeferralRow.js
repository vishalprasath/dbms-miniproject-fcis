'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './client';
import { fmtDate, money } from '@/lib/format';

/** "Simulate" re-projects the account with this instalment moved; "Apply" really moves it. */
export default function DeferralRow({ alertId, scheduleId, toDate, canApply }) {
  const router = useRouter();
  const [sim, setSim] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(fn) {
    setBusy(true);
    setError('');
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" disabled={busy}
          onClick={() => run(async () => setSim(await api('GET', `/api/forecast/simulate?alert=${alertId}&schedule=${scheduleId}&to=${toDate}`)))}>
          Simulate
        </button>
        {canApply ? (
          <button className="btn sm primary" disabled={busy}
            onClick={() => window.confirm(`Move this payment to ${fmtDate(toDate)}?`) && run(async () => {
              await api('POST', `/api/schedule/${scheduleId}/defer`, { new_date: toDate });
              await api('POST', '/api/forecast/run', { horizon: 60 });
              router.refresh();
            })}>
            Apply
          </button>
        ) : null}
      </div>
      {sim ? (
        <div className="small">
          Lowest balance {money(sim.before.min_balance)} → <b className={sim.after.min_balance < 0 ? 'neg' : ''}>{money(sim.after.min_balance)}</b>
          <br />Short days {sim.before.shortfall_days} → <b>{sim.after.shortfall_days}</b>
        </div>
      ) : null}
      {error ? <div className="msg err" role="alert">{error}</div> : null}
    </div>
  );
}
