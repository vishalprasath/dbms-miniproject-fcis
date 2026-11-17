import { NextResponse } from 'next/server';
import { getSession, SESSION_COOKIE } from '@/lib/auth';
import { logEvent } from '@/lib/mongo';

export async function POST() {
  const session = await getSession();
  if (session) await logEvent(session, 'logout', {});
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
