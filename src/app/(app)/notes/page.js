import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { queryAs } from '@/lib/db';
import { searchNotes, tagCounts } from '@/lib/docs';
import { fmtDateTime } from '@/lib/format';
import { Card, PageHead } from '@/components/ui';

export default async function NotesPage({ searchParams }) {
  const session = await requireSession();
  const sp = await searchParams;
  const q = sp.q?.trim() || '';
  const tag = sp.tag?.trim() || '';

  let notes = [];
  let tags = [];
  let down = false;
  try {
    [notes, tags] = await Promise.all([searchNotes({ q, tag }), tagCounts()]);
  } catch {
    down = true;
  }
  // titles come from PostgreSQL: the note only stores the commitment id
  const ids = [...new Set(notes.map((n) => n.commitmentId))];
  const titles = ids.length
    ? await queryAs(session, 'SELECT commitment_id, title FROM commitments WHERE commitment_id = ANY($1::int[])', [ids])
    : [];
  const titleOf = new Map(titles.map((t) => [t.commitment_id, t.title]));

  return (
    <div className="stack">
      <PageHead title="Notes">
        Contract terms, phone-call outcomes and follow-ups attached to commitments. Stored as documents in MongoDB
        because every note has a different set of terms; searched with a weighted text index.
      </PageHead>

      {down ? <div className="banner warn">MongoDB is not reachable, so notes cannot be shown.</div> : null}

      <div className="grid-side">
        <Card title={q || tag ? 'Search results' : 'All notes'} sub={`${notes.length} notes`}>
          <form className="filters" style={{ marginBottom: 14 }}>
            <label className="field grow">
              Search notes <span className="hint">$text over title, tags and body</span>
              <input name="q" defaultValue={q} placeholder="e.g. penalty, grace period, late payer" />
            </label>
            {tag ? <input type="hidden" name="tag" value={tag} /> : null}
            <button className="btn primary">Search</button>
            <Link href="/notes" className="btn">Clear</Link>
          </form>
          {notes.length === 0 ? <div className="empty">No notes match.</div> : notes.map((n) => (
            <article key={n._id} className={`note ${n.pinned ? 'pinned' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3>{n.pinned ? '★ ' : ''}{n.title}</h3>
                <span className="small muted">
                  {n.score ? `relevance ${n.score.toFixed(2)} · ` : ''}{n.author.name} · {fmtDateTime(n.updatedAt)}
                </span>
              </div>
              <div className="small">
                on <Link href={`/commitments/${n.commitmentId}`}>{titleOf.get(n.commitmentId) ?? `commitment #${n.commitmentId}`}</Link>
              </div>
              <p className="note-body">{n.body}</p>
              {Object.keys(n.terms ?? {}).length ? (
                <div className="small muted" style={{ marginBottom: 8 }}>
                  {Object.entries(n.terms).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('  ·  ')}
                </div>
              ) : null}
              <div>{n.tags.map((t) => <Link key={t} className={`tag ${t === tag ? 'active' : ''}`} href={`/notes?tag=${t}`}>{t}</Link>)}</div>
            </article>
          ))}
        </Card>

        <Card title="Tags" sub="aggregation: $unwind + $group">
          {tags.length === 0 ? <div className="empty">No tags yet.</div> : tags.map((t) => (
            <div key={t.tag} className="row" style={{ justifyContent: 'space-between', marginBottom: 8, flexWrap: 'nowrap' }}>
              <Link className={`tag ${t.tag === tag ? 'active' : ''}`} href={`/notes?tag=${t.tag}`}>{t.tag}</Link>
              <div className="bar-track" style={{ flex: 1 }}><div className="bar-fill" style={{ width: `${(t.notes / tags[0].notes) * 100}%` }} /></div>
              <span className="small muted nowrap">{t.notes} {t.notes === 1 ? 'note' : 'notes'}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
