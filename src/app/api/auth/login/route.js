import { NextResponse } from 'next/server';
import { verifyLogin } from '@/lib/db';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';
import { logEvent } from '@/lib/mongo';

// POST /api/auth/login  { email, password }
// The password is checked inside PostgreSQL by fn_verify_login (bcrypt via pgcrypto).
export async function POST(request) {
  const { email, password } = await request.json().catch(() => ({}));
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return NextResponse.json({ error: 'E-mail and password are required.' }, { status: 400 });
  }
  try {
    const user = await verifyLogin(email, password);
    if (!user) {
      await logEvent(null, 'login_failed', { email: email.slice(0, 120), reason: 'bad credentials' });
      return NextResponse.json({ error: 'Incorrect e-mail or password.' }, { status: 401 });
    }
    const session = { userId: user.user_id, name: user.full_name, role: user.role };
    await logEvent(session, 'login', {});
    const res = NextResponse.json({ name: user.full_name, role: user.role });
    res.cookies.set(SESSION_COOKIE, await createSessionToken(user), sessionCookieOptions);
    return res;
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Could not reach the database.' }, { status: 500 });
  }
}
