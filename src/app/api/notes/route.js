import { route, toInt, toText, ApiError } from '@/lib/api';
import { withSession } from '@/lib/db';
import { getMongo, logEvent, plain } from '@/lib/mongo';
import { notesFor, searchNotes } from '@/lib/docs';
import { cleanTags, cleanTerms } from '@/lib/notes';


// GET /api/notes?commitmentId=  |  /api/notes?q=&tag=
export const GET = route(async ({ query }) => {
  if (query.commitmentId) return notesFor(toInt(query.commitmentId, 'Commitment'));
  return searchNotes({ q: query.q?.trim(), tag: query.tag?.trim() });
});

// POST /api/notes
export const POST = route(async ({ session, body }) => {
  const commitmentId = toInt(body.commitmentId, 'Commitment');
  // the note must point at a real commitment in PostgreSQL
  const found = await withSession(session, async (c) =>
    (await c.query('SELECT title FROM commitments WHERE commitment_id = $1', [commitmentId])).rows[0]);
  if (!found) throw new ApiError(404, 'Commitment not found.');

  const now = new Date();
  const doc = {
    commitmentId,
    title: toText(body.title, 'Title'),
    body: toText(body.body, 'Note'),
    tags: cleanTags(body.tags),
    terms: cleanTerms(body.terms),
    author: { userId: session.userId, name: session.name },
    pinned: Boolean(body.pinned),
    createdAt: now,
    updatedAt: now,
  };
  const db = await getMongo();
  const { insertedId } = await db.collection('commitment_notes').insertOne(doc);
  await logEvent(session, 'note_created', { commitment: found.title, tags: doc.tags });
  return plain({ ...doc, _id: insertedId });
}, { roles: ['admin', 'analyst'] });
