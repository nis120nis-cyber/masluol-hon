// GET /api/company?symbol=KO[&debug=1]
// Reads the company's official annual reports from SEC EDGAR and returns the numbers the Graham checks need.
import { loadCompany } from './_lib/sec.mjs';
import { json, fail } from './_lib/http.mjs';

export default async (req) => {
  const u = new URL(req.url);
  const debug = u.searchParams.get('debug') === '1';
  try {
    const r = await loadCompany(u.searchParams.get('symbol') || '');
    const { debug: dbg, ...pub } = r;
    return json(debug ? r : pub, 200, 'public, s-maxage=21600, stale-while-revalidate=86400', 'symbol|debug');
  } catch (e) {
    return fail(e, debug);
  }
};

export const config = { path: '/api/company' };
