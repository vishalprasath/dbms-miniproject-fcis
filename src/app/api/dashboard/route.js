import { route } from '@/lib/api';
import { withSession } from '@/lib/db';
import { dashboard } from '@/lib/data';

export const GET = route(async ({ session }) => withSession(session, (c) => dashboard(c)));
