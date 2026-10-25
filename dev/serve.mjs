// Local test server: serves files from a folder and answers /api/* with the real function code,
// with SEC replaced by the made-up fixtures.  node dev/serve.mjs <root-folder> [port]
// Set QUOTE=1 to switch the (fake) price provider on.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { installStub } from './stub.mjs';

installStub();
if (process.env.QUOTE === '1') {
  process.env.QUOTE_PROVIDER = 'finnhub';
  process.env.QUOTE_API_KEY = 'test';
}
const fns = {
  company: (await import('../netlify/functions/company.mjs')).default,
  search: (await import('../netlify/functions/search.mjs')).default,
  quote: (await import('../netlify/functions/quote.mjs')).default,
};
const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8787);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.woff2': 'font/woff2', '.json': 'application/json' };

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.replace(/^\/(api|\.netlify\/functions)\//, '');
      if (process.env.NOSHORT === '1' && u.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<h1>Not found</h1>');
      }
      const fn = fns[name];
      if (!fn) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<h1>Not found</h1>');
      }
      if (process.env.SLOW) await new Promise((r) => setTimeout(r, Number(process.env.SLOW)));
      const r = await fn(new Request('http://localhost' + req.url));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(await r.text());
    }
    let f = path.join(root, decodeURIComponent(u.pathname));
    if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  })
  .listen(port, () => console.log('listening', port));
