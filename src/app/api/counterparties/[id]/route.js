import { route, toAmount, toInt, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';

// PATCH /api/counterparties/:id  { reliability_score }
export const PATCH = route(async ({ session, params, body }) => {
  const row = await withSession(session, async (c) => (await c.query(
    'UPDATE counterparties SET reliability_score = $2 WHERE counterparty_id = $1 RETURNING counterparty_id, name, reliability_score',
    [toInt(params.id, 'Id'), toAmount(body.reliability_score, 'Reliability')])).rows[0]);
  if (!row) throw new ApiError(404, 'Counterparty not found.');
  return row;
});
