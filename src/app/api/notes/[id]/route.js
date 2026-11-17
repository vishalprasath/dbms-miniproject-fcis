import { ObjectId } from 'mongodb';
import { route, toText, ApiError } from '@/lib/api';
import { getMongo, logEvent, plain } from '@/lib/mongo';
import { cleanTags, cleanTerms } from '@/lib/notes';

function oid(id) {
  if (!ObjectId.isValid(id)) throw new ApiError(400, 'Invalid note id.');
  return new ObjectId(id);
}

// PATCH /api/notes/:id  -> $set only what was sent, $currentDate for updatedAt
export const PATCH = route(async ({ session, params, body }) => {
  const set = {};
  if (body.title !== undefined) set.title = toText(body.title, 'Title');
  if (body.body !== undefined) set.body = toText(body.body, 'Note');
  if (body.tags !== undefined) set.tags = cleanTags(body.tags);
  if (body.terms !== undefined) set.terms = cleanTerms(body.terms);
  if (body.pinned !== undefined) set.pinned = Boolean(body.pinned);
  if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to update.');

  const db = await getMongo();
  const updated = await db.collection('commitment_notes').findOneAndUpdate(
    { _id: oid(params.id) },
    { $set: set, $currentDate: { updatedAt: true } },
    { returnDocument: 'after' },
  );
  if (!updated) throw new ApiError(404, 'Note not found.');
  await logEvent(session, 'note_updated', { noteId: params.id, fields: Object.keys(set) });
  return plain(updated);
}, { roles: ['admin', 'analyst'] });

// DELETE /api/notes/:id  -> admins delete anything, analysts only their own notes
export const DELETE = route(async ({ session, params }) => {
  const filter = { _id: oid(params.id) };
  if (session.role !== 'admin') filter['author.userId'] = session.userId;
  const db = await getMongo();
  const { deletedCount } = await db.collection('commitment_notes').deleteOne(filter);
  if (!deletedCount) throw new ApiError(404, 'Note not found, or it belongs to someone else.');
  await logEvent(session, 'note_deleted', { noteId: params.id });
  return { ok: true };
}, { roles: ['admin', 'analyst'] });
