import { route, toText } from '@/lib/api';
import { withSession } from '@/lib/db';
import { logEvent } from '@/lib/mongo';

// Both handlers also carry an application-level role check, but the real
// gate is the database: only fcis_admin can execute sp_create_user.
export const GET = route(async ({ session }) =>
  withSession(session, async (c) => (await c.query('SELECT * FROM v_user_directory ORDER BY user_id')).rows),
{ roles: ['admin'] });

export const POST = route(async ({ session, body }) => {
  const name = toText(body.full_name, 'Name');
  const email = toText(body.email, 'E-mail');
  const password = toText(body.password, 'Password');
  const role = toText(body.role, 'Role');
  await withSession(session, (c) => c.query('CALL sp_create_user($1, $2, $3, $4)', [name, email, password, role]));
  await logEvent(session, 'user_created', { email: email.toLowerCase(), role });
  return { ok: true };
}, { roles: ['admin'] });
