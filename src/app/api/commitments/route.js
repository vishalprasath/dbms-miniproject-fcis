import { route, toAmount, toDate, toInt, toText, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';
import { listCommitments } from '@/lib/data';
import { logEvent } from '@/lib/mongo';

// GET /api/commitments?q=&status=&direction=&account=&category=
export const GET = route(async ({ session, query }) => withSession(session, (c) => listCommitments(c, query)));

// POST /api/commitments
// Direction is taken from the category; the AFTER INSERT trigger generates the instalments.
export const POST = route(async ({ session, body }) => {
  const input = [
    toText(body.title, 'Title'),
    toText(body.description, 'Description', { required: false }),
    toInt(body.category_id, 'Category'),
    toInt(body.counterparty_id, 'Counterparty'),
    toInt(body.account_id, 'Account'),
    toAmount(body.amount),
    toText(body.frequency, 'Frequency'),
    toDate(body.start_date, 'Start date'),
    body.end_date ? toDate(body.end_date, 'End date') : null,
    toInt(body.priority ?? 3, 'Priority'),
    Boolean(body.is_flexible),
  ];
  const created = await withSession(session, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO commitments (title, description, category_id, counterparty_id, account_id, direction,
                                amount, frequency, start_date, end_date, priority, is_flexible, created_by)
       SELECT $1, $2, cat.category_id, $4, $5, cat.direction, $6, $7, $8, $9, $10, $11, fn_app_user()
         FROM categories cat WHERE cat.category_id = $3
       RETURNING commitment_id, title,
                 (SELECT COUNT(*) FROM commitment_schedule s WHERE s.commitment_id = commitments.commitment_id) AS instalments`,
      input,
    );
    if (!rows.length) throw new ApiError(400, 'That category does not exist.');
    // instalments are created by the trigger in the same transaction
    const count = await c.query('SELECT COUNT(*)::int AS n FROM commitment_schedule WHERE commitment_id = $1', [rows[0].commitment_id]);
    return { commitment_id: rows[0].commitment_id, title: rows[0].title, instalments: count.rows[0].n };
  });
  await logEvent(session, 'commitment_created', { commitmentId: created.commitment_id, title: created.title, instalments: created.instalments });
  return created;
});
