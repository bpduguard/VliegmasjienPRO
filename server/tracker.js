// Core tracker: polls dump1090's aircraft.json, maintains live aircraft state,
// classifies aircraft, checks zones + watchlist, fires notifications and
// records sightings into the database.
import { getConfig, saveConfig } from './config.js';
import { haversineKm, secondsToZoneEntry, etaSeconds, bearingDeg, crossTrackKm, alongTrackKm, angleDiff } from './geo.js';
import {
  planeDbLookup, lookupRoute, cachedAirlineName, maybeAutoRefreshPlaneDb,
  aircraftDbLocal, lookupAircraft
} from './enrich.js';
import { upsertSighting, pruneOldData, insertTracks, pruneTracks } from './db.js';
import { notify } from './notify.js';
import { ensureSbs, stopSbs, sbsSnapshot, sbsStatus } from './sbs.js';
import { icaoToCountry } from './country.js';

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

// How the position/track was received, from dump1090-fa / readsb fields.
// `raw.type` is the underlying message type; `raw.mlat` lists fields derived
// via multilateration. Returns: adsb | adsr | tisb | mlat | modes | uat | adsc | other.
function deriveSource(raw, ac) {
  if (Array.isArray(raw.mlat) && raw.mlat.includes('lat')) return 'mlat';
  const t = (raw.type || '').toLowerCase();
  if (t.startsWith('adsb')) return 'adsb';
  if (t.startsWith('adsr')) return 'adsr';
  if (t.startsWith('tisb')) return 'tisb';
  if (t === 'mlat') return 'mlat';
  if (t === 'mode_s' || t === 'modes') return 'modes';
  if (t === 'uat' || t === 'adsb_uat') return 'uat';
  if (t === 'adsc') return 'adsc';
  if (t) return 'other';
  // No type field (e.g. SBS feed): a decoded position implies ADS-B, otherwise Mode-S only.
  return (raw.lat ?? ac.lat) != null ? 'adsb' : 'modes';
}

// ICAO type-designator heuristics for the map pictogram. The ADS-B emitter
// category (A1..A7/B1..B7) is the primary signal; these regexes only refine or
// fill in when the category is generic/absent. Boundaries (?![0-9]) prevent
// short codes like C17 (Globemaster) from matching C172 (Cessna).
const HELI_TYPES = /^(EC2[05]|EC30|EC35|EC45|EC55|EC75|H1[0-9]{2}|H2[0-9]{2}|A109|A119|A129|A139|A149|A169|A189|R22|R44|R66|S55|S58|S61|S64|S70|S76|S92|B06|B47|B06T|B412|B427|B429|B505|AS3[0-9]|AS50|AS55|AS65|UH[0-9]{2}|CH[0-9]{2}|AH[0-9]{2}|MH[0-9]{2}|MI[0-9]{1,2}|NH90|EH10|BK17|EXPL|GAZL|LYNX|PUMA|TIGR|KA[0-9]{2})(?![A-Z0-9])/;
const FIGHTER_TYPES = /^(F1[045]|F16|F18|F22|F35|F4|F5|EUFI|RFAL|GR[0-9]|MIG[0-9]|SU[0-9]{2}|J39|A10|HARR|HUNT|TOR|F117|B1|B2|B52)(?![A-Z0-9])/;
const HEAVY_TYPES = /^(B74[0-9]|B77[0-9]|B78[0-9]|A33[0-9]|A34[0-9]|A35[0-9]|A38[0-9]|B76[0-9]|MD11|IL76|IL96|AN12|AN22|A124|A225|C5|C5M|C17|C130|C30J|KC10|KC13|KC46|E3[A-Z]{2}|A400|BLCF)(?![0-9])/;
const LIGHT_TYPES = /^(C1[0-9]{2}|C20[0-9]|C210|P28[A-Z]|PA[0-9]{2}|DA[0-9]{2}|DV20|DR[0-9]{2}|SR2[02]|M20[A-Z]|DG[0-9]{2}|BE3[0-9]|BE58|BE76|RV[0-9]{1,2}|TBM[0-9]|TB[0-9]{2}|PC[0-9]|AA[0-9]|G1[0-9]{2}|GLAS|VL3|GLST|EUPA|SAVG|EXTR|Z42|AT[0-9]{2}|GA8)(?![A-Z])/;

// Returns a pictogram kind for the map marker. Shape reflects the physical
// airframe class; the marker *colour* (set in the UI) conveys role, so a
// military transport shows as a heavy in green, a military heli as a heli in
// green, and only fast jets get the delta "military" shape.
function iconKind(ac) {
  const cat = (ac.emitterCategory || '').toUpperCase();
  const t = (ac.type || '').toUpperCase();
  if (cat === 'A7' || HELI_TYPES.test(t)) return 'heli';
  if (cat === 'B1') return 'glider';
  if (cat === 'B2') return 'balloon'; // lighter-than-air
  if (cat === 'B6' || cat === 'B7') return 'drone'; // UAV / space
  if (cat === 'A6' || FIGHTER_TYPES.test(t)) return 'military'; // high-performance / fast jet
  if (cat === 'A5' || HEAVY_TYPES.test(t)) return 'heavy';
  if (cat === 'A1' || cat === 'B4' || LIGHT_TYPES.test(t)) return 'light';
  if (cat === 'A3' || cat === 'A4' || cat === 'A2') return 'airliner';
  if (ac.airlineCallsign || t) return 'airliner';
  return 'unknown';
}

// Replay recording: at most one stored position per aircraft per interval.
const TRACK_RECORD_MS = 8000;
const lastTrackRec = new Map(); // hex -> ts of last recorded track point

async function pollOnce() {
  const cfg = getConfig();
  let data;
  if (cfg.source?.mode === 'sbs') {
    ensureSbs(cfg.source.sbsHost, cfg.source.sbsPort);
    const st = sbsStatus();
    if (!st.connected) {
      lastPollError = st.error || `connecting to ${cfg.source.sbsHost}:${cfg.source.sbsPort}…`;
      return;
    }
    data = sbsSnapshot();
    lastPollOk = Date.now();
    lastPollError = null;
  } else {
    stopSbs();
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
  }
  messagesTotal = data.messages ?? messagesTotal;
  const now = Date.now();
  const seen = new Set();
  const trackBuf = []; // replay position points recorded this poll

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
    ac.source = deriveSource(raw, ac);
    // readsb/tar1090 extras when available
    ac.registration = raw.r || ac.registration;
    ac.type = raw.t || ac.type;
    ac.military = !!((raw.dbFlags ?? 0) & 1) || ac.military || false;
    ac.emergency =
      (raw.emergency && raw.emergency !== 'none') || EMERGENCY_SQUAWKS.has(ac.squawk || '');

    // plane-alert-db enrichment (special / interesting aircraft)
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

    // hex → registration / type / operator for the rest (most aircraft).
    // Fast path: locally stored entry. Unknown hexes get a one-time background
    // lookup that backfills these fields and the sighting record.
    if (!ac.registration || !ac.type) {
      const local = aircraftDbLocal(hex);
      if (local) {
        ac.registration = ac.registration || local.registration;
        ac.type = ac.type || local.type;
        ac.typeName = ac.typeName || local.typeLong;
        ac.operator = ac.operator || local.operator;
      } else {
        backgroundAircraftLookup(ac, now);
      }
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

    // record a replay track point (throttled per aircraft)
    if (ac.lat != null && ac.lon != null && now - (lastTrackRec.get(hex) || 0) >= TRACK_RECORD_MS) {
      lastTrackRec.set(hex, now);
      trackBuf.push({
        ts: now, hex, lat: ac.lat, lon: ac.lon,
        alt: Number.isFinite(ac.alt_baro) ? ac.alt_baro : null,
        gs: Number.isFinite(ac.gs) ? Math.round(ac.gs) : null,
        trk: Number.isFinite(ac.track) ? Math.round(ac.track) : null,
        callsign: ac.flight || null, src: ac.source || null
      });
    }

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
      lastTrackRec.delete(hex);
    }
  }

  // flush replay track points for this poll
  if (trackBuf.length) {
    try { insertTracks(trackBuf); } catch (e) { console.warn('[db] track insert failed:', e.message); }
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

// One-time hex → reg/type/operator lookup for unknown aircraft; on success,
// backfill the live object and the current sighting so the list and the type
// statistics fill in.
const acLookupPending = new Set();
function backgroundAircraftLookup(ac, now) {
  if (acLookupPending.has(ac.hex)) return;
  if (acLookupPending.size > 6) return; // throttle concurrent lookups
  acLookupPending.add(ac.hex);
  lookupAircraft(ac.hex)
    .then((entry) => {
      if (!entry) return;
      if (!ac.registration) ac.registration = entry.registration || ac.registration;
      if (!ac.type) ac.type = entry.type || ac.type;
      if (!ac.typeName) ac.typeName = entry.typeLong || ac.typeName;
      if (!ac.operator) ac.operator = entry.operator || ac.operator;
      // re-record so the sighting (and therefore the type stats) gets the type
      if (entry.registration || entry.type) {
        try { upsertSighting(ac, now); } catch { /* non-fatal */ }
      }
    })
    .catch(() => {})
    .finally(() => acLookupPending.delete(ac.hex));
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
      country: icaoToCountry(ac.hex),
      classification: ac.classification,
      source: ac.source || null,
      padbCategory: ac.padbCategory || null,
      category: ac.emitterCategory || null,
      iconKind: iconKind(ac),
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
  const { route, error: routeError, agreement, sources } =
    ac.flight ? await lookupRoute(ac.flight) : { route: null, error: null, agreement: null, sources: [] };
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
  // Database routes are keyed by callsign and can be stale/wrong for the actual
  // flight. Sanity-check the route against where the plane really is and where
  // it's heading, so an implausible route is flagged rather than trusted.
  const routeCheck = checkRouteGeometry(ac, route, distToDestKm);
  // Combine the geometry check with cross-source agreement (adsbdb vs hexdb):
  //  - geometry says off-route -> low (physical evidence wins)
  //  - sources disagree -> low
  //  - both sources agree and geometry is fine -> confirmed
  let confidence = routeCheck.confidence;
  let issue = routeCheck.issue;
  if (confidence !== 'low') {
    if (agreement === 'conflict') {
      confidence = 'low';
      issue = 'the two route databases (adsbdb and hexdb) disagree on this flight';
    } else if (agreement === 'confirmed') {
      confidence = 'confirmed';
    }
  }
  return {
    ...snapshotOne(ac),
    route,
    routeError,
    routeConfidence: confidence,
    routeIssue: issue,
    routeSources: sources,
    etaDestSec: confidence === 'low' ? null : etaDest,
    distToDestKm,
    distFromOriginKm,
    // "departed" approximation: when we (or the route) first saw this flight
    firstSeen: ac.firstSeen
  };
}

// Returns { confidence: 'ok'|'low'|null, issue }. `null` when we can't judge
// (no route, or aircraft has no position). 'low' means the route is
// geometrically implausible for this aircraft right now.
function checkRouteGeometry(ac, route, distToDestKm) {
  const o = route?.origin, d = route?.destination;
  if (!route || ac.lat == null || o?.lat == null || d?.lat == null) return { confidence: null, issue: null };
  const routeLen = haversineKm(o.lat, o.lon, d.lat, d.lon);
  if (routeLen < 30) return { confidence: null, issue: null }; // origin≈dest, can't judge

  // 1) Is the plane anywhere near the direct corridor between the two airports?
  const xtk = Math.abs(crossTrackKm(ac.lat, ac.lon, o.lat, o.lon, d.lat, d.lon));
  const atk = alongTrackKm(ac.lat, ac.lon, o.lat, o.lon, d.lat, d.lon);
  const corridor = Math.max(150, 0.35 * routeLen); // airways wander; be generous
  const offCorridor = xtk > corridor || atk < -200 || atk > routeLen + 200;

  // 2) En-route (well clear of both airports), is it actually heading to the dest?
  const enRoute = (distToDestKm ?? 0) > 80 && haversineKm(ac.lat, ac.lon, o.lat, o.lon) > 80;
  const flyingAway =
    enRoute && ac.track != null && angleDiff(ac.track, bearingDeg(ac.lat, ac.lon, d.lat, d.lon)) > 90;

  if (offCorridor) return { confidence: 'low', issue: 'aircraft is well off the direct corridor between the listed airports' };
  if (flyingAway) return { confidence: 'low', issue: 'aircraft is not heading toward the listed destination' };
  return { confidence: 'ok', issue: null };
}

function snapshotOne(ac) {
  const s = snapshot();
  return s.aircraft.find((a) => a.hex === ac.hex);
}

async function detectReceiver() {
  const cfg = getConfig();
  if (cfg.receiver.lat != null) return;
  // receiver.json only exists on the HTTP source; with SBS set it manually.
  if (cfg.source?.mode === 'sbs') return;
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
    try { pruneTracks(getConfig().replayRetentionDays); } catch (e) { console.warn('[db] track prune failed:', e.message); }
    maybeAutoRefreshPlaneDb();
  }, 6 * 3600000);
}
