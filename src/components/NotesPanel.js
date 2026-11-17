'use client';

import { useState } from 'react';
import { api } from './client';
import { fmtDateTime } from '@/lib/format';

const blank = { title: '', body: '', tags: '', terms: [{ key: '', value: '' }], pinned: false };

function toForm(note) {
  const terms = Object.entries(note.terms ?? {}).map(([key, value]) => ({
    key, value: Array.isArray(value) ? value.join(', ') : String(value),
  }));
  return { title: note.title, body: note.body, tags: note.tags.join(', '), terms: terms.length ? terms : [{ key: '', value: '' }], pinned: note.pinned };
}

/**
 * Notes and contract terms for one commitment, stored in MongoDB.
 * Each note carries free-form "terms" whose keys differ from note to note.
 */
export default function NotesPanel({ commitmentId, initial, canWrite, isAdmin, userId }) {
  const [notes, setNotes] = useState(initial);
  const [editing, setEditing] = useState(null); // null | 'new' | note id
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reload = async () => setNotes(await api('GET', `/api/notes?commitmentId=${commitmentId}`));

  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await reload();
      setEditing(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const save = (e) => {
    e.preventDefault();
    const payload = { ...form, commitmentId };
    run(() => (editing === 'new' ? api('POST', '/api/notes', payload) : api('PATCH', `/api/notes/${editing}`, payload)));
  };

  const setTerm = (i, field, value) =>
    setForm((f) => ({ ...f, terms: f.terms.map((t, j) => (j === i ? { ...t, [field]: value } : t)) }));

  return (
    <section className="card">
      <div className="card-head">
        <h2>Notes and contract terms <span className="sub">&nbsp;MongoDB · commitment_notes</span></h2>
        {canWrite && !editing ? (
          <button className="btn sm primary" onClick={() => { setForm(blank); setEditing('new'); }}>Add note</button>
        ) : null}
      </div>
      <div className="card-body">
        {error ? <div className="msg err" role="alert" style={{ marginBottom: 10 }}>{error}</div> : null}

        {editing ? (
          <form onSubmit={save} className="note" style={{ marginBottom: 12 }}>
            <div className="form-grid">
              <label className="field wide">Title
                <input required minLength={3} maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </label>
              <label className="field wide">Note
                <textarea required maxLength={5000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
              </label>
              <label className="field wide">Tags <span className="hint">comma separated, e.g. negotiable, penalty</span>
                <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              </label>
              <div className="wide">
                <div className="small" style={{ fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>
                  Terms <span className="hint" style={{ fontWeight: 400 }}>any name and value; every commitment can have different ones</span>
                </div>
                {form.terms.map((t, i) => (
                  <div key={i} className="row" style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
                    <input placeholder="name, e.g. graceDays" value={t.key} onChange={(e) => setTerm(i, 'key', e.target.value)} />
                    <input placeholder="value, e.g. 3" value={t.value} onChange={(e) => setTerm(i, 'value', e.target.value)} />
                    <button type="button" className="btn sm" aria-label="Remove term" onClick={() => setForm((f) => ({ ...f, terms: f.terms.filter((_, j) => j !== i) }))}>×</button>
                  </div>
                ))}
                <button type="button" className="btn sm" onClick={() => setForm((f) => ({ ...f, terms: [...f.terms, { key: '', value: '' }] }))}>Add term</button>
              </div>
              <label className="field check wide">
                <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
                <span>Pin to the top</span>
              </label>
            </div>
            <div className="form-foot">
              <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : editing === 'new' ? 'Add note' : 'Save note'}</button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        ) : null}

        {notes.length === 0 && !editing ? <div className="empty">No notes yet for this commitment.</div> : null}

        {notes.filter((n) => n._id !== editing).map((n) => (
          <article key={n._id} className={`note ${n.pinned ? 'pinned' : ''}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3>{n.pinned ? '★ ' : ''}{n.title}</h3>
              <span className="small muted">{n.author.name} · {fmtDateTime(n.updatedAt)}</span>
            </div>
            <p className="note-body">{n.body}</p>
            {Object.keys(n.terms ?? {}).length ? (
              <dl className="kv" style={{ marginBottom: 8 }}>
                {Object.entries(n.terms).map(([k, v]) => (
                  <span key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
                  </span>
                ))}
              </dl>
            ) : null}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>{n.tags.map((t) => <a key={t} className="tag" href={`/notes?tag=${t}`}>{t}</a>)}</div>
              {canWrite ? (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" disabled={busy} onClick={() => run(() => api('PATCH', `/api/notes/${n._id}`, { pinned: !n.pinned }))}>
                    {n.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button className="btn sm" onClick={() => { setForm(toForm(n)); setEditing(n._id); }}>Edit</button>
                  {isAdmin || n.author.userId === userId ? (
                    <button
                      className="btn sm danger"
                      disabled={busy}
                      onClick={() => window.confirm('Delete this note?') && run(() => api('DELETE', `/api/notes/${n._id}`))}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
