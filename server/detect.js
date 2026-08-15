// ── Detection & anomaly layer ────────────────────────────────────────────────
// Runs entirely on the live state-vector stream already ingested by the tracker —
// no extra data source. Each detector is edge-triggered (fires on a transition /
// episode, not on steady state) and routes through the existing notify() pipeline
// (keyed cooldown → alert-log → SSE → Pushover/Discord). A structured copy of each
// detection is also kept in an in-memory ring buffer for the Detections tab.
//
// Detectors: squawk watch · loiter/orbit · emergency descent · ADS-B
// integrity/spoofing · rarity scoring. (Survey-grid, go-around and the external
// military feed are a later phase.)
import { haversineKm, bearingDeg, angleDiff } from './geo.js';
import { notify, underCooldown, noteCooldown } from './notify.js';

const NM_KM = 1.852;
const label = (ac) => ac.flight || ac.registration || ac.hex.toUpperCase();

// ── per-aircraft detector state (pruned when the aircraft expires) ────────────
const dstate = new Map(); // hex -> state bag
export function dropDetectState(hex) { dstate.delete(hex); }

// ── structured feed for the Detections tab ───────────────────────────────────
const recentDetections = [];
const DET_CAP = 400;
export function recentDetectionList(limit = 200) { return recentDetections.slice(0, limit); }

// Whether detections should also fire notifications (they always land in the
// Detections tab feed regardless). Updated each poll from config.
let notifyOn = true;

// ── learned history for rarity (self-tuning; seeded from the sightings DB) ────
let known = null; // { types:Set, operators:Set }
export function initDetections(sets) {
  known = { types: sets?.types || new Set(), operators: sets?.operators || new Set() };
}

// Emit a detection: dedup on the shared cooldown, record to the feed, and hand to
// the notify pipeline for push + alert-log + live SSE.
function emit(ac, det) {
  const key = det.key || `det:${det.type}:${ac.hex}`;
  if (underCooldown(key)) return;
  recentDetections.unshift({
    ts: Date.now(), type: det.type, severity: det.severity,
    hex: ac.hex, callsign: ac.flight || null, registration: ac.registration || null,
    title: det.title, detail: det.detail, metrics: det.metrics || null,
    lat: Number.isFinite(ac.lat) ? ac.lat : null,
    lon: Number.isFinite(ac.lon) ? ac.lon : null,
    alt: Number.isFinite(ac.alt_baro) ? ac.alt_baro : null
  });
  if (recentDetections.length > DET_CAP) recentDetections.length = DET_CAP;
  // Always in the feed; notify (alert-log / push / SSE toast) only when enabled.
  if (notifyOn) notify({ key, kind: 'detection', title: det.title, message: det.detail, aircraft: ac });
  else noteCooldown(key); // keep the same de-dup even when not notifying
}

// ── entry point, called once per aircraft per poll ───────────────────────────
export function runDetections(ac, cfg, now) {
  const d = cfg.detections;
  if (!d || d.enabled === false) return;
  notifyOn = d.notify !== false;
  let st = dstate.get(ac.hex);
  if (!st) { st = { win: [] }; dstate.set(ac.hex, st); }

  if (d.squawk !== false) detectSquawk(ac, st);
  if (d.emergencyDescent !== false) detectEmergencyDescent(ac, st);
  if (d.orbit !== false) detectOrbit(ac, st, now);
  if (d.integrity !== false) detectIntegrity(ac, st, now);
  if (d.rarity !== false) detectRarity(ac, st, cfg);
  if (d.survey !== false) detectSurvey(ac, st, now);
  if (d.goAround !== false) detectGoAround(ac, st);
  if (d.military !== false) detectMilitary(ac, st);
  // (the integrity detector manages its own trusted kinematic baseline)
}

// ── 1. squawk watch (transition-based) ───────────────────────────────────────
const SQUAWK_WATCH = {
  '7500': { label: 'Unlawful interference (hijack)', severity: 'critical' },
  '7600': { label: 'Radio failure', severity: 'critical' },
  '7700': { label: 'General emergency', severity: 'critical' },
  '0033': { label: 'Parachute dropping (NL)', severity: 'warning' },
  '7000': { label: 'VFR conspicuity (NL)', severity: 'info' }
};
function detectSquawk(ac, st) {
  const sq = ac.squawk || null;
  if (sq === st.squawk) return;           // no change — nothing to do
  const prev = st.squawk;                 // undefined on first observation
  st.squawk = sq;
  if (sq == null) return;
  const w = SQUAWK_WATCH[sq];
  if (!w) return;
  // On the very first observation of an aircraft we don't know its previous code,
  // so only alert benign/info codes (7000) on a *real* transition we witnessed.
  if (prev === undefined && w.severity === 'info') return;
  emit(ac, {
    type: 'squawk', severity: w.severity,
    title: `🆘 Squawk ${sq} — ${w.label}`,
    detail: `${label(ac)} is squawking ${sq} (${w.label})${prev ? ` — changed from ${prev}` : ''}.`,
    metrics: { squawk: sq, prev: prev || null },
    key: `det:squawk:${ac.hex}:${sq}`
  });
}

// ── 2. emergency descent (depressurisation signature) ────────────────────────
function detectEmergencyDescent(ac, st) {
  const vr = ac.baro_rate, alt = ac.alt_baro;
  const active = Number.isFinite(vr) && Number.isFinite(alt) && !ac.onGround
    && vr < -4000 && alt > 20000; // > 4000 fpm down, above FL200
  if (active && !st.descent) {
    st.descent = true;
    emit(ac, {
      type: 'descent', severity: 'critical',
      title: `⚠️ Emergency descent — ${label(ac)}`,
      detail: `Descending ${Math.abs(Math.round(vr))} fpm through FL${Math.round(alt / 100)} — rapid-descent / cabin-depressurisation signature.`,
      metrics: { vr: Math.round(vr), alt },
      key: `det:descent:${ac.hex}`
    });
  } else if (st.descent && (!Number.isFinite(vr) || vr > -2000 || (Number.isFinite(alt) && alt < 18000) || ac.onGround)) {
    st.descent = false; // episode ended
  }
}

// ── 3. loiter / orbit detection ──────────────────────────────────────────────
// Signed cumulative turn from consecutive *position* bearings (robust to reported-
// track jitter and to straight-line flight) vs. how tightly the track is bunched.
const ORBIT_WINDOW_MS = 12 * 60000;
const ORBIT_TURN_DEG = 720;             // ≥ two full turns
const ORBIT_RADIUS_KM = 3 * NM_KM;      // stays within ~3 NM
function detectOrbit(ac, st, now) {
  if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon) || ac.onGround) return;
  const win = st.win;
  const last = win[win.length - 1];
  // only append when the aircraft has actually moved a little (stable bearings)
  if (!last || haversineKm(last.lat, last.lon, ac.lat, ac.lon) > 0.05) {
    win.push({ ts: now, lat: ac.lat, lon: ac.lon });
  }
  while (win.length && now - win[0].ts > ORBIT_WINDOW_MS) win.shift();
  if (win.length < 10) return;

  let signedTurn = 0;
  for (let i = 2; i < win.length; i++) {
    const b1 = bearingDeg(win[i - 2].lat, win[i - 2].lon, win[i - 1].lat, win[i - 1].lon);
    const b2 = bearingDeg(win[i - 1].lat, win[i - 1].lon, win[i].lat, win[i].lon);
    signedTurn += ((b2 - b1 + 540) % 360) - 180; // signed −180..180
  }
  let clat = 0, clon = 0;
  for (const p of win) { clat += p.lat; clon += p.lon; }
  clat /= win.length; clon /= win.length;
  let radius = 0;
  for (const p of win) { const dk = haversineKm(clat, clon, p.lat, p.lon); if (dk > radius) radius = dk; }

  const orbiting = Math.abs(signedTurn) > ORBIT_TURN_DEG && radius < ORBIT_RADIUS_KM;
  if (orbiting && !st.orbit) {
    st.orbit = true;
    emit(ac, {
      type: 'orbit', severity: 'warning',
      title: `🔄 Loiter / orbit — ${label(ac)}`,
      detail: `Circling: ${Math.round(Math.abs(signedTurn))}° of turn within a ${(radius / NM_KM).toFixed(1)} NM radius over ${Math.round((now - win[0].ts) / 60000)} min — typical of police / medevac / ISR / survey flights.`,
      metrics: { turnDeg: Math.round(Math.abs(signedTurn)), radiusNm: +(radius / NM_KM).toFixed(1) },
      key: `det:orbit:${ac.hex}`
    });
  } else if (st.orbit && (radius > ORBIT_RADIUS_KM * 1.6 || Math.abs(signedTurn) < ORBIT_TURN_DEG * 0.4)) {
    st.orbit = false; // left the orbit
  }
}

// ── 4. ADS-B data-integrity / spoofing checks ────────────────────────────────
// ADS-B is unauthenticated, so we treat our own ingest as untrusted input.
function hexIssue(hex) {
  const n = parseInt(hex, 16);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 'is the null address (000000)';
  if (n >= 0xF00000) return 'is in a reserved / unallocated ICAO block';
  return null;
}
function detectIntegrity(ac, st, now) {
  // (a) suspect ICAO address — check once per aircraft
  if (!st.hexChecked) {
    st.hexChecked = true;
    const issue = hexIssue(ac.hex);
    if (issue) emit(ac, {
      type: 'integrity', severity: 'warning',
      title: `🛑 Suspect ICAO address — ${label(ac)}`,
      detail: `ICAO address ${ac.hex.toUpperCase()} ${issue}.`,
      metrics: { hex: ac.hex }, key: `det:hex:${ac.hex}`
    });
  }

  // The kinematic/quality checks are only as good as the ADS-B we receive, so we
  // deliberately run them ONLY on trustworthy fixes. Interpolated/rebroadcast
  // sources (MLAT, TIS-B, ADS-C) and low position-quality fixes are exactly what
  // produce apparent "teleports" and speed mismatches in sparse coverage — skip
  // them rather than cry wolf.
  const goodPos = Number.isFinite(ac.lat) && Number.isFinite(ac.lon)
    && DIRECT_ADSB.has(ac.source || '')
    && (ac.nic == null || ac.nic >= 5) && (ac.nacp == null || ac.nacp >= 5);

  // (d) NIC (navigation integrity) collapse — a good fix (≥7) followed by two
  // consecutive very-low fixes (≤1), so a single sparse-coverage dropout is ignored.
  const nic = Number.isFinite(ac.nic) ? ac.nic : null;
  if (nic != null && DIRECT_ADSB.has(ac.source || '') && !ac.onGround) {
    if (nic >= 7) { st.nicGood = nic; st.nicLow = 0; st.nicFired = false; }
    else if (nic <= 1 && st.nicGood) {
      st.nicLow = (st.nicLow || 0) + 1;
      if (st.nicLow >= 2 && !st.nicFired) {
        st.nicFired = true;
        emit(ac, {
          type: 'integrity', severity: 'warning',
          title: `📉 Position-quality drop — ${label(ac)}`,
          detail: `Navigation integrity (NIC) fell from ${st.nicGood} to ${nic} and stayed there — possible GPS loss, jamming or spoofing.`,
          metrics: { nicFrom: st.nicGood, nicTo: nic }, key: `det:nic:${ac.hex}`
        });
      }
    }
  }

  if (!goodPos) return;
  const base = st.kin;
  // Only compare *distinct* fixes. A stale/duplicate position repeated across polls
  // (common when reception is spotty) must keep the baseline — including its
  // timestamp — untouched, otherwise a fresh fix after a gap looks like a teleport.
  // That stale-position case was the #1 false-positive source.
  if (base && base.lat === ac.lat && base.lon === ac.lon) return;
  if (base) {
    const dt = (now - base.ts) / 1000;
    if (dt > 1 && dt < 300) {
      const dkm = haversineKm(base.lat, base.lon, ac.lat, ac.lon);
      const impliedKt = (dkm / NM_KM) / (dt / 3600);
      // (b) impossible kinematics — a jump implying > ~Mach 2. Require TWO
      // consecutive impossible fixes and don't advance the trusted baseline onto a
      // suspect position, so a one-off decode glitch that snaps back is rejected.
      if (dkm > 5 && impliedKt > 1500) {
        st.kinAnom = (st.kinAnom || 0) + 1;
        if (st.kinAnom >= 2) {
          emit(ac, {
            type: 'integrity', severity: 'critical',
            title: `🛑 Impossible kinematics — ${label(ac)}`,
            detail: `Position jumped ${dkm.toFixed(0)} km in ${dt.toFixed(0)} s (~${Math.round(impliedKt)} kt, faster than Mach 2) across two fixes — likely spoofed or corrupt ADS-B.`,
            metrics: { jumpKm: +dkm.toFixed(0), impliedKt: Math.round(impliedKt), dtSec: Math.round(dt) },
            key: `det:jump:${ac.hex}`
          });
          st.kinAnom = 0; st.kin = { ts: now, lat: ac.lat, lon: ac.lon };
        }
        return; // hold the baseline pending confirmation (or after firing)
      }
      st.kinAnom = 0;
      // (c) ground-speed vs. position-delta mismatch — only over a short interval
      // (so a turn during a gap can't cause it) and only when sustained (3 fixes).
      if (Number.isFinite(ac.gs) && ac.gs > 60 && dt <= 20 && dkm > 0.3) {
        const ratio = impliedKt / ac.gs;
        const mismatch = (ratio > 2.5 || ratio < 0.4) && Math.abs(impliedKt - ac.gs) > 250;
        if (mismatch) {
          st.gsMiss = (st.gsMiss || 0) + 1;
          if (st.gsMiss >= 3 && !st.gsMissActive) {
            st.gsMissActive = true;
            emit(ac, {
              type: 'integrity', severity: 'info',
              title: `⚠️ Speed / position mismatch — ${label(ac)}`,
              detail: `Reported ground speed ${Math.round(ac.gs)} kt but position moved ~${Math.round(impliedKt)} kt over ${dt.toFixed(0)} s across several fixes.`,
              metrics: { gs: Math.round(ac.gs), impliedKt: Math.round(impliedKt) },
              key: `det:gsmiss:${ac.hex}`
            });
          }
        } else { st.gsMiss = 0; st.gsMissActive = false; }
      }
    }
  }
  st.kin = { ts: now, lat: ac.lat, lon: ac.lon }; // advance the trusted baseline
}
// ADS-B sources whose positions are precise enough to reason about kinematically:
// direct ADS-B (1090 or UAT) and ADS-R (a rebroadcast of real ADS-B). Excluded —
// MLAT (multilaterated, jittery), TIS-B (radar-derived, coarse), ADS-C and Mode-S
// — because their jitter/latency is what causes false integrity hits in the first
// place, especially where coverage is thin.
const DIRECT_ADSB = new Set(['adsb', 'adsr', 'uat']);

// ── 5. rarity scoring (first time in your coverage) ──────────────────────────
// Self-tuning: learns from what it sees and only starts flagging once a baseline
// of types is known (so a fresh install doesn't flag everything on day one).
// First-time *type* and *operator* are the high-signal cases; per-airframe (hex)
// rarity is deliberately left out — most airframes are one-offs, so it's noise.
function detectRarity(ac, st, cfg) {
  const ready = known && known.types.size >= (cfg.detections?.rarityMinTypes ?? 40);
  if (!st.rarType && ac.type) {
    st.rarType = true;
    const t = ac.type.toUpperCase();
    const isNew = known && !known.types.has(t);
    if (known) known.types.add(t);
    if (ready && isNew) emit(ac, {
      type: 'rarity', severity: 'info',
      title: `✨ First-time type — ${label(ac)}`,
      detail: `Aircraft type ${t}${ac.typeName ? ` (${ac.typeName})` : ''} has not been seen in your coverage before.`,
      metrics: { typeCode: t }, key: `det:rartype:${t}`
    });
  }
  if (!st.rarOp && ac.operator) {
    st.rarOp = true;
    const o = ac.operator.trim();
    const ok = o.toLowerCase();
    const isNew = known && o && !known.operators.has(ok);
    if (known && o) known.operators.add(ok);
    if (ready && isNew) emit(ac, {
      type: 'rarity', severity: 'info',
      title: `✨ First-time operator — ${label(ac)}`,
      detail: `Operator “${o}” has not been seen in your coverage before.`,
      metrics: { operator: o }, key: `det:rarop:${ok}`
    });
  }
}

// ── 6. survey-grid detection ("mowing the lawn") ─────────────────────────────
// Repeated parallel legs on one axis with ~180° reversals and roughly constant
// spacing → pipeline patrol, aerial photogrammetry, calibration flights. Built
// from a long, down-sampled window; analysed on a throttle to stay cheap.
const SURVEY_WINDOW_MS = 30 * 60000;
const SURVEY_ADD_MS = 12000;     // down-sample: one point every ~12 s
const SURVEY_RUN_MS = 20000;     // re-analyse at most every ~20 s per aircraft
const SURVEY_MIN_LEG_KM = 1.2;
function enuKm(lat, lon, refLat, refLon) {
  const kLon = 111.320 * Math.cos((refLat * Math.PI) / 180);
  return { e: (lon - refLon) * kLon, n: (lat - refLat) * 110.574 };
}
function buildLegs(pts) {
  const legs = [];
  let cur = null, prev = null;
  const closeLeg = () => {
    if (cur && cur.len >= SURVEY_MIN_LEG_KM && cur.pts.length >= 2) {
      const cx = cur.pts.reduce((s, p) => s + p.lat, 0) / cur.pts.length;
      const cy = cur.pts.reduce((s, p) => s + p.lon, 0) / cur.pts.length;
      legs.push({ heading: (Math.atan2(cur.sx, cur.cyc) * 180 / Math.PI + 360) % 360, lat: cx, lon: cy, len: cur.len });
    }
    cur = null;
  };
  for (const p of pts) {
    if (prev) {
      const dkm = haversineKm(prev.lat, prev.lon, p.lat, p.lon);
      if (dkm < 0.15) continue; // too close for a stable bearing
      const b = bearingDeg(prev.lat, prev.lon, p.lat, p.lon);
      if (!cur) {
        cur = { sx: Math.sin(b * Math.PI / 180), cyc: Math.cos(b * Math.PI / 180), pts: [prev, p], len: dkm };
      } else {
        const mean = (Math.atan2(cur.sx, cur.cyc) * 180 / Math.PI + 360) % 360;
        if (angleDiff(b, mean) < 40) {
          cur.sx += Math.sin(b * Math.PI / 180); cur.cyc += Math.cos(b * Math.PI / 180);
          cur.pts.push(p); cur.len += dkm;
        } else {
          closeLeg();
          cur = { sx: Math.sin(b * Math.PI / 180), cyc: Math.cos(b * Math.PI / 180), pts: [prev, p], len: dkm };
        }
      }
    }
    prev = p;
  }
  closeLeg();
  return legs;
}
// Pure analysis (exported for tests): given the window points, decide whether
// they describe a parallel-leg survey grid.
export function _surveyVerdict(pts) {
  if (!pts || pts.length < 12) return { isSurvey: false, legs: 0 };
  const legs = buildLegs(pts);
  if (legs.length < 4) return { isSurvey: false, legs: legs.length };

  // 1) do all legs share one axis? circular stats on the doubled heading, so
  //    opposite directions (a leg and its reverse) map together.
  let sx = 0, cy = 0;
  for (const l of legs) { const a2 = 2 * l.heading * Math.PI / 180; sx += Math.sin(a2); cy += Math.cos(a2); }
  const R = Math.hypot(sx, cy) / legs.length;      // 1 = perfectly parallel axis
  const axis = ((Math.atan2(sx, cy) * 180 / Math.PI) / 2 + 360) % 180;
  if (R < 0.9) return { isSurvey: false, legs: legs.length, R: +R.toFixed(2) };

  // 2) do consecutive legs reverse (~180°)?
  let alt = 0;
  for (let i = 1; i < legs.length; i++) if (angleDiff(legs[i].heading, legs[i - 1].heading) > 140) alt++;
  if (alt < (legs.length - 1) * 0.6) return { isSurvey: false, legs: legs.length };

  // 3) roughly constant spacing between the parallel lines
  const refLat = legs[0].lat, refLon = legs[0].lon;
  const perp = (axis + 90) * Math.PI / 180;
  const offs = legs.map((l) => { const { e, n } = enuKm(l.lat, l.lon, refLat, refLon); return e * Math.sin(perp) + n * Math.cos(perp); })
    .sort((a, b) => a - b);
  const clusters = [];                              // merge lines within 0.15 km
  for (const o of offs) { if (!clusters.length || Math.abs(o - clusters[clusters.length - 1]) > 0.15) clusters.push(o); }
  if (clusters.length < 3) return { isSurvey: false, legs: legs.length, lines: clusters.length };
  const gaps = [];
  for (let i = 1; i < clusters.length; i++) gaps.push(clusters[i] - clusters[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const cv = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / (mean || 1);
  if (mean < 0.1 || mean > 6 || cv > 0.6) return { isSurvey: false, legs: legs.length, spacingKm: +mean.toFixed(2), cv: +cv.toFixed(2) };

  return { isSurvey: true, legs: legs.length, lines: clusters.length, spacingNm: +(mean / NM_KM).toFixed(1), axisDeg: Math.round(axis) };
}
function detectSurvey(ac, st, now) {
  if (!Number.isFinite(ac.lat) || !Number.isFinite(ac.lon) || ac.onGround) return;
  const s = st.survey || (st.survey = { pts: [], lastAdd: 0, lastRun: 0, active: false });
  if (now - s.lastAdd >= SURVEY_ADD_MS) { s.pts.push({ ts: now, lat: ac.lat, lon: ac.lon }); s.lastAdd = now; }
  while (s.pts.length && now - s.pts[0].ts > SURVEY_WINDOW_MS) s.pts.shift();
  if (now - s.lastRun < SURVEY_RUN_MS) return;
  s.lastRun = now;

  const v = _surveyVerdict(s.pts);
  if (!v.isSurvey) { s.active = false; return; }
  if (!s.active) {
    s.active = true;
    emit(ac, {
      type: 'survey', severity: 'warning',
      title: `🗺️ Survey / patrol pattern — ${label(ac)}`,
      detail: `Flying ${v.legs} parallel legs on a ${v.axisDeg}°/${(v.axisDeg + 180) % 360}° axis, ~${v.spacingNm} NM apart — pipeline patrol / aerial survey / calibration signature.`,
      metrics: { legs: v.legs, spacingNm: v.spacingNm, axisDeg: v.axisDeg },
      key: `det:survey:${ac.hex}`
    });
  }
}

// ── 7. go-around / missed approach ───────────────────────────────────────────
// Descended low near an airport while NOT climbing (the approach), then climbed
// away (> 500 fpm) without touching down. The "not climbing while low" gate is
// what separates this from an ordinary departure (which climbs from the ground).
// AGL uses the airport elevation when known, else assumes sea level. Runway
// alignment is approximated by proximity to a towered airport.
let airportIndex = []; // [{ ident, name, lat, lon, elev }]
export function initGoAround(airports) { airportIndex = airports || []; }
function nearestAirport(lat, lon) {
  let best = null, bestKm = Infinity;
  for (const a of airportIndex) {
    const dk = haversineKm(lat, lon, a.lat, a.lon);
    if (dk < bestKm) { bestKm = dk; best = a; }
  }
  return best ? { airport: best, distKm: bestKm } : null;
}
function detectGoAround(ac, st) {
  if (!airportIndex.length || !Number.isFinite(ac.lat) || !Number.isFinite(ac.alt_baro)) return;
  const g = st.ga || (st.ga = { phase: 'idle', minAlt: Infinity, airport: null });
  const near = nearestAirport(ac.lat, ac.lon);
  if (!near || near.distKm > 15) { g.phase = 'idle'; g.minAlt = Infinity; return; }
  const agl = ac.alt_baro - (near.airport.elev || 0);
  const vr = Number.isFinite(ac.baro_rate) ? ac.baro_rate : 0;

  if (ac.onGround || agl > 4000) { g.phase = 'idle'; g.minAlt = Infinity; return; } // landed / climbed out

  // On approach: low near the field and not climbing.
  if (near.distKm <= 8 && agl < 1800 && vr < 300) {
    g.phase = 'approach'; g.airport = near.airport;
    g.minAlt = Math.min(g.minAlt, agl);
  }
  // Go-around: was on approach, got low, and is now climbing away without landing.
  if (g.phase === 'approach' && vr > 500 && g.minAlt < 1500 && agl > g.minAlt + 200 && near.distKm < 12) {
    const ap = g.airport, lowAgl = Math.round(g.minAlt);
    g.phase = 'idle'; g.minAlt = Infinity;
    emit(ac, {
      type: 'goaround', severity: 'warning',
      title: `🛫 Possible go-around — ${label(ac)}`,
      detail: `Descended to ~${lowAgl} ft near ${ap.ident}${ap.name ? ` (${ap.name})` : ''} then climbed away at ${Math.round(vr)} fpm — missed approach / go-around.`,
      metrics: { airport: ap.ident, lowFt: lowAgl, climbFpm: Math.round(vr) },
      key: `det:goaround:${ac.hex}`
    });
  }
}

// ── 8. military / state fleet (from the adsb.lol/adsb.fi feed) ────────────────
function detectMilitary(ac, st) {
  if (st.milDone || !ac.milConfirmed) return;
  st.milDone = true;
  emit(ac, {
    type: 'military', severity: 'warning',
    title: `🪖 Military aircraft — ${label(ac)}`,
    detail: `${label(ac)}${ac.type ? ` (${ac.typeName || ac.type})` : ''} is on the military/state fleet list.`,
    metrics: { hex: ac.hex, type: ac.type || null },
    key: `det:mil:${ac.hex}`
  });
}
