// Talking to SEC EDGAR (free, official, no API key).
// Rules from the SEC: send a User-Agent that names you and gives a contact, and stay under 10 requests per second.
// Here that means: one call to company facts (+ one small call for the company profile) per lookup, and cache everything.

import { DataError, normalizeCompany } from './normalize.mjs';

const DATA = 'https://data.sec.gov';
const WWW = 'https://www.sec.gov';

/* ---------- tiny in-memory caches (live while the function instance stays warm) ---------- */
const cache = new Map();
function cget(key) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  cache.delete(key);
  return undefined;
}
function cput(key, val, ttlMs, max = 40) {
  if (cache.size >= max) cache.delete(cache.keys().next().value);
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

export function userAgent() {
  const ua = (process.env.SEC_USER_AGENT || '').trim();
  // A real contact (an e-mail address) is required by the SEC.
  if (!ua || !/@/.test(ua)) {
    throw new DataError('config', 'השירות עדיין לא הוגדר: חסר משתנה SEC_USER_AGENT בהגדרות של Netlify.');
  }
  return ua.replace(/[^\x20-\x7E]/g, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// deadline: a timestamp (ms) after which we stop trying, so the whole lookup stays inside Netlify's 10-second limit
export async function secJson(url, { timeoutMs = 7000, retries = 2, deadline = 0 } = {}) {
  const ua = userAgent();
  let last = null;
  for (let i = 0; i <= retries; i++) {
    const left = deadline ? deadline - Date.now() : timeoutMs;
    if (left < 800) break;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, left));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: ctl.signal });
      clearTimeout(timer);
      if (res.status === 404) throw new DataError('nofacts', 'לא נמצאו דוחות דיגיטליים לחברה הזו ב-SEC.');
      if (res.status === 403) {
        throw new DataError('secblock', 'שרת ה-SEC דחה את הבקשה כרגע. נסו שוב בעוד כמה דקות.', { status: 403, hint: 'The SEC refuses requests without a proper User-Agent (name + e-mail) or after too many requests. Check SEC_USER_AGENT in the Netlify settings.' });
      }
      if (res.status === 429 || res.status >= 500) {
        last = new DataError('sec', 'שרת ה-SEC עמוס כרגע. נסו שוב בעוד רגע.');
        await sleep(350 * 2 ** i);
        continue;
      }
      if (!res.ok) throw new DataError('sec', 'שרת ה-SEC החזיר שגיאה (' + res.status + ').');
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof DataError) {
        if (e.code === 'nofacts' || e.code === 'config' || e.code === 'secblock') throw e;
        last = e;
      } else {
        last = new DataError('sec', e && e.name === 'AbortError' ? 'השרת של ה-SEC לא ענה בזמן. נסו שוב.' : 'לא הצלחנו להתחבר לשרת של ה-SEC.');
      }
      if (i < retries) await sleep(350 * 2 ** i);
    }
  }
  throw last || new DataError('sec', 'לא הצלחנו להתחבר לשרת של ה-SEC.');
}

/* ---------- ticker list ---------- */
const SMALL = new Set(['INC', 'CORP', 'CO', 'LTD', 'PLC', 'LLC', 'LP', 'NV', 'SA', 'AG', 'ETF', 'ADR', 'USA', 'US', 'REIT', 'ADS', 'TRUST', 'FUND']);
function prettyName(s) {
  s = String(s || '').trim();
  if (!s || /[a-z]/.test(s)) return s;
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => {
      const up = w.replace(/[.,]/g, '').toUpperCase();
      if (up === 'INC' || up === 'CORP' || up === 'CO' || up === 'LTD') return w.charAt(0).toUpperCase() + w.slice(1);
      if (SMALL.has(up) && up.length <= 4 && up !== 'TRUST' && up !== 'FUND') return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// -> [{ t: 'AAPL', n: 'Apple Inc.', cik: '0000320193', ex: 'Nasdaq' }]
export async function tickerList(deadline = 0) {
  const hit = cget('tickers');
  if (hit) return hit;
  let rows = null;
  try {
    const j = await secJson(WWW + '/files/company_tickers_exchange.json', { timeoutMs: 5000, retries: 1, deadline });
    if (j && Array.isArray(j.fields) && Array.isArray(j.data)) {
      const f = j.fields;
      const ic = f.indexOf('cik'), inm = f.indexOf('name'), it = f.indexOf('ticker'), ie = f.indexOf('exchange');
      rows = j.data.map((r) => ({ t: String(r[it] || '').toUpperCase(), n: prettyName(r[inm]), cik: String(r[ic]).padStart(10, '0'), ex: r[ie] || '' }));
    }
  } catch (e) {
    if (e instanceof DataError && e.code === 'config') throw e;
  }
  if (!rows || !rows.length) {
    // older file with the same information (no exchange column)
    const j = await secJson(WWW + '/files/company_tickers.json', { timeoutMs: 5000, retries: 1, deadline });
    rows = Object.values(j || {}).map((r) => ({ t: String(r.ticker || '').toUpperCase(), n: prettyName(r.title), cik: String(r.cik_str).padStart(10, '0'), ex: '' }));
  }
  rows = rows.filter((r) => r.t && r.cik !== 'NaN');
  cput('tickers', rows, 6 * 3600 * 1000, 80);
  return rows;
}

export function normSymbol(s) {
  return String(s || '').trim().toUpperCase().replace(/\./g, '-');
}
export function validSymbol(s) {
  return /^[A-Z0-9][A-Z0-9-]{0,9}$/.test(s);
}

export async function searchCompanies(q) {
  const query = String(q || '').trim().toLowerCase();
  if (query.length < 1) return [];
  const list = await tickerList();
  const sym = query.replace(/\./g, '-');
  const scored = [];
  for (const r of list) {
    const t = r.t.toLowerCase();
    const n = r.n.toLowerCase();
    let s = 0;
    if (t === sym) s = 100;
    else if (t.startsWith(sym)) s = 80 - Math.min(t.length - sym.length, 10);
    else if (n.startsWith(query)) s = 60;
    else if (n.split(/[\s,.]+/).some((w) => w.startsWith(query))) s = 50;
    else if (query.length >= 3 && n.includes(query)) s = 30;
    if (!s) continue;
    if (r.ex && r.ex !== 'OTC') s += 5;
    scored.push({ s, r });
  }
  scored.sort((a, b) => b.s - a.s || a.r.t.length - b.r.t.length || (a.r.t < b.r.t ? -1 : 1));
  return scored.slice(0, 8).map((x) => ({ t: x.r.t, n: x.r.n, ex: x.r.ex }));
}

/* ---------- one company ---------- */
export async function loadCompany(symbolRaw) {
  const symbol = normSymbol(symbolRaw);
  if (!validSymbol(symbol)) throw new DataError('badsym', 'הסימול שהוזן אינו תקין. הקלידו סימול אמריקאי, למשל KO או AAPL.');
  const key = 'co:' + symbol;
  const hit = cget(key);
  if (hit) return hit;

  const deadline = Date.now() + 8800;
  const list = await tickerList(deadline);
  const row = list.find((r) => r.t === symbol);
  if (!row) throw new DataError('notfound', 'לא מצאנו את הסימול ' + symbol + ' ברשימת החברות של ה-SEC. האתר בודק חברות שנסחרות בארצות הברית. נסו לחפש לפי שם.');

  const [facts, profile] = await Promise.all([
    secJson(DATA + '/api/xbrl/companyfacts/CIK' + row.cik + '.json', { timeoutMs: 7500, retries: 1, deadline }),
    secJson(DATA + '/submissions/CIK' + row.cik + '.json', { timeoutMs: 4000, retries: 0, deadline }).catch((e) => (e && e.code === 'config' ? Promise.reject(e) : null)),
  ]);

  const meta = {
    name: row.n || (profile && profile.name) || '',
    sic: profile && profile.sic ? profile.sic : null,
    sicDescription: profile && profile.sicDescription ? profile.sicDescription : '',
  };
  const out = normalizeCompany(facts, meta, Date.now());
  const res = {
    ok: true,
    tk: symbol,
    cik: row.cik,
    ex: row.ex || (profile && profile.exchanges && profile.exchanges[0]) || '',
    sec: meta.sicDescription,
    ...out,
  };
  cput(key, res, 3600 * 1000);
  return res;
}
