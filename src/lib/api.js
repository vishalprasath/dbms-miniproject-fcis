// Wrapper for Route Handlers: authentication, optional role check,
// JSON body parsing and uniform error responses.
import { NextResponse } from 'next/server';
import { getSession } from './auth';
import { describeDbError } from './db';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function route(handler, { roles } = {}) {
  return async (request, context) => {
    try {
      const session = await getSession();
      if (!session) throw new ApiError(401, 'Please sign in.');
      if (roles && !roles.includes(session.role)) {
        throw new ApiError(403, `This action needs one of these roles: ${roles.join(', ')}.`);
      }
      const params = context?.params ? await context.params : {};
      let body = {};
      if (!['GET', 'HEAD', 'DELETE'].includes(request.method)) {
        body = await request.json().catch(() => ({}));
      }
      const query = Object.fromEntries(new URL(request.url).searchParams);
      const data = await handler({ request, session, params, body, query });
      return NextResponse.json(data ?? { ok: true });
    } catch (err) {
      const known = describeDbError(err);
      if (known) return NextResponse.json({ error: known.message }, { status: known.status });
      if (err?.code === 121) {
        return NextResponse.json({ error: 'Rejected by the MongoDB schema validator.' }, { status: 400 });
      }
      console.error(err);
      return NextResponse.json({ error: 'Something went wrong on the server.' }, { status: 500 });
    }
  };
}

// ---- small input helpers (shape only; the real rules live in the database) ----
export function toInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ApiError(400, `${label} must be a whole number.`);
  return n;
}
export function toAmount(value, label = 'Amount') {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ApiError(400, `${label} must be a number.`);
  return Math.round(n * 100) / 100;
}
export function toDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${label} must be a date (YYYY-MM-DD).`);
  }
  return value;
}
export function toText(value, label, { required = true } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s && required) throw new ApiError(400, `${label} is required.`);
  return s || null;
}
