import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { loadConfig, getConfig, saveConfig, publicConfig, DATA_DIR } from './config.js';
import { initDb, aircraftHistory, recentAlerts, statsSummary, aircraftDbCount, bulkImportAircraftDb, logStorageInfo, purgeLogs, getAircraftTrack } from './db.js';
import {
  loadPlaneDbFromDisk, refreshPlaneDb, planeDbMeta, planeDbLookup, planeDbSearch, aircraftDbError, lookupRoute
} from './enrich.js';
import { lookupPhoto, extFetch, photoServiceError, parseCsvLine } from './enrich.js';
import {
  startTracker, snapshot, aircraftDetail, trackerStatus, setTrackerBroadcast, arrivalsSnapshot, arrivalsBoard, rebuildAirportIndex, reloadFromDisk
} from './tracker.js';
import { setBroadcast, notify } from './notify.js';
import { refreshFrequencies, frequenciesMeta } from './freq.js';
import { airportFreqsInBounds, replayBounds, replayFrame, spottedSince, heatmapCells, airportByIdent } from './db.js';
import { recentDetectionList } from './detect.js';
import { webcamsInBounds, normalizeEmbed, isEmbeddableHost } from './webcams.js';
import { createBackup, restoreBackup, readManifest } from './backup.js';
import { icaoToCountry } from './country.js';
import { rangeOutline, clearRange } from './range.js';
import { getTles, startPassNotifier } from './space.js';
import { getForecast, weatherWarnings, startWeatherNotifier } from './weather.js';
import { skyAssessment } from './skywatch.js';
import {
  authed, requireAuth, isPasswordSet, setPassword, verifyPassword, setAuthCookie, clearAuthCookie,
  isTotpEnabled, verifyTotp, newTotpSecret, otpauthUri, setPendingTotp, getPendingTotp, enableTotp, disableTotp,
  loginLockedFor, recordFail, recordSuccess
} from './auth.js';
import QRCode from 'qrcode';
import { VERSION } from './version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8390;

// Resilience: a long-running daemon (especially on a Raspberry Pi that's hard to
// get to) must not fall over on a single stray error — a background fetch
// rejecting, a client vanishing mid-write, a transient hiccup. Log it loudly and
// keep serving. Docker's restart policy remains the backstop for anything that
// genuinely corrupts process state.
process.on('unhandledRejection', (reason) => {
  console.error('[guard] unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[guard] uncaught exception:', err);
});

loadConfig();
initDb();
loadPlaneDbFromDisk();

const app = express();
app.disable('x-powered-by');

// ----------------------------------------------------------------- security headers
// A strict Content-Security-Policy is the backstop against XSS: only same-origin
// scripts (everything is vendored locally), no inline scripts, no framing. Plus
// the usual hardening headers. img-src allows https: for the map-tile CDNs.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    // Airport-webcam layer embeds third-party live players in an iframe.
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://webcams.windy.com https://*.windy.com"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // HSTS only matters over TLS; harmless otherwise but set it when the request is secure.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// Leaflet is served locally so the app works without internet/CDN access.
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
// Bundled SVG country flags (served locally so they render everywhere incl. Windows).
app.use('/vendor/flag-icons', express.static(path.join(__dirname, '..', 'node_modules', 'flag-icons')));
// satellite.js (SGP4) served locally for the Aerospace layer.
app.use('/vendor/satellite', express.static(path.join(__dirname, '..', 'node_modules', 'satellite.js', 'dist')));
// leaflet.heat (canvas heatmap) served locally for the Heatmap layer.
app.use('/vendor/leaflet-heat', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet.heat', 'dist')));

// ----------------------------------------------------------------- public/auth split
// Strip everything that could resolve the receiver's location from data served to
// unauthenticated ("public") clients: the receiver coordinates, per-aircraft
// distance-from-receiver, and zone membership/ETA (zones sit at the receiver).
function stripAircraftLocation(a) {
  return { ...a, distKm: null, zones: [] };
}
function publicSnapshot(s) {
  return {
    ts: s.ts,
    status: s.status,
    receiver: { lat: null, lon: null },
    aircraft: (s.aircraft || []).map(stripAircraftLocation)
  };
}

// ------------------------------------------------------------------ SSE stream
const sseClients = new Set(); // { res, authed }
function sseFrame(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }

// Writing to a client whose socket has already gone away can throw; never let
// one dead client break the broadcast to the others (or crash the process).
function sseWrite(c, frame) {
  try { c.res.write(frame); } catch { sseClients.delete(c); }
}

function broadcast(event, data) {
  let full, pub;
  for (const c of sseClients) {
    if (event === 'aircraft') {
      if (c.authed) { full ??= sseFrame('aircraft', data); sseWrite(c, full); }
      else { pub ??= sseFrame('aircraft', publicSnapshot(data)); sseWrite(c, pub); }
    } else if (c.authed) {
      // alerts (and other private events) only go to authenticated clients
      sseWrite(c, sseFrame(event, data));
    }
  }
}
setBroadcast(broadcast);
setTrackerBroadcast(broadcast, () => sseClients.size > 0);

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  const isAuth = authed(req);
  const snap = snapshot();
  res.write(sseFrame('aircraft', isAuth ? snap : publicSnapshot(snap)));
  const client = { res, authed: isAuth };
  sseClients.add(client);
  const ping = setInterval(() => sseWrite(client, ': ping\n\n'), 25000);
  const cleanup = () => { clearInterval(ping); sseClients.delete(client); };
  req.on('close', cleanup);
  // An abrupt reset (client power-off, network drop) emits 'error' rather than a
  // clean 'close'; handle it so it can't surface as an uncaught exception.
  res.on('error', cleanup);
  req.on('error', cleanup);
});

// ------------------------------------------------------------------ auth
// Is the request HTTPS at the edge? (Cloudflare Tunnel / reverse proxies set
// X-Forwarded-Proto.) Used to add the Secure cookie flag + HSTS.
const secureReq = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

// Real client IP for rate-limiting / logging. Behind a tunnel/proxy every request
// arrives from the proxy (e.g. 127.0.0.1), so when TRUST_PROXY is enabled we read
// the forwarded client IP (Cloudflare's CF-Connecting-IP, else the first
// X-Forwarded-For hop). Off by default so a directly-exposed app can't be tricked
// by a spoofed header.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
function clientKey(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.get('/api/auth/status', (req, res) =>
  res.json({ passwordSet: isPasswordSet(), authenticated: authed(req), twoFactorEnabled: isTotpEnabled() }));

// First-run setup: create the password only when none exists yet, then log in.
app.post('/api/auth/setup', (req, res) => {
  if (isPasswordSet()) return res.status(403).json({ error: 'a password is already configured' });
  const pw = String(req.body?.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  setPassword(pw);
  setAuthCookie(res, secureReq(req));
  res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
  if (!isPasswordSet()) return res.status(400).json({ error: 'no password configured yet' });
  const key = clientKey(req);
  const locked = loginLockedFor(key);
  if (locked) {
    console.warn(`[auth] login blocked (locked ${locked}s) from ${key}`);
    res.setHeader('Retry-After', String(locked));
    return res.status(429).json({ error: `too many attempts — try again in ${locked}s`, retryAfter: locked });
  }

  const okPw = verifyPassword(String(req.body?.password || ''));
  // when 2FA is on, also require a valid TOTP code
  const totpOk = !isTotpEnabled() || verifyTotp(getConfigTotpSecret(), req.body?.code);
  if (!okPw || !totpOk) {
    recordFail(key);
    console.warn(`[auth] failed login (${okPw ? 'bad 2FA code' : 'bad password'}) from ${key}`);
    await delay(350); // slow scripted guessing
    return res.status(401).json({ error: okPw ? 'invalid 2FA code' : 'wrong password', needCode: isTotpEnabled() });
  }
  recordSuccess(key);
  console.log(`[auth] login ok from ${key}`);
  setAuthCookie(res, secureReq(req));
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => { clearAuthCookie(res, secureReq(req)); res.json({ ok: true }); });

app.post('/api/auth/password', requireAuth, (req, res) => {
  if (!verifyPassword(String(req.body?.current || ''))) return res.status(401).json({ error: 'current password is wrong' });
  const pw = String(req.body?.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'new password must be at least 8 characters' });
  setPassword(pw);
  setAuthCookie(res, secureReq(req));
  res.json({ ok: true });
});

// ---- 2FA (TOTP) enrollment, all authenticated ----
function getConfigTotpSecret() { return (getConfig().auth?.totp?.secret) || ''; }

// Begin enrollment: generate a fresh secret (pending, not yet active) + a QR.
app.post('/api/auth/2fa/setup', requireAuth, async (req, res) => {
  const secret = newTotpSecret();
  setPendingTotp(secret);
  const uri = otpauthUri(secret);
  let qr = null;
  try { qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 }); } catch { /* show secret instead */ }
  res.json({ secret, uri, qr });
});

// Confirm enrollment: the code must match the pending secret.
app.post('/api/auth/2fa/enable', requireAuth, (req, res) => {
  const pending = getPendingTotp();
  if (!pending) return res.status(400).json({ error: 'start 2FA setup first' });
  if (!verifyTotp(pending, req.body?.code)) return res.status(400).json({ error: 'code did not match — check your authenticator and try again' });
  enableTotp(pending);
  res.json({ ok: true });
});

// Turn 2FA off — requires the current password and a valid code.
app.post('/api/auth/2fa/disable', requireAuth, (req, res) => {
  if (!verifyPassword(String(req.body?.password || ''))) return res.status(401).json({ error: 'wrong password' });
  if (isTotpEnabled() && !verifyTotp(getConfigTotpSecret(), req.body?.code)) return res.status(400).json({ error: 'invalid 2FA code' });
  disableTotp();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ aircraft
app.get('/api/aircraft', (req, res) => {
  const snap = snapshot();
  res.json(authed(req) ? snap : publicSnapshot(snap));
});

// Detection & anomaly feed (auth-only — reveals coverage patterns).
app.get('/api/detections', requireAuth, (req, res) => {
  const limit = Math.min(400, Math.max(1, parseInt(req.query.limit, 10) || 200));
  res.json({ detections: recentDetectionList(limit) });
});

// Manage extra data sources (config.extraSources) — additional aircraft.json feeds.
app.get('/api/sources/extra', requireAuth, (req, res) => {
  res.json({ sources: getConfig().extraSources || [] });
});
app.post('/api/sources/extra', requireAuth, (req, res) => {
  const { name, url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(String(url).trim())) {
    return res.status(400).json({ error: 'A valid http(s) aircraft.json URL is required.' });
  }
  const entry = { id: crypto.randomUUID(), name: String(name || '').trim() || 'Extra', url: String(url).trim(), enabled: true };
  const extraSources = [...(getConfig().extraSources || []), entry];
  saveConfig({ extraSources });
  res.json({ entry, sources: extraSources });
});
app.patch('/api/sources/extra/:id', requireAuth, (req, res) => {
  const b = req.body || {};
  const extraSources = (getConfig().extraSources || []).map((s) => {
    if (s.id !== req.params.id) return s;
    const u = { ...s };
    if (typeof b.enabled === 'boolean') u.enabled = b.enabled;
    if (typeof b.name === 'string' && b.name.trim()) u.name = b.name.trim();
    if (typeof b.url === 'string' && /^https?:\/\//i.test(b.url.trim())) u.url = b.url.trim();
    return u;
  });
  saveConfig({ extraSources });
  res.json({ sources: extraSources });
});
app.delete('/api/sources/extra/:id', requireAuth, (req, res) => {
  const extraSources = (getConfig().extraSources || []).filter((s) => s.id !== req.params.id);
  saveConfig({ extraSources });
  res.json({ sources: extraSources });
});

// Manage the user-curated custom webcam feeds (config.webcams.custom).
app.get('/api/webcams/custom', requireAuth, (req, res) => {
  res.json({ custom: getConfig().webcams?.custom || [] });
});
app.post('/api/webcams/custom', requireAuth, (req, res) => {
  const { icao, name, lat, lon, title, embed } = req.body || {};
  const la = parseFloat(lat), lo = parseFloat(lon);
  if (!embed || !/^https:\/\//i.test(String(embed).trim())) {
    return res.status(400).json({ error: 'A valid https embed (iframe) URL is required.' });
  }
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
    return res.status(400).json({ error: 'Valid latitude/longitude are required.' });
  }
  if (!String(name || '').trim() && !String(icao || '').trim()) {
    return res.status(400).json({ error: 'An airport name or ICAO is required.' });
  }
  const finalEmbed = normalizeEmbed(String(embed).trim());
  const entry = {
    id: crypto.randomUUID(),
    icao: String(icao || '').trim().toUpperCase() || null,
    name: String(name || '').trim() || null,
    lat: la, lon: lo,
    feeds: [{ title: String(title || '').trim() || 'Webcam', embed: finalEmbed }]
  };
  const custom = [...(getConfig().webcams?.custom || []), entry];
  saveConfig({ webcams: { custom } });
  // Warn (don't block) when the host can't play inline under the app's CSP.
  const warning = isEmbeddableHost(finalEmbed) ? null
    : 'Saved — but this host is outside the app\'s embed allow-list (YouTube / Windy), so the browser will likely block it from playing inside the app. Use a YouTube or Windy embed URL for inline playback.';
  res.json({ entry, custom, warning });
});
app.delete('/api/webcams/custom/:id', requireAuth, (req, res) => {
  const custom = (getConfig().webcams?.custom || []).filter((e) => e.id !== req.params.id);
  saveConfig({ webcams: { custom } });
  res.json({ ok: true, custom });
});

// Look up an airport by ICAO to autofill a custom feed's name/coords.
app.get('/api/airports/lookup', requireAuth, (req, res) => {
  const a = airportByIdent(req.query.ident);
  if (!a) return res.status(404).json({ error: 'Airport not found (is the frequency database loaded?)' });
  res.json(a);
});

// Airport webcams within the given map bounds (built-in list + Windy Webcams API).
app.get('/api/webcams', async (req, res) => {
  const n = parseFloat(req.query.n), s = parseFloat(req.query.s);
  const e = parseFloat(req.query.e), w = parseFloat(req.query.w);
  if ([n, s, e, w].some((v) => !Number.isFinite(v))) {
    return res.status(400).json({ error: 'n, s, e, w bounds required' });
  }
  try { res.json(await webcamsInBounds({ n, s, e, w })); }
  catch (err) { res.status(502).json({ error: err.message, airports: [] }); }
});

// Arrivals layer: tracked aircraft grouped by their destination airport.
app.get('/api/arrivals', (req, res) => res.json(arrivalsSnapshot()));
// Arrivals board (FIDS-style flat list): inbound flights sorted by ETA.
app.get('/api/arrivals/board', (req, res) => res.json(arrivalsBoard()));

// Heatmap layer (reveals the coverage shape → authenticated only).
app.get('/api/heatmap', requireAuth, (req, res) => {
  const since = parseInt(req.query.since, 10);
  if (!Number.isFinite(since)) return res.status(400).json({ error: 'since (ms) required' });
  const grid = Math.min(0.05, Math.max(0.002, parseFloat(req.query.grid) || 0.01));
  try { res.json(heatmapCells(since, grid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Aerospace layer: orbital elements (TLEs) for the ISS and Hubble, from CelesTrak.
app.get('/api/aerospace/tle', async (req, res) => {
  try {
    const data = await getTles();
    if (!data) return res.json({ sats: {}, error: 'No orbital data yet — the server needs internet to fetch TLEs from CelesTrak.' });
    res.json({ fetchedAt: data.fetchedAt, source: data.source, sats: data.sats });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/aircraft/:hex', async (req, res) => {
  const detail = await aircraftDetail(req.params.hex);
  if (!detail) return res.status(404).json({ error: 'aircraft not currently tracked' });
  if (!authed(req)) { detail.distKm = null; detail.zones = []; } // hide receiver-relative data
  res.json(detail);
});

app.get('/api/aircraft/:hex/photo', async (req, res) => {
  res.json({ photo: await lookupPhoto(req.params.hex) });
});

// Image proxy: serves the thumbnail bytes from a local disk cache so images
// always load (and only ever fetch each one once). 404 when there's no photo.
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
app.get('/api/photo/:hex', async (req, res) => {
  const hex = (req.params.hex || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
  if (hex.length !== 6) return res.status(400).end();
  const file = path.join(PHOTO_DIR, `${hex}.jpg`);
  if (fs.existsSync(file)) {
    res.setHeader('cache-control', 'public, max-age=604800');
    return res.type('image/jpeg').sendFile(file);
  }
  const photo = await lookupPhoto(hex);
  if (!photo?.thumb) return res.status(404).end();
  try {
    const r = await extFetch(photo.thumb, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
    res.setHeader('cache-control', 'public, max-age=604800');
    res.type(r.headers.get('content-type') || 'image/jpeg').end(buf);
  } catch {
    res.status(502).end();
  }
});

app.get('/api/aircraft/:hex/history', (req, res) => {
  const history = aircraftHistory(req.params.hex);
  if (!authed(req)) for (const h of history) h.min_dist_km = null; // closest approach reveals the receiver
  res.json({ history });
});

// Recorded position track for a past sighting session, for drawing on the map.
// Auth-only: many stored tracks together outline the receiver's coverage. Only
// goes back as far as the replay retention window; older sessions return [].
app.get('/api/aircraft/:hex/track', requireAuth, (req, res) => {
  const from = parseInt(req.query.from, 10);
  const to = parseInt(req.query.to, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return res.status(400).json({ error: 'from,to (ms) required' });
  }
  // pad the window a little so the session's first/last fixes are included
  const track = getAircraftTrack(req.params.hex, from - 60000, to + 60000, 8000);
  res.json({ track, retentionDays: getConfig().replayRetentionDays });
});

// ------------------------------------------------------------------ stats & alerts
app.get('/api/stats', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7));
  res.json(statsSummary(days));
});

// Alerts carry place names / locations near the receiver → authenticated only.
app.get('/api/alerts', requireAuth, (req, res) => res.json({ alerts: recentAlerts(150) }));

// Storage usage of the retention-governed log data (history, alerts, replay).
app.get('/api/storage', requireAuth, (req, res) => {
  try { res.json(logStorageInfo()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Manually purge all log data and reclaim disk space.
app.post('/api/storage/purge', requireAuth, (req, res) => {
  try { res.json(purgeLogs()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ------------------------------------------------------------------ backup & restore
// Download a full backup ZIP (database snapshot + settings + reference files).
app.get('/api/backup', requireAuth, (req, res) => {
  try {
    const buf = createBackup();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="vliegmasjienpro-backup-${stamp}.zip"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Peek at an uploaded backup (returns its manifest) — the raw ZIP is the body.
app.post('/api/backup/inspect', requireAuth, express.raw({ type: '*/*', limit: '1gb' }), (req, res) => {
  res.json(readManifest(req.body));
});
// Restore selected categories from an uploaded backup (raw ZIP body; selection in query).
app.post('/api/backup/restore', requireAuth, express.raw({ type: '*/*', limit: '1gb' }), (req, res) => {
  try {
    const sel = {
      settings: req.query.settings === '1',
      history: req.query.history === '1',
      tracks: req.query.tracks === '1',
      reference: req.query.reference === '1'
    };
    const result = restoreBackup(req.body, sel);
    try { reloadFromDisk(); } catch (e) { console.warn('[restore] reinit:', e.message); }
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (req, res) => {
  const status = {
    ...trackerStatus(),
    planeDb: planeDbMeta(),
    aircraftDb: { count: aircraftDbCount(), error: aircraftDbError() },
    photos: { error: photoServiceError() },
    version: VERSION
  };
  if (!authed(req)) status.receiver = { lat: null, lon: null }; // never expose the location publicly
  res.json(status);
});

// --------------------------------------------------- spotted (plane-alert-db ∩ seen)
// Aircraft seen on the radar since `since` (ms) that are also in plane-alert-db,
// with their plane-alert-db details merged in.
app.get('/api/spotted', (req, res) => {
  const since = parseInt(req.query.since, 10);
  if (!Number.isFinite(since)) return res.status(400).json({ error: 'since (ms) required' });
  const rows = spottedSince(since, 2000);
  const spotted = [];
  for (const r of rows) {
    const padb = planeDbLookup(r.hex);
    if (!padb) continue; // only plane-alert-db members
    spotted.push({
      hex: r.hex,
      country: icaoToCountry(r.hex),
      callsign: r.callsign || null,
      registration: r.registration || padb.registration || null,
      operator: padb.operator || null,
      type: padb.type || padb.icaoType || null,
      icaoType: padb.icaoType || null,
      category: padb.category || null,
      tags: padb.tags || [],
      link: padb.link || null,
      sessions: r.sessions,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      maxAlt: r.max_alt,
      maxSpeed: r.max_speed,
      minDistKm: authed(req) ? r.min_dist_km : null // closest-approach reveals the receiver
    });
  }
  res.json({ spotted, total: spotted.length });
});

// Lazy route lookup by callsign (used by the Spotted tab rows).
app.get('/api/route/:callsign', async (req, res) => {
  try {
    const { route, error, agreement, sources } = await lookupRoute(req.params.callsign);
    res.json({ route, error, agreement, sources });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ------------------------------------------------------------------ aircraft DB
// Bulk import a hex→registration/type[/operator] dataset (CSV or NDJSON) for
// users whose receiver/firewall can't do per-hex lookups, or who want the whole
// database loaded at once. Accepts a `url` to fetch or a pasted `csv` body.
app.post('/api/aircraftdb/import', requireAuth, async (req, res) => {
  try {
    let text = req.body?.csv;
    if (!text && req.body?.url) {
      // SSRF guard: only fetch public http(s) URLs, not file:// or internal schemes
      let u;
      try { u = new URL(String(req.body.url)); } catch { return res.status(400).json({ error: 'invalid URL' }); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).json({ error: 'only http(s) URLs are allowed' });
      const r = await fetch(u, { signal: AbortSignal.timeout(120000), redirect: 'error' });
      if (!r.ok) return res.status(502).json({ error: `download failed: HTTP ${r.status}` });
      text = await r.text();
    }
    if (!text) return res.status(400).json({ error: 'provide a url or csv body' });
    const rows = parseAircraftDataset(text);
    if (!rows.length) return res.status(400).json({ error: 'no usable rows (need hex,registration,type columns)' });
    const n = bulkImportAircraftDb(rows);
    res.json({ imported: n, count: aircraftDbCount() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse either NDJSON (one JSON object per line, basic-ac-db style:
// {icao,reg,icaotype,...}) or CSV with a header naming the columns.
function parseAircraftDataset(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const trimmed = lines.find((l) => l.trim());
  if (trimmed && trimmed.trim().startsWith('{')) {
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        const hex = (o.icao || o.hex || o.icao24 || '').toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(hex)) continue;
        out.push({
          hex,
          registration: o.reg || o.registration || o.r || '',
          type: o.icaotype || o.icao_type || o.typecode || o.t || '',
          typeLong: o.type || o.model || '',
          operator: o.ownop || o.operator || o.registered_owner || ''
        });
      } catch { /* skip bad line */ }
    }
    return out;
  }
  // CSV with header (quote-aware — OpenSky's model/manufacturer fields contain commas)
  const header = parseCsvLine(lines[0] || '').map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
  const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iHex = col('icao24', 'icao', 'hex');
  const iReg = col('registration', 'reg', 'r');
  const iType = col('typecode', 'icaotype', 'icao_type', 'type', 't');
  const iOwner = col('operator', 'ownop', 'registered_owner', 'owner');
  if (iHex < 0) return out;
  for (let n = 1; n < lines.length; n++) {
    const c = parseCsvLine(lines[n]).map((v) => v.replace(/^["']|["']$/g, '').trim());
    const hex = (c[iHex] || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) continue;
    out.push({
      hex,
      registration: iReg >= 0 ? c[iReg] : '',
      type: iType >= 0 ? c[iType] : '',
      operator: iOwner >= 0 ? c[iOwner] : ''
    });
  }
  return out;
}

// ------------------------------------------------------------------ config
// Public clients get the config with the receiver location removed; full config
// (incl. receiver) only for authenticated clients.
app.get('/api/config', (req, res) => {
  const c = publicConfig();
  if (!authed(req)) {
    c.receiver = { lat: null, lon: null };
    c.weather = { hasOwmKey: false }; // owner's API keys aren't offered to public clients
    c.openAip = { hasKey: false };
  }
  res.json(c);
});

app.post('/api/config', requireAuth, (req, res) => {
  const patch = req.body || {};
  // Don't let masked secrets ('••••') overwrite real ones.
  for (const sect of ['pushover', 'discord']) {
    if (patch[sect]) {
      for (const [k, v] of Object.entries(patch[sect])) {
        if (typeof v === 'string' && v.includes('••')) delete patch[sect][k];
      }
    }
  }
  saveConfig(patch);
  res.json(publicConfig());
});

// ------------------------------------------------------------------ zones
app.get('/api/zones', requireAuth, (req, res) => res.json({ zones: getConfig().zones }));

app.post('/api/zones', requireAuth, (req, res) => {
  const { name, lat, lon, radiusKm, notify: doNotify = true, color } = req.body || {};
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusKm)) {
    return res.status(400).json({ error: 'name, lat, lon and radiusKm are required' });
  }
  const zones = [...getConfig().zones, {
    id: crypto.randomUUID(), name, lat, lon,
    radiusKm: Math.max(0.1, radiusKm), notify: doNotify, color: color || '#3b82f6'
  }];
  saveConfig({ zones });
  res.json({ zones });
});

app.put('/api/zones/:id', requireAuth, (req, res) => {
  const zones = getConfig().zones.map((z) => (z.id === req.params.id ? { ...z, ...req.body, id: z.id } : z));
  saveConfig({ zones });
  res.json({ zones });
});

app.delete('/api/zones/:id', requireAuth, (req, res) => {
  const zones = getConfig().zones.filter((z) => z.id !== req.params.id);
  saveConfig({ zones });
  res.json({ zones });
});

// ------------------------------------------------------------------ watchlist
app.get('/api/watchlist', requireAuth, (req, res) => res.json({ watchlist: getConfig().watchlist }));

app.post('/api/watchlist', requireAuth, (req, res) => {
  const e = req.body || {};
  if (!e.icao && !e.registration && !e.callsign) {
    return res.status(400).json({ error: 'icao, registration or callsign required' });
  }
  const entry = {
    id: crypto.randomUUID(),
    icao: (e.icao || '').toLowerCase(),
    registration: e.registration || '',
    callsign: e.callsign || '',
    operator: e.operator || '',
    type: e.type || '',
    icaoType: e.icaoType || '',
    category: e.category || '',
    tags: e.tags || [],
    link: e.link || '',
    notify: e.notify !== false
  };
  // de-dupe by icao
  const watchlist = getConfig().watchlist.filter((w) => !entry.icao || w.icao !== entry.icao);
  watchlist.push(entry);
  saveConfig({ watchlist });
  res.json({ watchlist });
});

app.delete('/api/watchlist/:id', requireAuth, (req, res) => {
  const watchlist = getConfig().watchlist.filter((w) => w.id !== req.params.id);
  saveConfig({ watchlist });
  res.json({ watchlist });
});

// Import a CSV in plane-alert-db format directly into the watchlist.
app.post('/api/watchlist/import', requireAuth, (req, res) => {
  const { csv } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'csv body field required' });
  let added = 0;
  const watchlist = [...getConfig().watchlist];
  const existing = new Set(watchlist.map((w) => w.icao));
  for (const line of csv.split(/\r?\n/)) {
    if (!line || line.startsWith('$ICAO') || line.startsWith('#')) continue;
    const c = parseCsvLine(line); // quote-aware: operator/type can contain commas
    const hex = (c[0] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex) || existing.has(hex)) continue;
    watchlist.push({
      id: crypto.randomUUID(),
      icao: hex,
      registration: (c[1] || '').trim(),
      callsign: '',
      operator: (c[2] || '').trim(),
      type: (c[3] || '').trim(),
      icaoType: (c[4] || '').trim(),
      category: (c[9] || '').trim(),
      tags: [c[6], c[7], c[8]].map((t) => (t || '').trim()).filter(Boolean),
      link: (c[10] || '').trim(),
      notify: true
    });
    existing.add(hex);
    added++;
  }
  saveConfig({ watchlist });
  res.json({ watchlist, added });
});

// ------------------------------------------------------------------ plane-alert-db
app.get('/api/planedb/meta', (req, res) => res.json(planeDbMeta()));

app.post('/api/planedb/refresh', requireAuth, async (req, res) => {
  try {
    res.json(await refreshPlaneDb());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/planedb/search', (req, res) => res.json({ results: planeDbSearch(req.query.q) }));

app.get('/api/planedb/:hex', (req, res) => res.json({ entry: planeDbLookup(req.params.hex) }));

// ------------------------------------------------------------------ weather
// Current conditions at the receiver (Open-Meteo — free, no API key). Cached
// for 10 minutes so we don't poll it on every page.
let currentWxCache = { ts: 0, key: '', data: null };
app.get('/api/weather/current', requireAuth, async (req, res) => {
  const r = getConfig().receiver;
  if (r.lat == null || r.lon == null) return res.status(400).json({ error: 'no receiver location set' });
  const key = `${r.lat.toFixed(3)},${r.lon.toFixed(3)}`;
  if (currentWxCache.data && currentWxCache.key === key && Date.now() - currentWxCache.ts < 600000) {
    return res.json(currentWxCache.data);
  }
  try {
    const base = process.env.OPEN_METEO_BASE || 'https://api.open-meteo.com/v1/forecast';
    const url =
      `${base}?latitude=${r.lat}&longitude=${r.lon}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day' +
      '&wind_speed_unit=kmh&timezone=auto';
    const resp = await extFetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    const c = j.current || {};
    const data = {
      temp: c.temperature_2m ?? null,
      feels: c.apparent_temperature ?? null,
      humidity: c.relative_humidity_2m ?? null,
      windKmh: c.wind_speed_10m ?? null,
      windDir: c.wind_direction_10m ?? null,
      precipMm: c.precipitation ?? null,
      code: c.weather_code ?? null,
      isDay: c.is_day ?? 1,
      ts: Date.now()
    };
    currentWxCache = { ts: Date.now(), key, data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Full forecast for the Weather tab: current conditions, hourly (48h) and daily
// (7-day) forecast plus derived extreme-condition warnings. Auth-only — it
// reveals the receiver location.
app.get('/api/weather/forecast', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); // always serve current data (server-side cache handles rate)
  const r = getConfig().receiver;
  if (r.lat == null || r.lon == null) return res.status(400).json({ error: 'no receiver location set' });
  try {
    const forecast = await getForecast(r.lat, r.lon);
    res.json({ ...forecast, warnings: weatherWarnings(forecast) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Nearest observed METAR to the receiver — a ground-truth cross-check of the
// forecast. Widens the search box until it finds a station (busy airspace has
// many; remote receivers may need a wide net). Auth-only.
let nearestMetarCache = { ts: 0, key: '', data: null };
app.get('/api/weather/metar-nearest', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const r = getConfig().receiver;
  if (r.lat == null || r.lon == null) return res.status(400).json({ error: 'no receiver location set' });
  const key = `${r.lat.toFixed(2)},${r.lon.toFixed(2)}`;
  if (nearestMetarCache.data && nearestMetarCache.key === key && Date.now() - nearestMetarCache.ts < 300000) {
    return res.json(nearestMetarCache.data);
  }
  const base = process.env.AVWX_BASE || 'https://aviationweather.gov/api/data';
  const haversineKm = (a, b, c, d) => {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (c - a) * toR, dLon = (d - b) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * toR) * Math.cos(c * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  try {
    let stations = [];
    for (const pad of [0.75, 1.75, 3.5]) { // ~80km, ~190km, ~380km latitude bands
      const s = (r.lat - pad).toFixed(2), n = (r.lat + pad).toFixed(2);
      const w = (r.lon - pad).toFixed(2), e = (r.lon + pad).toFixed(2);
      const resp = await extFetch(`${base}/metar?bbox=${s},${w},${n},${e}&format=json`, { signal: AbortSignal.timeout(12000) });
      if (!resp.ok) continue;
      const arr = await resp.json();
      stations = (Array.isArray(arr) ? arr : []).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
      if (stations.length) break;
    }
    if (!stations.length) { const data = { station: null }; nearestMetarCache = { ts: Date.now(), key, data }; return res.json(data); }
    stations.sort((a, b) => haversineKm(r.lat, r.lon, a.lat, a.lon) - haversineKm(r.lat, r.lon, b.lat, b.lon));
    const m = stations[0];
    const data = { station: {
      id: m.icaoId, name: m.name || null, lat: m.lat, lon: m.lon,
      distKm: Math.round(haversineKm(r.lat, r.lon, m.lat, m.lon)),
      fltCat: m.fltCat || null, temp: m.temp ?? null, dewp: m.dewp ?? null,
      wdir: m.wdir ?? null, wspd: m.wspd ?? null, wgst: m.wgst ?? null,
      visib: m.visib ?? null, altim: m.altim ?? null, obsTime: m.obsTime ?? null,
      raw: m.rawOb || null
    } };
    nearestMetarCache = { ts: Date.now(), key, data };
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.name === 'TimeoutError' ? 'aviationweather.gov timed out' : 'aviationweather.gov unreachable' });
  }
});

// Sky Watch: stargazing conditions (dark-sky window, Moon, clouds, observing
// score) for the next few nights + the best objects visible tonight. Auth-only —
// it's built from the receiver location. Cached briefly (recomputes hourly-ish).
let skyCache = { ts: 0, key: '', data: null };
app.get('/api/skywatch', requireAuth, async (req, res) => {
  const r = getConfig().receiver;
  if (r.lat == null || r.lon == null) return res.status(400).json({ error: 'no receiver location set' });
  const key = `${r.lat.toFixed(3)},${r.lon.toFixed(3)},${getConfig().skywatch?.bortle ?? 4}`;
  if (skyCache.data && skyCache.key === key && Date.now() - skyCache.ts < 600000) return res.json(skyCache.data);
  try {
    const data = await skyAssessment(r.lat, r.lon);
    skyCache = { ts: Date.now(), key, data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ------------------------------------------------------------------ range outline
app.get('/api/range', requireAuth, (req, res) => res.json(rangeOutline()));
app.post('/api/range/clear', requireAuth, (req, res) => res.json(clearRange()));

// RainViewer frame metadata proxy (avoids CORS surprises and centralizes caching).
let rainviewerCache = { ts: 0, data: null };
app.get('/api/weather/rainviewer', async (req, res) => {
  // The frame list changes every ~10 min and RainViewer only keeps ~2h of it —
  // if a browser or proxy (e.g. a Cloudflare Tunnel) caches this response the
  // radar shows stale (even day-old) frames. Forbid caching; our own 60 s
  // in-memory cache still shields the upstream API.
  res.setHeader('Cache-Control', 'no-store');
  if (Date.now() - rainviewerCache.ts < 60000 && rainviewerCache.data) {
    return res.json(rainviewerCache.data);
  }
  try {
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
      signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    rainviewerCache = { ts: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// OpenWeatherMap tile proxy so the API key never reaches the browser.
app.get('/api/weather/owm/:layer/:z/:x/:y', requireAuth, async (req, res) => {
  const key = getConfig().weather.openWeatherMapKey;
  if (!key) return res.status(404).json({ error: 'no OpenWeatherMap key configured' });
  const { layer, z, x, y } = req.params;
  if (!/^[a-z_]+$/.test(layer)) return res.status(400).end();
  try {
    const r = await fetch(
      `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${key}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=300');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// ------------------------------------------------------------------ basemap (CARTO)
// CARTO now requires a free API key for their basemaps. When one is configured
// we proxy the tiles so the key stays server-side. Unlike the OWM/OpenAIP
// overlays this is the *basemap* and must render for anyone viewing the map
// (incl. public mode), so it is not auth-gated. Without a key the client loads
// CARTO's public tiles directly, so this route just 404s.
const CARTO_STYLES = new Set([
  'dark_all', 'light_all', 'dark_nolabels', 'light_nolabels', 'dark_only_labels', 'light_only_labels'
]);
app.get('/api/basemap/:style/:z/:x/:tile', async (req, res) => {
  const key = getConfig().basemap?.cartoKey;
  if (!key) return res.status(404).end();
  const { style, z, x, tile } = req.params;
  const m = /^(\d+)(@2x)?\.png$/.exec(tile);
  if (!CARTO_STYLES.has(style) || !/^\d+$/.test(z) || !/^\d+$/.test(x) || !m) return res.status(400).end();
  const y = m[1], scale = m[2] || '';
  const sub = 'abcd'[(Number(x) + Number(y)) % 4];
  const base = process.env.CARTO_TILES_BASE || `https://${sub}.basemaps.cartocdn.com`;
  try {
    const r = await fetch(
      `${base}/${style}/${z}/${x}/${y}${scale}.png?key=${key}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// ------------------------------------------------------------------ airspace (OpenAIP)
// Controlled-airspace tile overlay proxied from OpenAIP so the API key stays
// server-side and there are no CORS issues. Needs a free OpenAIP API key.
app.get('/api/airspace/tiles/:z/:x/:y', requireAuth, async (req, res) => {
  const key = getConfig().openAip?.apiKey;
  if (!key) return res.status(404).json({ error: 'no OpenAIP key configured' });
  const { z, x, y } = req.params;
  if (![z, x, y].every((v) => /^\d+$/.test(v))) return res.status(400).end();
  try {
    const base = process.env.OPENAIP_TILES_BASE || 'https://api.tiles.openaip.net/api/data/openaip';
    const r = await fetch(`${base}/${z}/${x}/${y}.png?apiKey=${key}`, {
      headers: { 'x-openaip-api-key': key },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// ------------------------------------------------------------------ aviation weather (METAR)
// Current METARs in a bounding box from the NOAA Aviation Weather Center
// (aviationweather.gov) — free, no key. Cached briefly per bbox.
const metarCache = new Map(); // bbox key -> { ts, data }
app.get('/api/avwx/metar', async (req, res) => {
  const nums = ['s', 'w', 'n', 'e'].map((k) => parseFloat(req.query[k]));
  if (nums.some((v) => !Number.isFinite(v))) return res.status(400).json({ error: 's,w,n,e required' });
  const [s, w, n, e] = nums;
  const key = nums.map((v) => v.toFixed(2)).join(',');
  const hit = metarCache.get(key);
  if (hit && Date.now() - hit.ts < 120000) return res.json(hit.data);
  try {
    const base = process.env.AVWX_BASE || 'https://aviationweather.gov/api/data';
    const url = `${base}/metar?bbox=${s},${w},${n},${e}&format=json`;
    const r = await extFetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return res.status(502).json({ error: `aviationweather.gov HTTP ${r.status}` });
    const arr = await r.json();
    const stations = (Array.isArray(arr) ? arr : []).map((m) => ({
      id: m.icaoId, name: m.name || null, lat: m.lat, lon: m.lon,
      fltCat: m.fltCat || null, temp: m.temp ?? null, dewp: m.dewp ?? null,
      wdir: m.wdir ?? null, wspd: m.wspd ?? null, wgst: m.wgst ?? null,
      visib: m.visib ?? null, altim: m.altim ?? null, obsTime: m.obsTime ?? null,
      raw: m.rawOb || null
    })).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
    const data = { stations };
    metarCache.set(key, { ts: Date.now(), data });
    if (metarCache.size > 200) metarCache.clear();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.name === 'TimeoutError' ? 'aviationweather.gov timed out' : 'aviationweather.gov unreachable' });
  }
});

// ------------------------------------------------------------------ easter egg: invaders highscores
const HISCORE_FILE = path.join(DATA_DIR, 'invaders-highscores.json');
function readHiscores() {
  try { const a = JSON.parse(fs.readFileSync(HISCORE_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
app.get('/api/invaders/highscores', (req, res) => {
  res.json({ scores: readHiscores().sort((a, b) => b.score - a.score).slice(0, 10) });
});
app.post('/api/invaders/highscores', (req, res) => {
  const name = (String(req.body?.name || '').replace(/[^\w .\-]/g, '').trim().slice(0, 12)) || 'AAA';
  const score = Math.max(0, Math.min(100000000, Math.floor(Number(req.body?.score) || 0)));
  const entry = { name, score, ts: Date.now() };
  const list = readHiscores();
  list.push(entry);
  list.sort((a, b) => b.score - a.score);
  const top = list.slice(0, 50);
  try { fs.writeFileSync(HISCORE_FILE, JSON.stringify(top)); } catch { /* ignore */ }
  res.json({ scores: top.slice(0, 10), rank: top.indexOf(entry) >= 0 ? top.indexOf(entry) + 1 : null });
});

// ------------------------------------------------------------------ replay
app.get('/api/replay/bounds', (req, res) => res.json(replayBounds()));

app.get('/api/replay/frame', (req, res) => {
  const at = parseInt(req.query.at, 10);
  if (!Number.isFinite(at)) return res.status(400).json({ error: 'at (ms) required' });
  const window = Math.min(600000, Math.max(1000, parseInt(req.query.window, 10) || 60000));
  res.json({ at, aircraft: replayFrame(at, window) });
});

// ------------------------------------------------------------------ frequencies
app.get('/api/frequencies/meta', (req, res) => res.json(frequenciesMeta()));

app.post('/api/frequencies/refresh', requireAuth, async (req, res) => {
  try {
    const result = await refreshFrequencies();
    rebuildAirportIndex(); // refresh the go-around detector's airport index too
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Airports (with comm frequencies) within the given map bounds.
app.get('/api/frequencies', (req, res) => {
  const n = parseFloat(req.query.n);
  const s = parseFloat(req.query.s);
  const e = parseFloat(req.query.e);
  const w = parseFloat(req.query.w);
  if ([n, s, e, w].some((v) => !Number.isFinite(v))) {
    return res.status(400).json({ error: 'n, s, e, w bounds required' });
  }
  const limit = Math.min(800, Math.max(1, parseInt(req.query.limit, 10) || 500));
  res.json({ airports: airportFreqsInBounds(s, w, n, e, limit) });
});

// ------------------------------------------------------------------ test notification
app.post('/api/notify/test', requireAuth, async (req, res) => {
  await notify({
    key: null,
    kind: 'test',
    title: '🔔 VliegmasjienPRO test notification',
    message: 'If you can read this, notifications are working.',
    aircraft: null
  });
  res.json({ ok: true });
});

// 404 for unknown API routes (other paths fall through to the SPA index).
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Generic error handler — never leak stack traces to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.warn('[error]', err?.message || err);
  if (res.headersSent) return;
  res.status(err?.status || 500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`VliegmasjienPRO listening on http://0.0.0.0:${PORT}`);
  startTracker();
  startPassNotifier();
  startWeatherNotifier();
});
