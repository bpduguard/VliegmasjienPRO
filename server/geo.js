// Geographic helpers (distances in km, speeds in knots, bearings in degrees).

const R = 6371; // earth radius km
const KNOT_KMH = 1.852;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Smallest absolute difference between two bearings (degrees), 0..180.
export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Signed cross-track distance (km) of a point from the great circle through
// p1→p2 — i.e. how far the point sits off the direct route corridor.
export function crossTrackKm(lat, lon, lat1, lon1, lat2, lon2) {
  const d13 = haversineKm(lat1, lon1, lat, lon) / R; // angular distance p1→p3
  const t13 = (bearingDeg(lat1, lon1, lat, lon) * Math.PI) / 180;
  const t12 = (bearingDeg(lat1, lon1, lat2, lon2) * Math.PI) / 180;
  return Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(t13 - t12)))) * R;
}

// Along-track distance (km) from p1 to the point's projection onto p1→p2.
// Negative = projection lies "behind" p1; > route length = beyond p2.
export function alongTrackKm(lat, lon, lat1, lon1, lat2, lon2) {
  const d13 = haversineKm(lat1, lon1, lat, lon) / R;
  const xt = crossTrackKm(lat, lon, lat1, lon1, lat2, lon2) / R;
  const sign = angleDiff(bearingDeg(lat1, lon1, lat, lon), bearingDeg(lat1, lon1, lat2, lon2)) > 90 ? -1 : 1;
  return sign * Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt)))) * R;
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const f1 = (lat1 * Math.PI) / 180;
  const f2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Time in seconds until an aircraft at (lat,lon) moving on `track` degrees at
 * `gsKnots` ground speed enters a circle (centerLat, centerLon, radiusKm).
 * Returns null if it never enters on its current heading, 0 if already inside.
 * Uses a flat-earth approximation, fine for zone radii of tens of km.
 */
export function secondsToZoneEntry(lat, lon, track, gsKnots, centerLat, centerLon, radiusKm) {
  if (gsKnots == null || track == null || gsKnots <= 0) return null;
  const kmPerDegLat = 110.574;
  const kmPerDegLon = 111.32 * Math.cos((centerLat * Math.PI) / 180);
  // Position relative to circle center, in km.
  const px = (lon - centerLon) * kmPerDegLon;
  const py = (lat - centerLat) * kmPerDegLat;
  if (px * px + py * py <= radiusKm * radiusKm) return 0;
  const speedKms = (gsKnots * KNOT_KMH) / 3600;
  const tr = (track * Math.PI) / 180;
  const vx = Math.sin(tr) * speedKms; // east
  const vy = Math.cos(tr) * speedKms; // north
  // Solve |p + v t| = r  =>  (v·v)t² + 2(p·v)t + (p·p − r²) = 0
  const a = vx * vx + vy * vy;
  const b = 2 * (px * vx + py * vy);
  const c = px * px + py * py - radiusKm * radiusKm;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 ? t : null;
}

/** ETA in seconds to a point, assuming direct track at current ground speed. */
export function etaSeconds(lat, lon, gsKnots, destLat, destLon) {
  if (gsKnots == null || gsKnots <= 5) return null;
  const distKm = haversineKm(lat, lon, destLat, destLon);
  return (distKm / (gsKnots * KNOT_KMH)) * 3600;
}
