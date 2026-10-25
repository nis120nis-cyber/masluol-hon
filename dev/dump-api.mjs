// Writes what the three functions answer for the made-up companies, so the website can be tested against realistic answers.
import fs from 'node:fs';
import { installStub } from './stub.mjs';
installStub();
const company = (await import('../netlify/functions/company.mjs')).default;
const out = {};
for (const s of ['KOLA', 'SPLT', 'WEEK', 'HSOF', 'DCM-A', 'RGDS', 'FTB', 'EURO', 'NEWT', 'ZZZZ']) {
  const res = await company(new Request('https://x.test/api/company?symbol=' + s));
  out[s] = await res.json();
}
fs.writeFileSync(new URL('./api-samples.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([k, v]) => k + ':' + (v.ok ? 'ok' : v.code)).join(' '));
