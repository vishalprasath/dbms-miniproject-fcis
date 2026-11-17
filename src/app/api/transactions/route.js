import { route, toAmount, toDate, toInt, toText } from '@/lib/api';
import { withSession } from '@/lib/db';
import { listTransactions } from '@/lib/data';
import { logEvent } from '@/lib/mongo';

// GET /api/transactions?account=&direction=&q=&from=&to=
export const GET = route(async ({ session, query }) => withSession(session, (c) => listTransactions(c, query)));

// POST: a manual ledger entry. Nobody has INSERT on the ledger table;
// entries go through sp_post_transaction, which checks funds first.
export const POST = route(async ({ session, body }) => {
  const accountId = toInt(body.account_id, 'Account');
  const direction = toText(body.direction, 'Direction');
  const amount = toAmount(body.amount);
  const narration = toText(body.narration, 'Narration');
  const date = body.txn_date ? toDate(body.txn_date, 'Date') : null;
  await withSession(session, (c) =>
    c.query('CALL sp_post_transaction($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE))', [accountId, direction, amount, narration, date]));
  await logEvent(session, 'transaction_posted', { accountId, direction, amount, narration });
  return { ok: true };
});
