// Airport webcams layer. Two sources, merged and clustered per location:
//   1. A built-in / user-curated list (config.webcams.custom) — works with no key.
//   2. The Windy Webcams API (config.webcams.windyKey) — dynamic discovery of
//      embeddable live webcams near the visible airports.
// The client embeds each feed's `embed` URL in an iframe (with a switcher when a
// location has several). Nothing here needs the API key except the Windy query;
// embed URLs are public.
import { getConfig } from './config.js';
import { airportsNear } from './db.js';
import { haversineKm } from './geo.js';

// Built-in feeds ship empty on purpose: a webcam only plays inline if its source
// allows embedding, and hard-coding feeds that later break (or don't allow it)
// just produces the confusing "clicking play opens a new tab" behaviour. Add your
// own via Settings → Airport webcams (config.webcams.custom), and/or a Windy key.
export const BUILTIN_WEBCAMS = [];

// Only these hosts are allowed by the app's Content-Security-Policy frame-src, so
// only these can actually play inline; anything else the browser will block.
export function isEmbeddableHost(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h === 'youtube.com' || h === 'youtube-nocookie.com' || h === 'm.youtube.com' || h === 'windy.com' || h.endsWith('.windy.com');
  } catch { return false; }
}

// Turn common YouTube share links into a proper embeddable iframe URL (so a
// pasted watch/short/live link plays inline instead of linking out), and make
// YouTube embeds start muted-autoplay. Non-YouTube URLs pass through untouched.
export function normalizeEmbed(raw) {
  const url = String(raw || '').trim();
  if (!url) return url;
  const ytParams = (embedUrl) => {
    try {
      const u = new URL(embedUrl);
      for (const [k, v] of [['autoplay', '1'], ['mute', '1'], ['playsinline', '1']]) {
        if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      }
      return u.toString();
    } catch { return embedUrl; }
  };
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return id ? ytParams(`https://www.youtube.com/embed/${id}`) : url;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return ytParams(`https://www.youtube.com/embed/${u.searchParams.get('v')}`);
      if (u.pathname.startsWith('/live/')) return ytParams(`https://www.youtube.com/embed/${u.pathname.split('/')[2]}`);
      if (u.pathname.startsWith('/embed/')) return ytParams(url);
    }
    return url;
  } catch { return url; }
}

const WINDY_BASE = process.env.WINDY_WEBCAMS_BASE || 'https://api.windy.com/webcams/api/v3';
const CLUSTER_KM = 2.5;   // feeds within this radius = one map marker (one airport)
const CACHE_TTL = 10 * 60000;
const windyCache = new Map(); // rounded "lat,lon,r" -> { ts, list }

async function fetchWindy(lat, lon, radiusKm) {
  const key = getConfig().webcams?.windyKey;
  if (!key) return [];
  const ck = `${lat.toFixed(2)},${lon.toFixed(2)},${Math.round(radiusKm)}`;
  const hit = windyCache.get(ck);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.list;
  const url = `${WINDY_BASE}/webcams?nearby=${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(radiusKm)}`
    + '&include=images,location,player,urls&limit=50';
  let list = [];
  try {
    const res = await fetch(url, { headers: { 'x-windy-api-key': key }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.warn('[webcams] Windy HTTP', res.status); return []; }
    const data = await res.json();
    const raw = data.webcams || data.result?.webcams || [];
    list = raw.map((w) => {
      const id = w.webcamId ?? w.id;
      const loc = w.location || {};
      const lat2 = loc.latitude ?? loc.lat, lon2 = loc.longitude ?? loc.lng;
      const image = w.images?.current?.preview || w.images?.current?.thumbnail || w.image?.current?.preview || null;
      const embed = w.player?.live?.embed || w.player?.day?.embed
        || (id != null ? `https://webcams.windy.com/webcams/public/embed/player/${id}/live` : null);
      if (lat2 == null || lon2 == null || !embed) return null;
      return { title: w.title || loc.city || 'Webcam', lat: lat2, lon: lon2, image, embed, source: 'windy' };
    }).filter(Boolean);
    windyCache.set(ck, { ts: Date.now(), list });
    if (windyCache.size > 200) windyCache.clear();
  } catch (e) { console.warn('[webcams] Windy error:', e.message); }
  return list;
}

// Webcams within the given map bounds, clustered per location and labelled by the
// nearest airport. Returns { hasKey, airports:[{ icao, name, lat, lon, feeds:[{title,embed,image,source}] }] }.
export async function webcamsInBounds({ n, s, e, w }) {
  const cfg = getConfig();
  const inB = (lat, lon) => lat <= n && lat >= s && lon >= w && lon <= e;
  const points = [];

  // 1) built-in + user custom
  for (const a of [...BUILTIN_WEBCAMS, ...(cfg.webcams?.custom || [])]) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !inB(a.lat, a.lon)) continue;
    for (const f of a.feeds || []) {
      if (!f?.embed) continue;
      points.push({ title: f.title || a.name, lat: a.lat, lon: a.lon, embed: normalizeEmbed(f.embed), image: f.image || null, source: 'builtin', airport: { icao: a.icao || null, name: a.name || null } });
    }
  }

  // 2) Windy (query the centre with a radius covering the view)
  const cLat = (n + s) / 2, cLon = (e + w) / 2;
  const radius = Math.min(250, Math.max(20, haversineKm(cLat, cLon, n, e) || 50));
  for (const wc of await fetchWindy(cLat, cLon, radius)) if (inB(wc.lat, wc.lon)) points.push({ ...wc, embed: normalizeEmbed(wc.embed) });

  // cluster feeds that share a location into one marker (one airport)
  const clusters = [];
  for (const p of points) {
    let c = clusters.find((cl) => haversineKm(cl.lat, cl.lon, p.lat, p.lon) < CLUSTER_KM);
    if (!c) { c = { lat: p.lat, lon: p.lon, airport: p.airport || null, feeds: [] }; clusters.push(c); }
    if (!c.airport?.name && p.airport?.name) c.airport = p.airport;
    c.feeds.push({ title: p.title, embed: p.embed, image: p.image || null, source: p.source });
  }

  // label unlabelled clusters by their nearest airport (best-effort; needs the
  // frequency database — otherwise the cluster keeps a generic label)
  for (const c of clusters) {
    if (c.airport?.name) continue;
    try {
      let best = null, bkm = Infinity;
      for (const a of airportsNear(c.lat, c.lon, 15)) {
        const dk = haversineKm(c.lat, c.lon, a.lat, a.lon);
        if (dk < bkm) { bkm = dk; best = a; }
      }
      if (best) c.airport = { icao: best.ident, name: best.name };
    } catch { /* freq db may be empty */ }
  }

  const airports = clusters.map((c) => ({
    icao: c.airport?.icao || null,
    name: c.airport?.name || 'Webcam location',
    lat: c.lat, lon: c.lon,
    feeds: c.feeds
  }));
  return { hasKey: !!cfg.webcams?.windyKey, airports };
}
