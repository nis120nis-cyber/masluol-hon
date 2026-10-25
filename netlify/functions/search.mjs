// GET /api/search?q=coca  ->  { ok:true, r:[{ t:'KO', n:'Coca Cola Co', ex:'NYSE' }, ...] }
import { searchCompanies } from './_lib/sec.mjs';
import { json, fail } from './_lib/http.mjs';

export default async (req) => {
  const u = new URL(req.url);
  try {
    const q = (u.searchParams.get('q') || '').slice(0, 40);
    const r = await searchCompanies(q);
    return json({ ok: true, r }, 200, 'public, s-maxage=3600, stale-while-revalidate=86400', 'q');
  } catch (e) {
    return fail(e, u.searchParams.get('debug') === '1');
  }
};

export const config = { path: '/api/search' };
