import { route, toAmount, toInt, toText, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';
import { logEvent } from '@/lib/mongo';

// PATCH /api/accounts/:id
// Column-level grants decide what each role may change: an analyst can
// update min_buffer only; an admin can also rename, set limits, deactivate.
const EDITABLE = {
  min_buffer: (v) => toAmount(v, 'Minimum buffer'),
  overdraft_limit: (v) => toAmount(v, 'Overdraft limit'),
  account_name: (v) => toText(v, 'Account name'),
  is_active: (v) => Boolean(v),
};

export const PATCH = route(async ({ session, params, body }) => {
  const id = toInt(params.id, 'Id');
  const sets = [];
  const values = [id];
  for (const [field, parse] of Object.entries(EDITABLE)) {
    if (body[field] === undefined || body[field] === '') continue;
    values.push(parse(body[field]));
    sets.push(`${field} = $${values.length}`);
  }
  if (!sets.length) throw new ApiError(400, 'Nothing to update.');
  const row = await withSession(session, async (c) => {
    const { rows } = await c.query(
      `UPDATE bank_accounts SET ${sets.join(', ')} WHERE account_id = $1 RETURNING account_id, account_name, min_buffer`, values);
    return rows[0];
  });
  if (!row) throw new ApiError(404, 'Account not found.');
  await logEvent(session, 'account_updated', { account: row.account_name, fields: Object.keys(body) });
  return row;
});
