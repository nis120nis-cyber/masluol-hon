// Turns the raw SEC "company facts" JSON into the few numbers the Graham checks need.
// Pure functions only (no network), so every rule here can be tested with fixture files.
//
// Shape of SEC data, for reference:
//   facts.facts["us-gaap"]["EarningsPerShareDiluted"].units["USD/shares"] = [
//     { start, end, val, accn, fy, fp, form, filed, frame? }, ...
//   ]
// The same period shows up once per filing that included it, so one fiscal year can have several rows
// (the original 10-K, then each later 10-K that repeats it as a comparison year).
// "fy" is the fiscal year of the FILING, not of the period, so it is never used to label a period.

const DAY = 86400000;
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT', '10-KT/A', '20-F', '20-F/A', '40-F', '40-F/A']);

const toMs = (s) => Date.parse(s + 'T00:00:00Z');

export class DataError extends Error {
  constructor(code, msg, extra) {
    super(msg);
    this.code = code;
    this.extra = extra || null;
  }
}

/* ------------------------------------------------------------------ which tags to look at */

const TAGS = {
  eps: [
    ['us-gaap', 'EarningsPerShareDiluted'],
    ['us-gaap', 'EarningsPerShareBasicAndDiluted'],
    ['us-gaap', 'EarningsPerShareBasic'],
    ['ifrs-full', 'DilutedEarningsLossPerShare'],
    ['ifrs-full', 'BasicAndDilutedEarningsLossPerShare'],
    ['ifrs-full', 'BasicEarningsLossPerShare'],
    ['us-gaap', 'IncomeLossFromContinuingOperationsPerDilutedShare'],
    ['us-gaap', 'IncomeLossFromContinuingOperationsPerBasicShare'],
  ],
  sales: [
    ['us-gaap', 'Revenues'],
    ['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
    ['us-gaap', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
    ['us-gaap', 'SalesRevenueNet'],
    ['us-gaap', 'SalesRevenueGoodsNet'],
    ['ifrs-full', 'Revenue'],
  ],
  ca: [['us-gaap', 'AssetsCurrent'], ['ifrs-full', 'CurrentAssets']],
  cl: [['us-gaap', 'LiabilitiesCurrent'], ['ifrs-full', 'CurrentLiabilities']],
  eq: [
    ['us-gaap', 'StockholdersEquity'],
    ['ifrs-full', 'EquityAttributableToOwnersOfParent'],
    ['us-gaap', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    ['ifrs-full', 'Equity'],
  ],
  // Long-term debt, non-current part. First one found at the balance-sheet date wins (they are alternatives, never added up).
  ltd: [
    ['us-gaap', 'LongTermDebtNoncurrent'],
    ['us-gaap', 'LongTermDebtAndCapitalLeaseObligations'],
    ['us-gaap', 'LongTermNotesPayable'],
    ['us-gaap', 'SeniorNotesNoncurrent'],
    ['us-gaap', 'ConvertibleNotesPayableNoncurrent'],
    ['us-gaap', 'ConvertibleDebtNoncurrent'],
    ['us-gaap', 'OtherLongTermDebtNoncurrent'],
    ['ifrs-full', 'NoncurrentPortionOfLongtermBorrowings'],
    ['ifrs-full', 'LongtermBorrowings'],
    ['ifrs-full', 'NoncurrentPortionOfNoncurrentBondsIssued'],
  ],
  ltdTotal: [['us-gaap', 'LongTermDebt']],
  ltdCurrent: [['us-gaap', 'LongTermDebtCurrent']],
  sharesWeighted: [
    ['us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding'],
    ['us-gaap', 'WeightedAverageNumberOfSharesOutstandingBasic'],
    ['ifrs-full', 'WeightedAverageShares'],
  ],
  sharesBalance: [['us-gaap', 'CommonStockSharesOutstanding'], ['ifrs-full', 'NumberOfSharesOutstanding']],
  divPerShare: [
    ['us-gaap', 'CommonStockDividendsPerShareDeclared'],
    ['us-gaap', 'CommonStockDividendsPerShareCashPaid'],
    ['ifrs-full', 'DividendsRecognisedAsDistributionsToOwnersPerShare'],
  ],
  divCash: [
    ['us-gaap', 'PaymentsOfDividendsCommonStock'],
    ['us-gaap', 'PaymentsOfDividends'],
    ['us-gaap', 'PaymentsOfOrdinaryDividends'],
    ['us-gaap', 'DividendsCommonStockCash'],
    ['ifrs-full', 'DividendsPaidOrdinarySharesClassifiedAsFinancingActivities'],
    ['ifrs-full', 'DividendsPaidClassifiedAsFinancingActivities'],
  ],
};

/* ------------------------------------------------------------------ small helpers */

const unitsOf = (facts, ns, tag) => (facts && facts.facts && facts.facts[ns] && facts.facts[ns][tag] && facts.facts[ns][tag].units) || null;

// Pick the unit to read. kind: 'perShare' (USD/shares), 'money' (USD), 'shares' (shares).
// If a company reports in several currencies the unit with the most recent data wins; USD wins ties.
function pickUnit(units, kind) {
  if (!units) return null;
  const re = kind === 'perShare' ? /^[A-Z]{3}\/shares$/ : kind === 'shares' ? /^shares$/i : /^[A-Z]{3}$/;
  const keys = Object.keys(units).filter((k) => re.test(k) && Array.isArray(units[k]) && units[k].length);
  if (!keys.length) return null;
  const pref = kind === 'perShare' ? 'USD/shares' : kind === 'money' ? 'USD' : null;
  let best = null;
  for (const k of keys) {
    let last = '';
    for (const e of units[k]) if (e && e.end > last) last = e.end;
    if (!best || last > best.last || (last === best.last && k === pref)) best = { unit: k, last };
  }
  return { unit: best.unit, entries: units[best.unit] };
}

// Fiscal-year label: the calendar year of (period end - 15 days).
// This keeps 52/53-week years that end on Jan 1-3 in the right year, and gives every year exactly one label.
export function fyLabel(endISO) {
  return new Date(toMs(endISO) - 15 * DAY).getUTCFullYear();
}

// One row per annual period (350-380 days, annual forms only). Keeps the full filing history of each period.
export function annualPoints(entries) {
  const byEnd = new Map();
  for (const e of entries || []) {
    if (!e || typeof e.val !== 'number' || !isFinite(e.val) || !e.start || !e.end || !e.filed) continue;
    if (!ANNUAL_FORMS.has(e.form)) continue;
    const d = (toMs(e.end) - toMs(e.start)) / DAY;
    if (!(d >= 350 && d <= 380)) continue;
    let p = byEnd.get(e.end);
    if (!p) {
      p = { end: e.end, start: e.start, label: fyLabel(e.end), hist: [] };
      byEnd.set(e.end, p);
    }
    if (!p.hist.some((h) => h.accn === e.accn && h.val === e.val)) p.hist.push({ filed: e.filed, val: e.val, accn: e.accn || '', form: e.form });
  }
  const out = [];
  for (const p of byEnd.values()) {
    p.hist.sort((a, b) => (a.filed < b.filed ? -1 : a.filed > b.filed ? 1 : a.accn < b.accn ? -1 : 1));
    const last = p.hist[p.hist.length - 1];
    p.val = last.val;
    p.filed = last.filed;
    p.form = last.form;
    out.push(p);
  }
  out.sort((a, b) => (a.end < b.end ? -1 : 1));
  // two periods with the same label (a short transition year): keep the later one
  const byLabel = new Map();
  for (const p of out) byLabel.set(p.label, p);
  return [...byLabel.values()].sort((a, b) => a.label - b.label);
}

// Balance-sheet style value at an exact date. Prefers annual filings, then the newest filing.
function instantAt(entries, endISO) {
  let best = null;
  for (const e of entries || []) {
    if (!e || typeof e.val !== 'number' || !isFinite(e.val) || e.end !== endISO) continue;
    const annual = ANNUAL_FORMS.has(e.form) ? 1 : 0;
    if (!best || annual > best.annual || (annual === best.annual && (e.filed || '') > (best.filed || ''))) {
      best = { val: e.val, filed: e.filed || '', annual };
    }
  }
  return best;
}

function firstInstant(facts, specs, kind, endISO) {
  for (const [ns, tag] of specs) {
    const u = pickUnit(unitsOf(facts, ns, tag), kind);
    if (!u) continue;
    const hit = instantAt(u.entries, endISO);
    if (hit) return { val: hit.val, tag: ns + ':' + tag, unit: u.unit };
  }
  return null;
}

// Annual duration value (e.g. revenue) of the period ending exactly at endISO
function annualAt(facts, ns, tag, kind, endISO) {
  const u = pickUnit(unitsOf(facts, ns, tag), kind);
  if (!u) return null;
  const p = annualPoints(u.entries).find((x) => x.end === endISO);
  return p ? { val: p.val, tag: ns + ':' + tag, unit: u.unit } : null;
}

/* ------------------------------------------------------------------ stock splits */

// Common split ratios. 4/3 and 5/4 are rare, so they need two periods that agree.
const SPLIT_FACTORS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100, 1.5, 2.5, 4 / 3, 1.25];

// a = older reported value, b = newer reported value of the SAME period.
// Returns { f, err, whole } when a is about f times b (f>1 forward split, f<1 reverse split).
function matchSplit(a, b) {
  if (!(Math.abs(a) > 0) || !(Math.abs(b) > 0) || a > 0 !== b > 0) return null;
  let best = null;
  for (const k of SPLIT_FACTORS) {
    for (const f of [k, 1 / k]) {
      const old = f >= 1 ? a : b; // the larger-per-share side
      const nw = f >= 1 ? b : a;
      const kk = f >= 1 ? f : 1 / f;
      const diff = Math.abs(old - kk * nw);
      const tol = 0.005 * (1 + kk) + 0.003 * Math.abs(old); // cents rounding on both numbers
      if (diff <= tol) {
        const err = diff / Math.abs(old);
        if (!best || err < best.err) best = { f: a / b > 1 ? kk : 1 / kk, err, whole: Number.isInteger(kk) };
      }
    }
  }
  return best;
}

// A split shows up as a later filing repeating an earlier period at 1/k of the old per-share number.
// An event is accepted when two periods agree on it, or one period matches a whole ratio very closely.
export function detectSplits(points) {
  const votes = new Map();
  for (const p of points) {
    for (let i = 1; i < p.hist.length; i++) {
      const a = p.hist[i - 1].val;
      const b = p.hist[i].val;
      if (a === b) continue;
      const m = matchSplit(a, b);
      if (!m) continue;
      const key = p.hist[i].filed + '|' + m.f.toFixed(5);
      const v = votes.get(key) || { filedNew: p.hist[i].filed, f: m.f, n: 0, strong: 0 };
      v.n++;
      if (m.whole && m.err < 0.006 && Math.max(Math.abs(a), Math.abs(b)) >= 1) v.strong++;
      votes.set(key, v);
    }
  }
  const ev = [...votes.values()].filter((v) => v.n >= 2 || v.strong >= 1);
  ev.sort((x, y) => (x.filedNew < y.filedNew ? -1 : 1));
  return ev;
}

// Put every period on the same share basis as the newest filing.
export function applySplits(points, events) {
  if (!events.length) return points;
  return points.map((p) => {
    let f = 1;
    for (const e of events) if (p.filed < e.filedNew) f *= e.f;
    return f === 1 ? p : { ...p, val: p.val / f, adjusted: true };
  });
}

/* ------------------------------------------------------------------ earnings per share (ten fiscal years) */

function buildEps(facts, dbg) {
  const cands = [];
  TAGS.eps.forEach(([ns, tag], pri) => {
    const u = pickUnit(unitsOf(facts, ns, tag), 'perShare');
    if (!u) return;
    const pts = annualPoints(u.entries);
    if (!pts.length) return;
    cands.push({ ns, tag, pri, unit: u.unit, pts, top: pts[pts.length - 1].label });
  });
  dbg.epsCandidates = cands.map((c) => ({ tag: c.ns + ':' + c.tag, unit: c.unit, n: c.pts.length, first: c.pts[0].label, last: c.top }));
  if (!cands.length) throw new DataError('noeps', 'לא נמצא רווח למניה בדוחות השנתיים של החברה.');

  const topAll = Math.max(...cands.map((c) => c.top));
  const current = cands.filter((c) => c.top === topAll).sort((a, b) => a.pri - b.pri);
  const primary = current[0];
  if (primary.unit !== 'USD/shares') {
    throw new DataError('currency', 'החברה מדווחת במטבע שאינו דולר (' + primary.unit.split('/')[0] + '). כרגע האתר בודק רק חברות שמדווחות בדולרים.', { unit: primary.unit });
  }

  const events = detectSplits(primary.pts);
  const maps = [];
  const order = [primary, ...cands.filter((c) => c !== primary).sort((a, b) => a.pri - b.pri)];
  for (const c of order) {
    if (c.unit !== 'USD/shares') continue;
    const ev = c === primary ? events : detectSplits(c.pts);
    const pts = applySplits(c.pts, ev);
    const m = new Map();
    for (const p of pts) m.set(p.label, { ...p, tag: c.ns + ':' + c.tag });
    maps.push(m);
  }

  const rows = [];
  let stitched = false;
  for (let y = topAll; y > topAll - 10; y--) {
    let hit = null;
    for (let i = 0; i < maps.length; i++) {
      if (maps[i].has(y)) {
        hit = maps[i].get(y);
        if (i > 0) stitched = true;
        break;
      }
    }
    if (!hit) break;
    rows.unshift(hit);
  }
  dbg.splits = events;
  return {
    rows,
    top: topAll,
    fyEnd: primary.pts[primary.pts.length - 1].end,
    form: primary.pts[primary.pts.length - 1].form,
    filed: primary.pts[primary.pts.length - 1].filed,
    tag: primary.ns + ':' + primary.tag,
    stitched,
    splits: events,
    adjusted: rows.some((r) => r.adjusted),
  };
}

/* ------------------------------------------------------------------ dividends */

function dividendMap(facts, specs, kind) {
  const m = new Map(); // label -> true when something was paid that year
  for (const [ns, tag] of specs) {
    const u = pickUnit(unitsOf(facts, ns, tag), kind);
    if (!u) continue;
    for (const p of annualPoints(u.entries)) m.set(p.label, !!(m.get(p.label) || Math.abs(p.val) > 0));
  }
  return m;
}

function buildDividends(facts, top) {
  const a = dividendMap(facts, TAGS.divPerShare, 'perShare');
  const b = dividendMap(facts, TAGS.divCash, 'money');
  const m = new Map(a);
  for (const [y, v] of b) m.set(y, !!(m.get(y) || v));
  if (!m.size) return { div: 0, open: false, noData: true };
  if (!m.has(top)) return { div: 0, open: false, noData: true, missingLatest: true };
  let streak = 0;
  while (m.get(top - streak) === true) streak++;
  const earliest = Math.min(...m.keys());
  const open = streak > 0 && top - streak + 1 <= earliest && top - earliest >= 11;
  return { div: streak, open, noData: false, earliest };
}

/* ------------------------------------------------------------------ shares outstanding */

function buildShares(facts, fyEnd, now) {
  // 1) cover page of the newest filing(s). Several classes of shares appear as several rows with the same date: add them up.
  const cover = unitsOf(facts, 'dei', 'EntityCommonStockSharesOutstanding');
  const cu = pickUnit(cover, 'shares');
  if (cu) {
    let newest = '';
    for (const e of cu.entries) if (e && typeof e.val === 'number' && e.val > 0 && e.end > newest) newest = e.end;
    if (newest && (now - toMs(newest)) / DAY < 800) {
      const same = cu.entries.filter((e) => e && e.end === newest && typeof e.val === 'number' && e.val > 0);
      const latestAccn = same.reduce((acc, e) => ((e.filed || '') > acc.filed ? { filed: e.filed || '', accn: e.accn } : acc), { filed: '', accn: '' }).accn;
      const rows = same.filter((e) => e.accn === latestAccn);
      const vals = [...new Set(rows.map((e) => e.val))];
      const total = vals.reduce((s, v) => s + v, 0);
      return { val: total / 1e6, tag: 'dei:EntityCommonStockSharesOutstanding', multi: vals.length > 1, asOf: newest };
    }
  }
  // 2) balance-sheet count at the fiscal year end
  const bs = firstInstant(facts, TAGS.sharesBalance, 'shares', fyEnd);
  if (bs && bs.val > 0) return { val: bs.val / 1e6, tag: bs.tag, fallback: true, asOf: fyEnd };
  // 3) weighted average of the fiscal year
  for (const [ns, tag] of TAGS.sharesWeighted) {
    const h = annualAt(facts, ns, tag, 'shares', fyEnd);
    if (h && h.val > 0) return { val: h.val / 1e6, tag: h.tag, fallback: true, weighted: true, asOf: fyEnd };
  }
  return null;
}

/* ------------------------------------------------------------------ the whole company */

// dd.mm.yyyy for Hebrew text
export const heDate = (iso) => (iso ? iso.slice(8, 10).replace(/^0/, '') + '.' + iso.slice(5, 7).replace(/^0/, '') + '.' + iso.slice(0, 4) : '');
const round = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mil = (v) => round(v / 1e6, 3);

export function normalizeCompany(facts, meta, nowMs) {
  const dbg = {};
  const now = nowMs || Date.now();
  const e = buildEps(facts, dbg);
  const fyEnd = e.fyEnd;

  const years = e.rows.map((r) => r.label);
  if (e.rows.length < 6) {
    throw new DataError('history', 'יש בדוחות רק ' + e.rows.length + ' שנות רווח רצופות. כדי להריץ את המבחנים צריך לפחות 6 שנים (למשל חברה שהונפקה לאחרונה לא תתאים).', { years: e.rows.length });
  }

  // balance sheet at the fiscal year end
  const ca = firstInstant(facts, TAGS.ca, 'money', fyEnd);
  const cl = firstInstant(facts, TAGS.cl, 'money', fyEnd);
  if (!ca || !cl) {
    throw new DataError('nobs', 'במאזן של החברה אין חלוקה לנכסים והתחייבויות שוטפים (כך נראים בדרך כלל בנקים, חברות ביטוח וקרנות), ולכן מבחני גרהם לא מתאימים לה.');
  }
  if (ca.unit !== 'USD' || cl.unit !== 'USD') {
    throw new DataError('currency', 'המאזן של החברה אינו בדולרים. כרגע האתר בודק רק חברות שמדווחות בדולרים.', { unit: ca.unit });
  }
  const eq = firstInstant(facts, TAGS.eq, 'money', fyEnd);

  let ltd = firstInstant(facts, TAGS.ltd, 'money', fyEnd);
  let ltdNote = null;
  if (!ltd) {
    const tot = firstInstant(facts, TAGS.ltdTotal, 'money', fyEnd);
    if (tot) {
      const cur = firstInstant(facts, TAGS.ltdCurrent, 'money', fyEnd);
      ltd = { val: Math.max(0, tot.val - (cur ? cur.val : 0)), tag: tot.tag + (cur ? ' − ' + cur.tag : ''), unit: 'USD' };
    }
  }
  if (!ltd) ltdNote = 'missing';

  // revenue: the largest of the revenue lines reported for the year (total revenue is never smaller than a part of it)
  let sales = null;
  for (const [ns, tag] of TAGS.sales) {
    const h = annualAt(facts, ns, tag, 'money', fyEnd);
    if (h && (!sales || h.val > sales.val)) sales = h;
  }

  const sh = buildShares(facts, fyEnd, now);
  const dv = buildDividends(facts, e.top);

  // ---- warnings (Hebrew, shown to the user)
  const warns = [];
  const sic = meta && meta.sic ? Number(meta.sic) : null;
  if (sic && sic >= 6000 && sic <= 6799) {
    warns.push({ c: 'finco', l: 'warn', t: 'זו חברה פיננסית (בנק, ביטוח, השקעות או נדל״ן). מבחני היחס השוטף והחוב ארוך הטווח של גרהם נבנו לחברות תעשייה ומסחר, ולכן התוצאה כאן פחות אמינה.' });
  }
  if (!eq) {
    throw new DataError('noeq', 'לא נמצא הון עצמי במאזן של החברה.');
  }
  if (!sh) {
    throw new DataError('noshares', 'לא נמצא מספר המניות של החברה בדוחות.');
  }
  if (e.rows.length < 10) {
    warns.push({ c: 'short', l: 'warn', t: 'בדוחות יש ' + e.rows.length + ' שנות רווח רצופות בלבד, ולא עשר. מבחנים שדורשים עשר שנים (יציבות רווחים וצמיחה) מסומנים כ״לא נבדק״ כשהחברה עוברת אותם.' });
  }
  if (e.stitched) {
    warns.push({ c: 'stitched', l: 'info', t: 'בחלק מהשנים הרווח למניה נלקח מסעיף אחר בדוחות (למשל בסיסי במקום מדולל), כי הסעיף הרגיל חסר באותן שנים.' });
  }
  if (e.adjusted) {
    warns.push({ c: 'split', l: 'info', t: 'זוהה פיצול מניות בעשור האחרון, והרווח למניה בשנים שלפניו הותאם כדי שכל השנים יהיו על אותו בסיס. כדאי לוודא את המספרים מול הדוחות.' });
  }
  const ageDays = (now - toMs(fyEnd)) / DAY;
  if (ageDays > 560) {
    warns.push({ c: 'stale', l: 'warn', t: 'הדוח השנתי האחרון של החברה נסגר ב-' + heDate(fyEnd) + ', כלומר הוא ישן. ייתכן שהחברה כבר אינה מדווחת, או שיש דוחות חדשים שעדיין לא נקלטו.' });
  }
  if (e.form === '20-F' || e.form === '40-F' || e.form === '20-F/A' || e.form === '40-F/A') {
    warns.push({ c: 'foreign', l: 'info', t: 'חברה זרה שמגישה דוח ' + e.form.replace('/A', '') + '. ודאו שהמחיר שאתם בודקים הוא למניה רגילה אחת, כי מניות הנסחרות כ-ADR עשויות לייצג מספר אחר של מניות.' });
  }
  if (ltdNote === 'missing') {
    warns.push({ c: 'noltd', l: 'warn', t: 'לא נמצא חוב ארוך טווח במאזן, ולכן הוא הוגדר כאפס. אם לחברה יש אג״ח או הלוואות, בדקו במאזן ועדכנו ידנית בבדיקה צעד אחר צעד.' });
  } else {
    warns.push({ c: 'ltdsrc', l: 'info', t: 'החוב ארוך הטווח נלקח מסעיף אחד במאזן (השם המדויק מופיע בפירוט הנתונים). אם בחברה יש חכירות או סעיפי חוב נוספים, ייתכן שחלק מהם לא נכלל.' });
  }
  if (!sales) {
    warns.push({ c: 'nosales', l: 'warn', t: 'לא נמצא מחזור שנתי בדוחות, ולכן מבחן הגודל לא נבדק.' });
  }
  if (sh.fallback) {
    warns.push({ c: 'shfb', l: 'info', t: 'מספר המניות נלקח מהמאזן או מממוצע שנתי ולא מעמוד השער של הדוח, ולכן עשוי להיות פחות עדכני.' });
  }
  if (sh.multi) {
    warns.push({ c: 'multi', l: 'info', t: 'לחברה כמה סוגי מניות. מספר המניות הוא הסכום של כולן, והמחיר צריך להיות של אחד הסוגים.' });
  }
  if (dv.noData) {
    warns.push({ c: 'nodiv', l: 'info', t: 'לא נמצא בדוחות נתון על דיבידנד, ולכן הרצף מוצג כאפס. אם החברה מחלקת דיבידנד, אפשר להזין את מספר השנים בעצמכם.' });
  } else if (dv.open) {
    warns.push({ c: 'divopen', l: 'info', t: 'הדוחות הדיגיטליים מכסים בערך 15 שנה, ולכן הרצף שמוצג הוא רף תחתון. מבחן 20 השנים מסומן כ״לא נבדק״ עד שתזינו כמה שנים החברה מחלקת בפועל.' });
  }

  const eps = e.rows.map((r) => round(r.val, 4));
  const name = (meta && meta.name) || facts.entityName || '';
  dbg.chosen = {
    eps: e.rows.map((r) => r.label + ':' + r.tag),
    ca: ca.tag, cl: cl.tag, eq: eq.tag, ltd: ltd ? ltd.tag : null, sales: sales ? sales.tag : null, shares: sh.tag, sharesAsOf: sh.asOf,
    dividends: dv,
  };

  return {
    n: name,
    form: e.form,
    filed: e.filed,
    fyEnd,
    fyLabel: e.top,
    y0: years[0],
    years,
    eps,
    shares: round(sh.val, 3),
    eq: mil(eq.val),
    sales: sales ? mil(sales.val) : null,
    ca: mil(ca.val),
    cl: mil(cl.val),
    ltd: ltd ? mil(ltd.val) : 0,
    div: dv.div,
    divOpen: !!dv.open,
    divNoData: !!dv.noData,
    warns,
    tags: { eps: e.tag, ca: ca.tag, cl: cl.tag, eq: eq.tag, ltd: ltd ? ltd.tag : null, sales: sales ? sales.tag : null, shares: sh.tag },
    debug: dbg,
  };
}
