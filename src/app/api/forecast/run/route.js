import { route, toInt } from '@/lib/api';
import { withSession } from '@/lib/db';
import { getMongo, logEvent } from '@/lib/mongo';
import { buildSnapshots } from '@/lib/snapshot.mjs';

// POST /api/forecast/run  { horizon }
// 1. PostgreSQL: sp_run_forecast projects every account and raises alerts.
// 2. MongoDB:   the full curve of each account is stored as one document.
// The snapshot is written before COMMIT, so if MongoDB rejects it the
// relational run is rolled back too.
export const POST = route(async ({ session, body }) => {
  const horizon = toInt(body.horizon ?? 60, 'Horizon');
  const db = await getMongo();
  const result = await withSession(session, async (c) => {
    const call = await c.query('CALL sp_run_forecast($1, NULL)', [horizon]);
    const batchId = call.rows[0].p_batch_id;
    const snapshots = await buildSnapshots({ pg: c, db, batchId, actor: { userId: session.userId, name: session.name } });
    const alerts = await c.query('SELECT COUNT(*)::int AS n FROM v_live_alerts');
    return { batchId, snapshots, liveAlerts: alerts.rows[0].n };
  });
  await logEvent(session, 'forecast_run', { horizonDays: horizon, ...result });
  return result;
}, { roles: ['admin', 'analyst'] });
