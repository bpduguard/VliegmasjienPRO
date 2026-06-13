// Airport communication frequencies from OurAirports (public domain, no key).
// Downloads airports.csv + airport-frequencies.csv, joins them, and stores one
// record per airport (with its frequency list) in SQLite for fast bounding-box
// lookups behind the map's "Frequencies" layer.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { replaceAirportFreqs, airportFreqsCount } from './db.js';

const META_FILE = path.join(DATA_DIR, 'frequencies.meta.json');

const DEFAULT_AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const DEFAULT_FREQS_URL = 'https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv';

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

function headerIndex(headerLine) {
  const cols = parseCsvLine(headerLine).map((c) => c.trim().toLowerCase());
  return (name) => cols.indexOf(name);
}

export function frequenciesMeta() {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { /* none */ }
  return { count: airportFreqsCount(), ...meta };
}

export async function refreshFrequencies(opts = {}) {
  const cfg = getConfig();
  const airportsUrl = opts.airportsUrl || cfg.frequencies?.airportsUrl || DEFAULT_AIRPORTS_URL;
  const freqsUrl = opts.freqsUrl || cfg.frequencies?.freqsUrl || DEFAULT_FREQS_URL;

  // 1. frequencies file → group by airport ident
  const freqRes = await fetch(freqsUrl, { signal: AbortSignal.timeout(120000) });
  if (!freqRes.ok) throw new Error(`airport-frequencies download failed: HTTP ${freqRes.status}`);
  const freqText = await freqRes.text();
  const freqLines = freqText.split(/\r?\n/);
  const fi = headerIndex(freqLines[0]);
  const iIdent = fi('airport_ident');
  const iType = fi('type');
  const iDesc = fi('description');
  const iMhz = fi('frequency_mhz');
  if (iIdent < 0 || iMhz < 0) throw new Error('unexpected airport-frequencies.csv format');

  const byIdent = new Map(); // ident -> [{type, description, mhz}]
  for (let k = 1; k < freqLines.length; k++) {
    if (!freqLines[k]) continue;
    const c = parseCsvLine(freqLines[k]);
    const ident = (c[iIdent] || '').trim();
    const mhz = (c[iMhz] || '').trim();
    if (!ident || !mhz) continue;
    let arr = byIdent.get(ident);
    if (!arr) { arr = []; byIdent.set(ident, arr); }
    arr.push({ type: (c[iType] || '').trim(), description: (c[iDesc] || '').trim(), mhz });
  }

  // 2. airports file → lat/lon/name for the idents that have frequencies
  const apRes = await fetch(airportsUrl, { signal: AbortSignal.timeout(120000) });
  if (!apRes.ok) throw new Error(`airports download failed: HTTP ${apRes.status}`);
  const apText = await apRes.text();
  const apLines = apText.split(/\r?\n/);
  const ai = headerIndex(apLines[0]);
  const aIdent = ai('ident');
  const aName = ai('name');
  const aLat = ai('latitude_deg');
  const aLon = ai('longitude_deg');
  const aMun = ai('municipality');
  const aCountry = ai('iso_country');
  if (aIdent < 0 || aLat < 0 || aLon < 0) throw new Error('unexpected airports.csv format');

  const rows = [];
  for (let k = 1; k < apLines.length; k++) {
    if (!apLines[k]) continue;
    const c = parseCsvLine(apLines[k]);
    const ident = (c[aIdent] || '').trim();
    const freqs = byIdent.get(ident);
    if (!freqs) continue;
    const lat = parseFloat(c[aLat]);
    const lon = parseFloat(c[aLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push({
      ident,
      name: (c[aName] || '').trim(),
      municipality: (c[aMun] || '').trim(),
      country: (c[aCountry] || '').trim(),
      lat,
      lon,
      freqs
    });
  }
  if (rows.length < 100) throw new Error('frequency dataset looks invalid (too few airports)');

  const n = replaceAirportFreqs(rows);
  fs.writeFileSync(META_FILE, JSON.stringify({ updatedAt: Date.now(), airports: n, source: 'OurAirports' }));
  console.log(`[freq] loaded frequencies for ${n} airports`);
  return { airports: n };
}
