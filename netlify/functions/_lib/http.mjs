// Small helper: JSON responses with sensible cache headers.
// "cdn" is how long Netlify's edge may keep a successful answer (errors are never cached).
export function json(body, status = 200, cdn = null, vary = null) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' };
  if (cdn && status === 200) {
    headers['cache-control'] = 'public, max-age=0, must-revalidate';
    headers['netlify-cdn-cache-control'] = cdn;
    // the answer depends on these query parameters, so each value gets its own cache entry
    if (vary) headers['netlify-vary'] = 'query=' + vary;
  } else {
    headers['cache-control'] = 'no-store';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const STATUS = { badsym: 400, notfound: 404, nofacts: 404, noeps: 422, currency: 422, nobs: 422, history: 422, noeq: 422, noshares: 422, config: 503, sec: 503, secblock: 503 };

// Turns any error into { ok:false, code, msg } with a fitting HTTP status. "detail" only when ?debug=1.
export function fail(e, debug) {
  const code = e && e.code ? e.code : 'internal';
  const body = {
    ok: false,
    code,
    msg: code === 'internal' ? 'אירעה שגיאה בעיבוד נתוני החברה. נסו חברה אחרת או נסו שוב מאוחר יותר.' : e.message,
  };
  if (code === 'internal') {
    try { console.error('internal error', e && e.stack ? e.stack : e); } catch (_) { /* ignore */ }
  }
  if (debug) body.detail = { message: String(e && e.message), extra: (e && e.extra) || null, stack: code === 'internal' && e && e.stack ? String(e.stack).split('\n').slice(0, 6) : undefined };
  return json(body, STATUS[code] || 500);
}
