// Actual reception-range outline: the farthest aircraft seen in each 1° bearing
// sector around the receiver, accumulated over time and persisted to disk. This
// is the real coverage shape (unlike the perfect distance rings).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { bearingDeg } from './geo.js';

const FILE = path.join(DATA_DIR, 'range.json');
const SECTORS = 360; // 1° resolution
const MAX_RANGE_KM = 700; // reject implausible positions (beyond ADS-B line-of-sight)

let buckets = new Array(SECTORS).fill(null); // each: { lat, lon, dist, alt, ts }
let rcvKey = null; // 'lat,lon' the outline was built around
let dirty = false;
let lastSave = 0;

export function initRange() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(data.buckets) && data.buckets.length === SECTORS) {
      buckets = data.buckets;
      rcvKey = data.rcvKey || null;
      console.log(`[range] loaded outline (${filledCount()} sectors)`);
    }
  } catch { /* first run */ }
}

function filledCount() {
  return buckets.reduce((n, b) => n + (b ? 1 : 0), 0);
}

// Update the outline with one observed aircraft position.
export function updateRangePoint(rcv, lat, lon, alt, distKm, now) {
  if (rcv?.lat == null || lat == null || lon == null || distKm == null) return;
  if (distKm > MAX_RANGE_KM) return; // garbage guard
  const key = `${rcv.lat.toFixed(3)},${rcv.lon.toFixed(3)}`;
  if (key !== rcvKey) {
    // receiver moved (or first run) — start the outline fresh for this location
    buckets = new Array(SECTORS).fill(null);
    rcvKey = key;
    dirty = true;
  }
  const i = Math.floor(((bearingDeg(rcv.lat, rcv.lon, lat, lon) % 360) + 360) % 360);
  const cur = buckets[i];
  if (!cur || distKm > cur.dist) {
    buckets[i] = { lat: +lat.toFixed(4), lon: +lon.toFixed(4), dist: +distKm.toFixed(1), alt: Number.isFinite(alt) ? alt : null, ts: now };
    dirty = true;
  }
}

// Points ordered by bearing for drawing the polygon.
export function rangeOutline() {
  const points = [];
  let maxKm = 0;
  for (let i = 0; i < SECTORS; i++) {
    const b = buckets[i];
    if (b) {
      points.push({ bearing: i, lat: b.lat, lon: b.lon, dist: b.dist, alt: b.alt });
      if (b.dist > maxKm) maxKm = b.dist;
    }
  }
  return { points, meta: { sectors: points.length, maxKm: +maxKm.toFixed(1), rcvKey } };
}

export function clearRange() {
  buckets = new Array(SECTORS).fill(null);
  dirty = true;
  saveRange(true);
  return { sectors: 0 };
}

export function saveRange(force = false) {
  if (!dirty && !force) return;
  if (!force && Date.now() - lastSave < 30000) return; // throttle writes
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ rcvKey, buckets }));
    dirty = false;
    lastSave = Date.now();
  } catch (e) {
    console.warn('[range] save failed:', e.message);
  }
}
