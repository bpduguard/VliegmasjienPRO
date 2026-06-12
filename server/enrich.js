// Aircraft enrichment:
//  - plane-alert-db (the same CSV resource planefence/plane-alert uses)
//  - flight routes via adsbdb.com (origin/destination airports + airline)
//  - photos via planespotters.net public API
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

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

// callsign -> { ts, route } ; route = { airline, origin, destination } or null
const routeCache = new Map();
const ROUTE_TTL = 6 * 3600000;
const ROUTE_NEG_TTL = 30 * 60000;

export async function lookupRoute(callsign) {
  const cs = (callsign || '').trim().toUpperCase();
  if (!cs) return null;
  const cached = routeCache.get(cs);
  if (cached && Date.now() - cached.ts < (cached.route ? ROUTE_TTL : ROUTE_NEG_TTL)) {
    return cached.route;
  }
  let route = null;
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
    }
  } catch {
    /* network hiccup — cache negative briefly */
  }
  routeCache.set(cs, { ts: Date.now(), route });
  if (routeCache.size > 2000) {
    // crude LRU trim
    for (const k of routeCache.keys()) { routeCache.delete(k); if (routeCache.size <= 1500) break; }
  }
  return route;
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
