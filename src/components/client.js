'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function NavLinks({ items }) {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {items.map((it) => {
        const active = it.href === '/' ? pathname === '/' : pathname.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} className={active ? 'active' : ''}>
            <span>{it.label}</span>
            {it.count ? <span className="nav-count">{it.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="btn ghost sm"
      onClick={async () => {
        await api('POST', '/api/auth/logout');
        router.push('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

/** A button that calls one API endpoint and refreshes the page data. */
export function ActionButton({ method = 'POST', url, body, label, confirm, className = 'btn sm', redirectTo, doneLabel }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError('');
    try {
      await api(method, url, body);
      setDone(true);
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="row" style={{ gap: 8 }}>
      <button className={className} onClick={run} disabled={busy}>
        {busy ? 'Working…' : done && doneLabel ? doneLabel : label}
      </button>
      {error ? <span className="msg err" role="alert">{error}</span> : null}
    </span>
  );
}

function initialValues(fields) {
  const v = {};
  for (const f of fields) v[f.name] = f.defaultValue ?? (f.type === 'checkbox' ? false : '');
  return v;
}

/**
 * A form described by data. Posts JSON to `url` and refreshes the page.
 * field: { name, label, type, options, required, defaultValue, hint, wide, step, min, max, placeholder }
 */
export function ApiForm({ method = 'POST', url, fields, extra, submitLabel = 'Save', success = 'Saved.', reset = true, redirectTo }) {
  const router = useRouter();
  const [values, setValues] = useState(() => initialValues(fields));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const set = (name, value) => setValues((v) => ({ ...v, [name]: value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const data = await api(method, url, { ...extra, ...values });
      setMessage({ ok: true, text: success });
      if (reset) setValues(initialValues(fields));
      if (redirectTo) router.push(typeof redirectTo === 'function' ? redirectTo(data) : redirectTo);
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        {fields.map((f) => {
          const common = {
            id: `${url}-${f.name}`,
            name: f.name,
            required: f.required,
            placeholder: f.placeholder,
          };
          if (f.type === 'checkbox') {
            return (
              <label key={f.name} className={`field check ${f.wide ? 'wide' : ''}`}>
                <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
                <span>{f.label}{f.hint ? <span className="hint"> - {f.hint}</span> : null}</span>
              </label>
            );
          }
          return (
            <label key={f.name} className={`field ${f.wide ? 'wide' : ''}`}>
              <span>{f.label}{f.hint ? <span className="hint"> - {f.hint}</span> : null}</span>
              {f.type === 'select' ? (
                <select {...common} value={values[f.name]} onChange={(e) => set(f.name, e.target.value)}>
                  {f.required && f.defaultValue != null ? null : <option value="">{f.placeholder ?? 'Select…'}</option>}
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea {...common} value={values[f.name]} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <input
                  {...common}
                  type={f.type ?? 'text'}
                  step={f.step}
                  min={f.min}
                  max={f.max}
                  value={values[f.name]}
                  onChange={(e) => set(f.name, e.target.value)}
                />
              )}
            </label>
          );
        })}
      </div>
      <div className="form-foot">
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        {message ? <span className={`msg ${message.ok ? 'ok' : 'err'}`} role="status">{message.text}</span> : null}
      </div>
    </form>
  );
}
