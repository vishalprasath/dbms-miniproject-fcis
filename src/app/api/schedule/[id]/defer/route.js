import { route, toDate, toInt } from '@/lib/api';
import { withSession } from '@/lib/db';
import { logEvent } from '@/lib/mongo';

// POST /api/schedule/:id/defer  { new_date }
export const POST = route(async ({ session, params, body }) => {
  const scheduleId = toInt(params.id, 'Instalment');
  const newDate = toDate(body.new_date, 'New date');
  const row = await withSession(session, async (c) => {
    await c.query('CALL sp_defer_schedule($1, $2)', [scheduleId, newDate]);
    const { rows } = await c.query(
      `SELECT s.due_date, s.original_due_date, c.title
         FROM commitment_schedule s JOIN commitments c ON c.commitment_id = s.commitment_id
        WHERE s.schedule_id = $1`, [scheduleId]);
    return rows[0];
  });
  await logEvent(session, 'schedule_deferred', { scheduleId, commitment: row.title, from: row.original_due_date, to: row.due_date });
  return row;
});
