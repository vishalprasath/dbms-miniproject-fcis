import { route, toAmount, toInt, toText } from '@/lib/api';
import { withSession } from '@/lib/db';
import { logEvent } from '@/lib/mongo';

// POST /api/transfers  { from_account, to_account, amount, narration? }
// Debit and credit are written in one transaction: both or neither.
export const POST = route(async ({ session, body }) => {
  const from = toInt(body.from_account, 'From account');
  const to = toInt(body.to_account, 'To account');
  const amount = toAmount(body.amount);
  const narration = toText(body.narration, 'Narration', { required: false });
  await withSession(session, (c) => c.query('CALL sp_transfer_funds($1, $2, $3, $4)', [from, to, amount, narration]));
  await logEvent(session, 'funds_transferred', { from, to, amount });
  return { ok: true };
});
