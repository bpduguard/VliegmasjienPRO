// Sky Watch: is tonight (and the next few nights) good for stargazing from the
// configured location, and what's worth looking at?
//
// Everything here is computed from first principles — no external astronomy API:
//   • Sun / Moon / planet positions from standard low-precision models
//     (NOAA/Meeus for Sun & Moon, the JPL "approximate positions of the planets"
//     Keplerian elements for the planets). Accuracy is a fraction of a degree —
//     far better than you need to point binoculars or a telescope.
//   • The dark-sky window is real astronomical twilight (Sun 18° below the
//     horizon), not just sunset.
//   • Deep-sky objects have fixed J2000 coordinates; we rotate them into the
//     local sky for the night.
//
// Cloud cover comes from the trusted Open-Meteo forecast (see weather.js); light
// pollution is the Bortle class the user sets in Settings. The observing score
// combines all of it. Object photos aren't hot-linked — the UI draws a clean
// illustration per object type so it works offline and leaks nothing.
import * as satellite from 'satellite.js';
import { getConfig } from './config.js';
import { getForecast } from './weather.js';
import { azToCompass } from './passes.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const OBLIQ = 23.43928 * RAD; // mean obliquity J2000

const norm360 = (d) => ((d % 360) + 360) % 360;
const jdOf = (ms) => ms / 86400000 + 2440587.5;

// -------------------------------------------------------------- Sun
function sunEcliptic(jd) {
  const n = jd - 2451545.0;
  const L = norm360(280.460 + 0.9856474 * n);
  const g = norm360(357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g); // AU
  return { lambda, R };
}
function sunRaDec(jd) {
  const { lambda } = sunEcliptic(jd);
  return {
    ra: Math.atan2(Math.cos(OBLIQ) * Math.sin(lambda), Math.cos(lambda)),
    dec: Math.asin(Math.sin(OBLIQ) * Math.sin(lambda))
  };
}
// Sun altitude (deg) at observer for a moment.
function sunAltDeg(ms, latRad, lonRad) {
  const { ra, dec } = sunRaDec(jdOf(ms));
  const ha = satellite.gstime(new Date(ms)) + lonRad - ra;
  return Math.asin(Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha)) * DEG;
}

// -------------------------------------------------------------- Moon (Meeus, reduced)
// Returns geocentric ecliptic longitude/latitude (deg), distance (km), the
// illuminated fraction (0..1), phase angle and mean elongation D (deg).
function moonState(jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const Lp = norm360(218.3164477 + 481267.88123421 * T);
  const D = norm360(297.8501921 + 445267.1114034 * T);
  const M = norm360(357.5291092 + 35999.0502909 * T);
  const Mp = norm360(134.9633964 + 477198.8675055 * T);
  const F = norm360(93.2720950 + 483202.0175233 * T);
  const d = D * RAD, m = M * RAD, mp = Mp * RAD, f = F * RAD;

  // longitude terms (1e-6 deg)
  const sl =
    6288774 * Math.sin(mp) + 1274027 * Math.sin(2 * d - mp) + 658314 * Math.sin(2 * d) +
    213618 * Math.sin(2 * mp) - 185116 * Math.sin(m) - 114332 * Math.sin(2 * f) +
    58793 * Math.sin(2 * d - 2 * mp) + 57066 * Math.sin(2 * d - m - mp) + 53322 * Math.sin(2 * d + mp) +
    45758 * Math.sin(2 * d - m) - 40923 * Math.sin(m - mp) - 34720 * Math.sin(d) -
    30383 * Math.sin(m + mp) + 15327 * Math.sin(2 * d - 2 * f) - 12528 * Math.sin(mp + 2 * f) +
    10980 * Math.sin(mp - 2 * f);
  // latitude terms (1e-6 deg)
  const sb =
    5128122 * Math.sin(f) + 280602 * Math.sin(mp + f) + 277693 * Math.sin(mp - f) +
    173237 * Math.sin(2 * d - f) + 55413 * Math.sin(2 * d - mp + f) + 46271 * Math.sin(2 * d - mp - f) +
    32573 * Math.sin(2 * d + f) + 17198 * Math.sin(2 * mp + f) + 9266 * Math.sin(2 * d + mp - f) +
    8822 * Math.sin(2 * mp - f) + 8216 * Math.sin(2 * d - m - f) + 4324 * Math.sin(2 * d - 2 * mp - f);
  // distance terms (1e-3 km)
  const sr =
    -20905355 * Math.cos(mp) - 3699111 * Math.cos(2 * d - mp) - 2955968 * Math.cos(2 * d) -
    569925 * Math.cos(2 * mp) + 48888 * Math.cos(m) - 3149 * Math.cos(2 * f) +
    246158 * Math.cos(2 * d - 2 * mp) - 152138 * Math.cos(2 * d - m - mp) - 170733 * Math.cos(2 * d + mp) -
    204586 * Math.cos(2 * d - m) - 129620 * Math.cos(m - mp) + 108743 * Math.cos(d) +
    104755 * Math.cos(m + mp);

  const lambda = Lp + sl / 1e6;
  const beta = sb / 1e6;
  const dist = 385000.56 + sr / 1000;

  // illuminated fraction (Meeus 48.4, approximate phase angle)
  const i = 180 - D - 6.289 * Math.sin(mp) + 2.100 * Math.sin(m) -
    1.274 * Math.sin(2 * d - mp) - 0.658 * Math.sin(2 * d) -
    0.214 * Math.sin(2 * mp) - 0.110 * Math.sin(d);
  const k = (1 + Math.cos(i * RAD)) / 2;
  return { lambda, beta, dist, k, phaseAngle: i, D: norm360(D) };
}
function eclToRaDec(lambdaRad, betaRad) {
  const ra = Math.atan2(
    Math.sin(lambdaRad) * Math.cos(OBLIQ) - Math.tan(betaRad) * Math.sin(OBLIQ),
    Math.cos(lambdaRad));
  const dec = Math.asin(
    Math.sin(betaRad) * Math.cos(OBLIQ) + Math.cos(betaRad) * Math.sin(OBLIQ) * Math.sin(lambdaRad));
  return { ra, dec };
}
function moonRaDec(jd) {
  const m = moonState(jd);
  return eclToRaDec(m.lambda * RAD, m.beta * RAD);
}
const MOON_PHASES = [
  'New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
  'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'
];
function moonPhaseName(D) {
  // D = mean elongation (0 new → 180 full → 360 new)
  return MOON_PHASES[Math.floor((norm360(D) + 22.5) / 45) % 8];
}

// -------------------------------------------------------------- Planets (JPL approx elements)
// a, e, I, L, longPeri (ϖ), longNode (Ω) and their per-century rates. Valid
// 1800–2050 AD (https://ssd.jpl.nasa.gov/planets/approx_pos.html).
const PLANET_ELEMENTS = {
  mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
  venus:   [0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
  earth:   [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0.0, 0.0],
  mars:    [1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
  jupiter: [5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
  saturn:  [9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
  uranus:  [19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.95427630, 0.40805281, 74.01692503, 0.04240589],
  neptune: [30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664]
};
// Heliocentric J2000 ecliptic rectangular coordinates (AU) for a planet.
function heliocentric(name, T) {
  const el = PLANET_ELEMENTS[name];
  const a = el[0] + el[1] * T;
  const e = el[2] + el[3] * T;
  const I = (el[4] + el[5] * T) * RAD;
  const L = el[6] + el[7] * T;
  const wbar = el[8] + el[9] * T;
  const omega = (el[10] + el[11] * T) * RAD;
  const w = (wbar - (el[10] + el[11] * T)) * RAD; // argument of perihelion
  let M = norm360(L - wbar);
  if (M > 180) M -= 360;
  const Mr = M * RAD;
  // Kepler
  let E = Mr + e * Math.sin(Mr);
  for (let it = 0; it < 12; it++) {
    const dE = (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-9) break;
  }
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w);
  const cO = Math.cos(omega), sO = Math.sin(omega);
  const cI = Math.cos(I), sI = Math.sin(I);
  return {
    x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    z: (sw * sI) * xp + (cw * sI) * yp
  };
}
const MAG_C = { // base absolute-ish magnitude constants for apparent-mag formula
  mercury: -0.42, venus: -4.40, mars: -1.52, jupiter: -9.40, saturn: -8.88, uranus: -7.19, neptune: -6.87
};
function planetRaDec(name, jd) {
  const T = (jd - 2451545.0) / 36525.0;
  const p = heliocentric(name, T);
  const earth = heliocentric('earth', T);
  const gx = p.x - earth.x, gy = p.y - earth.y, gz = p.z - earth.z;
  // ecliptic -> equatorial
  const xe = gx;
  const ye = Math.cos(OBLIQ) * gy - Math.sin(OBLIQ) * gz;
  const ze = Math.sin(OBLIQ) * gy + Math.cos(OBLIQ) * gz;
  const ra = Math.atan2(ye, xe);
  const dec = Math.atan2(ze, Math.hypot(xe, ye));
  const delta = Math.hypot(gx, gy, gz);           // planet–Earth (AU)
  const r = Math.hypot(p.x, p.y, p.z);            // planet–Sun (AU)
  const Rr = Math.hypot(earth.x, earth.y, earth.z); // Earth–Sun (AU)
  let cosi = (r * r + delta * delta - Rr * Rr) / (2 * r * delta);
  cosi = Math.max(-1, Math.min(1, cosi));
  const iDeg = Math.acos(cosi) * DEG;
  const c = MAG_C[name];
  let mag = c + 5 * Math.log10(r * delta);
  if (name === 'mercury') mag += 0.0380 * iDeg - 0.000273 * iDeg * iDeg + 2e-6 * iDeg ** 3;
  else if (name === 'venus') mag += 0.0009 * iDeg + 0.000239 * iDeg * iDeg - 6.5e-7 * iDeg ** 3;
  else if (name === 'mars') mag += 0.016 * iDeg;
  else if (name === 'jupiter') mag += 0.005 * iDeg;
  return { ra, dec, mag: Math.round(mag * 10) / 10 };
}

// -------------------------------------------------------------- coordinate transforms
// Equatorial RA/Dec (radians) -> local altitude/azimuth (deg). Azimuth from N, CW.
function altAz(ra, dec, ms, latRad, lonRad) {
  const lst = satellite.gstime(new Date(ms)) + lonRad;
  const ha = lst - ra;
  const sinAlt = Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  let cosAz = (Math.sin(dec) - Math.sin(latRad) * sinAlt) / (Math.cos(latRad) * Math.cos(alt));
  cosAz = Math.max(-1, Math.min(1, cosAz));
  let az = Math.acos(cosAz) * DEG;
  if (Math.sin(ha) > 0) az = 360 - az;
  return { alt: alt * DEG, az: norm360(az) };
}

// -------------------------------------------------------------- deep-sky catalog
// RA in hours, Dec in degrees (J2000). Precession over a couple of decades is
// well under the pointing precision, so we ignore it.
export const SKY_OBJECTS = [
  { id: 'm31', name: 'Andromeda Galaxy (M31)', ra: 0.7123, dec: 41.269, mag: 3.4, type: 'galaxy', con: 'Andromeda', info: 'The nearest large spiral galaxy, 2.5 million light-years away and the most distant thing visible to the unaided eye under a dark sky.' },
  { id: 'dbl', name: 'Double Cluster (NGC 869/884)', ra: 2.333, dec: 57.14, mag: 3.7, type: 'open', con: 'Perseus', info: 'A stunning pair of open star clusters side by side — a showpiece in binoculars and small telescopes.' },
  { id: 'hyades', name: 'Hyades', ra: 4.45, dec: 15.87, mag: 0.5, type: 'open', con: 'Taurus', info: 'The nearest open cluster, forming the V-shaped face of Taurus the Bull around bright orange Aldebaran.' },
  { id: 'm45', name: 'Pleiades (M45)', ra: 3.783, dec: 24.117, mag: 1.6, type: 'open', con: 'Taurus', info: 'The Seven Sisters — a brilliant young star cluster, unmistakable to the naked eye and gorgeous in binoculars.' },
  { id: 'm42', name: 'Orion Nebula (M42)', ra: 5.588, dec: -5.39, mag: 4.0, type: 'nebula', con: 'Orion', info: 'A vast stellar nursery below Orion’s Belt — a glowing cloud where new stars are being born, visible to the naked eye.' },
  { id: 'm44', name: 'Beehive Cluster (M44)', ra: 8.668, dec: 19.98, mag: 3.7, type: 'open', con: 'Cancer', info: 'A large, bright open cluster — a hazy patch to the eye that explodes into dozens of stars in binoculars.' },
  { id: 'm81', name: 'Bode’s Galaxy (M81)', ra: 9.926, dec: 69.07, mag: 6.9, type: 'galaxy', con: 'Ursa Major', info: 'A bright grand-design spiral galaxy near the Big Dipper, 12 million light-years away.' },
  { id: 'm51', name: 'Whirlpool Galaxy (M51)', ra: 13.498, dec: 47.20, mag: 8.4, type: 'galaxy', con: 'Canes Venatici', info: 'A face-on spiral interacting with a smaller companion — the classic “whirlpool” shape in larger scopes.' },
  { id: 'm104', name: 'Sombrero Galaxy (M104)', ra: 12.666, dec: -11.62, mag: 8.0, type: 'galaxy', con: 'Virgo', info: 'An edge-on spiral with a dark dust lane that gives it the look of a wide-brimmed hat.' },
  { id: 'm13', name: 'Hercules Cluster (M13)', ra: 16.695, dec: 36.46, mag: 5.8, type: 'globular', con: 'Hercules', info: 'The finest globular cluster in northern skies — hundreds of thousands of stars in a tight ball.' },
  { id: 'm7', name: 'Ptolemy Cluster (M7)', ra: 17.898, dec: -34.79, mag: 3.3, type: 'open', con: 'Scorpius', info: 'A big, bright open cluster in the tail of Scorpius, set against the rich Milky Way.' },
  { id: 'm8', name: 'Lagoon Nebula (M8)', ra: 18.063, dec: -24.38, mag: 6.0, type: 'nebula', con: 'Sagittarius', info: 'A glowing emission nebula and star cluster toward the heart of the Milky Way.' },
  { id: 'm22', name: 'Sagittarius Cluster (M22)', ra: 18.607, dec: -23.90, mag: 5.1, type: 'globular', con: 'Sagittarius', info: 'One of the brightest globular clusters, low in the south for northern observers but a fine sight.' },
  { id: 'm57', name: 'Ring Nebula (M57)', ra: 18.893, dec: 33.03, mag: 8.8, type: 'planetary', con: 'Lyra', info: 'A dying star’s glowing smoke ring — small but famous, needing a telescope to show its shape.' },
  { id: 'albireo', name: 'Albireo', ra: 19.512, dec: 27.96, mag: 3.1, type: 'double', con: 'Cygnus', info: 'A beautiful colour-contrast double star — golden and blue — at the head of the Northern Cross.' },
  { id: 'm27', name: 'Dumbbell Nebula (M27)', ra: 19.993, dec: 22.72, mag: 7.4, type: 'planetary', con: 'Vulpecula', info: 'The brightest planetary nebula — the glowing shell of a dying Sun-like star, easy in small scopes.' },
  { id: 'm15', name: 'Pegasus Cluster (M15)', ra: 21.500, dec: 12.17, mag: 6.2, type: 'globular', con: 'Pegasus', info: 'A dense, bright globular cluster with an intensely compact core.' }
];

const PLANETS = [
  { id: 'mercury', name: 'Mercury', info: 'The innermost planet, never far from the Sun — catch it low in twilight.' },
  { id: 'venus', name: 'Venus', info: 'The dazzling “morning/evening star”, the brightest planet by far.' },
  { id: 'mars', name: 'Mars', info: 'The Red Planet — a distinctly orange point of light.' },
  { id: 'jupiter', name: 'Jupiter', info: 'The largest planet; its four big moons are visible in binoculars.' },
  { id: 'saturn', name: 'Saturn', info: 'The ringed planet — the rings show in any small telescope.' },
  { id: 'uranus', name: 'Uranus', info: 'A faint blue-green world at the naked-eye limit under dark skies.' },
  { id: 'neptune', name: 'Neptune', info: 'The most distant planet — a tiny blue disc, telescope only.' }
];

// Bortle class -> naked-eye limiting magnitude (zenith, no Moon).
const BORTLE_NELM = { 1: 7.8, 2: 7.3, 3: 6.8, 4: 6.3, 5: 5.9, 6: 5.5, 7: 5.0, 8: 4.3, 9: 4.0 };
const BORTLE_LABEL = {
  1: 'Excellent dark sky', 2: 'Typical truly dark site', 3: 'Rural sky', 4: 'Rural/suburban transition',
  5: 'Suburban sky', 6: 'Bright suburban sky', 7: 'Suburban/urban transition', 8: 'City sky', 9: 'Inner-city sky'
};

// -------------------------------------------------------------- night geometry
// Find the astronomical-night window (Sun < -18°) for the night that *starts* on
// the evening of local day `dayStartMs` (local noon). Also reports the darkest
// Sun depression, so high-latitude "never fully dark" nights are handled.
function darkWindow(noonMs, latRad, lonRad) {
  const step = 5 * 60000;
  const end = noonMs + 24 * 3600000;
  let darkStart = null, darkEnd = null, minAlt = 90;
  let prevDark = false;
  for (let t = noonMs; t <= end; t += step) {
    const alt = sunAltDeg(t, latRad, lonRad);
    if (alt < minAlt) minAlt = alt;
    const dark = alt < -18;
    if (dark && !prevDark && darkStart == null) darkStart = t;
    if (!dark && prevDark && darkStart != null && darkEnd == null) darkEnd = t;
    prevDark = dark;
  }
  if (darkStart != null && darkEnd == null) darkEnd = end;
  return { start: darkStart, end: darkEnd, minSunAlt: minAlt, hasDark: darkStart != null };
}

// Sample the Moon over a window: illumination, whether/how long it's above the
// horizon, and its rise/set within the window.
function moonOverWindow(startMs, endMs) {
  const midJd = jdOf((startMs + endMs) / 2);
  const ms = moonState(midJd);
  return { illum: ms.k, phase: moonPhaseName(ms.D), phaseAngle: ms.D };
}
function bodyTrack(raDecFn, startMs, endMs, latRad, lonRad) {
  const step = 10 * 60000;
  let peak = { alt: -90, az: 0, t: startMs };
  let upMs = 0;
  let prevUp = false, riseT = null, setT = null;
  for (let t = startMs; t <= endMs; t += step) {
    const { ra, dec } = raDecFn(jdOf(t));
    const { alt, az } = altAz(ra, dec, t, latRad, lonRad);
    if (alt > peak.alt) peak = { alt, az, t };
    const up = alt > 0;
    if (up) upMs += step;
    if (up && !prevUp) riseT = t;
    if (!up && prevUp) setT = t;
    prevUp = up;
  }
  return { peak, upFraction: (endMs > startMs) ? upMs / (endMs - startMs) : 0, riseT, setT };
}

function ratingFor(score) {
  if (score >= 80) return 'Excellent';
  if (score >= 62) return 'Good';
  if (score >= 42) return 'Fair';
  if (score >= 22) return 'Poor';
  return 'Bad';
}

// Aggregate the hourly forecast over the dark window [startMs,endMs] in a single
// pass: mean cloud & humidity, the worst precipitation chance / total accumulation
// (does it stay dry?), and the *smallest* temperature−dew-point spread — a small
// spread means dew forms on optics and fog/haze is likely.
function windowWeather(forecast, startMs, endMs) {
  const none = { cloud: null, humidity: null, precipProb: null, precipMm: null, dewSpread: null };
  if (!forecast?.hourly?.length || startMs == null) return none;
  const off = (forecast.utcOffsetSeconds || 0) * 1000;
  let cSum = 0, cN = 0, hSum = 0, hN = 0;
  let maxProb = 0, mmSum = 0, hasPrecip = false, minSpread = null;
  for (const h of forecast.hourly) {
    // h.time is local wall-clock (no zone); treat as UTC then remove the offset.
    const utc = new Date(h.time + 'Z').getTime() - off;
    if (utc < startMs || utc > endMs) continue;
    if (h.cloud != null) { cSum += h.cloud; cN++; }
    if (h.humidity != null) { hSum += h.humidity; hN++; }
    if (h.precipProb != null) { maxProb = Math.max(maxProb, h.precipProb); hasPrecip = true; }
    if (h.precip != null) { mmSum += h.precip; hasPrecip = true; }
    if (h.temp != null && h.dewPoint != null) {
      const spread = h.temp - h.dewPoint;
      if (minSpread == null || spread < minSpread) minSpread = spread;
    }
  }
  return {
    cloud: cN ? Math.round(cSum / cN) : null,
    humidity: hN ? Math.round(hSum / hN) : null,
    precipProb: hasPrecip ? Math.round(maxProb) : null,
    precipMm: hasPrecip ? Math.round(mmSum * 10) / 10 : null,
    dewSpread: minSpread == null ? null : Math.round(minSpread * 10) / 10
  };
}

// Score a single night (0..100) and explain the main limiter.
function scoreNight({ hasDark, minSunAlt, cloud, moonIllum, moonUpFrac, precipProb, precipMm, dewSpread }) {
  if (!hasDark) {
    // no astronomical darkness (high-latitude summer) — cap hard
    return { score: Math.max(5, 30 - Math.round((minSunAlt + 18) * 2)), reasons: ['No astronomical darkness tonight'] };
  }
  const reasons = [];
  let score = 100;
  if (cloud != null) {
    score -= cloud * 0.85; // clouds dominate
    if (cloud >= 70) reasons.push('Mostly cloudy');
    else if (cloud >= 35) reasons.push('Partly cloudy');
    else reasons.push('Mostly clear');
  } else {
    reasons.push('Cloud forecast unavailable');
  }
  // Precipitation ends a session outright — penalise on the worst hourly chance
  // (and any accumulation) during the dark window.
  if (precipProb != null) {
    const wet = Math.max(precipProb, (precipMm || 0) > 0.1 ? 60 : 0);
    score -= Math.min(60, wet * 0.6);
    if (wet >= 50) reasons.push('Precipitation likely');
    else if (wet >= 20) reasons.push('Showers possible');
    else reasons.push('Staying dry');
  }
  // Moon washout: penalty scales with illumination and how long it's up in the dark
  const moonPen = Math.round(moonIllum * moonUpFrac * 45);
  score -= moonPen;
  if (moonIllum > 0.6 && moonUpFrac > 0.3) reasons.push('Bright Moon up');
  else if (moonIllum < 0.15 || moonUpFrac < 0.1) reasons.push('Little/no moonlight');
  // Dew/fog on optics: a small temperature−dew-point spread fogs lenses & mirrors
  // and usually means haze. Not sky-blocking, so a lighter penalty than cloud.
  if (dewSpread != null) {
    if (dewSpread <= 1) { score -= 14; reasons.push('Dew/fog likely'); }
    else if (dewSpread <= 3) { score -= 7; reasons.push('Dew possible'); }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons };
}

// Local noon (UTC ms) for "tonight + offset days", given the location's UTC offset.
function localNoonMs(nowMs, offsetSec, dayOffset) {
  const local = nowMs + offsetSec * 1000;
  const dayStart = Math.floor(local / 86400000) * 86400000; // local midnight
  return dayStart + 12 * 3600000 - offsetSec * 1000 + dayOffset * 86400000;
}

// -------------------------------------------------------------- public: assessment
// Full assessment: N nights of scoring + the best objects for tonight.
export async function skyAssessment(lat, lon, nowMs = Date.now(), nights = 5) {
  const latRad = lat * RAD, lonRad = lon * RAD;
  const cfg = getConfig();
  const bortle = Math.min(9, Math.max(1, Math.round(cfg.skywatch?.bortle ?? 4)));
  let forecast = null;
  try { forecast = await getForecast(lat, lon); } catch { /* clouds optional */ }
  const offsetSec = forecast?.utcOffsetSeconds ?? 0;

  const nightList = [];
  let tonight = null;
  for (let i = 0; i < nights; i++) {
    const noon = localNoonMs(nowMs, offsetSec, i);
    const dw = darkWindow(noon, latRad, lonRad);
    const wStart = dw.start ?? noon + 8 * 3600000;
    const wEnd = dw.end ?? noon + 16 * 3600000;
    const moon = moonOverWindow(wStart, wEnd);
    const moonTrack = bodyTrack(moonRaDec, wStart, wEnd, latRad, lonRad);
    const w = windowWeather(forecast, wStart, wEnd);
    const { score, reasons } = scoreNight({
      hasDark: dw.hasDark, minSunAlt: dw.minSunAlt, cloud: w.cloud,
      moonIllum: moon.illum, moonUpFrac: moonTrack.upFraction,
      precipProb: w.precipProb, precipMm: w.precipMm, dewSpread: w.dewSpread
    });
    // "Dry" once astronomical night exists and precipitation is unlikely/none.
    const dry = w.precipProb == null ? null
      : (w.precipProb < 20 && (w.precipMm || 0) <= 0.1);
    const night = {
      dayOffset: i,
      dateMs: noon,
      darkStart: dw.start, darkEnd: dw.end, hasDark: dw.hasDark,
      moonIllum: Math.round(moon.illum * 100), moonPhase: moon.phase,
      moonUpFrac: Math.round(moonTrack.upFraction * 100),
      cloud: w.cloud, humidity: w.humidity,
      precipProb: w.precipProb, precipMm: w.precipMm, dewSpread: w.dewSpread, dry,
      score, rating: ratingFor(score), reasons
    };
    nightList.push(night);
    if (i === 0) tonight = { ...night, wStart, wEnd };
  }

  const nelm = Math.max(2, BORTLE_NELM[bortle] - (tonight.moonIllum / 100) * (tonight.moonUpFrac / 100) * 2.2);
  const objects = tonight
    ? bestObjects(tonight.wStart, tonight.wEnd, latRad, lonRad, nelm)
    : [];

  return {
    bortle, bortleLabel: BORTLE_LABEL[bortle], nelm: Math.round(nelm * 10) / 10,
    utcOffsetSeconds: offsetSec,
    nights: nightList,
    objects
  };
}

// Exposed for unit tests (astronomy correctness).
export const _internals = { sunRaDec, moonState, moonRaDec, planetRaDec, altAz, darkWindow, jdOf, DEG, RAD };

// Which catalogue objects & planets are well-placed during the dark window.
function bestObjects(wStart, wEnd, latRad, lonRad, nelm) {
  const out = [];
  const instrument = (mag) => (mag <= nelm ? 'Naked eye' : mag <= nelm + 4.2 ? 'Binoculars' : 'Telescope');

  const consider = (base, raDecFn, mag) => {
    const tr = bodyTrack(raDecFn, wStart, wEnd, latRad, lonRad);
    if (tr.peak.alt < 12) return; // never usefully clear of the horizon
    // rank: prefer high altitude, bright objects; small penalty for faintness vs limit
    const altScore = Math.min(1, tr.peak.alt / 60);
    const magScore = Math.max(0, Math.min(1, (nelm + 5 - mag) / 10));
    out.push({
      ...base, mag,
      peakAlt: Math.round(tr.peak.alt),
      peakAz: Math.round(tr.peak.az),
      dir: azToCompass(tr.peak.az),
      bestTimeMs: tr.peak.t, // raw UTC ms; client formats in the receiver's timezone
      instrument: instrument(mag),
      _rank: altScore * 0.6 + magScore * 0.4
    });
  };

  // Moon as an object
  {
    const ms = moonState(jdOf((wStart + wEnd) / 2));
    consider(
      { id: 'moon', name: 'The Moon', type: 'moon', con: '—',
        info: `${moonPhaseName(ms.D)}, ${Math.round(ms.k * 100)}% illuminated. The finest target in binoculars — scan the terminator for craters and mountains.`,
        moonIllum: Math.round(ms.k * 100), moonPhase: moonPhaseName(ms.D) },
      moonRaDec, -12);
  }
  for (const p of PLANETS) {
    consider({ id: p.id, name: p.name, type: 'planet', con: 'Solar System', info: p.info },
      (jd) => planetRaDec(p.id, jd), planetRaDec(p.id, jdOf((wStart + wEnd) / 2)).mag);
  }
  for (const o of SKY_OBJECTS) {
    const raRad = o.ra * 15 * RAD, decRad = o.dec * RAD;
    consider({ id: o.id, name: o.name, type: o.type, con: o.con, info: o.info },
      () => ({ ra: raRad, dec: decRad }), o.mag);
  }
  out.sort((a, b) => b._rank - a._rank);
  for (const o of out) delete o._rank;
  return out.slice(0, 12);
}
