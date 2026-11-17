import { route, toInt, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';
import { logEvent } from '@/lib/mongo';

// DELETE (admin only at the database): the trigger reverses the balance
// and, for a commitment payment, reopens the instalment.
export const DELETE = route(async ({ session, params }) => {
  const id = toInt(params.id, 'Id');
  const row = await withSession(session, async (c) => {
    const { rows } = await c.query(
      'DELETE FROM transactions WHERE txn_id = $1 RETURNING txn_id, amount, direction, narration', [id]);
    return rows[0];
  });
  if (!row) throw new ApiError(404, 'Transaction not found.');
  await logEvent(session, 'transaction_posted', { action: 'reversed', ...row });
  return { ok: true };
});
