// GET /api/quote?symbol=KO  ->  { ok:true, price, asOf, source }  or  { ok:false, code:'noquote' }
// A share price needs a separate data provider (the SEC has no prices). It is optional:
// set QUOTE_PROVIDER (finnhub | alphavantage | twelvedata) and QUOTE_API_KEY in Netlify to switch it on.
// Without them the site simply asks the visitor to type the price. The key never reaches the browser.
import { json } from './_lib/http.mjs';

const none = (code, msg) => json({ ok: false, code, msg }, 200);

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDERS = {
  async finnhub(sym, key) {
    const j = await get('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym.replace(/-/g, '.')) + '&token=' + encodeURIComponent(key));
    if (!j || !(j.c > 0)) return null;
    return { price: j.c, asOf: j.t ? new Date(j.t * 1000).toISOString().slice(0, 10) : null, source: 'Finnhub' };
  },
  async alphavantage(sym, key) {
    const j = await get('https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=' + encodeURIComponent(sym) + '&apikey=' + encodeURIComponent(key));
    const q = j && j['Global Quote'];
    const p = q ? parseFloat(q['05. price']) : NaN;
    if (!(p > 0)) return null;
    return { price: p, asOf: q['07. latest trading day'] || null, source: 'Alpha Vantage' };
  },
  async twelvedata(sym, key) {
    const j = await get('https://api.twelvedata.com/price?symbol=' + encodeURIComponent(sym) + '&apikey=' + encodeURIComponent(key));
    const p = j ? parseFloat(j.price) : NaN;
    if (!(p > 0)) return null;
    return { price: p, asOf: null, source: 'Twelve Data' };
  },
};

export default async (req) => {
  const u = new URL(req.url);
  const sym = (u.searchParams.get('symbol') || '').trim().toUpperCase().replace(/\./g, '-');
  if (!/^[A-Z0-9][A-Z0-9-]{0,9}$/.test(sym)) return none('badsym', 'סימול לא תקין');
  const provider = (process.env.QUOTE_PROVIDER || '').trim().toLowerCase();
  const key = (process.env.QUOTE_API_KEY || '').trim();
  if (!provider || !key || !PROVIDERS[provider]) return none('noquote', 'מחיר חי אינו מופעל באתר');
  try {
    const q = await PROVIDERS[provider](sym, key);
    if (!q) return none('noprice', 'לא התקבל מחיר לסימול הזה');
    return json({ ok: true, tk: sym, price: Math.round(q.price * 100) / 100, asOf: q.asOf, source: q.source }, 200, 'public, s-maxage=120, stale-while-revalidate=600', 'symbol');
  } catch (e) {
    const out = { ok: false, code: 'error', msg: 'שירות המחירים לא ענה' };
    // ?debug=1 shows why (never the key itself)
    if (u.searchParams.get('debug') === '1') {
      out.detail = { provider, keyLength: key.length, error: String(e && e.message), cause: e && e.cause ? String(e.cause.message || e.cause) : null };
    }
    return json(out, 200);
  }
};

export const config = { path: '/api/quote' };
