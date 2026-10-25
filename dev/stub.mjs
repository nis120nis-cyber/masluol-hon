// Replaces the network with the made-up SEC files in dev/fixtures.mjs (used by the local test server and the sample dump).
import * as FX from './fixtures.mjs';

export function installStub() {
  process.env.SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'MasluolHonLocal local@example.com';
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/files/company_tickers_exchange.json')) return ok(FX.TICKERS);
    let m = u.match(/companyfacts\/CIK(\d{10})\.json/);
    if (m) {
      const f = FX.FACTS_BY_CIK[Number(m[1])];
      return f ? ok(f) : ok({ message: 'nf' }, 404);
    }
    m = u.match(/submissions\/CIK(\d{10})\.json/);
    if (m) return Number(m[1]) === 111 ? ok(FX.profileA) : Number(m[1]) === 555 ? ok(FX.profileBank) : ok({}, 404);
    if (u.startsWith('https://finnhub.io/api/v1/quote')) {
      const sym = new URL(u).searchParams.get('symbol');
      return ok(sym === 'SPLT' ? { c: 0, t: 0 } : { c: sym === 'KOLA' ? 92.71 : 41.5, t: 1792800000 });
    }
    return new Response('?', { status: 599 });
  };
}
