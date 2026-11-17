import { route, toInt, toText, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';
import { logEvent } from '@/lib/mongo';

// PATCH /api/users/:id  { role?, is_active?, full_name?, password? }
// trg_users_last_admin refuses to demote or deactivate the last admin.
export const PATCH = route(async ({ session, params, body }) => {
  const id = toInt(params.id, 'Id');
  const sets = [];
  const values = [id];
  if (body.role !== undefined) { values.push(toText(body.role, 'Role')); sets.push(`role = $${values.length}`); }
  if (body.is_active !== undefined) { values.push(Boolean(body.is_active)); sets.push(`is_active = $${values.length}`); }
  if (body.full_name !== undefined) { values.push(toText(body.full_name, 'Name')); sets.push(`full_name = $${values.length}`); }
  if (!sets.length && !body.password) throw new ApiError(400, 'Nothing to update.');

  const row = await withSession(session, async (c) => {
    if (body.password) await c.query('CALL sp_reset_password($1, $2)', [id, String(body.password)]);
    if (!sets.length) return (await c.query('SELECT user_id, email, role, is_active FROM v_user_directory WHERE user_id = $1', [id])).rows[0];
    const { rows } = await c.query(
      `UPDATE users SET ${sets.join(', ')} WHERE user_id = $1 RETURNING user_id, email, role, is_active`, values);
    return rows[0];
  });
  if (!row) throw new ApiError(404, 'User not found.');
  await logEvent(session, 'user_updated', { email: row.email, fields: Object.keys(body).filter((k) => k !== 'password').concat(body.password ? ['password'] : []) });
  return row;
}, { roles: ['admin'] });

export const DELETE = route(async ({ session, params }) => {
  const id = toInt(params.id, 'Id');
  if (id === session.userId) throw new ApiError(400, 'You cannot delete your own account.');
  const row = await withSession(session, async (c) =>
    (await c.query('DELETE FROM users WHERE user_id = $1 RETURNING email', [id])).rows[0]);
  if (!row) throw new ApiError(404, 'User not found.');
  await logEvent(session, 'user_deleted', { email: row.email });
  return { ok: true };
}, { roles: ['admin'] });
