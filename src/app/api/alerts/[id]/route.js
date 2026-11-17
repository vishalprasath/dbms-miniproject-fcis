import { route, toInt, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';
import { logEvent } from '@/lib/mongo';

// PATCH /api/alerts/:id  { status: 'acknowledged' | 'resolved' }
export const PATCH = route(async ({ session, params, body }) => {
  const id = toInt(params.id, 'Id');
  if (!['acknowledged', 'resolved'].includes(body.status)) throw new ApiError(400, 'Status must be acknowledged or resolved.');
  const row = await withSession(session, async (c) => {
    const { rows } = await c.query(
      `UPDATE shortfall_alerts
          SET status = $2, acknowledged_by = fn_app_user(), acknowledged_at = now()
        WHERE alert_id = $1 AND status IN ('open', 'acknowledged')
        RETURNING alert_id, status, severity`, [id, body.status]);
    return rows[0];
  });
  if (!row) throw new ApiError(404, 'Alert not found or no longer live.');
  await logEvent(session, 'alert_updated', row);
  return row;
});
