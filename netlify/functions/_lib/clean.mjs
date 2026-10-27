// Shape guard for a demo trading account (shared by the code-save and the login-save functions).
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
