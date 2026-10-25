// Automatic checks for the server side. Run:  node dev/test.mjs
// No network is used: SEC's answers are replaced by the made-up files in dev/fixtures.mjs.
import assert from 'node:assert/strict';
import * as FX from './fixtures.mjs';
import { normalizeCompany, DataError, fyLabel, annualPoints, detectSplits } from '../netlify/functions/_lib/normalize.mjs';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('ok   ', name);
  } catch (e) {
    fail++;
    console.log('FAIL ', name, '\n      ', (e && e.message ? e.message : e).split('\n').slice(0, 6).join('\n       '));
  }
}
const NOW = Date.parse('2026-10-25T00:00:00Z');
const near = (a, b, d = 0.005) => assert.ok(Math.abs(a - b) <= d, a + ' vs ' + b);
const has = (r, c) => r.warns.some((w) => w.c === c);
const code = (fn) => { try { fn(); } catch (e) { return e.code || 'other:' + e.message; } return 'none'; };

await t('fiscal-year label: Dec 31 and 52/53-week years', () => {
  assert.equal(fyLabel('2025-12-31'), 2025);
  assert.equal(fyLabel('2022-01-01'), 2021);
  assert.equal(fyLabel('2021-01-03'), 2020);
  assert.equal(fyLabel('2026-01-31'), 2026);
  assert.equal(fyLabel('2018-02-03'), 2018);
  assert.equal(fyLabel('2025-06-30'), 2025);
});

await t('A: ordinary company, ten years, balance sheet, dividends', () => {
  const r = normalizeCompany(FX.A, { name: 'Kola Beverage Co', sic: '2086' }, NOW);
  assert.deepEqual(r.years, [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);
  assert.equal(r.eps.length, 10);
  assert.equal(r.eps[9], 3.04);
  assert.equal(r.eps[0], 1.49);
  assert.equal(r.y0, 2016);
  assert.equal(r.fyEnd, '2025-12-31');
  assert.equal(r.fyLabel, 2025);
  assert.equal(r.ca, 31044);
  assert.equal(r.cl, 21281);
  assert.equal(r.eq, 32169);
  assert.equal(r.ltd, 42819);
  assert.equal(r.shares, 4302);
  near(r.sales, 30000 + 15 * 1100, 0.01);
  assert.equal(r.div, 16);
  assert.equal(r.divOpen, true);
  assert.ok(has(r, 'divopen'));
  assert.ok(!has(r, 'split'));
  assert.ok(!has(r, 'finco'));
  assert.equal(r.form, '10-K');
});

await t('B: 4-for-1 split is detected and old years are put on the new basis', () => {
  const r = normalizeCompany(FX.B, { name: 'x' }, NOW);
  const truth = [2.5, 2.7, 3.0, 3.3, 3.6, 4.0, 4.5, 5.1, 5.6, 6.2];
  assert.equal(r.eps.length, 10);
  r.eps.forEach((v, i) => near(v, truth[i], 0.011));
  assert.ok(has(r, 'split'));
  assert.equal(r.debug.splits.length, 1);
  near(r.debug.splits[0].f, 4, 0.0001);
  // dividends: none before 2016, then paid every year from 2016 on (10 years)
  assert.equal(r.div, 10);
});

await t('I: a plain restatement (not a split ratio) is left alone', () => {
  const r = normalizeCompany(FX.I, { name: 'x' }, NOW);
  assert.ok(!has(r, 'split'));
  assert.equal(r.debug.splits.length, 0);
  assert.equal(r.eps[6], 1.2, 'latest filing wins (2022)');
  assert.equal(r.eps[5], 1.7);
});

await t('detectSplits: one period with a whole ratio is enough, a lone odd ratio is not', () => {
  const mk = (a, b) => [{ end: '2019-12-31', label: 2019, hist: [{ filed: '2020-02-20', val: a }, { filed: '2021-02-20', val: b }] }];
  assert.equal(detectSplits(mk(11.89, 2.97)).length, 1);
  assert.equal(detectSplits(mk(3.0, 2.0)).length, 0);
  assert.equal(detectSplits(mk(3.1, 2.2)).length, 0);
  assert.equal(detectSplits(mk(0.12, 0.04)).length, 0, 'tiny numbers need two agreeing periods');
  assert.equal(detectSplits([...mk(0.12, 0.04), ...mk(0.2, 0.0667).map((p) => ({ ...p, end: '2018-12-31', label: 2018 }))]).length, 1);
  // reverse split 1-for-10
  const rv = detectSplits(mk(0.35, 3.5));
  assert.equal(rv.length, 1);
  near(rv[0].f, 0.1, 1e-6);
});

await t('C: 52/53-week retailer, tags change, debt from convertible notes', () => {
  const r = normalizeCompany(FX.C, { name: 'x', sic: '5311' }, NOW);
  assert.equal(r.eps.length, 10);
  assert.equal(r.fyEnd, '2026-01-31');
  assert.equal(r.fyLabel, 2026);
  assert.deepEqual(r.years, [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  assert.equal(r.eps[0], 1.2);
  assert.equal(r.eps[9], 2.9);
  assert.ok(has(r, 'stitched'));
  assert.equal(r.ltd, 2500);
  assert.equal(r.tags.ltd, 'us-gaap:ConvertibleNotesPayableNoncurrent');
  assert.ok(r.tags.sales.includes('RevenueFromContract'));
  assert.equal(r.div, 0);
  assert.equal(r.divNoData, true);
  assert.ok(has(r, 'nodiv'));
});

await t('D: non-dollar reporter is refused with a clear code', () => {
  assert.equal(code(() => normalizeCompany(FX.D, {}, NOW)), 'currency');
});
await t('E: bank without current assets is refused', () => {
  assert.equal(code(() => normalizeCompany(FX.Ebank, { sic: '6022' }, NOW)), 'nobs');
});
await t('F: fewer than six years is refused', () => {
  assert.equal(code(() => normalizeCompany(FX.F, {}, NOW)), 'history');
});
await t('G: foreign filer, losses, missing debt/revenue/dividend tags', () => {
  const r = normalizeCompany(FX.G, {}, NOW);
  assert.equal(r.form, '20-F');
  assert.ok(has(r, 'foreign'));
  assert.ok(has(r, 'noltd'));
  assert.ok(has(r, 'nosales'));
  assert.ok(has(r, 'nodiv'));
  assert.equal(r.ltd, 0);
  assert.equal(r.sales, null);
  assert.equal(r.shares, 105.6);
  assert.ok(r.eps.some((v) => v < 0));
});
await t('H: two share classes on the cover page are added up', () => {
  const r = normalizeCompany(FX.H, {}, NOW);
  assert.equal(r.shares, 1200);
  assert.ok(has(r, 'multi'));
});
await t('stale report is flagged, and old cover-page share counts fall back to the yearly average', () => {
  const r = normalizeCompany(FX.A, {}, Date.parse('2028-06-01T00:00:00Z'));
  assert.ok(has(r, 'stale'));
  assert.ok(has(r, 'shfb'));
  assert.equal(r.shares, 4350);
});
await t('financial SIC code is flagged', () => {
  const r = normalizeCompany(FX.A, { sic: '6311' }, NOW);
  assert.ok(has(r, 'finco'));
});
await t('annualPoints ignores quarterly rows and 10-Q forms', () => {
  const rows = [
    { start: '2025-01-01', end: '2025-03-31', val: 1, filed: '2025-05-01', form: '10-Q', accn: 'a' },
    { start: '2025-01-01', end: '2025-12-31', val: 5, filed: '2026-02-01', form: '10-K', accn: 'b' },
    { start: '2025-01-01', end: '2025-12-31', val: 5, filed: '2026-04-01', form: '10-Q', accn: 'c' },
  ];
  const p = annualPoints(rows);
  assert.equal(p.length, 1);
  assert.equal(p[0].val, 5);
});

/* ---------------- the three functions, with SEC and a price provider replaced by fixtures ---------------- */
const realFetch = globalThis.fetch;
let calls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);
  const ok = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/files/company_tickers_exchange.json')) return ok(FX.TICKERS);
  let m = u.match(/companyfacts\/CIK(\d{10})\.json/);
  if (m) {
    const f = FX.FACTS_BY_CIK[Number(m[1])];
    return f ? ok(f) : ok({ message: 'nf' }, 404);
  }
  m = u.match(/submissions\/CIK(\d{10})\.json/);
  if (m) return Number(m[1]) === 111 ? ok(FX.profileA) : Number(m[1]) === 555 ? ok(FX.profileBank) : ok({}, 404);
  if (u.startsWith('https://finnhub.io/api/v1/quote')) return ok({ c: 92.71, t: 1792800000 });
  if (u.startsWith('https://www.alphavantage.co')) return ok({ 'Global Quote': { '05. price': '92.7100', '07. latest trading day': '2026-10-23' } });
  if (u.startsWith('https://api.twelvedata.com')) return ok({ price: '92.71000' });
  return new Response('?', { status: 599 });
};
// the real code paths use these environment variables
process.env.SEC_USER_AGENT = 'MasluolHonTest test@example.com';

const company = (await import('../netlify/functions/company.mjs')).default;
const search = (await import('../netlify/functions/search.mjs')).default;
const quote = (await import('../netlify/functions/quote.mjs')).default;
const req = (path) => new Request('https://site.test' + path);
const body = async (res) => JSON.parse(await res.text());

await t('company: success for KOLA, with profile data and cache headers', async () => {
  const res = await company(req('/api/company?symbol=kola'));
  assert.equal(res.status, 200);
  const j = await body(res);
  assert.equal(j.ok, true);
  assert.equal(j.tk, 'KOLA');
  assert.equal(j.ex, 'NYSE');
  assert.equal(j.n, 'Kola Beverage Co');
  assert.ok(j.sec.includes('Soft Drinks'));
  assert.equal(j.eps.length, 10);
  assert.equal(j.debug, undefined);
  assert.ok(res.headers.get('netlify-cdn-cache-control').includes('s-maxage'));
});
await t('company: debug=1 adds the diagnostics', async () => {
  const j = await body(await company(req('/api/company?symbol=KOLA&debug=1')));
  assert.ok(j.debug && j.debug.epsCandidates && j.debug.chosen);
});
await t('company: second request is served from the cache (no new SEC calls)', async () => {
  calls = [];
  await company(req('/api/company?symbol=KOLA'));
  assert.equal(calls.filter((c) => c.includes('companyfacts')).length, 0);
});
await t('company: split company through the function', async () => {
  const j = await body(await company(req('/api/company?symbol=SPLT')));
  assert.equal(j.ok, true);
  near(j.eps[0], 2.5, 0.011);
});
await t('company: class-share ticker with a dash (DCM.A -> DCM-A)', async () => {
  const j = await body(await company(req('/api/company?symbol=DCM.A')));
  assert.equal(j.ok, true);
  assert.equal(j.tk, 'DCM-A');
});
await t('company: errors come back as JSON with the right status', async () => {
  let res = await company(req('/api/company?symbol=ZZZZ'));
  assert.equal(res.status, 404);
  assert.equal((await body(res)).code, 'notfound');
  res = await company(req('/api/company?symbol=%3Cscript%3E'));
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, 'badsym');
  res = await company(req('/api/company?symbol=FTB'));
  assert.equal(res.status, 422);
  assert.equal((await body(res)).code, 'nobs');
  res = await company(req('/api/company?symbol=EURO'));
  assert.equal((await body(res)).code, 'currency');
  res = await company(req('/api/company?symbol=NEWT'));
  assert.equal((await body(res)).code, 'history');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
await t('company: SEC down -> friendly 503, never a crash', async () => {
  const keep = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes('company_tickers_exchange') ? new Response(JSON.stringify(FX.TICKERS), { status: 200 }) : new Response('busy', { status: 503 }));
  const res = await company(req('/api/company?symbol=WEEK'));
  assert.equal(res.status, 503);
  assert.equal((await body(res)).code, 'sec');
  globalThis.fetch = keep;
});
await t('company: SEC refuses (403) -> friendly message, hint only in debug', async () => {
  const keep = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes('company_tickers_exchange') ? new Response(JSON.stringify(FX.TICKERS), { status: 200 }) : new Response('denied', { status: 403 }));
  let res = await company(req('/api/company?symbol=EURO'));
  assert.equal(res.status, 503);
  let j = await body(res);
  assert.equal(j.code, 'secblock');
  assert.equal(j.detail, undefined);
  res = await company(req('/api/company?symbol=EURO&debug=1'));
  j = await body(res);
  assert.ok(j.detail && j.detail.extra && j.detail.extra.hint.includes('SEC_USER_AGENT'));
  globalThis.fetch = keep;
});
await t('company: answers vary by query parameter in the CDN cache', async () => {
  const res = await company(req('/api/company?symbol=KOLA'));
  assert.equal(res.headers.get('netlify-vary'), 'query=symbol|debug');
  const s = await search(req('/api/search?q=kol'));
  assert.equal(s.headers.get('netlify-vary'), 'query=q');
});
await t('company: missing SEC_USER_AGENT -> clear configuration error', async () => {
  const keep = process.env.SEC_USER_AGENT;
  delete process.env.SEC_USER_AGENT;
  const res = await company(req('/api/company?symbol=HSOF'));
  assert.equal(res.status, 503);
  assert.equal((await body(res)).code, 'config');
  process.env.SEC_USER_AGENT = keep;
});
await t('company: an unexpected bug is reported as internal, with detail only in debug', async () => {
  const keep = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes('company_tickers_exchange')) return new Response(JSON.stringify(FX.TICKERS), { status: 200 });
    if (s.includes('companyfacts')) return new Response(JSON.stringify({ facts: 'not an object' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  let res = await company(req('/api/company?symbol=RGDS'));
  let j = await body(res);
  assert.equal(res.status >= 400, true);
  assert.equal(j.ok, false);
  assert.equal(j.detail, undefined);
  res = await company(req('/api/company?symbol=RGDS&debug=1'));
  j = await body(res);
  assert.ok(j.detail);
  globalThis.fetch = keep;
});

await t('search: ticker first, then names; limits to 8', async () => {
  let j = await body(await search(req('/api/search?q=kol')));
  assert.equal(j.r[0].t, 'KOLA');
  j = await body(await search(req('/api/search?q=appl')));
  assert.deepEqual(j.r.map((x) => x.t).sort(), ['APLC', 'APWD']);
  j = await body(await search(req('/api/search?q=SPLITTER')));
  assert.equal(j.r[0].t, 'SPLT');
  assert.equal(j.r[0].n, 'Splitter Systems Inc', 'upper-case SEC names are tidied');
  j = await body(await search(req('/api/search?q=')));
  assert.deepEqual(j.r, []);
});

await t('quote: off by default', async () => {
  delete process.env.QUOTE_PROVIDER;
  delete process.env.QUOTE_API_KEY;
  const j = await body(await quote(req('/api/quote?symbol=KOLA')));
  assert.equal(j.ok, false);
  assert.equal(j.code, 'noquote');
});
for (const p of ['finnhub', 'alphavantage', 'twelvedata']) {
  await t('quote: ' + p, async () => {
    process.env.QUOTE_PROVIDER = p;
    process.env.QUOTE_API_KEY = 'secretkey';
    const res = await quote(req('/api/quote?symbol=KOLA'));
    const j = await body(res);
    assert.equal(j.ok, true);
    assert.equal(j.price, 92.71);
    assert.ok(!JSON.stringify(j).includes('secretkey'), 'the key never leaves the server');
  });
}
await t('quote: bad symbol is rejected', async () => {
  const j = await body(await quote(req('/api/quote?symbol=a%20b')));
  assert.equal(j.ok, false);
});

globalThis.fetch = realFetch;
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
