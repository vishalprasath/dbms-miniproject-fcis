import { route, toAmount, toDate, toInt, toText, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';
import { getCommitment } from '@/lib/data';
import { getMongo, logEvent } from '@/lib/mongo';

export const GET = route(async ({ session, params }) => {
  const data = await withSession(session, (c) => getCommitment(c, toInt(params.id, 'Id')));
  if (!data) throw new ApiError(404, 'Commitment not found.');
  return data;
});

// PATCH: only the fields that are sent are changed.
// Triggers re-price or waive instalments and write the audit trail.
const EDITABLE = {
  title: (v) => toText(v, 'Title'),
  description: (v) => toText(v, 'Description', { required: false }),
  amount: (v) => toAmount(v),
  priority: (v) => toInt(v, 'Priority'),
  is_flexible: (v) => Boolean(v),
  status: (v) => toText(v, 'Status'),
  end_date: (v) => (v ? toDate(v, 'End date') : null),
  category_id: (v) => toInt(v, 'Category'),
  counterparty_id: (v) => toInt(v, 'Counterparty'),
};

export const PATCH = route(async ({ session, params, body }) => {
  const id = toInt(params.id, 'Id');
  const sets = [];
  const values = [id];
  for (const [field, parse] of Object.entries(EDITABLE)) {
    if (body[field] === undefined) continue;
    values.push(parse(body[field]));
    sets.push(`${field} = $${values.length}`);
  }
  if (!sets.length) throw new ApiError(400, 'Nothing to update.');
  const updated = await withSession(session, async (c) => {
    const { rows } = await c.query(
      `UPDATE commitments SET ${sets.join(', ')} WHERE commitment_id = $1 RETURNING commitment_id, title, status`,
      values,
    );
    return rows[0];
  });
  if (!updated) throw new ApiError(404, 'Commitment not found.');
  await logEvent(session, 'commitment_updated', { commitmentId: id, title: updated.title, fields: Object.keys(body) });
  return updated;
});

// DELETE: only the admin database role holds DELETE. The foreign key from
// the ledger blocks deletion of anything with payment history.
export const DELETE = route(async ({ session, params }) => {
  const id = toInt(params.id, 'Id');
  const deleted = await withSession(session, async (c) => {
    const { rows } = await c.query('DELETE FROM commitments WHERE commitment_id = $1 RETURNING title', [id]);
    return rows[0];
  });
  if (!deleted) throw new ApiError(404, 'Commitment not found.');
  const db = await getMongo();
  const notes = await db.collection('commitment_notes').deleteMany({ commitmentId: id });
  await logEvent(session, 'commitment_deleted', { commitmentId: id, title: deleted.title, notesRemoved: notes.deletedCount });
  return { ok: true };
});
