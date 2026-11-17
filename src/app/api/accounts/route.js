import { route, toAmount, toText } from '@/lib/api';
import { withSession } from '@/lib/db';
import { accountHealth } from '@/lib/data';
import { logEvent } from '@/lib/mongo';

export const GET = route(async ({ session }) => withSession(session, (c) => accountHealth(c)));

// POST: INSERT on bank_accounts is granted to fcis_admin only.
export const POST = route(async ({ session, body }) => {
  const values = [
    toText(body.account_name, 'Account name'),
    toText(body.bank_name, 'Bank'),
    toText(body.account_last4, 'Last 4 digits'),
    toText(body.account_type, 'Type'),
    toAmount(body.min_buffer || 0, 'Minimum buffer'),
    toAmount(body.overdraft_limit || 0, 'Overdraft limit'),
  ];
  const row = await withSession(session, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO bank_accounts (account_name, bank_name, account_last4, account_type, min_buffer, overdraft_limit)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING account_id, account_name`, values);
    return rows[0];
  });
  await logEvent(session, 'account_updated', { account: row.account_name, action: 'created' });
  return row;
});
