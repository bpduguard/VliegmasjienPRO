// Core tracker: polls dump1090's aircraft.json, maintains live aircraft state,
// classifies aircraft, checks zones + watchlist, fires notifications and
// records sightings into the database.
import { getConfig, saveConfig } from './config.js';
import { haversineKm, secondsToZoneEntry, etaSeconds } from './geo.js';
import { planeDbLookup, lookupRoute, cachedAirlineName, maybeAutoRefreshPlaneDb } from './enrich.js';
import { upsertSighting, pruneOldData } from './db.js';
import { notify } from './notify.js';

// hex -> live aircraft object
const aircraft = new Map();
// hex -> Set of zone ids the aircraft is currently inside (for enter detection)
const zonePresence = new Map();

let lastPollOk = null;
let lastPollError = null;
let messagesTotal = null;
let broadcast = null;

export function setTrackerBroadcast(fn) {
  broadcast = fn;
}

export function trackerStatus() {
  return {
    aircraftCount: aircraft.size,
    lastPollOk,
    lastPollError,
    messagesTotal,
    receiver: getConfig().receiver
  };
}

export function getAircraftList() {
  return [...aircraft.values()];
}

export function getAircraft(hex) {
  return aircraft.get((hex || '').toLowerCase()) || null;
}

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
// Common business-jet ICAO type prefixes (heuristic).
const BIZJET_TYPES = /^(GLF|GL[0-9]|GLEX|G[0-9]{3}|CL[0-9]{2}|C25|C50|C52|C55|C56|C68|C70|C75|E50P|E55P|E545|E550|E35L|F2TH|F900|FA[0-9]X|FA50|H25|HDJT|LJ[0-9]|PC24|PRM1|ASTR|BE40|GALX)/;

function classify(ac) {
  if (ac.emergency) return 'emergency';
  if (ac.military) return 'military';
  const padb = ac.padbCategory ? ac.padbCategory.toLowerCase() : '';
  if (padb.includes('mil')) return 'military';
  if (ac.airlineCallsign) return 'airline';
  if (ac.type && BIZJET_TYPES.test(ac.type.toUpperCase())) return 'business';
  // ICAO emitter categories: A1 light, A2 small, A7 rotorcraft → mostly GA/private
  if (ac.emitterCategory === 'A1' || ac.emitterCategory === 'A7') return 'private';
  if (ac.emitterCategory === 'A2' && !ac.airlineCallsign) return 'private';
  if (ac.type) return 'other';
  return 'unknown';
}

function detectAirlineCallsign(flight) {
  // Airline callsigns: 3-letter ICAO airline code + flight number (e.g. KLM123, RYR45AB)
  const m = /^([A-Z]{3})\d/.exec((flight || '').trim().toUpperCase());
  return m ? m[1] : null;
}

async function pollOnce() {
  const cfg = getConfig();
  let data;
  try {
    const res = await fetch(cfg.dump1090Url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    lastPollOk = Date.now();
    lastPollError = null;
  } catch (e) {
    lastPollError = e.message;
    return;
  }
  messagesTotal = data.messages ?? messagesTotal;
  const now = Date.now();
  const seen = new Set();

  for (const raw of data.aircraft || []) {
    const hex = (raw.hex || '').toLowerCase().replace('~', '');
    if (!hex) continue;
    seen.add(hex);
    let ac = aircraft.get(hex);
    if (!ac) {
      ac = { hex, firstSeen: now, trail: [] };
      aircraft.set(hex, ac);
    }
    ac.lastSeen = now;
    ac.flight = (raw.flight || ac.flight || '').trim();
    ac.squawk = raw.squawk ?? ac.squawk;
    ac.lat = raw.lat ?? ac.lat;
    ac.lon = raw.lon ?? ac.lon;
    ac.alt_baro = raw.alt_baro === 'ground' ? 0 : raw.alt_baro ?? ac.alt_baro;
    ac.onGround = raw.alt_baro === 'ground';
    ac.alt_geom = raw.alt_geom ?? ac.alt_geom;
    ac.gs = raw.gs ?? ac.gs;
    ac.ias = raw.ias ?? ac.ias;
    ac.track = raw.track ?? ac.track;
    ac.baro_rate = raw.baro_rate ?? raw.geom_rate ?? ac.baro_rate;
    ac.rssi = raw.rssi ?? ac.rssi;
    ac.messages = raw.messages ?? ac.messages;
    ac.seen = raw.seen ?? 0;
    ac.emitterCategory = raw.category || ac.emitterCategory;
    // readsb/tar1090 extras when available
    ac.registration = raw.r || ac.registration;
    ac.type = raw.t || ac.type;
    ac.military = !!((raw.dbFlags ?? 0) & 1) || ac.military || false;
    ac.emergency =
      (raw.emergency && raw.emergency !== 'none') || EMERGENCY_SQUAWKS.has(ac.squawk || '');

    // plane-alert-db enrichment
    const padb = planeDbLookup(hex);
    if (padb) {
      ac.registration = ac.registration || padb.registration;
      ac.type = ac.type || padb.icaoType || padb.type;
      ac.typeName = padb.type || ac.typeName;
      ac.operator = padb.operator || ac.operator;
      ac.padbCategory = padb.category;
      ac.padbTags = padb.tags;
      ac.padbLink = padb.link;
    }

    ac.airlineCallsign = detectAirlineCallsign(ac.flight);
    ac.classification = classify(ac);
    // Military traffic often uses airline-style callsigns (RCH, GAF…) — don't
    // count those as airlines in stats/filters.
    if (ac.classification === 'military') ac.airlineCallsign = null;
    ac.airline = ac.airlineCallsign
      ? cachedAirlineName(ac.flight) || ac.airline || ac.airlineCallsign
      : null;

    // distance from receiver
    const rcv = cfg.receiver;
    if (rcv.lat != null && ac.lat != null) {
      ac.distKm = +haversineKm(rcv.lat, rcv.lon, ac.lat, ac.lon).toFixed(1);
    }

    // trail
    if (ac.lat != null && ac.lon != null) {
      const last = ac.trail[ac.trail.length - 1];
      if (!last || last[0] !== ac.lat || last[1] !== ac.lon) {
        ac.trail.push([ac.lat, ac.lon, ac.alt_baro ?? null, now]);
        if (ac.trail.length > cfg.trailLength) ac.trail.splice(0, ac.trail.length - cfg.trailLength);
      }
    }

    // zone math (ETA + inside detection)
    ac.zones = computeZones(ac, cfg);

    // persist sighting
    try {
      upsertSighting(ac, now);
    } catch (e) {
      console.warn('[db] sighting failed:', e.message);
    }

    checkAlerts(ac, cfg);
    backgroundRouteLookup(ac);
  }

  // expire aircraft not seen for 60s
  for (const [hex, ac] of aircraft) {
    if (!seen.has(hex) && now - ac.lastSeen > 60000) {
      aircraft.delete(hex);
      zonePresence.delete(hex);
    }
  }

  if (broadcast) broadcast('aircraft', snapshot());
}

function computeZones(ac, cfg) {
  if (ac.lat == null || !cfg.zones.length) return [];
  const out = [];
  for (const z of cfg.zones) {
    const dist = haversineKm(ac.lat, ac.lon, z.lat, z.lon);
    const inside = dist <= z.radiusKm;
    let etaSec = null;
    if (!inside) {
      etaSec = secondsToZoneEntry(ac.lat, ac.lon, ac.track, ac.gs, z.lat, z.lon, z.radiusKm);
      // only surface "approaching" if entry is within 30 minutes
      if (etaSec != null && etaSec > 1800) etaSec = null;
    }
    out.push({ id: z.id, name: z.name, inside, distKm: +dist.toFixed(1), etaSec: etaSec != null ? Math.round(etaSec) : null });
  }
  return out;
}

function checkAlerts(ac, cfg) {
  const label = ac.flight || ac.registration || ac.hex.toUpperCase();

  // Zone entry alerts
  let present = zonePresence.get(ac.hex);
  if (!present) { present = new Set(); zonePresence.set(ac.hex, present); }
  for (const zs of ac.zones || []) {
    const zone = cfg.zones.find((z) => z.id === zs.id);
    if (!zone) continue;
    if (zs.inside && !present.has(zs.id)) {
      present.add(zs.id);
      if (zone.notify !== false) {
        notify({
          key: `zone:${zone.id}:${ac.hex}`,
          kind: 'zone',
          title: `✈ ${label} entered zone “${zone.name}”`,
          message: alertBody(ac),
          aircraft: ac
        });
      }
    } else if (!zs.inside && present.has(zs.id)) {
      present.delete(zs.id);
    }
  }

  // Watchlist alerts (plane-alert-db style matching: hex, registration or callsign)
  const wl = cfg.watchlist.find(
    (w) =>
      (w.icao && w.icao.toLowerCase() === ac.hex) ||
      (w.registration && ac.registration && w.registration.toUpperCase() === ac.registration.toUpperCase()) ||
      (w.callsign && ac.flight && w.callsign.toUpperCase() === ac.flight.toUpperCase())
  );
  if (wl && wl.notify !== false) {
    notify({
      key: `watch:${ac.hex}`,
      kind: 'watchlist',
      title: `⭐ Watchlist: ${wl.operator || wl.registration || label} spotted`,
      message: alertBody(ac),
      aircraft: ac,
      url: wl.link || undefined
    });
  }

  if (cfg.notifyEmergency && ac.emergency) {
    notify({
      key: `emerg:${ac.hex}`,
      kind: 'emergency',
      title: `🚨 EMERGENCY squawk ${ac.squawk || ''} — ${label}`,
      message: alertBody(ac),
      aircraft: ac
    });
  }

  if (cfg.notifyMilitary && ac.classification === 'military') {
    notify({
      key: `mil:${ac.hex}`,
      kind: 'military',
      title: `🪖 Military aircraft: ${label}`,
      message: alertBody(ac),
      aircraft: ac
    });
  }
}

function alertBody(ac) {
  const parts = [];
  if (ac.typeName || ac.type) parts.push(ac.typeName || ac.type);
  if (ac.operator) parts.push(ac.operator);
  if (Number.isFinite(ac.alt_baro)) parts.push(`${ac.alt_baro} ft`);
  if (Number.isFinite(ac.gs)) parts.push(`${Math.round(ac.gs)} kt`);
  if (ac.distKm != null) parts.push(`${ac.distKm} km away`);
  return parts.join(' · ') || 'No extra data';
}

// Resolve airline names lazily for airline callsigns (cached in enrich.js).
const routeLookupPending = new Set();
function backgroundRouteLookup(ac) {
  if (!ac.airlineCallsign || !ac.flight) return;
  if (cachedAirlineName(ac.flight)) return;
  if (routeLookupPending.has(ac.flight)) return;
  if (routeLookupPending.size > 5) return; // throttle concurrent lookups
  routeLookupPending.add(ac.flight);
  lookupRoute(ac.flight)
    .catch(() => {})
    .finally(() => routeLookupPending.delete(ac.flight));
}

// Compact snapshot for the SSE stream / list endpoint.
export function snapshot() {
  return {
    ts: Date.now(),
    receiver: getConfig().receiver,
    status: { lastPollOk, lastPollError, messagesTotal },
    aircraft: getAircraftList().map((ac) => ({
      hex: ac.hex,
      flight: ac.flight || null,
      registration: ac.registration || null,
      type: ac.type || null,
      typeName: ac.typeName || null,
      operator: ac.operator || null,
      airline: ac.airline || null,
      airlineCallsign: ac.airlineCallsign || null,
      classification: ac.classification,
      padbCategory: ac.padbCategory || null,
      lat: ac.lat ?? null,
      lon: ac.lon ?? null,
      alt: ac.alt_baro ?? null,
      altGeom: ac.alt_geom ?? null,
      gs: ac.gs ?? null,
      ias: ac.ias ?? null,
      track: ac.track ?? null,
      vr: ac.baro_rate ?? null,
      squawk: ac.squawk ?? null,
      emergency: !!ac.emergency,
      military: ac.classification === 'military',
      onGround: !!ac.onGround,
      rssi: ac.rssi ?? null,
      messages: ac.messages ?? null,
      seen: ac.seen ?? null,
      distKm: ac.distKm ?? null,
      firstSeen: ac.firstSeen,
      zones: ac.zones || [],
      trail: ac.trail
    }))
  };
}

// Extended detail for the side panel, including route + ETAs.
export async function aircraftDetail(hex) {
  const ac = getAircraft(hex);
  if (!ac) return null;
  const route = ac.flight ? await lookupRoute(ac.flight) : null;
  let etaDest = null;
  let distToDestKm = null;
  let distFromOriginKm = null;
  if (route?.destination?.lat != null && ac.lat != null) {
    distToDestKm = +haversineKm(ac.lat, ac.lon, route.destination.lat, route.destination.lon).toFixed(0);
    const eta = etaSeconds(ac.lat, ac.lon, ac.gs, route.destination.lat, route.destination.lon);
    if (eta != null) etaDest = Math.round(eta);
  }
  if (route?.origin?.lat != null && ac.lat != null) {
    distFromOriginKm = +haversineKm(ac.lat, ac.lon, route.origin.lat, route.origin.lon).toFixed(0);
  }
  return {
    ...snapshotOne(ac),
    route,
    etaDestSec: etaDest,
    distToDestKm,
    distFromOriginKm,
    // "departed" approximation: when we (or the route) first saw this flight
    firstSeen: ac.firstSeen
  };
}

function snapshotOne(ac) {
  const s = snapshot();
  return s.aircraft.find((a) => a.hex === ac.hex);
}

async function detectReceiver() {
  const cfg = getConfig();
  if (cfg.receiver.lat != null) return;
  try {
    const url = cfg.dump1090Url.replace(/aircraft\.json.*/, 'receiver.json');
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const r = await res.json();
      if (r.lat != null && r.lon != null) {
        saveConfig({ receiver: { lat: r.lat, lon: r.lon } });
        console.log(`[tracker] receiver location detected: ${r.lat}, ${r.lon}`);
      }
    }
  } catch { /* fine — user can set it in Settings */ }
}

let pollTimer = null;
export function startTracker() {
  detectReceiver();
  maybeAutoRefreshPlaneDb();
  const loop = async () => {
    try {
      await pollOnce();
    } catch (e) {
      console.warn('[tracker] poll error:', e.message);
    }
    pollTimer = setTimeout(loop, getConfig().pollIntervalMs);
  };
  loop();
  // housekeeping every 6h: prune DB + maybe refresh plane-alert-db
  setInterval(() => {
    try { pruneOldData(getConfig().retentionDays); } catch (e) { console.warn('[db] prune failed:', e.message); }
    maybeAutoRefreshPlaneDb();
  }, 6 * 3600000);
}
