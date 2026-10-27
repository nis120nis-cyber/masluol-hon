// The signed-in user's saved data: lesson progress + demo trading account.
//   GET  /api/data   (Authorization: Bearer <token>) -> { ok, user, data:{demo,prog,updated}|null }
//   POST /api/data   {demo?, prog?}                   -> { ok, updated }
import { json } from './_lib/http.mjs';
import { whoIs, userData } from './_lib/users.mjs';
import { cleanAccount } from './_lib/clean.mjs';

const bad = (code, msg, status = 400) => json({ ok: false, code, msg }, status);

// progress: { lessonId: { best:number, done:boolean, n?:number } }, small and shape-checked
export function cleanProg(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  const keys = Object.keys(p);
  if (keys.length > 80) return null;
  for (const k of keys) {
    const x = p[k];
    if (!/^[a-z0-9-]{1,40}$/i.test(k) || !x || typeof x !== 'object') return null;
    if (typeof x.best !== 'number' || !Number.isFinite(x.best) || x.best < 0 || x.best > 1000) return null;
    const e = { best: x.best, done: !!x.done };
    if (typeof x.n === 'number' && Number.isFinite(x.n) && x.n >= 0 && x.n <= 1000) e.n = x.n;
    out[k] = e;
  }
  return out;
}

export default async (req) => {
  try {
    const who = await whoIs(req);
    if (!who) return bad('auth', 'צריך להתחבר מחדש.', 401);
    const st = await userData();
    if (req.method === 'GET') {
      const d = await st.get(who.key);
      return json({ ok: true, user: who.name, data: d || null });
    }
    if (req.method === 'POST') {
      const text = await req.text();
      if (text.length > 90000) return bad('big', 'הנתונים גדולים מדי לשמירה.', 413);
      let b;
      try {
        b = JSON.parse(text);
      } catch (e) {
        return bad('badrequest', 'בקשה לא תקינה.');
      }
      if (!b || typeof b !== 'object') return bad('badrequest', 'בקשה לא תקינה.');
      const old = (await st.get(who.key)) || {};
      const next = { demo: old.demo || null, prog: old.prog || {}, updated: Date.now() };
      if (b.demo !== undefined) {
        if (b.demo === null) next.demo = null;
        else {
          const a = cleanAccount(b.demo);
          if (!a) return bad('badaccount', 'נתוני החשבון אינם תקינים ולכן לא נשמרו.');
          next.demo = a;
        }
      }
      if (b.prog !== undefined) {
        const p = cleanProg(b.prog);
        if (!p) return bad('badprog', 'נתוני ההתקדמות אינם תקינים ולכן לא נשמרו.');
        next.prog = p;
      }
      await st.set(who.key, next);
      return json({ ok: true, updated: next.updated });
    }
    return bad('method', 'שיטה לא נתמכת.', 405);
  } catch (e) {
    try { console.error('data error', e && e.message); } catch (_) { /* ignore */ }
    return bad('store', 'שירות השמירה אינו זמין כרגע. נסו שוב בעוד רגע.', 503);
  }
};

export const config = { path: '/api/data' };
