import { route, toDate, toInt, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';
import { simulateDeferral } from '@/lib/data';

// GET /api/forecast/simulate?alert=..&schedule=..&to=YYYY-MM-DD
// What-if: re-project the account with one instalment moved. Nothing is written.
export const GET = route(async ({ session, query }) => {
  const alertId = toInt(query.alert, 'Alert');
  const scheduleId = toInt(query.schedule, 'Instalment');
  const toDateValue = toDate(query.to, 'Date');
  return withSession(session, async (c) => {
    const alert = (await c.query(
      `SELECT al.account_id, r.horizon_days FROM shortfall_alerts al JOIN forecast_runs r ON r.run_id = al.run_id
        WHERE al.alert_id = $1`, [alertId])).rows[0];
    if (!alert) throw new ApiError(404, 'Alert not found.');
    const base = await simulateDeferral(c, { accountId: alert.account_id, horizon: alert.horizon_days, scheduleId: null, toDate: null });
    const moved = await simulateDeferral(c, { accountId: alert.account_id, horizon: alert.horizon_days, scheduleId, toDate: toDateValue });
    return { before: base, after: moved };
  });
});
