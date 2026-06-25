// Visible satellite-pass prediction for the Aerospace notifications.
//
// A pass is "visible" from the ground when three things line up:
//   1. the satellite rises high enough above the horizon (we use >= 10°),
//   2. the sky at the observer is dark enough (sun below ~civil dusk), and
//   3. the satellite itself is still in sunlight (not in Earth's shadow) — that's
//      what makes it a bright moving "star".
// We compute look angles with SGP4 (satellite.js) and a low-precision solar
// position model (good to well under a degree — ample for this).
import * as satellite from 'satellite.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const EARTH_R = 6378.137; // km, equatorial

// Low-precision geocentric solar position (NOAA/Meeus). Returns equatorial
// right ascension/declination and a scaled ECI vector (km) — close enough to the
// TEME frame satellite.js uses for shadow + elevation geometry.
function sunPosition(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0; // days since J2000.0
  const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;        // mean longitude
  const g = (((357.528 + 0.9856003 * n) % 360 + 360) % 360) * RAD; // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = 23.439 * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const distKm = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * 149597870.7;
  return { ra, dec, eci: { x: Math.cos(dec) * Math.cos(ra) * distKm, y: Math.cos(dec) * Math.sin(ra) * distKm, z: Math.sin(dec) * distKm } };
}

// Sun elevation (deg) at an observer — for the darkness test.
function sunElevationDeg(date, latRad, lonRad) {
  const { ra, dec } = sunPosition(date);
  const ha = satellite.gstime(date) + lonRad - ra; // local hour angle
  const s = Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, s))) * DEG;
}

// Is the satellite outside Earth's cylindrical umbra (i.e. sunlit)?
function satSunlit(satEci, date) {
  const sun = sunPosition(date).eci;
  const sMag = Math.hypot(sun.x, sun.y, sun.z);
  const sx = sun.x / sMag, sy = sun.y / sMag, sz = sun.z / sMag;
  const d = satEci.x * sx + satEci.y * sy + satEci.z * sz; // projection onto sun direction
  if (d > 0) return true; // sun-facing hemisphere → lit
  const px = satEci.x - d * sx, py = satEci.y - d * sy, pz = satEci.z - d * sz;
  return Math.hypot(px, py, pz) > EARTH_R; // outside the shadow cylinder → lit
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function azToCompass(az) {
  return COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}

const MIN_ELEV = 10;       // ignore passes that never clear obstructions
const DARK_SUN_ELEV = -6;  // observer must be at/after civil dusk

// Predict visible passes of one satellite over an observer in [fromMs, toMs].
// observer: { latDeg, lonDeg, heightKm }. Returns the *visible portion* of each
// qualifying pass with appearance/disappearance times, directions and peak.
export function predictVisiblePasses(satrec, observer, fromMs, toMs, stepSec = 30) {
  const obsGd = { latitude: observer.latDeg * RAD, longitude: observer.lonDeg * RAD, height: observer.heightKm || 0 };
  const passes = [];
  let cur = null;
  for (let t = fromMs; t <= toMs; t += stepSec * 1000) {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) { if (cur) { passes.push(cur); cur = null; } continue; }
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    const look = satellite.ecfToLookAngles(obsGd, ecf);
    const elDeg = look.elevation * DEG;
    if (elDeg > 0) {
      if (!cur) cur = [];
      const visible = elDeg >= MIN_ELEV
        && sunElevationDeg(date, obsGd.latitude, obsGd.longitude) < DARK_SUN_ELEV
        && satSunlit(pv.position, date);
      cur.push({ t, elDeg, azDeg: (look.azimuth * DEG + 360) % 360, visible });
    } else if (cur) {
      passes.push(cur); cur = null;
    }
  }
  if (cur) passes.push(cur);

  const out = [];
  for (const samples of passes) {
    const vis = samples.filter((s) => s.visible);
    if (!vis.length) continue;
    const start = vis[0], end = vis[vis.length - 1];
    let peak = vis[0];
    for (const s of vis) if (s.elDeg > peak.elDeg) peak = s;
    out.push({
      startMs: start.t, endMs: end.t,
      durationSec: Math.round((end.t - start.t) / 1000),
      riseAz: Math.round(start.azDeg), setAz: Math.round(end.azDeg), peakAz: Math.round(peak.azDeg),
      riseDir: azToCompass(start.azDeg), setDir: azToCompass(end.azDeg), peakDir: azToCompass(peak.azDeg),
      maxElev: Math.round(peak.elDeg)
    });
  }
  return out;
}
