import { route, toAmount, toDate, toInt, toText } from '@/lib/api';
import { withSession } from '@/lib/db';
import { logEvent } from '@/lib/mongo';

// POST /api/schedule/:id/pay  { amount, txn_date?, narration? }
// One transaction: ledger insert + balance trigger + instalment update.
// If the procedure raises (insufficient funds, overpayment ...), all of it rolls back.
export const POST = route(async ({ session, params, body }) => {
  const scheduleId = toInt(params.id, 'Instalment');
  const amount = toAmount(body.amount);
  const date = body.txn_date ? toDate(body.txn_date, 'Date') : null;
  const narration = toText(body.narration, 'Narration', { required: false });

  const result = await withSession(session, async (c) => {
    await c.query('CALL sp_record_payment($1, $2, COALESCE($3::date, CURRENT_DATE), $4)', [scheduleId, amount, date, narration]);
    const { rows } = await c.query(
      `SELECT s.status, s.amount_paid, s.amount_due, c.title, c.direction, a.account_name, a.current_balance
         FROM commitment_schedule s
         JOIN commitments c   ON c.commitment_id = s.commitment_id
         JOIN bank_accounts a ON a.account_id = c.account_id
        WHERE s.schedule_id = $1`, [scheduleId]);
    return rows[0];
  });
  await logEvent(session, 'payment_recorded', {
    scheduleId, amount, direction: result.direction, commitment: result.title, status: result.status,
  });
  return result;
});
