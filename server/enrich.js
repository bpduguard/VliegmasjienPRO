// Aircraft enrichment:
//  - plane-alert-db (the same CSV resource planefence/plane-alert uses)
//  - flight routes via adsbdb.com (origin/destination airports + airline)
//  - photos via planespotters.net public API
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { getAircraftDb, putAircraftDb } from './db.js';

// ---------------------------------------------------------------- plane-alert-db

// hex (lowercase) -> { icao, registration, operator, type, icaoType, group, tags, link }
let planeDb = new Map();
const PLANEDB_FILE = path.join(DATA_DIR, 'plane-alert-db.csv');
const PLANEDB_META = path.join(DATA_DIR, 'plane-alert-db.meta.json');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parsePlaneAlertCsv(text) {
  // plane-alert-db columns:
  // $ICAO,$Registration,$Operator,$Type,$ICAO Type,#CMPG,$Tag 1,$#Tag 2,$#Tag 3,Category,$#Link
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('$ICAO') || line.startsWith('#')) continue;
    const c = parseCsvLine(line);
    const hex = (c[0] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) continue;
    map.set(hex, {
      icao: hex,
      registration: (c[1] || '').trim(),
      operator: (c[2] || '').trim(),
      type: (c[3] || '').trim(),
      icaoType: (c[4] || '').trim(),
      group: (c[5] || '').trim(),
      tags: [c[6], c[7], c[8]].map((t) => (t || '').trim()).filter(Boolean),
      category: (c[9] || '').trim(),
      link: (c[10] || '').trim()
    });
  }
  return map;
}

export function loadPlaneDbFromDisk() {
  try {
    planeDb = parsePlaneAlertCsv(fs.readFileSync(PLANEDB_FILE, 'utf8'));
    console.log(`[planedb] loaded ${planeDb.size} aircraft from disk`);
  } catch {
    console.log('[planedb] no local copy yet — use Settings → refresh plane-alert-db');
  }
}

export async function refreshPlaneDb() {
  const url = getConfig().planeAlertDbUrl;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`plane-alert-db download failed: HTTP ${res.status}`);
  const text = await res.text();
  const parsed = parsePlaneAlertCsv(text);
  if (parsed.size < 100) throw new Error('plane-alert-db download looks invalid (too few rows)');
  fs.writeFileSync(PLANEDB_FILE, text);
  fs.writeFileSync(PLANEDB_META, JSON.stringify({ updatedAt: Date.now(), url, rows: parsed.size }));
  planeDb = parsed;
  console.log(`[planedb] refreshed: ${planeDb.size} aircraft`);
  return { rows: planeDb.size };
}

export function planeDbMeta() {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(PLANEDB_META, 'utf8')); } catch { /* none */ }
  return { rows: planeDb.size, ...meta };
}

export function planeDbLookup(hex) {
  return planeDb.get((hex || '').toLowerCase()) || null;
}

export function planeDbSearch(q, limit = 30) {
  q = (q || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  for (const entry of planeDb.values()) {
    if (
      entry.icao.includes(q) ||
      entry.registration.toLowerCase().includes(q) ||
      entry.operator.toLowerCase().includes(q) ||
      entry.type.toLowerCase().includes(q) ||
      entry.category.toLowerCase().includes(q)
    ) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function maybeAutoRefreshPlaneDb() {
  const hours = getConfig().planeAlertDbAutoRefreshHours;
  if (!hours) return;
  const meta = planeDbMeta();
  const age = Date.now() - (meta.updatedAt || 0);
  if (age > hours * 3600000) {
    refreshPlaneDb().catch((e) => console.warn('[planedb] auto refresh failed:', e.message));
  }
}

// ---------------------------------------------------------------- routes (adsbdb)

// callsign -> { ts, route, error } ; route = { airline, origin, destination } or null
const routeCache = new Map();
const ROUTE_TTL = 6 * 3600000; // remember a found route for 6h
const ROUTE_NOTFOUND_TTL = 30 * 60000; // genuine "unknown callsign" — back off 30m
const ROUTE_ERROR_TTL = 20000; // network/egress failure — retry soon

// Returns { route, error }. `error` is set when the lookup service could not be
// reached (DNS/egress/timeout) so the UI can explain *why* there's no route,
// instead of showing the same "no route" as a genuinely unknown callsign.
export async function lookupRoute(callsign) {
  const cs = (callsign || '').trim().toUpperCase();
  if (!cs) return { route: null, error: null };
  const cached = routeCache.get(cs);
  if (cached) {
    const ttl = cached.route ? ROUTE_TTL : cached.error ? ROUTE_ERROR_TTL : ROUTE_NOTFOUND_TTL;
    if (Date.now() - cached.ts < ttl) return { route: cached.route, error: cached.error };
  }
  let route = null;
  let error = null;
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      const fr = data?.response?.flightroute;
      if (fr) {
        route = {
          callsign: cs,
          airline: fr.airline
            ? { name: fr.airline.name, icao: fr.airline.icao, iata: fr.airline.iata, country: fr.airline.country }
            : null,
          origin: airportInfo(fr.origin),
          destination: airportInfo(fr.destination)
        };
      }
      // res.ok with no flightroute === genuinely unknown callsign (not an error)
    } else if (res.status === 404) {
      // adsbdb returns 404 for unknown callsigns — treat as "not found", not an error
    } else {
      error = `route service HTTP ${res.status}`;
    }
  } catch (e) {
    // DNS / no egress / timeout — the most common real-world cause on a
    // firewalled Raspberry Pi. Surface it instead of swallowing it.
    error = e.name === 'TimeoutError' ? 'route service timed out' : `route service unreachable (${e.code || e.message})`;
  }
  routeCache.set(cs, { ts: Date.now(), route, error });
  if (routeCache.size > 2000) {
    for (const k of routeCache.keys()) { routeCache.delete(k); if (routeCache.size <= 1500) break; }
  }
  return { route, error };
}

function airportInfo(a) {
  if (!a) return null;
  return {
    name: a.name,
    icao: a.icao_code,
    iata: a.iata_code,
    municipality: a.municipality,
    country: a.country_name,
    lat: a.latitude,
    lon: a.longitude,
    elevation: a.elevation
  };
}

// Airline name lookup purely from a cached route (no extra fetch).
export function cachedAirlineName(callsign) {
  const cs = (callsign || '').trim().toUpperCase();
  const cached = routeCache.get(cs);
  return cached?.route?.airline?.name || null;
}

// ----------------------------------------------------- aircraft DB (hex→reg/type)

// Plain dump1090-fa / SBS feeds don't carry registration or ICAO type per
// aircraft (only readsb/tar1090 do). We fill that gap with a persistent per-hex
// database: SQLite first (instant, offline, survives restarts), and for unknown
// hexes a one-time lookup against adsbdb that we then store. This mirrors the
// route-lookup pattern and stays light enough for a Raspberry Pi.
const acAttempted = new Map(); // hex -> ts of last network attempt (avoid hammering)
const AC_RETRY_TTL = 6 * 3600000;
let acDbError = null;

export function aircraftDbError() {
  return acDbError;
}

// Synchronous, offline: returns a stored entry or null. Use this every poll.
export function aircraftDbLocal(hex) {
  const row = getAircraftDb(hex);
  if (!row) return null;
  return {
    registration: row.registration || '',
    type: row.type || '',
    typeLong: row.type_long || '',
    operator: row.operator || ''
  };
}

// Async: fetch an unknown hex from adsbdb once, store it, return the entry.
// Returns null if unknown/unreachable. Heavily de-duped so each hex is tried
// at most once per AC_RETRY_TTL.
export async function lookupAircraft(hex) {
  hex = (hex || '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  const local = aircraftDbLocal(hex);
  if (local && (local.registration || local.type)) return local;
  const last = acAttempted.get(hex);
  if (last && Date.now() - last < AC_RETRY_TTL) return local;
  acAttempted.set(hex, Date.now());
  if (acAttempted.size > 8000) {
    for (const k of acAttempted.keys()) { acAttempted.delete(k); if (acAttempted.size <= 6000) break; }
  }
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/aircraft/${hex}`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const a = data?.response?.aircraft;
      if (a) {
        const entry = {
          hex,
          registration: a.registration || '',
          type: a.icao_type || a.type || '',
          typeLong: a.type || '',
          operator: a.registered_owner || ''
        };
        putAircraftDb(entry);
        acDbError = null;
        return entry;
      }
      // res.ok with no aircraft → genuinely unknown hex
    } else if (res.status !== 404) {
      acDbError = `aircraft DB service HTTP ${res.status}`;
    }
  } catch (e) {
    acDbError = e.name === 'TimeoutError' ? 'aircraft DB service timed out' : `aircraft DB unreachable (${e.code || e.message})`;
  }
  return local;
}

// ---------------------------------------------------------------- photos

const photoCache = new Map(); // hex -> { ts, photo }
const PHOTO_TTL = 24 * 3600000;

export async function lookupPhoto(hex) {
  hex = (hex || '').toLowerCase();
  const cached = photoCache.get(hex);
  if (cached && Date.now() - cached.ts < PHOTO_TTL) return cached.photo;
  let photo = null;
  try {
    const res = await fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      const p = data?.photos?.[0];
      if (p) {
        photo = {
          thumb: p.thumbnail_large?.src || p.thumbnail?.src,
          link: p.link,
          photographer: p.photographer
        };
      }
    }
  } catch { /* ignore */ }
  photoCache.set(hex, { ts: Date.now(), photo });
  if (photoCache.size > 2000) {
    for (const k of photoCache.keys()) { photoCache.delete(k); if (photoCache.size <= 1500) break; }
  }
  return photo;
}
