// Synthetic "company facts" files shaped exactly like SEC EDGAR's API (data.sec.gov/api/xbrl/companyfacts).
// They let us test the parsing rules without network access. The companies are made up.

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// o: {
//   name, ends[], eps[] (true values, latest basis), epsTag(k)->[ns,tag], epsUnit,
//   sales[], salesTag(k), bs(k)->{ca,cl,eq,ltd}, ltdTag, divps[]|null, form, lag,
//   split:{filedBefore, factor}  // filings before this date show eps * factor
//   cover: [v1, v2..] (cover-page share counts, same date), coverUnit
// }
export function build(o) {
  const lag = o.lag || 55;
  const form = o.form || '10-K';
  const facts = {};
  const add = (ns, tag, unit, row) => {
    facts[ns] = facts[ns] || {};
    facts[ns][tag] = facts[ns][tag] || { label: tag, description: tag, units: {} };
    facts[ns][tag].units[unit] = facts[ns][tag].units[unit] || [];
    facts[ns][tag].units[unit].push(row);
  };
  const n = o.ends.length;
  const startOf = (k) => (k > 0 ? addDays(o.ends[k - 1], 1) : addDays(o.ends[k], -364));
  const epsTag = o.epsTag || (() => ['us-gaap', 'EarningsPerShareDiluted']);
  const salesTag = o.salesTag || (() => ['us-gaap', 'Revenues']);
  let seq = 0;
  for (let j = 0; j < n; j++) {
    const filed = addDays(o.ends[j], lag);
    const accn = '0000000000-' + String(20 + Math.floor(j / 3)).padStart(2, '0') + '-' + String(++seq).padStart(6, '0');
    const fy = Number(o.ends[j].slice(0, 4));
    const base = { accn, fy, fp: 'FY', form, filed };
    const f = o.split && filed < o.split.filedBefore ? o.split.factor : 1;
    for (let k = Math.max(0, j - 2); k <= j; k++) {
      const [ns, tag] = epsTag(k);
      if (o.eps && o.eps[k] !== undefined && o.eps[k] !== null) {
        add(ns, tag, o.epsUnit || 'USD/shares', { start: startOf(k), end: o.ends[k], val: Math.round(o.eps[k] * f * 100) / 100, ...base });
      }
      if (o.sales && o.sales[k] !== undefined && o.sales[k] !== null) {
        const [sn, st] = salesTag(k);
        add(sn, st, o.unit || 'USD', { start: startOf(k), end: o.ends[k], val: o.sales[k] * 1e6, ...base });
      }
      if (o.weighted) {
        add('us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding', 'shares', { start: startOf(k), end: o.ends[k], val: o.weighted, ...base });
      }
      if (o.divps && o.divps[k] !== undefined && o.divps[k] !== null) {
        add('us-gaap', 'CommonStockDividendsPerShareDeclared', 'USD/shares', { start: startOf(k), end: o.ends[k], val: o.divps[k], ...base });
      }
    }
    for (let k = Math.max(0, j - 1); k <= j; k++) {
      const b = o.bs ? o.bs(k) : null;
      if (!b) continue;
      const unit = o.unit || 'USD';
      if (b.ca !== undefined) add('us-gaap', 'AssetsCurrent', unit, { end: o.ends[k], val: b.ca * 1e6, ...base });
      if (b.cl !== undefined) add('us-gaap', 'LiabilitiesCurrent', unit, { end: o.ends[k], val: b.cl * 1e6, ...base });
      if (b.eq !== undefined) add('us-gaap', 'StockholdersEquity', unit, { end: o.ends[k], val: b.eq * 1e6, ...base });
      if (b.ltd !== undefined && o.ltdTag !== null) {
        add('us-gaap', o.ltdTag || 'LongTermDebtNoncurrent', unit, { end: o.ends[k], val: b.ltd * 1e6, ...base });
      }
    }
    if (o.cover) {
      for (const v of o.cover) {
        add('dei', 'EntityCommonStockSharesOutstanding', 'shares', { end: addDays(filed, -12), val: v, ...base });
      }
    }
  }
  return { cik: o.cik || 1234567, entityName: o.name, facts };
}

const E = (y, md) => y + '-' + md;
const dec = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => E(from + i, '12-31'));
const series = (arr) => arr;

// A: ordinary calendar-year company, 16 years of reports (2010-2025), dividends every year
const epsA = [1.9, 2.0, 2.1, 2.2, 2.3, 2.4, 1.49, 0.29, 1.5, 2.07, 1.79, 2.25, 2.19, 2.47, 2.46, 3.04];
export const A = build({
  name: 'Kola Beverage Co', cik: 111,
  ends: dec(2010, 2025), eps: epsA,
  sales: epsA.map((e, i) => 30000 + i * 1100),
  bs: (k) => (k === 15 ? { ca: 31044, cl: 21281, eq: 32169, ltd: 42819 } : { ca: 20000 + k * 500, cl: 15000, eq: 25000, ltd: 12000 }),
  divps: epsA.map((e, i) => 0.6 + i * 0.05),
  cover: [4302000000], weighted: 4350000000,
});

// B: same size company with a 4-for-1 split: filings made before 2021-01-01 show 4x the per-share numbers
const epsB = [1.1, 1.3, 1.5, 1.7, 2.0, 2.2, 2.5, 2.7, 3.0, 3.3, 3.6, 4.0, 4.5, 5.1, 5.6, 6.2];
export const B = build({
  name: 'Splitter Systems Inc', cik: 222,
  ends: dec(2010, 2025), eps: epsB, split: { filedBefore: '2021-01-01', factor: 4 },
  sales: epsB.map((e, i) => 8000 + i * 900),
  bs: () => ({ ca: 9000, cl: 4000, eq: 15000, ltd: 3000 }),
  divps: epsB.map((e, i) => (i < 6 ? 0 : 0.2 + i * 0.01)),
  cover: [2000000000],
});

// C: retailer with 52/53-week years ending near 31 January; tags change over time; debt tagged as convertible notes
const endsC = ['2016-01-30', '2017-01-28', '2018-02-03', '2019-02-02', '2020-02-01', '2021-01-30', '2022-01-29', '2023-01-28', '2024-02-03', '2025-02-01', '2026-01-31'];
const epsC = [1.0, 1.2, 1.1, 1.4, 1.6, 0.9, 1.8, 2.1, 2.4, 2.5, 2.9];
export const C = build({
  name: 'Fiftytwo Weeks Retail Corp', cik: 333,
  ends: endsC, eps: epsC, lag: 40,
  epsTag: (k) => (k < 5 ? ['us-gaap', 'EarningsPerShareBasicAndDiluted'] : ['us-gaap', 'EarningsPerShareDiluted']),
  sales: epsC.map((e, i) => 20000 + i * 700),
  salesTag: (k) => (k < 6 ? ['us-gaap', 'SalesRevenueNet'] : ['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax']),
  bs: () => ({ ca: 6000, cl: 5000, eq: 7000, ltd: 2500 }), ltdTag: 'ConvertibleNotesPayableNoncurrent',
  divps: null,
  cover: [500000000],
});
// 53-week year: make the period ending 2018-02-03 371 days long
C.facts['us-gaap'].EarningsPerShareBasicAndDiluted.units['USD/shares'].forEach((r) => {
  if (r.end === '2018-02-03') r.start = '2017-01-29';
});

// D: reports in euros
export const D = build({
  name: 'Euro Industrie NV', cik: 444, ends: dec(2015, 2025), eps: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  epsUnit: 'EUR/shares', sales: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], unit: 'EUR',
  bs: () => ({ ca: 500, cl: 300, eq: 800, ltd: 100 }), cover: [100000000],
});

// E: a bank: no current assets / liabilities
export const Ebank = build({
  name: 'First Teller Bancorp', cik: 555, ends: dec(2012, 2025), eps: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  sales: [3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000],
  bs: () => ({ eq: 9000 }), cover: [300000000],
});

// F: young company: only 4 years
export const F = build({
  name: 'Newly Listed Tech Inc', cik: 666, ends: dec(2022, 2025), eps: [0.5, 0.7, 0.9, 1.2],
  sales: [100, 150, 200, 260], bs: () => ({ ca: 300, cl: 100, eq: 400, ltd: 0 }), cover: [90000000],
});

// G: foreign filer (20-F), losses, no debt tag, no revenue tag, no dividend data
export const G = build({
  name: 'Haifa Software Ltd', cik: 777, ends: dec(2015, 2025), eps: [0.8, 0.9, -0.2, 0.4, 1.0, 1.2, -0.1, 0.5, 0.9, 1.1, 1.4], form: '20-F',
  bs: () => ({ ca: 1500, cl: 700, eq: 2000 }), ltdTag: null, cover: [105600000],
});

// H: two share classes on the cover page (same filing)
export const H = build({
  name: 'Dual Class Media Inc', cik: 888, ends: dec(2014, 2025), eps: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1],
  sales: [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000],
  bs: () => ({ ca: 3000, cl: 1500, eq: 6000, ltd: 1000 }), cover: [900000000, 300000000],
});

// I: earnings restated by a non-split ratio (3.00 became 2.20): must NOT be treated as a split
const epsI = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.2];
export const I = build({
  name: 'Restated Goods Inc', cik: 999, ends: dec(2014, 2025), eps: epsI,
  sales: epsI.map(() => 4000), bs: () => ({ ca: 2000, cl: 1000, eq: 5000, ltd: 500 }), cover: [100000000],
});
I.facts['us-gaap'].EarningsPerShareDiluted.units['USD/shares'].forEach((r) => {
  if (r.end === '2022-12-31' && r.filed > '2024-01-01') r.val = 1.2; // 1.8 restated to 1.2 (ratio 1.5) in later filings
});

export const profileA = { cik: '0000000111', name: 'Kola Beverage Co', sic: '2086', sicDescription: 'Bottled & Canned Soft Drinks & Carbonated Waters', exchanges: ['NYSE'], tickers: ['KOLA'] };
export const profileBank = { sic: '6022', sicDescription: 'State Commercial Banks' };

export const TICKERS = {
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [
    [111, 'Kola Beverage Co', 'KOLA', 'NYSE'],
    [222, 'SPLITTER SYSTEMS INC', 'SPLT', 'Nasdaq'],
    [333, 'FIFTYTWO WEEKS RETAIL CORP', 'WEEK', 'NYSE'],
    [444, 'Euro Industrie NV', 'EURO', 'Nasdaq'],
    [555, 'First Teller Bancorp', 'FTB', 'Nasdaq'],
    [666, 'Newly Listed Tech Inc', 'NEWT', 'Nasdaq'],
    [777, 'Haifa Software Ltd', 'HSOF', 'Nasdaq'],
    [888, 'Dual Class Media Inc', 'DCM-A', 'NYSE'],
    [999, 'Restated Goods Inc', 'RGDS', 'OTC'],
    [1010, 'Apple Cart Holdings', 'APLC', 'Nasdaq'],
    [1111, 'Applied Widgets Corp', 'APWD', 'NYSE'],
  ],
};

export const FACTS_BY_CIK = { 111: A, 222: B, 333: C, 444: D, 555: Ebank, 666: F, 777: G, 888: H, 999: I };
