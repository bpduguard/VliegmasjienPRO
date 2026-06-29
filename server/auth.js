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
  const secret = getConfig().auth?.secret || crypto.randomBytes(32).toString('hex');
  saveConfig({ auth: { passwordHash, salt, secret } });
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
