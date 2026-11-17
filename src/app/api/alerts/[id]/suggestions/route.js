import { route, toInt } from '@/lib/api';
import { withSession } from '@/lib/db';
import { deferralSuggestions } from '@/lib/data';

// GET /api/alerts/:id/suggestions -> fn_suggest_deferrals()
export const GET = route(async ({ session, params }) =>
  withSession(session, (c) => deferralSuggestions(c, toInt(params.id, 'Id'))));
