import { ObjectId } from 'mongodb';
import { route, toText, ApiError } from '@/lib/api';
import { getMongo, logEvent } from '@/lib/mongo';

function oid(id) {
  if (!ObjectId.isValid(id)) throw new ApiError(400, 'Invalid snapshot id.');
  return new ObjectId(id);
}

// PATCH /api/snapshots/:id  { annotation?, pinned? }
// $push appends to the embedded annotations array; $set flips the pin.
export const PATCH = route(async ({ session, params, body }) => {
  const update = {};
  if (body.annotation !== undefined) {
    update.$push = { annotations: { text: toText(body.annotation, 'Annotation'), by: session.name, at: new Date() } };
  }
  if (body.pinned !== undefined) update.$set = { pinned: Boolean(body.pinned) };
  if (!Object.keys(update).length) throw new ApiError(400, 'Nothing to update.');
  const db = await getMongo();
  const res = await db.collection('forecast_snapshots').updateOne({ _id: oid(params.id) }, update);
  if (!res.matchedCount) throw new ApiError(404, 'Snapshot not found.');
  await logEvent(session, 'snapshot_updated', { snapshotId: params.id, fields: Object.keys(body) });
  return { ok: true };
}, { roles: ['admin', 'analyst'] });

// DELETE /api/snapshots/:id  -> admin only; pinned snapshots are protected
export const DELETE = route(async ({ session, params }) => {
  const db = await getMongo();
  const { deletedCount } = await db.collection('forecast_snapshots').deleteOne({ _id: oid(params.id), pinned: false });
  if (!deletedCount) throw new ApiError(409, 'Snapshot not found, or it is pinned. Unpin it first.');
  await logEvent(session, 'snapshot_deleted', { snapshotId: params.id });
  return { ok: true };
}, { roles: ['admin'] });
