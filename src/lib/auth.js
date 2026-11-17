// Session handling: a signed (HS256) JWT in an httpOnly cookie.
// The credentials themselves are checked inside PostgreSQL (fn_verify_login).
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'fcis_session';
const MAX_AGE = 60 * 60 * 8; // 8 hours

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(s);
}

export async function createSessionToken(user) {
  return new SignJWT({ name: user.full_name, email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.user_id))
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: MAX_AGE,
};

/** The signed-in user, or null. */
export async function getSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return { userId: Number(payload.sub), name: payload.name, email: payload.email, role: payload.role };
  } catch {
    return null;
  }
}

/** For pages: redirect to /login when signed out, to / when the role is not allowed. */
export async function requireSession(roles) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (roles && !roles.includes(session.role)) redirect('/?denied=1');
  return session;
}

export const can = {
  write: (s) => s?.role === 'admin' || s?.role === 'analyst',
  admin: (s) => s?.role === 'admin',
};
