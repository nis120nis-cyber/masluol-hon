// Users: name + password. Passwords are hashed with scrypt (never stored); sessions are random tokens (only their SHA-256 is stored).
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { demoStore } from './store.mjs';

const hashPw = (pw, salt) => new Promise((res, rej) => scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
const sha = (s) => createHash('sha256').update(s).digest('hex');

export const normUser = (u) => String(u || '').trim().normalize('NFC').toLowerCase();
export const validUser = (u) => /^[\p{L}\p{N}_.-]{3,20}$/u.test(u);
export const validPass = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 100;

const DAY = 86400000;
const SESSION_DAYS = 120;
const MAX_FAILS = 6;
const LOCK_MS = 15 * 60000;

export const users = () => demoStore('users');
export const sessions = () => demoStore('sessions');
export const userData = () => demoStore('userdata');

export async function register(name, pass) {
  const key = normUser(name);
  const st = await users();
  if (await st.get(key)) return { err: 'taken' };
  const salt = randomBytes(16);
  const hash = await hashPw(pass, salt);
  await st.set(key, { name: String(name).trim(), salt: salt.toString('hex'), hash: hash.toString('hex'), created: Date.now(), fails: 0, lock: 0 });
  return { key, name: String(name).trim() };
}

export async function check(name, pass) {
  const key = normUser(name);
  const st = await users();
  const u = await st.get(key);
  if (!u) {
    await hashPw(String(pass), randomBytes(16)); // same cost whether or not the name exists
    return { err: 'bad' };
  }
  if (u.lock && u.lock > Date.now()) return { err: 'locked', until: u.lock };
  const h = await hashPw(String(pass), Buffer.from(u.salt, 'hex'));
  const ok = timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
  if (!ok) {
    u.fails = (u.fails || 0) + 1;
    if (u.fails >= MAX_FAILS) {
      u.lock = Date.now() + LOCK_MS;
      u.fails = 0;
    }
    await st.set(key, u);
    return u.lock > Date.now() ? { err: 'locked', until: u.lock } : { err: 'bad' };
  }
  if (u.fails || u.lock) {
    u.fails = 0;
    u.lock = 0;
    await st.set(key, u);
  }
  return { key, name: u.name };
}

export async function newSession(key, name) {
  const token = randomBytes(32).toString('hex');
  await (await sessions()).set(sha(token), { key, name, exp: Date.now() + SESSION_DAYS * DAY });
  return token;
}

export async function whoIs(req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('authorization') || '');
  if (!m) return null;
  const st = await sessions();
  const s = await st.get(sha(m[1]));
  if (!s) return null;
  if (s.exp < Date.now()) {
    await st.del(sha(m[1]));
    return null;
  }
  return s;
}

export async function endSession(token) {
  if (/^[0-9a-f]{64}$/.test(token || '')) await (await sessions()).del(sha(token));
}
