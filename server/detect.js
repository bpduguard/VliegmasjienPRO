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
import { notify, underCooldown } from './notify.js';

const NM_KM = 1.852;
const label = (ac) => ac.flight || ac.registration || ac.hex.toUpperCase();

// ── per-aircraft detector state (pruned when the aircraft expires) ────────────
const dstate = new Map(); // hex -> state bag
export function dropDetectState(hex) { dstate.delete(hex); }

// ── structured feed for the Detections tab ───────────────────────────────────
const recentDetections = [];
const DET_CAP = 400;
export function recentDetectionList(limit = 200) { return recentDetections.slice(0, limit); }

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
  notify({ key, kind: 'detection', title: det.title, message: det.detail, aircraft: ac });
}

// ── entry point, called once per aircraft per poll ───────────────────────────
export function runDetections(ac, cfg, now) {
  const d = cfg.detections;
  if (!d || d.enabled === false) return;
  let st = dstate.get(ac.hex);
  if (!st) { st = { win: [] }; dstate.set(ac.hex, st); }

  if (d.squawk !== false) detectSquawk(ac, st);
  if (d.emergencyDescent !== false) detectEmergencyDescent(ac, st);
  if (d.orbit !== false) detectOrbit(ac, st, now);
  if (d.integrity !== false) detectIntegrity(ac, st, now);
  if (d.rarity !== false) detectRarity(ac, st, cfg);

  // Update the kinematic baseline last, so integrity checks compared against the
  // *previous* fix this poll.
  if (Number.isFinite(ac.lat) && Number.isFinite(ac.lon)) {
    st.lastKin = { ts: now, lat: ac.lat, lon: ac.lon };
  }
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

  const prev = st.lastKin;
  if (prev && Number.isFinite(ac.lat) && Number.isFinite(ac.lon)) {
    const dt = (now - prev.ts) / 1000; // seconds
    if (dt > 1 && dt < 120) {
      const dkm = haversineKm(prev.lat, prev.lon, ac.lat, ac.lon);
      const impliedKt = (dkm / NM_KM) / (dt / 3600);
      // (b) impossible kinematics — a position jump implying > ~Mach 2
      if (dkm > 5 && impliedKt > 1500) {
        emit(ac, {
          type: 'integrity', severity: 'critical',
          title: `🛑 Impossible kinematics — ${label(ac)}`,
          detail: `Position jumped ${dkm.toFixed(0)} km in ${dt.toFixed(0)} s (~${Math.round(impliedKt)} kt, faster than Mach 2) — likely spoofed or corrupt ADS-B.`,
          metrics: { jumpKm: +dkm.toFixed(0), impliedKt: Math.round(impliedKt), dtSec: Math.round(dt) },
          key: `det:jump:${ac.hex}`
        });
        st.gsMiss = 0; st.gsMissActive = false;
      } else if (Number.isFinite(ac.gs) && ac.gs > 40 && dkm > 0.2) {
        // (c) ground-speed vs. position-delta mismatch (needs two consecutive)
        const ratio = impliedKt / ac.gs;
        const mismatch = (ratio > 2.2 || ratio < 0.45) && Math.abs(impliedKt - ac.gs) > 200;
        if (mismatch) {
          st.gsMiss = (st.gsMiss || 0) + 1;
          if (st.gsMiss >= 2 && !st.gsMissActive) {
            st.gsMissActive = true;
            emit(ac, {
              type: 'integrity', severity: 'info',
              title: `⚠️ Speed / position mismatch — ${label(ac)}`,
              detail: `Reported ground speed ${Math.round(ac.gs)} kt but position moved ~${Math.round(impliedKt)} kt over ${dt.toFixed(0)} s.`,
              metrics: { gs: Math.round(ac.gs), impliedKt: Math.round(impliedKt) },
              key: `det:gsmiss:${ac.hex}`
            });
          }
        } else { st.gsMiss = 0; st.gsMissActive = false; }
      }
    }
  }

  // (d) navigation-integrity (NIC) degradation while airborne
  const nic = Number.isFinite(ac.nic) ? ac.nic : null;
  if (nic != null) {
    if (st.nic != null && st.nic >= 7 && nic <= 1 && !ac.onGround) {
      emit(ac, {
        type: 'integrity', severity: 'warning',
        title: `📉 Position-quality drop — ${label(ac)}`,
        detail: `Navigation integrity (NIC) fell from ${st.nic} to ${nic} — possible GPS loss, jamming or spoofing.`,
        metrics: { nicFrom: st.nic, nicTo: nic }, key: `det:nic:${ac.hex}`
      });
    }
    st.nic = nic;
  }
}

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
