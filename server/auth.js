// Simple single-password auth for the public/authenticated split (no RBAC).
// The password is stored only as a scrypt hash + salt in the config; sessions
// are stateless HMAC cookies signed with a persisted per-install secret, so they
// survive restarts without a session store.
import crypto from 'node:crypto';
import { getConfig, saveConfig } from './config.js';

const SESSION_DAYS = 30;
export const COOKIE = 'vmauth';

export function isPasswordSet() {
  return !!getConfig().auth?.passwordHash;
}

function ensureSecret() {
  let secret = getConfig().auth?.secret;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    saveConfig({ auth: { ...(getConfig().auth || {}), secret } });
  }
  return secret;
}

export function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  // Rotate the session-signing secret on every password (re)set so that changing
  // the password invalidates all existing sessions.
  const secret = crypto.randomBytes(32).toString('hex');
  const prev = getConfig().auth || {};
  saveConfig({ auth: { passwordHash, salt, secret, totp: prev.totp || { enabled: false, secret: '' }, totpPending: '' } });
}

export function verifyPassword(pw) {
  const a = getConfig().auth;
  if (!a?.passwordHash || !a.salt) return false;
  const hash = crypto.scryptSync(String(pw), a.salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.passwordHash, 'hex')); }
  catch { return false; }
}

export function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const sig = crypto.createHmac('sha256', ensureSecret()).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

function validToken(token) {
  if (!token) return false;
  const [expS, sig] = String(token).split('.');
  const exp = parseInt(expS, 10);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expect = crypto.createHmac('sha256', ensureSecret()).update(String(exp)).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expect, 'hex')); }
  catch { return false; }
}

function cookieValue(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// A request is authenticated only when a password is configured AND it carries a
// valid session cookie. With no password set, nobody is "authed" — everyone gets
// the public view — until the owner creates one via the setup flow.
export function authed(req) {
  if (!isPasswordSet()) return false;
  return validToken(cookieValue(req, COOKIE));
}

export function setAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
export function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function requireAuth(req, res, next) {
  if (authed(req)) return next();
  res.status(401).json({ error: 'authentication required' });
}

// --------------------------------------------------------------- TOTP (2FA)
// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — compatible with Google Authenticator,
// Authy, etc. Implemented on node:crypto, no external library.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

export function verifyTotp(secretB32, token, window = 1) {
  const t = String(token || '').replace(/\D/g, '');
  if (t.length !== 6 || !secretB32) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let e = -window; e <= window; e++) {
    const expect = hotp(secret, step + e);
    try { if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(t))) return true; } catch { /* len mismatch */ }
  }
  return false;
}

export function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
export function otpauthUri(secret, label = 'admin', issuer = 'VliegmasjienPRO') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function isTotpEnabled() { return !!getConfig().auth?.totp?.enabled; }

export function setPendingTotp(secret) {
  saveConfig({ auth: { ...(getConfig().auth || {}), totpPending: secret } });
}
export function getPendingTotp() { return getConfig().auth?.totpPending || null; }
export function enableTotp(secret) {
  saveConfig({ auth: { ...(getConfig().auth || {}), totp: { enabled: true, secret }, totpPending: '' } });
}
export function disableTotp() {
  saveConfig({ auth: { ...(getConfig().auth || {}), totp: { enabled: false, secret: '' }, totpPending: '' } });
}
export function totpSecret() { return getConfig().auth?.totp?.secret || ''; }

// --------------------------------------------------- login brute-force throttle
// Per-client escalating lockout after repeated failures, plus a global slowdown
// so a distributed guess flood still can't run unbounded.
const attempts = new Map(); // key -> { fails, lockUntil }
const MAX_FAILS = 5;
let globalFails = [];

export function loginLockedFor(key) {
  const s = attempts.get(key);
  if (s && s.lockUntil > Date.now()) return Math.ceil((s.lockUntil - Date.now()) / 1000);
  // global flood guard: too many failures across all clients in the last minute
  globalFails = globalFails.filter((t) => t > Date.now() - 60000);
  if (globalFails.length > 30) return 30;
  return 0;
}

export function recordFail(key) {
  const s = attempts.get(key) || { fails: 0, lockUntil: 0 };
  s.fails++;
  if (s.fails >= MAX_FAILS) {
    const over = s.fails - MAX_FAILS;
    s.lockUntil = Date.now() + Math.min(15 * 60, 30 * 2 ** over) * 1000; // 30s → … → 15min cap
  }
  attempts.set(key, s);
  globalFails.push(Date.now());
  if (attempts.size > 5000) attempts.clear();
}

export function recordSuccess(key) { attempts.delete(key); }
