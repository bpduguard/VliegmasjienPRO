// Aerospace layer data: orbital elements (TLEs) for Earth-orbiting craft we can
// draw a ground track for. Source: CelesTrak (https://celestrak.org) — the
// long-standing, freely available public catalogue of Two-Line Element sets,
// the same data professional trackers use. We proxy + cache it (TLEs update
// roughly daily) so the browser doesn't hit CelesTrak directly and it keeps
// working across brief outages / restarts.
//
// Note on JWST: the James Webb Space Telescope is NOT here. It orbits the
// Sun–Earth L2 point ~1.5 million km away, so it has no meaningful ground track
// over the Earth's surface — SGP4/TLE propagation doesn't apply. The client
// shows it as an informational entry instead, not a fake position.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { extFetch } from './enrich.js';

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
