// Saves a demo trading account in the cloud under a personal code (no sign-up, no e-mail).
//   GET  /api/demo?code=XXXX-XXXX-XXXX-XXXX         -> { ok, code, account, updated }
//   POST /api/demo {action:'create', account}        -> { ok, code }
//   POST /api/demo {action:'save', code, account}    -> { ok, updated }   (only for a code that already exists)
// The code is 16 random characters (80 bits), so it cannot be guessed; whoever holds it can read and change that one account.
import { json } from './_lib/http.mjs';
import { demoStore } from './_lib/store.mjs';

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U
const newCode = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += ALPHA[x & 31];
  return s;
};
const normCode = (c) => String(c || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const validCode = (c) => /^[0-9A-HJKMNP-TV-Z]{16}$/.test(c);
const pretty = (c) => c.match(/.{4}/g).join('-');

const num = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const str = (x, max) => typeof x === 'string' && x.length <= max;
const TK = /^[A-Z0-9-]{1,10}$/;

// Keep only the fields we know, with sane limits (the browser does the arithmetic, the server only guards the shape).
export function cleanAccount(a) {
  if (!a || typeof a !== 'object' || a.v !== 1) return null;
  if (!num(a.start, 100, 1e9) || !num(a.cash, 0, 1e11)) return null;
  if (!a.hold || typeof a.hold !== 'object' || Array.isArray(a.hold)) return null;
  if (!Array.isArray(a.log) || a.log.length > 200 || !Array.isArray(a.snap) || a.snap.length > 300) return null;
  const hold = {};
  const keys = Object.keys(a.hold);
  if (keys.length > 60) return null;
  for (const k of keys) {
    const x = a.hold[k];
    if (!TK.test(k) || !x || !str(x.n, 100) || !num(x.sh, 0, 1e10) || !num(x.cost, 0, 1e13)) return null;
    hold[k] = { n: x.n, sh: x.sh, cost: x.cost };
    if (num(x.px, 0, 1e9)) hold[k].px = x.px;
    if (str(x.asOf, 24)) hold[k].asOf = x.asOf;
  }
  const log = [];
  for (const l of a.log) {
    if (!l || (l.side !== 'buy' && l.side !== 'sell') || !TK.test(String(l.tk)) || !str(l.n, 100) || !num(l.t, 0, 4e12) || !num(l.sh, 0, 1e10) || !num(l.px, 0, 1e9) || !num(l.total, 0, 1e13)) return null;
    const e = { t: l.t, side: l.side, tk: l.tk, n: l.n, sh: l.sh, px: l.px, total: l.total };
    if (l.pl !== undefined) {
      if (!num(l.pl, -1e13, 1e13)) return null;
      e.pl = l.pl;
    }
    log.push(e);
  }
  const snap = [];
  for (const s of a.snap) {
    if (!s || !num(s.t, 0, 4e12) || !num(s.v, -1e13, 1e13)) return null;
    snap.push({ t: s.t, v: s.v });
  }
  const out = { v: 1, start: a.start, cash: a.cash, hold, log, snap, created: num(a.created, 0, 4e12) ? a.created : Date.now() };
  if (num(a.u, 0, 4e12)) out.u = a.u;
  return out;
}

const bad = (code, msg, status = 400) => json({ ok: false, code, msg }, status);

export default async (req) => {
  try {
    const store = await demoStore();
    if (req.method === 'GET') {
      const code = normCode(new URL(req.url).searchParams.get('code'));
      if (!validCode(code)) return bad('badcode', 'הקוד אינו תקין. הוא מורכב מ-16 תווים, אותיות באנגלית ומספרים.');
      const rec = await store.get('a/' + code);
      if (!rec || !rec.account) return bad('nocode', 'לא מצאנו חשבון עם הקוד הזה. בדקו שהקלדתם אותו נכון.', 404);
      return json({ ok: true, code: pretty(code), account: rec.account, updated: rec.updated });
    }
    if (req.method === 'POST') {
      const text = await req.text();
      if (text.length > 80000) return bad('big', 'החשבון גדול מדי לשמירה.', 413);
      let b;
      try {
        b = JSON.parse(text);
      } catch (e) {
        return bad('badrequest', 'בקשה לא תקינה.');
      }
      const account = cleanAccount(b && b.account);
      if (!account) return bad('badaccount', 'נתוני החשבון אינם תקינים ולכן לא נשמרו.');
      if (b.action === 'create') {
        const code = newCode();
        await store.set('a/' + code, { account, created: Date.now(), updated: Date.now() });
        return json({ ok: true, code: pretty(code) });
      }
      if (b.action === 'save') {
        const code = normCode(b.code);
        if (!validCode(code)) return bad('badcode', 'הקוד אינו תקין.');
        const old = await store.get('a/' + code);
        if (!old) return bad('nocode', 'לא מצאנו את החשבון בענן. אפשר ליצור קוד חדש.', 404);
        const updated = Date.now();
        await store.set('a/' + code, { account, created: old.created || updated, updated });
        return json({ ok: true, updated });
      }
      return bad('badrequest', 'בקשה לא תקינה.');
    }
    return bad('method', 'שיטה לא נתמכת.', 405);
  } catch (e) {
    try { console.error('demo store error', e && e.message); } catch (_) { /* ignore */ }
    return bad('store', 'שירות השמירה אינו זמין כרגע. נסו שוב בעוד רגע.', 503);
  }
};

export const config = { path: '/api/demo' };
