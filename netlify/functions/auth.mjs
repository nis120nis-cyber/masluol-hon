// Sign up / log in / log out.  POST /api/auth {action:'register'|'login'|'logout', user, pass, token}
import { json } from './_lib/http.mjs';
import { normUser, validUser, validPass, register, check, newSession, endSession } from './_lib/users.mjs';

const bad = (code, msg, status = 400) => json({ ok: false, code, msg }, status);

export default async (req) => {
  if (req.method !== 'POST') return bad('method', 'שיטה לא נתמכת.', 405);
  try {
    const text = await req.text();
    if (text.length > 2000) return bad('badrequest', 'בקשה לא תקינה.');
    let b;
    try {
      b = JSON.parse(text);
    } catch (e) {
      return bad('badrequest', 'בקשה לא תקינה.');
    }
    if (!b || typeof b !== 'object') return bad('badrequest', 'בקשה לא תקינה.');
    if (b.action === 'logout') {
      await endSession(b.token);
      return json({ ok: true });
    }
    const name = String(b.user || '').trim();
    if (b.action === 'register') {
      if (!validUser(normUser(name))) return bad('baduser', 'שם משתמש: 3 עד 20 תווים, אותיות, ספרות, נקודה, קו תחתון או מקף.');
      if (!validPass(b.pass)) return bad('badpass', 'הסיסמה צריכה להיות באורך 6 תווים לפחות.');
      const r = await register(name, b.pass);
      if (r.err === 'taken') return bad('taken', 'שם המשתמש הזה תפוס. בחרו שם אחר.', 409);
      const token = await newSession(r.key, r.name);
      return json({ ok: true, token, user: r.name });
    }
    if (b.action === 'login') {
      if (!name || typeof b.pass !== 'string' || !b.pass) return bad('badrequest', 'יש להזין שם משתמש וסיסמה.');
      const r = await check(name, b.pass);
      if (r.err === 'locked') return bad('locked', 'יותר מדי ניסיונות שגויים. נסו שוב בעוד כמה דקות.', 429);
      if (r.err) return bad('bad', 'שם המשתמש או הסיסמה שגויים.', 401);
      const token = await newSession(r.key, r.name);
      return json({ ok: true, token, user: r.name });
    }
    return bad('badrequest', 'בקשה לא תקינה.');
  } catch (e) {
    try { console.error('auth error', e && e.message); } catch (_) { /* ignore */ }
    return bad('store', 'שירות החשבונות אינו זמין כרגע. נסו שוב בעוד רגע.', 503);
  }
};

export const config = { path: '/api/auth' };
