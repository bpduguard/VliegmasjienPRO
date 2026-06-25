// Aerospace layer data: orbital elements (TLEs) for Earth-orbiting craft we can
// draw a ground track for. Source: CelesTrak (https://celestrak.org) — the
// long-standing, freely available public catalogue of Two-Line Element sets,
// the same data professional trackers use. We proxy + cache it (TLEs update
// roughly daily) so the browser doesn't hit CelesTrak directly and it keeps
// working across brief outages / restarts.
//
// Only Earth-orbiting craft with a meaningful ground track belong here. (The
// JWST, for example, orbits Sun–Earth L2 ~1.5M km away and has no ground track,
// so it isn't tracked.)
import fs from 'node:fs';
import path from 'node:path';
import * as satellite from 'satellite.js';
import { DATA_DIR, getConfig } from './config.js';
import { extFetch } from './enrich.js';
import { notify } from './notify.js';
import { predictVisiblePasses } from './passes.js';

const CELESTRAK_BASE = process.env.CELESTRAK_BASE || 'https://celestrak.org/NORAD/elements';
const TLE_FILE = path.join(DATA_DIR, 'tle.json');
const TLE_TTL = 6 * 3600000; // refresh every 6h — TLEs are reissued ~daily

// Earth-orbiting objects we track (NORAD catalogue numbers).
export const SPACE_OBJECTS = [
  { key: 'iss', id: 25544, name: 'ISS (ZARYA)', icon: '🛰' },
  { key: 'hst', id: 20580, name: 'Hubble Space Telescope', icon: '🔭' }
];

let cache = null; // { fetchedAt, source, sats: { key: { name, line1, line2 } } }
let inflight = null;

function loadDisk() {
  try { cache = JSON.parse(fs.readFileSync(TLE_FILE, 'utf8')); } catch { cache = null; }
}

// CelesTrak TLE response: optional name line + two element lines ("1 ..."/"2 ...").
function parseTle(text) {
  const lines = (text || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const i1 = lines.findIndex((l) => /^1 /.test(l));
  if (i1 < 0 || !/^2 /.test(lines[i1 + 1] || '')) return null;
  return { name: i1 > 0 ? lines[i1 - 1] : null, line1: lines[i1], line2: lines[i1 + 1] };
}

async function refresh() {
  const sats = {};
  let ok = 0;
  for (const o of SPACE_OBJECTS) {
    try {
      const res = await extFetch(`${CELESTRAK_BASE}/gp.php?CATNR=${o.id}&FORMAT=TLE`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tle = parseTle(await res.text());
      if (tle?.line1 && tle?.line2) { sats[o.key] = { name: o.name, ...tle }; ok++; continue; }
      throw new Error('unparseable TLE');
    } catch {
      if (cache?.sats?.[o.key]) sats[o.key] = cache.sats[o.key]; // keep last good for this one
    }
  }
  if (ok > 0) {
    cache = { fetchedAt: Date.now(), source: 'celestrak', sats };
    try { fs.writeFileSync(TLE_FILE, JSON.stringify(cache)); } catch { /* ignore */ }
  }
  return cache;
}

// Returns the cached TLE set, refreshing if stale. De-duplicates concurrent
// refreshes. Returns null only when we have never managed to fetch anything.
export async function getTles() {
  if (!cache) loadDisk();
  if (cache && Date.now() - cache.fetchedAt < TLE_TTL) return cache;
  if (!inflight) inflight = refresh().finally(() => { inflight = null; });
  await inflight;
  return cache;
}

// ----------------------------------------------------- visible-pass notifications
const PASS_LOOKAHEAD_MS = 3 * 3600000; // search this far ahead for passes
const NOTIFY_BEFORE_MS = 60 * 60000;   // alert ~1h before the pass
const notifiedPasses = new Map();      // key -> pass startMs (for dedupe + pruning)

function fmtLocalTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  } catch { return new Date(ms).toISOString().slice(11, 16) + ' UTC'; }
}

// `nowMs` is injectable for testing; defaults to the wall clock.
export async function checkPassNotifications(nowMs = Date.now()) {
  const cfg = getConfig();
  if (!cfg.notifySatellitePasses) return;
  const rcv = cfg.receiver;
  if (rcv?.lat == null || rcv?.lon == null) return;

  const data = await getTles();
  if (!data?.sats) return;
  const observer = { latDeg: rcv.lat, lonDeg: rcv.lon, heightKm: 0.05 };
  const now = nowMs;

  for (const obj of SPACE_OBJECTS) {
    const tle = data.sats[obj.key];
    if (!tle) continue;
    let satrec;
    try { satrec = satellite.twoline2satrec(tle.line1, tle.line2); } catch { continue; }
    let passes;
    try { passes = predictVisiblePasses(satrec, observer, now, now + PASS_LOOKAHEAD_MS); } catch { continue; }
    for (const p of passes) {
      const until = p.startMs - now;
      if (until <= 0 || until > NOTIFY_BEFORE_MS) continue; // only within the hour before
      const key = `${obj.key}:${Math.round(p.startMs / 60000)}`;
      if (notifiedPasses.has(key)) continue;
      notifiedPasses.set(key, p.startMs);
      const mins = Math.round(until / 60000);
      notify({
        key,
        kind: 'test', // not aircraft — reuse the generic styling
        title: `${obj.icon} Visible ${obj.name} pass in ~${mins} min`,
        message:
          `${obj.name} will be visible from your location — skies will be dark.\n` +
          `Starts ${fmtLocalTime(p.startMs)}, rising in the ${p.riseDir} and setting in the ${p.setDir}, ` +
          `up to ${p.maxElev}° high (${p.peakDir}). Visible for about ${Math.max(1, Math.round(p.durationSec / 60))} min.`
      });
    }
  }
  // prune passes that are well in the past
  for (const [k, startMs] of notifiedPasses) {
    if (startMs < now - 3600000) notifiedPasses.delete(k);
  }
}

let passTimer = null;
export function startPassNotifier() {
  // first check shortly after startup, then every 5 minutes
  setTimeout(() => { checkPassNotifications().catch(() => {}); }, 30000);
  passTimer = setInterval(() => { checkPassNotifications().catch(() => {}); }, 5 * 60000);
}
