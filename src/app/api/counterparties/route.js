import { route, toAmount, toText } from '@/lib/api';
import { withSession } from '@/lib/db';

export const GET = route(async ({ session }) =>
  withSession(session, async (c) => (await c.query('SELECT * FROM v_counterparty_exposure ORDER BY name')).rows));

export const POST = route(async ({ session, body }) => {
  const values = [
    toText(body.name, 'Name'),
    toText(body.kind, 'Kind'),
    toText(body.contact_email, 'E-mail', { required: false }),
    toText(body.phone, 'Phone', { required: false }),
    body.reliability_score === undefined || body.reliability_score === '' ? 1 : toAmount(body.reliability_score, 'Reliability'),
  ];
  return withSession(session, async (c) => (await c.query(
    `INSERT INTO counterparties (name, kind, contact_email, phone, reliability_score)
     VALUES ($1, $2, $3, $4, $5) RETURNING counterparty_id, name`, values)).rows[0]);
});
