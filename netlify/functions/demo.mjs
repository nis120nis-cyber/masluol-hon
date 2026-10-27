// Saves a demo trading account in the cloud under a personal code (no sign-up, no e-mail).
//   GET  /api/demo?code=XXXX-XXXX-XXXX-XXXX         -> { ok, code, account, updated }
//   POST /api/demo {action:'create', account}        -> { ok, code }
//   POST /api/demo {action:'save', code, account}    -> { ok, updated }   (only for a code that already exists)
// The code is 16 random characters (80 bits), so it cannot be guessed; whoever holds it can read and change that one account.
import { json } from './_lib/http.mjs';
import { demoStore } from './_lib/store.mjs';
import { cleanAccount } from './_lib/clean.mjs';

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
