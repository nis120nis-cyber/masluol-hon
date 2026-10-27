// Sign up / log in / log out.  POST /api/auth {action:'register'|'login'|'logout', user, pass, token}
import { json } from './_lib/http.mjs';
import { normUser, validUser, validPass, register, check, newSession, endSession } from './_lib/users.mjs';

const bad = (code, msg, status = 400) => json({ ok: false, code, msg }, status);

// Verifies a "Sign in with Google" ID token with Google and returns the stable user id + a display name.
export async function verifyGoogle(credential, clientId) {
  if (typeof credential !== 'string' || credential.length > 4000) return null;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) return null;
  const t = await r.json();
  if (t.aud !== clientId || !t.sub) return null;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(t.iss)) return null;
  if (String(t.email_verified) !== 'true') return null;
  if (Number(t.exp) * 1000 < Date.now()) return null;
  const name = String(t.given_name || String(t.email || '').split('@')[0] || 'משתמש').slice(0, 30);
  return { key: 'google:' + t.sub, name };
}

export default async (req) => {
  if (req.method === 'GET') return json({ ok: true, google: process.env.GOOGLE_CLIENT_ID || null });
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
    if (b.action === 'google') {
      const cid = process.env.GOOGLE_CLIENT_ID;
      if (!cid) return bad('nogoogle', 'כניסה עם גוגל עדיין לא הופעלה באתר.', 503);
      const g = await verifyGoogle(b.credential, cid);
      if (!g) return bad('badgoogle', 'לא הצלחנו לאמת את החשבון בגוגל. נסו שוב.', 401);
      const token = await newSession(g.key, g.name);
      return json({ ok: true, token, user: g.name });
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
