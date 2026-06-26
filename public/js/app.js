/* VliegmasjienPRO frontend */
'use strict';

// ----------------------------------------------------------------- state
const state = {
  aircraft: new Map(), // hex -> aircraft
  receiver: null,
  selected: null,
  follow: false,
  autoFollow: false,       // auto-follow the newest aircraft
  autoFollowHex: null,     // hex currently auto-followed
  autoFollowSince: 0,      // when we started following it (for the 10s minimum)
  filter: 'all',
  airlineQuery: '',
  showLabels: true,
  zones: [],
  config: null,
  weatherOn: false,
  freqOn: false,
  units: 'aviation' // 'aviation' (ft/kt) or 'metric' (m, km/h); distance is always km
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Unit labels for column headers etc.
const unitLabels = () =>
  state.units === 'metric' ? { alt: 'Alt m', spd: 'Spd km/h', vr: 'V/S m/s' } : { alt: 'Alt ft', spd: 'Spd kt', vr: 'V/S fpm' };

const fmt = {
  // altitude: input is feet (the ADS-B native unit)
  alt: (v) => {
    if (v == null) return '—';
    if (v === 0) return 'ground';
    return state.units === 'metric'
      ? `${Math.round(v * 0.3048).toLocaleString()} m`
      : `${v.toLocaleString()} ft`;
  },
  // raw numeric (for table cells)
  altN: (v) => (v == null ? '—' : v === 0 ? 'gnd' : (state.units === 'metric' ? Math.round(v * 0.3048) : v).toLocaleString()),
  // ground speed: input is knots
  spd: (v) => {
    if (v == null) return '—';
    return state.units === 'metric' ? `${Math.round(v * 1.852)} km/h` : `${Math.round(v)} kt (${Math.round(v * 1.852)} km/h)`;
  },
  spdN: (v) => (v == null ? '—' : Math.round(state.units === 'metric' ? v * 1.852 : v)),
  // vertical rate: input is feet/min
  vr: (v) => {
    if (v == null) return '—';
    return state.units === 'metric'
      ? `${v > 0 ? '+' : ''}${(v * 0.00508).toFixed(1)} m/s`
      : `${v > 0 ? '+' : ''}${v} fpm`;
  },
  vrN: (v) => {
    if (v == null) return '—';
    const val = state.units === 'metric' ? (v * 0.00508).toFixed(1) : v;
    return (v > 0 ? '↑' : v < 0 ? '↓' : '') + Math.abs(val);
  },
  dist: (v) => (v == null ? '—' : `${v} km`),
  dur: (s) => {
    if (s == null) return '—';
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  },
  time: (ts) => new Date(ts).toLocaleTimeString(),
  dateTime: (ts) => new Date(ts).toLocaleString()
};

// ----------------------------------------------------------------- tabs
$$('#tabs button').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('#tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'map') setTimeout(() => { map.invalidateSize(); renderAircraft(); }, 50);
    if (btn.dataset.tab === 'stats') loadStats();
    if (btn.dataset.tab === 'watchlist') loadWatchlist();
    if (btn.dataset.tab === 'spotted') loadSpotted();
    if (btn.dataset.tab === 'zones') loadZones();
    if (btn.dataset.tab === 'alerts') loadAlerts();
    if (btn.dataset.tab === 'settings') loadSettings();
  })
);
// Catch up the map view when the page becomes visible again after being hidden.
document.addEventListener('visibilitychange', () => { if (mapVisible()) renderAircraft(); });

// ----------------------------------------------------------------- map
const darkTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  maxZoom: 19
});
const lightTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap',
  maxZoom: 19
});
const map = L.map('map', { center: [52.3, 4.9], zoom: 8, layers: [darkTiles], zoomControl: false });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.layers({ Dark: darkTiles, Light: lightTiles }, {}, { position: 'bottomright' }).addTo(map);

let receiverMarker = null;
let centeredOnce = false;

// weather overlays
const weatherLayers = [];
async function enableWeather() {
  try {
    const rv = await (await fetch('/api/weather/rainviewer')).json();
    const frame = rv?.radar?.past?.slice(-1)[0];
    if (frame) {
      const radar = L.tileLayer(`${rv.host}${frame.path}/256/{z}/{x}/{y}/4/1_1.png`, {
        opacity: 0.7, attribution: 'Radar &copy; RainViewer'
      }).addTo(map);
      weatherLayers.push(radar);
    }
  } catch (e) { console.warn('rainviewer failed', e); }
  if (state.config?.weather?.hasOwmKey) {
    const clouds = L.tileLayer('/api/weather/owm/clouds_new/{z}/{x}/{y}', { opacity: 0.5 }).addTo(map);
    weatherLayers.push(clouds);
  }
}
function disableWeather() {
  weatherLayers.forEach((l) => map.removeLayer(l));
  weatherLayers.length = 0;
}
$('#weather-toggle').addEventListener('change', (e) => {
  state.weatherOn = e.target.checked;
  if (state.weatherOn) enableWeather(); else disableWeather();
});
// refresh radar frame every 5 min while enabled
setInterval(() => { if (state.weatherOn) { disableWeather(); enableWeather(); } }, 300000);

$('#labels-toggle').addEventListener('change', (e) => {
  state.showLabels = e.target.checked;
  renderAircraft();
});

// layers dropdown (Weather / Frequencies / Labels)
function refreshLayersBtn() {
  const anyOn = $('#weather-toggle').checked || $('#freq-toggle').checked || $('#rings-toggle').checked
    || $('#range-toggle').checked || $('#arrivals-toggle').checked || $('#space-toggle').checked
    || $('#heatmap-toggle').checked || $('#airspace-toggle').checked || $('#metar-toggle').checked;
  $('#layers-btn').classList.toggle('has-active', anyOn);
}
$('#layers-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#layers-menu').classList.toggle('hidden');
});
// close the menu when clicking elsewhere
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu')) $$('.menu-pop').forEach((m) => m.classList.add('hidden'));
});
['#weather-toggle', '#freq-toggle'].forEach((sel) => $(sel).addEventListener('change', refreshLayersBtn));

// legend
$('#legend-toggle').addEventListener('click', () => {
  const body = $('#legend-body');
  body.classList.toggle('hidden');
  if (!body.dataset.filled) {
    $$('#legend-body .leg-ico').forEach((el) => {
      const kind = el.dataset.kind;
      const color = kind === 'military' ? CLASS_COLORS.military : '#cbd5e1';
      el.innerHTML = planeSvg(kind, color, 0, kind === 'ground');
    });
    body.dataset.filled = '1';
  }
});

// zone circles on map
let zoneCircles = [];
function drawZones() {
  zoneCircles.forEach((c) => map.removeLayer(c));
  zoneCircles = state.zones.map((z) =>
    L.circle([z.lat, z.lon], {
      radius: z.radiusKm * 1000,
      color: z.color || '#3b82f6',
      weight: 1.5,
      fillOpacity: 0.06,
      dashArray: '6 4'
    })
      .bindTooltip(`${z.name} (${z.radiusKm} km)`, { sticky: true })
      .addTo(map)
  );
}

// ----------------------------------------------------------------- distance rings
const RING_KM = [10, 25, 50, 100, 200, 400];
const ringsLayer = L.layerGroup();

function drawRings() {
  ringsLayer.clearLayers();
  const r = state.receiver;
  if (!r || r.lat == null) return;
  for (const km of RING_KM) {
    L.circle([r.lat, r.lon], {
      radius: km * 1000,
      color: '#64748b',
      weight: 1,
      opacity: 0.55,
      fill: false,
      dashArray: '3 5',
      interactive: false
    }).addTo(ringsLayer);
    // km label at the top of each ring
    const labelLat = r.lat + km / 111.32;
    L.marker([labelLat, r.lon], {
      interactive: false,
      icon: L.divIcon({ className: 'ring-label', html: `${km} km`, iconSize: [40, 14], iconAnchor: [20, 7] })
    }).addTo(ringsLayer);
  }
}

$('#rings-toggle').addEventListener('change', (e) => {
  state.ringsOn = e.target.checked;
  if (state.ringsOn) {
    if (state.receiver?.lat == null) {
      e.target.checked = false; state.ringsOn = false;
      toast({ kind: 'test', title: 'No receiver location', message: 'Set the receiver lat/lon in Settings to use distance rings.' });
      return;
    }
    drawRings();
    ringsLayer.addTo(map);
  } else {
    map.removeLayer(ringsLayer);
  }
  refreshLayersBtn();
});

// ----------------------------------------------------------------- range outline
// The actual reception coverage (farthest aircraft seen per bearing).
const rangeLayer = L.layerGroup();
let rangePoly = null;

async function drawRange() {
  try {
    const data = await (await fetch('/api/range')).json();
    const pts = (data.points || []).map((p) => [p.lat, p.lon]);
    rangeLayer.clearLayers();
    rangePoly = null;
    if (pts.length < 3) {
      if (state.rangeOn) toast({ kind: 'test', title: 'Range outline still building', message: 'Not enough coverage recorded yet — let the receiver run a while.' });
      return;
    }
    rangePoly = L.polygon(pts, {
      color: '#22d3ee', weight: 2, opacity: 0.9, fillColor: '#22d3ee', fillOpacity: 0.05, interactive: true
    }).bindTooltip(`Reception range · max ${data.meta?.maxKm ?? '?'} km · ${data.meta?.sectors ?? 0} sectors`, { sticky: true });
    rangePoly.addTo(rangeLayer);
  } catch { /* ignore */ }
}

$('#range-toggle').addEventListener('change', (e) => {
  state.rangeOn = e.target.checked;
  if (state.rangeOn) {
    rangeLayer.addTo(map);
    drawRange();
  } else {
    map.removeLayer(rangeLayer);
  }
  refreshLayersBtn();
});
// refresh the outline periodically while shown (it grows over time)
setInterval(() => { if (state.rangeOn) drawRange(); }, 60000);

// ----------------------------------------------------------------- arrivals layer
// Destination airports of currently-tracked aircraft, each marker carrying a
// table of inbound flights (arrival time, time-to-go, origin, type/operator).
const arrivalsLayer = L.layerGroup();
let arrivalsTimer = null;

function arrivalsPopupHtml(ap, arrivals) {
  const rows = arrivals.map((a) => {
    const op = [a.operator, a.type].filter(Boolean).join(' · ');
    const from = a.origin ? (a.origin.iata || a.origin.icao || a.origin.name || '?') : '?';
    const fromTitle = a.origin ? [a.origin.name, a.origin.country].filter(Boolean).join(', ') : 'unknown origin';
    return `<tr data-hex="${a.hex}">
      <td><b>${a.callsign}</b>${op ? `<br><span class="muted">${op}</span>` : ''}</td>
      <td title="${fromTitle}">${from}</td>
      <td>${fmt.time(a.arrivalMs)}</td>
      <td>${a.etaSec != null ? fmt.dur(a.etaSec) : '—'}</td>
    </tr>`;
  }).join('');
  const title = [ap.iata || ap.icao, ap.name].filter(Boolean).join(' · ') || 'Airport';
  return `<div class="arr-popup">
    <div class="arr-title">🛬 ${title}${ap.country ? ` <span class="muted">${ap.country}</span>` : ''}</div>
    <table class="arr-table">
      <thead><tr><th>Flight</th><th>From</th><th>Arr</th><th>In</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

async function drawArrivals() {
  try {
    const data = await (await fetch('/api/arrivals')).json();
    arrivalsLayer.clearLayers();
    for (const grp of data.airports || []) {
      const ap = grp.airport;
      if (ap.lat == null || ap.lon == null) continue;
      const code = ap.iata || ap.icao || '✈';
      const icon = L.divIcon({
        className: 'airport-icon',
        html: `<div class="airport-pin"><span class="airport-code">🛬 ${code}</span><span class="airport-badge">${grp.arrivals.length}</span></div>`,
        iconSize: [60, 22], iconAnchor: [30, 11]
      });
      const m = L.marker([ap.lat, ap.lon], { icon, zIndexOffset: 1000 }).addTo(arrivalsLayer);
      m.bindPopup(arrivalsPopupHtml(ap, grp.arrivals), { maxWidth: 360, className: 'arr-leaflet-popup' });
      // clicking a row selects that aircraft (if it's live)
      m.on('popupopen', (e) => {
        e.popup.getElement()?.querySelectorAll('.arr-table tr[data-hex]').forEach((tr) =>
          tr.addEventListener('click', () => { if (state.aircraft.has(tr.dataset.hex)) selectAircraft(tr.dataset.hex, true); }));
      });
    }
  } catch { /* ignore */ }
}

$('#arrivals-toggle').addEventListener('change', (e) => {
  state.arrivalsOn = e.target.checked;
  if (state.arrivalsOn) {
    arrivalsLayer.addTo(map);
    drawArrivals();
    // refresh while shown, but don't yank a popup the user is reading
    arrivalsTimer = setInterval(() => {
      const open = arrivalsLayer.getLayers().some((l) => l.isPopupOpen && l.isPopupOpen());
      if (!open) drawArrivals();
    }, 15000);
  } else {
    map.removeLayer(arrivalsLayer);
    arrivalsLayer.clearLayers();
    if (arrivalsTimer) { clearInterval(arrivalsTimer); arrivalsTimer = null; }
  }
  refreshLayersBtn();
});

// ----------------------------------------------------------------- aerospace layer
// ISS + Hubble, propagated from CelesTrak TLEs with satellite.js (SGP4) in the
// browser: live markers + ~95-min ground tracks. (Only Earth-orbiting craft with
// a meaningful ground track are tracked here.)
const SPACE_DEFS = [
  { key: 'iss', name: 'ISS (ZARYA)', icon: '🛰', color: '#34d399' },
  { key: 'hst', name: 'Hubble Space Telescope', icon: '🔭', color: '#f472b6' }
];
const spaceLayer = L.layerGroup();        // satellite markers
const spaceTrackLayer = L.layerGroup();   // ground-track polylines
let spaceObjs = [];                        // [{ key, name, icon, color, satrec }]
const spaceMarkers = new Map();            // key -> L.marker
let spaceTimer = null;
let spaceTick = 0;
let spaceMeta = null;                       // { fetchedAt, source }

function satGeo(satrec, date) {
  let pv;
  try { pv = satellite.propagate(satrec, date); } catch { return null; }
  if (!pv || !pv.position) return null;
  const g = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
  const v = pv.velocity;
  return {
    lat: satellite.degreesLat(g.latitude),
    lon: satellite.degreesLong(g.longitude),
    altKm: g.height,
    speedKms: v ? Math.hypot(v.x, v.y, v.z) : null
  };
}

// Ground track from ~35 min ago to ~60 min ahead, split at the ±180° meridian
// so the line doesn't smear across the whole map.
function spaceGroundTrack(satrec) {
  const now = Date.now();
  const segs = []; let seg = []; let prevLon = null;
  for (let s = -35 * 60; s <= 60 * 60; s += 30) {
    const p = satGeo(satrec, new Date(now + s * 1000));
    if (!p) { if (seg.length > 1) segs.push(seg); seg = []; prevLon = null; continue; }
    if (prevLon != null && Math.abs(p.lon - prevLon) > 180) { if (seg.length > 1) segs.push(seg); seg = []; }
    seg.push([p.lat, p.lon]); prevLon = p.lon;
  }
  if (seg.length > 1) segs.push(seg);
  return segs;
}

function updateSpace() {
  if (!state.spaceOn || !spaceObjs.length) return;
  if (!mapVisible()) return; // skip propagation while the map isn't on screen
  const now = new Date();
  for (const o of spaceObjs) {
    const p = satGeo(o.satrec, now);
    if (!p) continue;
    let m = spaceMarkers.get(o.key);
    if (!m) {
      const icon = L.divIcon({
        className: 'sat-icon',
        html: `<div class="sat-pin" style="border-color:${o.color}">${o.icon}<span class="sat-code">${o.key.toUpperCase()}</span></div>`,
        iconSize: [56, 22], iconAnchor: [28, 11]
      });
      m = L.marker([p.lat, p.lon], { icon, zIndexOffset: 2000 }).addTo(spaceLayer);
      spaceMarkers.set(o.key, m);
    } else {
      m.setLatLng([p.lat, p.lon]);
    }
    const age = spaceMeta?.fetchedAt ? fmt.time(spaceMeta.fetchedAt) : '?';
    m.bindPopup(`<div class="arr-title">${o.icon} ${o.name}</div>
      <table class="arr-table"><tbody>
        <tr><td>Latitude</td><td>${p.lat.toFixed(2)}°</td></tr>
        <tr><td>Longitude</td><td>${p.lon.toFixed(2)}°</td></tr>
        <tr><td>Altitude</td><td>${Math.round(p.altKm).toLocaleString()} km</td></tr>
        <tr><td>Speed</td><td>${p.speedKms ? Math.round(p.speedKms * 3600).toLocaleString() + ' km/h' : '—'}</td></tr>
      </tbody></table>
      <div class="muted" style="margin-top:6px">Orbit via CelesTrak TLE · updated ${age}</div>`);
  }
  if (spaceTick % 60 === 0) { // refresh the ground track ~once a minute
    spaceTrackLayer.clearLayers();
    for (const o of spaceObjs) {
      for (const seg of spaceGroundTrack(o.satrec)) {
        L.polyline(seg, { color: o.color, weight: 1.5, opacity: 0.6, dashArray: '4 6' }).addTo(spaceTrackLayer);
      }
    }
  }
  spaceTick++;
}

async function enableSpace() {
  if (typeof satellite === 'undefined') {
    toast({ kind: 'test', title: 'Aerospace unavailable', message: 'The satellite.js library failed to load.' });
    $('#space-toggle').checked = false; state.spaceOn = false; return;
  }
  let data = null;
  try { data = await (await fetch('/api/aerospace/tle')).json(); } catch { /* ignore */ }
  if (!data || !data.sats || !Object.keys(data.sats).length) {
    toast({ kind: 'test', title: 'Aerospace data unavailable', message: (data && data.error) || 'Could not load orbital elements (the server needs internet to reach CelesTrak).' });
    $('#space-toggle').checked = false; state.spaceOn = false; refreshLayersBtn(); return;
  }
  spaceMeta = { fetchedAt: data.fetchedAt, source: data.source };
  spaceObjs = [];
  for (const def of SPACE_DEFS) {
    const s = data.sats[def.key];
    if (!s) continue;
    try { spaceObjs.push({ ...def, satrec: satellite.twoline2satrec(s.line1, s.line2) }); } catch { /* skip bad TLE */ }
  }
  spaceLayer.addTo(map); spaceTrackLayer.addTo(map);
  spaceTick = 0;
  updateSpace();
  spaceTimer = setInterval(updateSpace, 1000);
}

function disableSpace() {
  if (spaceTimer) { clearInterval(spaceTimer); spaceTimer = null; }
  map.removeLayer(spaceLayer); map.removeLayer(spaceTrackLayer);
  spaceLayer.clearLayers(); spaceTrackLayer.clearLayers();
  spaceMarkers.clear(); spaceObjs = [];
}

$('#space-toggle').addEventListener('change', (e) => {
  state.spaceOn = e.target.checked;
  if (state.spaceOn) enableSpace(); else disableSpace();
  refreshLayersBtn();
});

// ----------------------------------------------------------------- heatmap layer
// Density of recorded aircraft positions (the replay track log), aggregated
// server-side and drawn with leaflet.heat — the tar1090-style position heatmap.
const HEAT_GRADIENT = { 0.0: '#2c3e9e', 0.3: '#2c7fb8', 0.5: '#41b6c4', 0.65: '#a1dab4', 0.78: '#fdae61', 0.9: '#f46d43', 1.0: '#d7191c' };
let heatLayer = null;
let heatLoadToken = 0;

function heatmapSinceMs() {
  const hours = parseInt($('#hm-range').value, 10) || 6;
  return Date.now() - hours * 3600000;
}

async function drawHeatmap() {
  if (!state.heatmapOn) return;
  if (typeof L.heatLayer !== 'function') {
    $('#hm-info').textContent = 'Heatmap library failed to load.';
    return;
  }
  const token = ++heatLoadToken;
  $('#hm-info').textContent = 'Loading…';
  let data;
  try { data = await (await fetch(`/api/heatmap?since=${heatmapSinceMs()}`)).json(); }
  catch { $('#hm-info').textContent = 'Failed to load.'; return; }
  if (token !== heatLoadToken || !state.heatmapOn) return;
  // log-compress counts so busy areas near the receiver don't wash out the rest
  const lmax = Math.log1p(data.max || 1) || 1;
  const points = (data.cells || []).map((c) => [c[0], c[1], Math.log1p(c[2])]);
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  heatLayer = L.heatLayer(points, {
    radius: 18, blur: 16, minOpacity: 0.25, maxZoom: 9, max: lmax, gradient: HEAT_GRADIENT
  }).addTo(map);
  $('#hm-info').textContent = data.total
    ? `${data.total.toLocaleString()} points · ${data.count.toLocaleString()} cells${data.capped ? ' (capped)' : ''}`
    : 'No recorded positions in this period yet.';
}

$('#heatmap-toggle').addEventListener('change', (e) => {
  state.heatmapOn = e.target.checked;
  $('#heatmap-opts').classList.toggle('hidden', !state.heatmapOn);
  if (state.heatmapOn) {
    drawHeatmap();
  } else if (heatLayer) {
    map.removeLayer(heatLayer); heatLayer = null;
  }
  refreshLayersBtn();
});
$('#hm-range').addEventListener('change', drawHeatmap);

// ----------------------------------------------------------------- airspace (OpenAIP)
// Controlled-airspace tile overlay, proxied through the server (key stays server-side).
let airspaceLayer = null;

async function enableAirspace() {
  if (!state.config) { try { state.config = await (await fetch('/api/config')).json(); } catch { /* ignore */ } }
  if (!state.config?.openAip?.hasKey) {
    toast({ kind: 'test', title: 'OpenAIP key needed', message: 'Add a free OpenAIP API key in Settings → Aeronautical layers to show controlled airspace.' });
    $('#airspace-toggle').checked = false; state.airspaceOn = false; refreshLayersBtn();
    return;
  }
  airspaceLayer = L.tileLayer('/api/airspace/tiles/{z}/{x}/{y}', {
    opacity: 0.85, maxZoom: 14, tileSize: 256, zIndex: 350, attribution: 'Airspace &copy; OpenAIP'
  }).addTo(map);
}
function disableAirspace() {
  if (airspaceLayer) { map.removeLayer(airspaceLayer); airspaceLayer = null; }
}
$('#airspace-toggle').addEventListener('change', (e) => {
  state.airspaceOn = e.target.checked;
  if (state.airspaceOn) enableAirspace(); else disableAirspace();
  refreshLayersBtn();
});

// ----------------------------------------------------------------- aviation weather (METAR)
// Colour-coded METAR station markers from aviationweather.gov (no key).
const metarLayer = L.layerGroup();
let metarLoadToken = 0;
const FLT_CAT_COLORS = { VFR: '#22c55e', MVFR: '#3b82f6', IFR: '#ef4444', LIFR: '#d946ef' };

function metarPopup(m) {
  const color = FLT_CAT_COLORS[m.fltCat] || '#94a3b8';
  const rows = [];
  if (m.wspd != null) {
    const wind = m.wspd === 0 ? 'calm'
      : `${m.wdir == null || m.wdir === 'VRB' ? 'VRB' : m.wdir + '°'} @ ${m.wspd} kt${m.wgst ? ' G' + m.wgst : ''}`;
    rows.push(['Wind', wind]);
  }
  if (m.visib != null) rows.push(['Visibility', `${m.visib} sm`]);
  if (m.temp != null) rows.push(['Temp / dew', `${Math.round(m.temp)}° / ${m.dewp != null ? Math.round(m.dewp) + '°' : '—'} C`]);
  if (m.altim != null) rows.push(['Altimeter', `${Math.round(m.altim)} hPa · ${(m.altim / 33.8639).toFixed(2)} inHg`]);
  const body = rows.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${v}</td></tr>`).join('');
  return `<div class="metar-pop">
    <div class="arr-title">${m.id}${m.name ? ` · ${m.name}` : ''}</div>
    <div><span class="fltcat" style="background:${color}">${m.fltCat || '—'}</span></div>
    <table class="arr-table"><tbody>${body}</tbody></table>
    ${m.raw ? `<div class="metar-raw">${m.raw}</div>` : ''}
  </div>`;
}

async function loadMetar() {
  if (!state.metarOn) return;
  const b = map.getBounds();
  const token = ++metarLoadToken;
  let data;
  try {
    const p = new URLSearchParams({ s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() });
    data = await (await fetch(`/api/avwx/metar?${p}`)).json();
  } catch { return; }
  if (token !== metarLoadToken || !state.metarOn) return;
  metarLayer.clearLayers();
  for (const m of data.stations || []) {
    L.circleMarker([m.lat, m.lon], {
      radius: 6, color: '#0b1220', weight: 1, fillColor: FLT_CAT_COLORS[m.fltCat] || '#94a3b8', fillOpacity: 0.95
    }).bindPopup(metarPopup(m), { maxWidth: 320 }).bindTooltip(m.id, { direction: 'top' }).addTo(metarLayer);
  }
}
$('#metar-toggle').addEventListener('change', (e) => {
  state.metarOn = e.target.checked;
  if (state.metarOn) { metarLayer.addTo(map); loadMetar(); }
  else { map.removeLayer(metarLayer); metarLayer.clearLayers(); }
  refreshLayersBtn();
});
map.on('moveend', () => { if (state.metarOn) loadMetar(); });

// ----------------------------------------------------------------- frequencies layer
const freqLayer = L.layerGroup();
let freqLoadToken = 0;

const freqIcon = L.divIcon({
  className: 'freq-icon',
  html: '<div class="freq-pin">📻</div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10]
});

// group frequencies by type and format the popup
function freqPopup(ap) {
  const ORDER = ['TWR', 'GND', 'APP', 'DEP', 'ATIS', 'CTAF', 'UNICOM', 'AFIS', 'CLD', 'A/D'];
  const rank = (t) => {
    const i = ORDER.indexOf((t || '').toUpperCase());
    return i < 0 ? ORDER.length : i;
  };
  const list = [...ap.freqs].sort((a, b) => rank(a.type) - rank(b.type));
  const rows = list
    .map((f) => `<tr><td class="ft">${f.type || ''}</td><td>${f.mhz}</td><td class="fd">${f.description || ''}</td></tr>`)
    .join('');
  const where = [ap.municipality, ap.country].filter(Boolean).join(', ');
  return `<div class="freq-pop"><div class="freq-h"><b>${ap.ident}</b> ${ap.name || ''}<div class="muted">${where}</div></div>
    <table class="freq-tbl">${rows}</table></div>`;
}

async function loadFrequencies() {
  if (!state.freqOn) return;
  const b = map.getBounds();
  const token = ++freqLoadToken;
  try {
    const params = new URLSearchParams({
      n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest()
    });
    const { airports } = await (await fetch(`/api/frequencies?${params}`)).json();
    if (token !== freqLoadToken || !state.freqOn) return; // superseded by a newer pan/zoom
    freqLayer.clearLayers();
    for (const ap of airports || []) {
      L.marker([ap.lat, ap.lon], { icon: freqIcon, interactive: true })
        .bindPopup(freqPopup(ap), { maxWidth: 320 })
        .addTo(freqLayer);
    }
  } catch { /* ignore */ }
}

$('#freq-toggle').addEventListener('change', async (e) => {
  state.freqOn = e.target.checked;
  if (state.freqOn) {
    const meta = await (await fetch('/api/frequencies/meta')).json();
    if (!meta.count) {
      e.target.checked = false;
      state.freqOn = false;
      toast({ kind: 'test', title: 'No frequency data yet', message: 'Download it first: Settings → Communication frequencies.' });
      return;
    }
    freqLayer.addTo(map);
    loadFrequencies();
  } else {
    map.removeLayer(freqLayer);
    freqLayer.clearLayers();
  }
});
map.on('moveend', () => { if (state.freqOn) loadFrequencies(); });

// ----------------------------------------------------------------- reception source
// How the position was picked up (colours roughly match tar1090's source legend).
const SOURCE_INFO = {
  adsb:  { label: 'ADS-B',  color: '#22c55e' },
  uat:   { label: 'UAT',    color: '#10b981' },
  adsr:  { label: 'ADS-R',  color: '#84cc16' },
  tisb:  { label: 'TIS-B',  color: '#a855f7' },
  mlat:  { label: 'MLAT',   color: '#eab308' },
  modes: { label: 'Mode-S', color: '#38bdf8' },
  adsc:  { label: 'ADS-C',  color: '#14b8a6' },
  other: { label: 'Other',  color: '#64748b' }
};
const sourceColor = (s) => (SOURCE_INFO[s] || SOURCE_INFO.other).color;
const sourceLabel = (s) => (SOURCE_INFO[s] || SOURCE_INFO.other).label;

// ISO 3166-1 alpha-2 country code -> bundled SVG flag (renders everywhere,
// including Windows, unlike flag emoji).
function flagHtml(code) {
  if (!code || code.length !== 2) return '';
  const c = code.toLowerCase();
  return `<span class="fi fi-${c} acflag" title="${code}"></span> `;
}

// Reception-source filter: which sources are shown (default: all).
state.sourceEnabled = new Set(Object.keys(SOURCE_INFO));

(function buildSourceMenu() {
  const menu = $('#source-menu');
  menu.innerHTML =
    Object.entries(SOURCE_INFO)
      .map(
        ([k, v]) =>
          `<label class="menu-item"><input type="checkbox" data-src="${k}" checked>
             <span><span class="leg-dot" style="background:${v.color}"></span> ${v.label}</span></label>`
      )
      .join('') +
    `<div class="menu-actions"><button id="src-all">All</button><button id="src-none">None</button></div>`;

  function syncFromMenu() {
    state.sourceEnabled = new Set(
      [...menu.querySelectorAll('input[data-src]')].filter((c) => c.checked).map((c) => c.dataset.src)
    );
    $('#source-btn').classList.toggle('has-active', state.sourceEnabled.size < Object.keys(SOURCE_INFO).length);
    renderAircraft();
  }
  menu.querySelectorAll('input[data-src]').forEach((c) => c.addEventListener('change', syncFromMenu));
  $('#src-all').addEventListener('click', () => {
    menu.querySelectorAll('input[data-src]').forEach((c) => (c.checked = true));
    syncFromMenu();
  });
  $('#src-none').addEventListener('click', () => {
    menu.querySelectorAll('input[data-src]').forEach((c) => (c.checked = false));
    syncFromMenu();
  });
})();

$('#source-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#source-menu').classList.toggle('hidden');
});

// ----------------------------------------------------------------- plane icons
const CLASS_COLORS = {
  airline: '#38bdf8',
  military: '#4ade80',
  private: '#facc15',
  business: '#c084fc',
  emergency: '#ef4444',
  other: '#94a3b8',
  unknown: '#64748b'
};

// Distinct silhouettes per aircraft kind. All drawn nose-up in a 26×26 box and
// rotated by ground track. Helicopters get a rotor cross; light/GA get straight
// wings; airliners swept wings; heavy 4 engines; military a delta; etc.
const SHAPES = {
  airliner:
    'M13 1.5 L15 9 L24 14.5 L24 17 L15 14 L14.6 20.5 L17.5 23 L17.5 24.8 L13 23.4 L8.5 24.8 L8.5 23 L11.4 20.5 L11 14 L2 17 L2 14.5 L11 9 Z',
  // straight wings + straight tailplane = light / general-aviation
  light:
    'M13 3 L13.9 10 L23 11.3 L23 12.7 L13.9 12 L13.7 18 L16.6 20.4 L16.6 21.6 L13 20.6 L9.4 21.6 L9.4 20.4 L12.3 18 L12.1 12 L3 12.7 L3 11.3 L12.1 10 Z',
  // strong delta = military / fast jet
  military:
    'M13 1.5 L14 12 L22.5 21 L22.5 22.4 L13.6 18.4 L13.4 22 L15.4 24.4 L15.4 25.4 L13 24.2 L10.6 25.4 L10.6 24.4 L12.6 22 L12.4 18.4 L3.5 22.4 L3.5 21 L12 12 Z',
  // heavy: swept wings with 4 engine nacelles hinted
  heavy:
    'M13 1.5 L15 9 L24 15 L24 17.2 L15 14 L14.6 20.5 L17.6 23 L17.6 24.6 L13 23.4 L8.4 24.6 L8.4 23 L11.4 20.5 L11 14 L2 17.2 L2 15 L11 9 Z',
  glider:
    'M13 4 L13.7 11 L24 12 L24 13 L13.7 12.6 L13.5 19 L15.5 21 L15.5 22 L13 21.2 L10.5 22 L10.5 21 L12.5 19 L12.3 12.6 L2 13 L2 12 L12.3 11 Z'
};

function planeSvg(kind, color, track, onGround) {
  const rot = track ?? 0;
  const stroke = `stroke="#0b1220" stroke-width="0.8"`;
  let shape;
  if (onGround) {
    shape = `<circle cx="13" cy="13" r="5" fill="${color}" stroke="#0b1220" stroke-width="1.2"/>`;
  } else if (kind === 'heli') {
    // body + tail boom + main rotor cross + tail rotor
    shape = `<g transform="rotate(${rot} 13 13)">
      <rect x="12.3" y="12.5" width="1.4" height="11" rx="0.6" fill="${color}" ${stroke}/>
      <circle cx="13" cy="13" r="3.2" fill="${color}" ${stroke}/>
      <rect x="3.5" y="12.3" width="19" height="1.4" rx="0.7" fill="${color}"/>
      <rect x="12.3" y="3.5" width="1.4" height="19" rx="0.7" fill="${color}"/>
      <rect x="9.5" y="22.6" width="7" height="1.3" rx="0.6" fill="${color}"/>
    </g>`;
  } else if (kind === 'balloon') {
    shape = `<g><circle cx="13" cy="11" r="7" fill="${color}" ${stroke}/><rect x="11" y="18" width="4" height="4" rx="1" fill="${color}" ${stroke}/></g>`;
  } else if (kind === 'drone') {
    shape = `<g transform="rotate(${rot} 13 13)"><circle cx="6" cy="6" r="3" fill="${color}"/><circle cx="20" cy="6" r="3" fill="${color}"/><circle cx="6" cy="20" r="3" fill="${color}"/><circle cx="20" cy="20" r="3" fill="${color}"/><rect x="5" y="11.5" width="16" height="3" rx="1.5" fill="${color}"/><rect x="11.5" y="5" width="3" height="16" rx="1.5" fill="${color}"/></g>`;
  } else {
    const d = SHAPES[kind] || SHAPES.airliner;
    shape = `<path transform="rotate(${rot} 13 13)" fill="${color}" ${stroke} d="${d}"/>`;
  }
  return `<svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">${shape}</svg>`;
}

const markers = new Map(); // hex -> { marker, trail }

// Selected-aircraft trail. Accumulated from the live snapshots (recent tail) and
// seeded with the full history from the detail endpoint, keyed by timestamp so it
// never shortens while the plane is tracked. Gaps (long time jumps between
// consecutive points) are drawn as dashed connectors so signal loss is visible.
const selTrailLayer = L.layerGroup().addTo(map);
let selTrailHex = null;
let selTrailPoints = new Map(); // ts -> [lat, lon, alt, ts]
const TRAIL_GAP_MS = 20000; // a jump larger than this between points = a gap

function clearSelTrail() {
  selTrailLayer.clearLayers();
  selTrailPoints = new Map();
  selTrailHex = null;
}

function mergeSelTrail(points) {
  for (const p of points || []) {
    if (Array.isArray(p) && p.length >= 4 && p[3] != null && !selTrailPoints.has(p[3])) {
      selTrailPoints.set(p[3], p);
    }
  }
}

// Seed the selected trail with the full history returned by the detail endpoint.
function seedSelTrail(hex, fullTrail) {
  if (hex !== state.selected) return;
  if (selTrailHex !== hex) { clearSelTrail(); selTrailHex = hex; }
  mergeSelTrail(fullTrail);
  const ac = state.aircraft.get(hex);
  if (ac) drawSelTrail(trailColor(ac));
}

function trailColor(ac) {
  return ac.emergency ? CLASS_COLORS.emergency : CLASS_COLORS[ac.classification] || CLASS_COLORS.unknown;
}

// Rebuild the trail polylines: solid segments where points are continuous, and a
// dashed amber connector (with end dots) across any gap so it's clearly visible.
function drawSelTrail(color) {
  selTrailLayer.clearLayers();
  const pts = [...selTrailPoints.values()].sort((a, b) => a[3] - b[3]);
  if (pts.length < 1) return;
  let seg = [[pts[0][0], pts[0][1]]];
  const flushSeg = () => { if (seg.length >= 2) L.polyline(seg, { color, weight: 2.5, opacity: 0.85 }).addTo(selTrailLayer); };
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][3] - pts[i - 1][3] > TRAIL_GAP_MS) {
      flushSeg();
      const a = [pts[i - 1][0], pts[i - 1][1]], b = [pts[i][0], pts[i][1]];
      L.polyline([a, b], { color: '#fbbf24', weight: 2, opacity: 0.85, dashArray: '3 8' })
        .bindTooltip('Signal gap', { sticky: true }).addTo(selTrailLayer);
      for (const e of [a, b]) {
        L.circleMarker(e, { radius: 3, color: '#fbbf24', weight: 1.5, fillColor: '#1b2238', fillOpacity: 1 }).addTo(selTrailLayer);
      }
      seg = [[pts[i][0], pts[i][1]]];
    } else {
      seg.push([pts[i][0], pts[i][1]]);
    }
  }
  flushSeg();
}

function classifiedVisible(ac) {
  if (state.filter !== 'all') {
    if (state.filter === 'emergency' && !ac.emergency) return false;
    if (state.filter !== 'emergency' && ac.classification !== state.filter) return false;
  }
  if (state.sourceEnabled && !state.sourceEnabled.has(ac.source || 'other')) return false;
  if (state.airlineQuery) {
    const q = state.airlineQuery.toLowerCase();
    const hay = `${ac.airline || ''} ${ac.airlineCallsign || ''} ${ac.flight || ''} ${ac.operator || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// The map + list are only visible on the Map tab. Skip the (relatively costly)
// marker/list DOM rebuild when the map isn't on screen — another tab is open or
// the browser tab is backgrounded. Live state still updates from the SSE feed;
// the view is refreshed on the way back (tab switch / visibilitychange).
function mapVisible() {
  return !document.hidden && $('#tab-map').classList.contains('active');
}

function renderAircraft() {
  if (!mapVisible()) return;
  // During replay we freeze the live planes and show historical frames instead;
  // keep the list updating with live data though.
  if (state.replay && state.replay.active) { renderList(); return; }
  const live = new Set();
  let visibleCount = 0;
  for (const ac of state.aircraft.values()) {
    if (ac.lat == null || ac.lon == null) continue;
    if (!classifiedVisible(ac)) continue;
    visibleCount++;
    live.add(ac.hex);
    const color = ac.emergency ? CLASS_COLORS.emergency : CLASS_COLORS[ac.classification] || CLASS_COLORS.unknown;
    const html = planeSvg(ac.iconKind || 'airliner', color, ac.track, ac.onGround);
    let entry = markers.get(ac.hex);
    const labelText = ac.flight || ac.registration || ac.hex.toUpperCase();
    if (!entry) {
      const icon = L.divIcon({ className: 'plane-icon', html, iconSize: [26, 26], iconAnchor: [13, 13] });
      const marker = L.marker([ac.lat, ac.lon], { icon }).addTo(map);
      marker.on('click', () => selectAircraft(ac.hex));
      entry = { marker, trail: null, lastHtml: html, labeled: false };
      markers.set(ac.hex, entry);
    } else {
      entry.marker.setLatLng([ac.lat, ac.lon]);
      if (entry.lastHtml !== html) {
        entry.marker.setIcon(L.divIcon({ className: 'plane-icon', html, iconSize: [26, 26], iconAnchor: [13, 13] }));
        entry.lastHtml = html;
      }
    }
    // label
    if (state.showLabels && !entry.labeled) {
      entry.marker.bindTooltip(labelText, {
        permanent: true, direction: 'right', offset: [14, 0], className: 'plane-label'
      });
      entry.labeled = true;
    } else if (!state.showLabels && entry.labeled) {
      entry.marker.unbindTooltip();
      entry.labeled = false;
    } else if (entry.labeled && entry.marker.getTooltip()?.getContent() !== labelText) {
      entry.marker.setTooltipContent(labelText);
    }
    // selected: accumulate + draw the full trail (with visible gaps) + follow
    if (state.selected === ac.hex) {
      if (selTrailHex !== ac.hex) { clearSelTrail(); selTrailHex = ac.hex; }
      mergeSelTrail(ac.trail);
      drawSelTrail(color);
      if (state.follow) map.panTo([ac.lat, ac.lon], { animate: true });
      updateDetailLive(ac);
    }
  }
  // remove stale markers
  for (const [hex, entry] of markers) {
    if (!live.has(hex)) {
      map.removeLayer(entry.marker);
      markers.delete(hex);
    }
  }
  // the selected plane's trail persists until it actually leaves the map
  // (expires from tracking) — keep it across brief signal gaps.
  if (selTrailHex && !state.aircraft.has(selTrailHex)) clearSelTrail();
  renderList(visibleCount);
  autoFollowTick();
}

// ------------------------------------------------------ auto-follow newest plane
const AUTO_FOLLOW_MIN_MS = 10000; // hold each plane at least this long before switching

// Pick the newest visible aircraft and follow it; switch to a newer arrival only
// after the current one has been followed for AUTO_FOLLOW_MIN_MS. Called at the
// end of every renderAircraft pass (i.e. on each live snapshot).
function autoFollowTick() {
  if (!state.autoFollow) return;
  // newest visible aircraft = latest firstSeen, with a position and not filtered out
  let newest = null;
  for (const ac of state.aircraft.values()) {
    if (ac.lat == null || ac.lon == null || !classifiedVisible(ac)) continue;
    if (!newest || (ac.firstSeen || 0) > (newest.firstSeen || 0)) newest = ac;
  }
  if (!newest) return;

  const cur = state.autoFollowHex ? state.aircraft.get(state.autoFollowHex) : null;
  const curVisible = cur && cur.lat != null && cur.lon != null && classifiedVisible(cur);
  const heldLongEnough = Date.now() - state.autoFollowSince >= AUTO_FOLLOW_MIN_MS;

  let target = null;
  if (!curVisible) target = newest; // current plane gone — jump to newest now
  else if (heldLongEnough && (newest.firstSeen || 0) > (cur.firstSeen || 0)) target = newest;

  if (target && target.hex !== state.autoFollowHex) {
    state.autoFollowHex = target.hex;
    state.autoFollowSince = Date.now();
    autoSelect(target.hex, target);
  }
}

// Select + follow a plane without re-entering renderAircraft (avoids recursion
// when called from inside the render pass). Mirrors selectAircraft's side panel.
function autoSelect(hex, ac) {
  state.selected = hex;
  state.follow = true;
  $('#detail').classList.remove('hidden');
  $('#d-follow').classList.add('active');
  if (ac.lat != null) map.setView([ac.lat, ac.lon], Math.max(map.getZoom(), 9));
  try { updateDetailLive(ac); } catch (e) { console.warn('detail render error', e); }
  loadDetailExtras(hex);
}

function setAutoFollow(on) {
  state.autoFollow = on;
  $('#autofollow-btn').classList.toggle('active', on);
  if (on) {
    if (state.replay?.active) closeReplay(); // replay and auto-follow don't mix
    state.autoFollowHex = null;
    state.autoFollowSince = 0;
    renderAircraft(); // pick + follow the newest immediately
  } else {
    state.follow = false;
    $('#d-follow').classList.remove('active');
  }
}

$('#autofollow-btn').addEventListener('click', () => setAutoFollow(!state.autoFollow));

// ----------------------------------------------------------------- aircraft list
state.listExpanded = false;
state.listSort = { key: 'distKm', dir: 1 };

// label can be a string or a function (for unit-dependent headers).
const LIST_COLUMNS = [
  ['flight', 'Callsign', (ac) => `${flagHtml(ac.country)}${ac.flight || ac.registration || ac.hex.toUpperCase()}`],
  ['registration', 'Reg', (ac) => ac.registration || '—'],
  ['type', 'Type', (ac) => ac.type || '—'],
  ['airline', 'Airline / operator', (ac) => ac.airline || ac.operator || '—'],
  ['alt', () => unitLabels().alt, (ac) => fmt.altN(ac.alt)],
  ['gs', () => unitLabels().spd, (ac) => fmt.spdN(ac.gs)],
  ['vr', () => unitLabels().vr, (ac) => fmt.vrN(ac.vr)],
  ['distKm', 'Dist km', (ac) => ac.distKm ?? '—'],
  ['squawk', 'Squawk', (ac) => ac.squawk || '—'],
  ['source', 'Source', (ac) => `<span style="color:${sourceColor(ac.source)}">${sourceLabel(ac.source)}</span>`]
];

function sortRows(rows) {
  const { key, dir } = state.listSort;
  return rows.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'flight') { va = a.flight || a.registration || a.hex; vb = b.flight || b.registration || b.hex; }
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
}

function rowClasses(ac, base) {
  return [
    base,
    ac.classification === 'military' ? 'mil' : '',
    ac.emergency ? 'emerg' : '',
    state.selected === ac.hex ? 'sel' : ''
  ].join(' ');
}

function renderList() {
  const all = [...state.aircraft.values()].filter(classifiedVisible);
  $('#ac-count').textContent = `${all.length} aircraft`;
  const rows = sortRows(all).slice(0, 250);

  if (state.listExpanded) {
    const { key, dir } = state.listSort;
    const head = LIST_COLUMNS.map(
      ([k, label]) => {
        const text = typeof label === 'function' ? label() : label;
        return `<th data-key="${k}" class="${k === key ? 'sorted' : ''}">${text}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
      }
    ).join('');
    const body = rows
      .map(
        (ac) => `<tr class="${rowClasses(ac, '')}" data-hex="${ac.hex}" style="box-shadow: inset 4px 0 0 ${sourceColor(ac.source)}">
          ${LIST_COLUMNS.map(([, , render]) => `<td>${render(ac)}</td>`).join('')}
        </tr>`
      )
      .join('');
    $('#ac-list').innerHTML = `<table class="ac-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    return;
  }

  $('#ac-list').innerHTML = rows
    .slice(0, 150)
    .map(
      (ac) => `<div class="${rowClasses(ac, 'ac-row')}" data-hex="${ac.hex}" style="border-left:4px solid ${sourceColor(ac.source)}" title="Source: ${sourceLabel(ac.source)}">
        <div>
          <div class="cs">${flagHtml(ac.country)}${ac.flight || ac.registration || ac.hex.toUpperCase()}</div>
          <div class="meta">${ac.type || ac.typeName || ''}</div>
        </div>
        <div class="meta">${fmt.alt(ac.alt)}<br>${ac.distKm != null ? ac.distKm + ' km' : ''}</div>
      </div>`
    )
    .join('');
}

$('#ac-list').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-key]');
  if (th) {
    const key = th.dataset.key;
    if (state.listSort.key === key) state.listSort.dir *= -1;
    else state.listSort = { key, dir: 1 };
    renderAircraft();
    return;
  }
  const row = e.target.closest('[data-hex]');
  if (row) selectAircraft(row.dataset.hex, true);
});
$('#ac-list-collapse').addEventListener('click', () => $('#ac-list-panel').classList.toggle('collapsed'));
$('#ac-list-expand').addEventListener('click', () => {
  state.listExpanded = !state.listExpanded;
  $('#ac-list-panel').classList.toggle('expanded', state.listExpanded);
  $('#ac-list-expand').classList.toggle('active', state.listExpanded);
  $('#ac-list-panel').classList.remove('collapsed');
  renderAircraft();
});

// ----------------------------------------------------------------- replay
const replayLayer = L.layerGroup();
let replayRaf = null;
state.replay = { active: false, playing: false, vt: 0, dayStart: 0, dayEnd: 0, speed: 30, lastWall: 0, lastFetch: 0, fetchToken: 0, fetching: false };

function clearLiveMarkers() {
  for (const [, entry] of markers) {
    map.removeLayer(entry.marker);
    if (entry.trail) map.removeLayer(entry.trail);
  }
  markers.clear();
  clearSelTrail();
}

function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function openReplay() {
  const bounds = await (await fetch('/api/replay/bounds')).json();
  if (!bounds.count) {
    toast({ kind: 'test', title: 'No replay data yet', message: 'Track recording has just started — let it run a while, then try again.' });
    return;
  }
  if (state.autoFollow) { state.autoFollow = false; $('#autofollow-btn').classList.remove('active'); }
  state.replay.active = true;
  state.replay.bounds = bounds;
  $('#replay-open').classList.add('active');
  $('#replay-bar').classList.remove('hidden');
  clearLiveMarkers();
  replayLayer.addTo(map);
  // default to the day of the most recent data (usually today)
  const last = new Date(bounds.max);
  $('#rb-date').value = ymdLocal(last);
  $('#rb-date').max = ymdLocal(new Date());
  setReplayDay($('#rb-date').value);
}

function closeReplay() {
  pauseReplay();
  state.replay.active = false;
  $('#replay-open').classList.remove('active');
  $('#replay-bar').classList.add('hidden');
  map.removeLayer(replayLayer);
  replayLayer.clearLayers();
  renderAircraft(); // resume live
}

function setReplayDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  state.replay.dayStart = start;
  state.replay.dayEnd = start + 86400000;
  // start at the beginning of available data within the day
  state.replay.vt = Math.min(state.replay.dayEnd, Math.max(start, state.replay.bounds.min));
  updateScrub();
  fetchReplayFrame();
}

function updateScrub() {
  const { dayStart, dayEnd, vt } = state.replay;
  const frac = (vt - dayStart) / (dayEnd - dayStart);
  $('#rb-scrub').value = String(Math.round(Math.max(0, Math.min(1, frac)) * 1000));
  $('#rb-clock').textContent = new Date(vt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function fetchReplayFrame() {
  const token = ++state.replay.fetchToken;
  state.replay.fetching = true;
  const at = Math.round(state.replay.vt);
  try {
    const { aircraft } = await (await fetch(`/api/replay/frame?at=${at}&window=60000`, { signal: AbortSignal.timeout(8000) })).json();
    if (token !== state.replay.fetchToken || !state.replay.active) return;
    replayLayer.clearLayers();
    for (const a of aircraft || []) {
      const color = sourceColor(a.src);
      const icon = L.divIcon({ className: 'plane-icon', html: planeSvg('airliner', color, a.trk, false), iconSize: [26, 26], iconAnchor: [13, 13] });
      const m = L.marker([a.lat, a.lon], { icon }).addTo(replayLayer);
      const label = a.callsign || a.hex.toUpperCase();
      if (state.showLabels) m.bindTooltip(label, { permanent: true, direction: 'right', offset: [14, 0], className: 'plane-label' });
      m.bindPopup(`<b>${label}</b><br>${fmt.alt(a.alt)} · ${fmt.spdN(a.gs)} ${unitLabels().spd.split(' ')[1] || ''}<br>${sourceLabel(a.src)}`);
    }
    $('#rb-count').textContent = `${(aircraft || []).length} aircraft`;
  } catch { /* ignore */ } finally {
    // Only the latest fetch clears the in-flight flag and (re)starts the throttle
    // window — measured from completion, so a slow frame query can't cause the
    // play loop to launch overlapping requests that pile up and starve rendering.
    if (token === state.replay.fetchToken) {
      state.replay.fetching = false;
      state.replay.lastFetch = performance.now();
    }
  }
}

function replayLoop() {
  if (!state.replay.playing) return;
  const wall = performance.now();
  const dt = wall - state.replay.lastWall;
  state.replay.lastWall = wall;
  state.replay.vt += dt * state.replay.speed;
  if (state.replay.vt >= state.replay.dayEnd) {
    state.replay.vt = state.replay.dayEnd;
    updateScrub();
    fetchReplayFrame();
    pauseReplay();
    return;
  }
  updateScrub();
  if (!state.replay.fetching && wall - state.replay.lastFetch > 350) fetchReplayFrame();
  replayRaf = requestAnimationFrame(replayLoop);
}

function playReplay() {
  if (state.replay.vt >= state.replay.dayEnd) setReplayDay($('#rb-date').value);
  state.replay.playing = true;
  state.replay.lastWall = performance.now();
  $('#rb-play').textContent = '⏸';
  replayLoop();
}
function pauseReplay() {
  state.replay.playing = false;
  if (replayRaf) cancelAnimationFrame(replayRaf);
  $('#rb-play').textContent = '▶';
}

$('#replay-open').addEventListener('click', () => { state.replay.active ? closeReplay() : openReplay(); });
$('#rb-close').addEventListener('click', closeReplay);
$('#rb-play').addEventListener('click', () => { state.replay.playing ? pauseReplay() : playReplay(); });
$('#rb-speed').addEventListener('change', (e) => { state.replay.speed = parseInt(e.target.value, 10) || 30; });
$('#rb-date').addEventListener('change', (e) => { pauseReplay(); setReplayDay(e.target.value); });
$('#rb-scrub').addEventListener('input', (e) => {
  pauseReplay();
  const frac = parseInt(e.target.value, 10) / 1000;
  state.replay.vt = state.replay.dayStart + frac * (state.replay.dayEnd - state.replay.dayStart);
  $('#rb-clock').textContent = new Date(state.replay.vt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  fetchReplayFrame();
});

// ----------------------------------------------------------------- filters
$$('.filt').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.filt').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.filter = b.dataset.filter;
    renderAircraft();
  })
);
$('#airline-filter').addEventListener('input', (e) => {
  state.airlineQuery = e.target.value.trim();
  renderAircraft();
});

// ----------------------------------------------------------------- detail panel
async function selectAircraft(hex, pan = false) {
  // A manual pick takes over from auto-follow.
  if (state.autoFollow) { state.autoFollow = false; $('#autofollow-btn').classList.remove('active'); }
  state.selected = hex;
  state.follow = false;
  $('#d-follow').classList.remove('active');
  $('#detail').classList.remove('hidden');
  const ac = state.aircraft.get(hex);
  if (ac && pan && ac.lat != null) map.panTo([ac.lat, ac.lon]);
  renderAircraft();
  // Guard the live panel so a render glitch can never block the route / photo /
  // "seen before" fetches that follow.
  try { updateDetailLive(ac); } catch (e) { console.warn('detail render error', e); }
  loadDetailExtras(hex);
}

function updateDetailLive(ac) {
  if (!ac) return;
  $('#d-callsign').textContent = ac.flight || ac.registration || ac.hex.toUpperCase();
  const subParts = [ac.hex.toUpperCase(), ac.registration, ac.typeName || ac.type, ac.airline || ac.operator].filter(Boolean);
  $('#d-sub').textContent = subParts.join(' · ');

  const badges = [];
  badges.push(`<span class="badge ${badgeClass(ac)}">${ac.classification}</span>`);
  if (ac.source) badges.push(`<span class="badge" style="border-color:${sourceColor(ac.source)};color:${sourceColor(ac.source)}">${sourceLabel(ac.source)}</span>`);
  if (ac.emergency) badges.push(`<span class="badge emerg">EMERGENCY ${ac.squawk || ''}</span>`);
  if (ac.padbCategory) badges.push(`<span class="badge">${ac.padbCategory}</span>`);
  (ac.padbTags || []).forEach((t) => badges.push(`<span class="badge">${t}</span>`));
  $('#d-badges').innerHTML = badges.join('');

  const cells = [
    ['Altitude', fmt.alt(ac.alt)],
    ['Ground speed', fmt.spd(ac.gs)],
    ['Vertical rate', fmt.vr(ac.vr)],
    ['Track', ac.track != null ? Math.round(ac.track) + '°' : '—'],
    ['Squawk', ac.squawk || '—'],
    ['Distance', fmt.dist(ac.distKm)],
    ['Signal', ac.rssi != null ? ac.rssi + ' dBFS' : '—'],
    ['Messages', ac.messages?.toLocaleString() ?? '—'],
    ['First seen', fmt.time(ac.firstSeen)],
    ['Position', ac.lat != null ? `${ac.lat.toFixed(3)}, ${ac.lon.toFixed(3)}` : '—']
  ];
  $('#d-grid').innerHTML = cells
    .map(([k, v]) => `<div class="d-cell"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  // zones
  const zhtml = (ac.zones || [])
    .filter((z) => z.inside || z.etaSec != null)
    .map(
      (z) => `<div class="zone-line"><span>${z.name}</span>
        ${z.inside ? '<span class="in">INSIDE</span>' : `<span class="eta">enters in ${fmt.dur(z.etaSec)}</span>`}
      </div>`
    )
    .join('');
  $('#d-zones').innerHTML = zhtml || '<span class="muted">Not inside or approaching any zone</span>';
  $('#d-zones-section').style.display = state.zones.length ? '' : 'none';
}

function badgeClass(ac) {
  if (ac.emergency) return 'emerg';
  if (ac.classification === 'military') return 'mil';
  if (ac.classification === 'airline') return 'airline';
  return '';
}

async function loadDetailExtras(hex) {
  // photo (image via the cached proxy; metadata for the credit/link)
  $('#d-photo').innerHTML = '';
  fetch(`/api/aircraft/${hex}/photo`)
    .then((r) => r.json())
    .then(({ photo }) => {
      if (state.selected !== hex) return;
      if (photo?.thumb) {
        $('#d-photo').innerHTML = `<a href="${photo.link}" target="_blank" rel="noopener">
          <img src="/api/photo/${hex}" alt="aircraft photo" /></a>
          <div class="credit">© ${photo.photographer} / planespotters.net</div>`;
      }
    })
    .catch(() => {});

  // route + ETA
  $('#d-route').textContent = 'Looking up route…';
  fetch(`/api/aircraft/${hex}`)
    .then((r) => r.json())
    .then((d) => {
      if (state.selected !== hex) return;
      seedSelTrail(hex, d.trailFull); // fill in the full pre-click history
      if (!d.route) {
        $('#d-route').innerHTML = d.routeError
          ? `<span class="muted">Route unavailable — ${d.routeError}. Check the container's internet access.</span>`
          : d.flight
            ? '<span class="muted">No route data for this callsign</span>'
            : '<span class="muted">No callsign yet — route needs a flight number</span>';
        return;
      }
      const o = d.route.origin, dst = d.route.destination;
      const low = d.routeConfidence === 'low';
      let html = '';
      if (d.route.airline?.name) html += `<div class="muted" style="margin-bottom:6px">${d.route.airline.name}</div>`;
      html += `<div class="route-box${low ? ' route-suspect' : ''}">
        <div class="route-airport"><div class="code">${o?.iata || o?.icao || '?'}</div>
          <div class="name">${o ? `${o.municipality || o.name}, ${o.country}` : 'Unknown'}</div></div>
        <div class="route-arrow">→</div>
        <div class="route-airport" style="text-align:right"><div class="code">${dst?.iata || dst?.icao || '?'}</div>
          <div class="name">${dst ? `${dst.municipality || dst.name}, ${dst.country}` : 'Unknown'}</div></div>
      </div>`;
      const srcLabel = (d.routeSources || []).join(' + ') || 'database';
      if (low) {
        html += `<div class="route-warn">⚠ This route looks inaccurate for this flight —
          ${d.routeIssue || 'the geometry does not match'}. Treat it with caution.</div>`;
      } else if (d.routeConfidence === 'confirmed') {
        html += `<div class="route-ok">✓ Confirmed by two sources (adsbdb + hexdb) and consistent with the aircraft's position.</div>`;
      }
      const etas = [];
      if (!low) {
        if (d.distFromOriginKm != null) etas.push(`${d.distFromOriginKm} km flown from origin`);
        if (d.distToDestKm != null) etas.push(`${d.distToDestKm} km to go`);
        if (d.etaDestSec != null) {
          const eta = new Date(Date.now() + d.etaDestSec * 1000);
          etas.push(`<b>ETA ${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b> (~${fmt.dur(d.etaDestSec)})`);
        }
      }
      etas.push(`tracked since ${fmt.time(d.firstSeen)}`);
      etas.push(`source: ${srcLabel}`);
      html += `<div class="route-eta muted">${etas.join(' · ')}</div>`;
      $('#d-route').innerHTML = html;
    })
    .catch(() => { $('#d-route').innerHTML = '<span class="muted">Route lookup failed</span>'; });

  // history
  $('#d-history').textContent = 'Loading…';
  fetch(`/api/aircraft/${hex}/history`)
    .then((r) => r.json())
    .then(({ history }) => {
      if (state.selected !== hex) return;
      if (!history?.length) { $('#d-history').textContent = 'First time seen.'; return; }
      $('#d-history').innerHTML = history
        .slice(0, 12)
        .map(
          (h) => `<div class="hist-line">${fmt.dateTime(h.first_seen)} — ${fmt.dur((h.last_seen - h.first_seen) / 1000)}
            ${h.callsign ? ' · ' + h.callsign : ''}${h.max_alt ? ' · max ' + fmt.alt(h.max_alt) : ''}
            ${h.min_dist_km != null ? ' · closest ' + h.min_dist_km.toFixed(1) + ' km' : ''}</div>`
        )
        .join('');
    })
    .catch(() => {});
}

$('#d-close').addEventListener('click', () => {
  if (state.autoFollow) { state.autoFollow = false; $('#autofollow-btn').classList.remove('active'); }
  state.selected = null;
  state.follow = false;
  clearSelTrail();
  $('#detail').classList.add('hidden');
  renderAircraft();
});
$('#d-follow').addEventListener('click', () => {
  state.follow = !state.follow;
  $('#d-follow').classList.toggle('active', state.follow);
  const ac = state.aircraft.get(state.selected);
  if (state.follow && ac?.lat != null) map.setView([ac.lat, ac.lon], Math.max(map.getZoom(), 9));
});
$('#d-watch-add').addEventListener('click', async () => {
  const ac = state.aircraft.get(state.selected);
  if (!ac) return;
  await fetch('/api/watchlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      icao: ac.hex, registration: ac.registration || '', operator: ac.operator || ac.airline || '',
      type: ac.typeName || ac.type || '', notify: true
    })
  });
  toast({ kind: 'watchlist', title: 'Added to watchlist', message: ac.flight || ac.hex.toUpperCase() });
});

// ----------------------------------------------------------------- SSE live feed
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('aircraft', (e) => {
    const snap = JSON.parse(e.data);
    state.receiver = snap.receiver;
    state.aircraft = new Map(snap.aircraft.map((a) => [a.hex, a]));
    $('#conn-status').classList.toggle('ok', !snap.status.lastPollError);
    $('#conn-status').title = snap.status.lastPollError
      ? `dump1090 unreachable: ${snap.status.lastPollError}`
      : `Connected · ${snap.aircraft.length} aircraft`;
    if (!centeredOnce && snap.receiver?.lat != null) {
      centeredOnce = true;
      map.setView([snap.receiver.lat, snap.receiver.lon], 9);
      receiverMarker = L.circleMarker([snap.receiver.lat, snap.receiver.lon], {
        radius: 6, color: '#38bdf8', fillOpacity: 0.9
      }).bindTooltip('Receiver').addTo(map);
      if (state.ringsOn) drawRings(); // receiver now known
      loadWeather(); // location available -> fetch local weather
    }
    renderAircraft();
  });
  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    toast(a);
    if (a.browser && Notification.permission === 'granted') {
      new Notification(a.title, { body: a.message, icon: '/favicon.ico', tag: a.kind + (a.hex || '') });
    }
  });
  es.onerror = () => {
    $('#conn-status').classList.remove('ok');
    setTimeout(() => { es.close(); connectStream(); }, 5000);
  };
}

// ----------------------------------------------------------------- toasts
function toast({ kind, title, message, hex }) {
  const el = document.createElement('div');
  el.className = `toast ${kind || ''}`;
  el.innerHTML = `<div class="t">${title}</div><div class="m">${message || ''}</div>`;
  if (hex) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { selectAircraft(hex, true); el.remove(); });
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

// ----------------------------------------------------------------- stats
async function loadStats() {
  const days = $('#stats-days').value;
  const s = await (await fetch(`/api/stats?days=${days}`)).json();
  $('#stats-cards').innerHTML = `
    <div class="card"><div class="num">${s.totals.aircraft.toLocaleString()}</div><div class="lbl">unique aircraft</div></div>
    <div class="card"><div class="num">${s.totals.sightings.toLocaleString()}</div><div class="lbl">sightings</div></div>
    <div class="card"><div class="num">${state.aircraft.size}</div><div class="lbl">live right now</div></div>
    <div class="card"><div class="num">${s.topAirlines.length}</div><div class="lbl">airlines spotted</div></div>`;

  const maxDay = Math.max(1, ...s.perDay.map((d) => d.aircraft));
  $('#chart-perday').innerHTML = s.perDay
    .map(
      (d) => `<div class="bar" style="height:${(d.aircraft / maxDay) * 100}%" title="${d.day}: ${d.aircraft} aircraft">
        <b>${d.aircraft}</b><span>${d.day.slice(5)}</span></div>`
    )
    .join('') || '<span class="muted">No data yet</span>';

  hbar('#chart-types', s.topTypes.map((t) => [t.type, t.count]));
  hbar('#chart-airlines', s.topAirlines.map((t) => [t.airline, t.count]));
  hbar('#chart-categories', s.categories.map((t) => [t.category, t.count]));
}
function hbar(sel, rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  $(sel).innerHTML =
    rows
      .map(
        ([lbl, cnt]) => `<div class="hbar-row"><div class="lbl" title="${lbl}">${lbl}</div>
        <div class="bar" style="width:${(cnt / max) * 60}%"></div><div class="cnt">${cnt}</div></div>`
      )
      .join('') || '<span class="muted">No data yet</span>';
}
$('#stats-days').addEventListener('change', loadStats);

// ----------------------------------------------------------------- watchlist
async function loadWatchlist() {
  const { watchlist } = await (await fetch('/api/watchlist')).json();
  $('#wl-table tbody').innerHTML = watchlist
    .map(
      (w) => `<tr>
        <td>${w.icao || '—'}</td><td>${w.registration || '—'}</td><td>${w.callsign || '—'}</td>
        <td>${w.operator || '—'}</td><td>${w.type || '—'}</td><td>${w.category || '—'}</td>
        <td>${w.notify ? '🔔' : '—'}</td>
        <td><button class="del" data-id="${w.id}">delete</button></td>
      </tr>`
    )
    .join('');
  $$('#wl-table .del').forEach((b) =>
    b.addEventListener('click', async () => {
      await fetch(`/api/watchlist/${b.dataset.id}`, { method: 'DELETE' });
      loadWatchlist();
    })
  );
}
$('#wl-add').addEventListener('click', async () => {
  const body = {
    icao: $('#wl-icao').value.trim(),
    registration: $('#wl-reg').value.trim(),
    callsign: $('#wl-callsign').value.trim(),
    operator: $('#wl-operator').value.trim(),
    notify: true
  };
  const res = await fetch('/api/watchlist', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) return alert((await res.json()).error);
  ['#wl-icao', '#wl-reg', '#wl-callsign', '#wl-operator'].forEach((s) => ($(s).value = ''));
  loadWatchlist();
});
$('#padb-search-btn').addEventListener('click', doPadbSearch);
$('#padb-search').addEventListener('keydown', (e) => e.key === 'Enter' && doPadbSearch());
async function doPadbSearch() {
  const q = $('#padb-search').value.trim();
  if (q.length < 2) return;
  const { results } = await (await fetch(`/api/planedb/search?q=${encodeURIComponent(q)}`)).json();
  $('#padb-results').innerHTML = results.length
    ? results
        .map(
          (r) => `<div class="padb-hit"><b>${r.icao}</b><span>${r.registration}</span>
          <span class="grow">${r.operator} — ${r.type} <span class="muted">(${r.category})</span></span>
          <button data-icao="${r.icao}" class="padb-add">+ watch</button></div>`
        )
        .join('')
    : '<span class="muted">No matches in plane-alert-db (refresh it in Settings if empty)</span>';
  $$('.padb-add').forEach((b) =>
    b.addEventListener('click', async () => {
      const entry = results.find((r) => r.icao === b.dataset.icao);
      await fetch('/api/watchlist', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...entry, notify: true })
      });
      b.textContent = '✓ added';
      loadWatchlist();
    })
  );
}
$('#wl-import-btn').addEventListener('click', () => $('#wl-import-file').click());
$('#wl-import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const csv = await file.text();
  const res = await (await fetch('/api/watchlist/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv })
  })).json();
  toast({ kind: 'watchlist', title: 'CSV import', message: `${res.added} aircraft added to watchlist` });
  loadWatchlist();
});

// ----------------------------------------------------------------- zones
async function loadZones() {
  const { zones } = await (await fetch('/api/zones')).json();
  state.zones = zones;
  drawZones();
  $('#z-table tbody').innerHTML = zones
    .map(
      (z) => `<tr>
        <td><span style="color:${z.color}">●</span> ${z.name}</td>
        <td>${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}</td>
        <td>${z.radiusKm} km</td>
        <td><input type="checkbox" data-id="${z.id}" class="z-notify" ${z.notify !== false ? 'checked' : ''}></td>
        <td><button class="del" data-id="${z.id}">delete</button></td>
      </tr>`
    )
    .join('');
  $$('#z-table .del').forEach((b) =>
    b.addEventListener('click', async () => {
      await fetch(`/api/zones/${b.dataset.id}`, { method: 'DELETE' });
      loadZones();
    })
  );
  $$('#z-table .z-notify').forEach((cb) =>
    cb.addEventListener('change', () =>
      fetch(`/api/zones/${cb.dataset.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notify: cb.checked })
      })
    )
  );
}
$('#z-add').addEventListener('click', async () => {
  const body = {
    name: $('#z-name').value.trim() || 'Zone',
    lat: parseFloat($('#z-lat').value),
    lon: parseFloat($('#z-lon').value),
    radiusKm: parseFloat($('#z-radius').value),
    color: $('#z-color').value,
    notify: true
  };
  const res = await fetch('/api/zones', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) return alert((await res.json()).error);
  ['#z-name', '#z-lat', '#z-lon', '#z-radius'].forEach((s) => ($(s).value = ''));
  loadZones();
});
$('#z-use-map').addEventListener('click', () => {
  const c = map.getCenter();
  $('#z-lat').value = c.lat.toFixed(4);
  $('#z-lon').value = c.lng.toFixed(4);
});

// ----------------------------------------------------------------- alerts
state.alerts = [];
state.alertsPage = 1;

function alertsPageSize() {
  const v = $('#alerts-pagesize').value;
  return v === 'all' ? Infinity : parseInt(v, 10) || 25;
}

async function loadAlerts() {
  $('#alerts-count').textContent = 'Loading…';
  try {
    const { alerts } = await (await fetch('/api/alerts')).json();
    state.alerts = alerts || [];
  } catch {
    $('#alerts-count').textContent = 'Failed to load.';
    return;
  }
  state.alertsPage = 1;
  renderAlerts();
}

function renderAlerts() {
  const size = alertsPageSize();
  const total = state.alerts.length;
  const totalPages = size === Infinity ? 1 : Math.max(1, Math.ceil(total / size));
  if (state.alertsPage > totalPages) state.alertsPage = totalPages;
  if (state.alertsPage < 1) state.alertsPage = 1;
  const start = size === Infinity ? 0 : (state.alertsPage - 1) * size;
  const end = size === Infinity ? total : Math.min(total, start + size);
  const rows = state.alerts.slice(start, end);

  $('#alerts-count').textContent = total
    ? `${total} alert${total === 1 ? '' : 's'}${total > rows.length ? ` · showing ${start + 1}–${end}` : ''}`
    : '0 alerts';

  $('#alerts-table tbody').innerHTML = rows.length
    ? rows
        .map(
          (a) => `<tr><td>${fmt.dateTime(a.ts)}</td><td>${a.kind}</td>
        <td>${a.callsign || a.hex || '—'}</td><td>${a.message}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No alerts yet</td></tr>';

  renderPager($('#alerts-pager'), totalPages, state.alertsPage, (p) => {
    state.alertsPage = p;
    renderAlerts();
  });
}

$('#alerts-pagesize').addEventListener('change', () => {
  state.alertsPage = 1;
  renderAlerts();
});

// ----------------------------------------------------------------- spotted
function spottedSinceMs(range) {
  if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (range === 'month') return Date.now() - 30 * 86400000;
  if (range === 'all') return 0; // everything still retained (matches the log/stats retention)
  return Date.now() - 7 * 86400000; // week
}

state.spotted = [];
state.spottedSort = { key: 'lastSeen', dir: -1 }; // default: most recent first
state.spottedPage = 1;
const spottedRoute = new Map(); // callsign -> route | null

function spottedPageSize() {
  const v = $('#spotted-pagesize').value;
  return v === 'all' ? Infinity : parseInt(v, 10) || 25;
}

// small concurrency-limited runner so we don't hammer planespotters / adsbdb
async function runPool(items, worker, concurrency = 4) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

async function loadSpotted() {
  const range = $('#spotted-range').value;
  const since = spottedSinceMs(range);
  $('#spotted-count').textContent = 'Loading…';
  try {
    const data = await (await fetch(`/api/spotted?since=${since}`)).json();
    state.spotted = data.spotted || [];
  } catch {
    $('#spotted-count').textContent = 'Failed to load.';
    return;
  }
  state.spottedPage = 1;
  renderSpotted();
}

function sortSpotted(rows) {
  const { key, dir } = state.spottedSort;
  return [...rows].sort((a, b) => {
    let va = key === 'callsign' ? (a.callsign || a.registration || a.hex) : a[key];
    let vb = key === 'callsign' ? (b.callsign || b.registration || b.hex) : b[key];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
}

function spottedRouteHtml(cs) {
  if (!cs) return '<span class="muted">—</span>';
  if (!spottedRoute.has(cs)) return '<span class="muted">…</span>';
  const entry = spottedRoute.get(cs);
  const route = entry?.route;
  if (route && (route.origin || route.destination)) {
    const o = route.origin, d = route.destination;
    const badge = entry.agreement === 'confirmed'
      ? ' <span class="rt-ok" title="confirmed by adsbdb + hexdb">✓</span>'
      : entry.agreement === 'conflict'
        ? ' <span class="rt-warn" title="route databases disagree — treat with caution">⚠</span>'
        : '';
    return `<span title="${o ? o.name + ', ' + o.country : '?'} → ${d ? d.name + ', ' + d.country : '?'}">${o?.iata || o?.icao || '?'} → ${d?.iata || d?.icao || '?'}</span>${badge}`;
  }
  return '<span class="muted">no route</span>';
}

function spottedPhotoHtml(s) {
  // Load straight from the server-side image proxy (cached on disk, reliable).
  // onerror swaps in a ✈ placeholder when there's no photo.
  return `<a href="https://www.planespotters.net/hex/${s.hex.toUpperCase()}" target="_blank" rel="noopener" title="photos on planespotters.net">
    <img class="spotted-thumb" src="/api/photo/${s.hex}" loading="lazy" alt="" onerror="imgFallback(this)"></a>`;
}

function renderSpotted() {
  // header sort indicators
  $$('#spotted-table th[data-sort]').forEach((th) => {
    const k = th.dataset.sort;
    th.classList.toggle('sorted', k === state.spottedSort.key);
    th.dataset.arrow = k === state.spottedSort.key ? (state.spottedSort.dir > 0 ? ' ▲' : ' ▼') : '';
  });

  const sorted = sortSpotted(state.spotted);
  const size = spottedPageSize();
  const total = sorted.length;
  const totalPages = size === Infinity ? 1 : Math.max(1, Math.ceil(total / size));
  if (state.spottedPage > totalPages) state.spottedPage = totalPages;
  if (state.spottedPage < 1) state.spottedPage = 1;
  const start = size === Infinity ? 0 : (state.spottedPage - 1) * size;
  const end = size === Infinity ? total : Math.min(total, start + size);
  const rows = sorted.slice(start, end);

  $('#spotted-count').textContent = total
    ? `${total} aircraft${total > rows.length ? ` · showing ${start + 1}–${end}` : ''}`
    : '0 aircraft';

  $('#spotted-table tbody').innerHTML = rows.length
    ? rows
        .map((s) => {
          const tags = (s.tags || []).filter(Boolean).map((t) => `<span class="badge">${t}</span>`).join(' ');
          const label = s.callsign || s.registration || s.hex.toUpperCase();
          const closest = s.minDistKm != null ? `${s.minDistKm.toFixed(1)} km` : '—';
          return `<tr data-hex="${s.hex}" data-cs="${s.callsign || ''}">
            <td class="spotted-photo" data-hex="${s.hex}">${spottedPhotoHtml(s)}</td>
            <td>${flagHtml(s.country)}<b>${label}</b>${s.registration && s.registration !== label ? ` <span class="muted">${s.registration}</span>` : ''}
              ${s.link ? ` <a href="${s.link}" target="_blank" rel="noopener" title="plane-alert-db link">↗</a>` : ''}</td>
            <td>${s.operator || '—'}</td>
            <td>${s.type || s.icaoType || '—'}</td>
            <td>${s.category || '—'}</td>
            <td>${tags || '—'}</td>
            <td>${s.sessions}×</td>
            <td>${fmt.dateTime(s.firstSeen)}</td>
            <td>${fmt.dateTime(s.lastSeen)}</td>
            <td>${closest}</td>
            <td class="spotted-route" data-cs="${s.callsign || ''}">${spottedRouteHtml(s.callsign)}</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="11" class="muted">No plane-alert-db aircraft seen in this period.</td></tr>`;

  // clicking a row (not a link) selects the plane if it's live
  $$('#spotted-table tbody tr[data-hex]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const hex = tr.dataset.hex;
      if (state.aircraft.has(hex)) {
        $$('#tabs button').forEach((b) => b.classList.remove('active'));
        $('#tabs button[data-tab="map"]').classList.add('active');
        $$('.tab').forEach((t) => t.classList.remove('active'));
        $('#tab-map').classList.add('active');
        setTimeout(() => { map.invalidateSize(); selectAircraft(hex, true); }, 60);
      }
    })
  );

  renderSpottedPager(totalPages);
  // only the rows actually on screen need their routes fetched
  hydrateSpotted(rows);
}

// Reusable windowed pager: « Prev  1 … 4 [5] 6 … 12  Next » — capped to a few
// numbers around the current page. Calls go(page) when a page button is clicked.
function renderPager(el, totalPages, current, go) {
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  const cur = current;
  const pages = [];
  const window = 2; // pages either side of current
  const lo = Math.max(1, cur - window);
  const hi = Math.min(totalPages, cur + window);
  if (lo > 1) { pages.push(1); if (lo > 2) pages.push('…'); }
  for (let p = lo; p <= hi; p++) pages.push(p);
  if (hi < totalPages) { if (hi < totalPages - 1) pages.push('…'); pages.push(totalPages); }

  const btn = (label, page, opts = {}) => {
    const { disabled = false, active = false } = opts;
    return `<button class="pager-btn${active ? ' active' : ''}"${disabled ? ' disabled' : ''} data-page="${page}">${label}</button>`;
  };

  el.innerHTML =
    btn('‹ Prev', cur - 1, { disabled: cur <= 1 }) +
    pages.map((p) => (p === '…' ? '<span class="pager-gap">…</span>' : btn(String(p), p, { active: p === cur }))).join('') +
    btn('Next ›', cur + 1, { disabled: cur >= totalPages });

  el.querySelectorAll('.pager-btn[data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = parseInt(b.dataset.page, 10);
      if (!Number.isFinite(p) || p === cur) return;
      go(p);
    })
  );
}

function renderSpottedPager(totalPages) {
  renderPager($('#spotted-pager'), totalPages, state.spottedPage, (p) => {
    state.spottedPage = p;
    renderSpotted();
  });
}

// Photos load directly from the cached image proxy (<img src>), so only the
// routes need background fetching here. Hydrates just the rows passed in (the
// current page), so we don't fetch routes for aircraft that aren't visible.
function hydrateSpotted(rows) {
  const needRoute = (rows || []).filter((s) => s.callsign && !spottedRoute.has(s.callsign));
  runPool(needRoute, async (s) => {
    let entry = { route: null, agreement: null };
    try {
      const r = await (await fetch(`/api/route/${encodeURIComponent(s.callsign)}`)).json();
      entry = { route: r.route, agreement: r.agreement };
    } catch { /* ignore */ }
    spottedRoute.set(s.callsign, entry);
    $$(`#spotted-table td.spotted-route[data-cs="${s.callsign}"]`).forEach((c) => (c.innerHTML = spottedRouteHtml(s.callsign)));
  });
}

// Global onerror handler: replace a broken/absent photo with a ✈ placeholder.
window.imgFallback = (img) => {
  const cell = img.closest('.spotted-photo') || img.parentElement;
  if (cell) cell.innerHTML = '<span class="ph-skel ph-none">✈</span>';
};

$('#spotted-range').addEventListener('change', loadSpotted);
$('#spotted-pagesize').addEventListener('change', () => {
  state.spottedPage = 1;
  renderSpotted();
});
$$('#spotted-table th[data-sort]').forEach((th) =>
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.spottedSort.key === k) state.spottedSort.dir *= -1;
    else state.spottedSort = { key: k, dir: k === 'lastSeen' || k === 'firstSeen' || k === 'sessions' ? -1 : 1 };
    state.spottedPage = 1;
    renderSpotted();
  })
);

// ----------------------------------------------------------------- settings
async function loadSettings() {
  const c = await (await fetch('/api/config')).json();
  state.config = c;
  $('#s-src-mode').value = c.source?.mode || 'json';
  $('#s-sbs-host').value = c.source?.sbsHost || '';
  $('#s-sbs-port').value = c.source?.sbsPort || 30003;
  toggleSourceRows();
  $('#s-dump-url').value = c.dump1090Url;
  $('#s-poll').value = c.pollIntervalMs;
  $('#s-rlat').value = c.receiver.lat ?? '';
  $('#s-rlon').value = c.receiver.lon ?? '';
  $('#s-retention').value = c.retentionDays;
  $('#s-units').value = c.ui?.units || 'aviation';
  $('#s-po-enabled').checked = c.pushover.enabled;
  $('#s-po-token').value = c.pushover.token;
  $('#s-po-user').value = c.pushover.user;
  $('#s-dc-enabled').checked = c.discord.enabled;
  $('#s-dc-url').value = c.discord.webhookUrl;
  $('#s-browser-enabled').checked = c.browserNotifications.enabled;
  $('#s-cooldown').value = c.notifyCooldownMin;
  $('#s-notify-mil').checked = c.notifyMilitary;
  $('#s-notify-emerg').checked = c.notifyEmergency;
  $('#s-notify-passes').checked = c.notifySatellitePasses;
  $('#s-owm').value = '';
  $('#s-owm').placeholder = c.weather.hasOwmKey ? 'key configured ✓ (enter to replace)' : '(optional)';
  $('#s-openaip').value = '';
  $('#s-openaip').placeholder = c.openAip?.hasKey ? 'key configured ✓ (enter to replace)' : '(optional)';
  const meta = await (await fetch('/api/planedb/meta')).json();
  $('#s-padb-meta').textContent = meta.rows
    ? `${meta.rows.toLocaleString()} aircraft in DB, updated ${meta.updatedAt ? fmt.dateTime(meta.updatedAt) : '(bundled)'}`
    : 'Database not downloaded yet';
  const status = await (await fetch('/api/status')).json();
  $('#s-version').textContent = 'v' + (status.version || '?');
  $('#s-footer-version').textContent = 'v' + (status.version || '?');
  const acdb = status.aircraftDb || {};
  $('#s-acdb-meta').innerHTML = `${(acdb.count || 0).toLocaleString()} aircraft cached locally`
    + (acdb.error ? ` · <span style="color:var(--danger)">lookup problem: ${acdb.error}</span>` : ' · auto-filling as aircraft are seen');
  const fmeta = await (await fetch('/api/frequencies/meta')).json();
  $('#s-freq-meta').textContent = fmeta.count
    ? `${fmeta.count.toLocaleString()} airports with frequencies${fmeta.updatedAt ? ', updated ' + fmt.dateTime(fmeta.updatedAt) : ''}`
    : 'Not downloaded yet';
  const rng = await (await fetch('/api/range')).json();
  $('#s-range-meta').textContent = rng.meta?.sectors
    ? `${rng.meta.sectors}/360 sectors covered · max range ${rng.meta.maxKm} km`
    : 'No coverage recorded yet';
  loadStorage();
}

function fmtMb(bytes) {
  if (bytes == null) return '?';
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 1) + ' MB';
}

function renderStorage(s) {
  const size = s.logBytes != null ? fmtMb(s.logBytes) : fmtMb(s.fileBytes);
  $('#s-storage-meta').innerHTML =
    `Log size: <b>${size}</b> · ${s.sightings.toLocaleString()} sightings, `
    + `${s.alerts.toLocaleString()} alerts, ${s.tracks.toLocaleString()} replay points`
    + ` · database file ${fmtMb(s.fileBytes)}`;
}

async function loadStorage() {
  try {
    renderStorage(await (await fetch('/api/storage')).json());
  } catch {
    $('#s-storage-meta').textContent = 'Could not read storage size.';
  }
}

$('#s-range-clear').addEventListener('click', async () => {
  if (!confirm('Reset the recorded range outline? It will rebuild as aircraft are seen.')) return;
  await fetch('/api/range/clear', { method: 'POST' });
  $('#s-range-meta').textContent = 'Reset — rebuilding as aircraft are seen';
  if (state.rangeOn) drawRange();
});

$('#s-storage-purge').addEventListener('click', async () => {
  if (!confirm('Purge ALL log data now? This deletes the entire sighting history (Spotted/Statistics), the alert log, and the replay trail, then reclaims disk space. Reference data (aircraft DB, photos, frequencies) is kept. This cannot be undone.')) return;
  $('#s-storage-meta').textContent = 'Purging…';
  try {
    const s = await (await fetch('/api/storage/purge', { method: 'POST' })).json();
    renderStorage(s);
  } catch {
    $('#s-storage-meta').textContent = 'Purge failed.';
  }
});

$('#s-freq-refresh').addEventListener('click', async () => {
  $('#s-freq-meta').textContent = 'Downloading OurAirports data… (a few MB)';
  const res = await fetch('/api/frequencies/refresh', { method: 'POST' });
  const data = await res.json();
  $('#s-freq-meta').textContent = res.ok
    ? `✓ ${data.airports.toLocaleString()} airports with frequencies loaded`
    : `Failed: ${data.error}`;
});

async function importAircraftDb(body) {
  $('#s-acdb-meta').textContent = 'Importing… (large files can take a moment)';
  const res = await fetch('/api/aircraftdb/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) { $('#s-acdb-meta').innerHTML = `<span style="color:var(--danger)">Import failed: ${data.error}</span>`; return; }
  $('#s-acdb-meta').textContent = `✓ imported ${data.imported.toLocaleString()} — ${data.count.toLocaleString()} aircraft cached locally`;
}
$('#s-acdb-import-url').addEventListener('click', () => {
  const url = $('#s-acdb-url').value.trim();
  if (url) importAircraftDb({ url });
});
$('#s-acdb-import-file').addEventListener('click', () => $('#s-acdb-file').click());
$('#s-acdb-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) importAircraftDb({ csv: await file.text() });
});
function toggleSourceRows() {
  const sbs = $('#s-src-mode').value === 'sbs';
  $('#s-src-json').style.display = sbs ? 'none' : '';
  $('#s-src-sbs').style.display = sbs ? '' : 'none';
}
$('#s-src-mode').addEventListener('change', toggleSourceRows);

$('#s-save').addEventListener('click', async () => {
  const patch = {
    source: {
      mode: $('#s-src-mode').value,
      sbsHost: $('#s-sbs-host').value.trim(),
      sbsPort: parseInt($('#s-sbs-port').value, 10) || 30003
    },
    dump1090Url: $('#s-dump-url').value.trim(),
    pollIntervalMs: Math.max(500, parseInt($('#s-poll').value, 10) || 2000),
    receiver: {
      lat: parseFloat($('#s-rlat').value) || null,
      lon: parseFloat($('#s-rlon').value) || null
    },
    retentionDays: Math.max(1, parseInt($('#s-retention').value, 10) || 30),
    pushover: {
      enabled: $('#s-po-enabled').checked,
      token: $('#s-po-token').value.trim(),
      user: $('#s-po-user').value.trim()
    },
    discord: { enabled: $('#s-dc-enabled').checked, webhookUrl: $('#s-dc-url').value.trim() },
    browserNotifications: { enabled: $('#s-browser-enabled').checked },
    notifyCooldownMin: Math.max(1, parseInt($('#s-cooldown').value, 10) || 15),
    notifyMilitary: $('#s-notify-mil').checked,
    notifyEmergency: $('#s-notify-emerg').checked,
    notifySatellitePasses: $('#s-notify-passes').checked,
    ui: { units: $('#s-units').value }
  };
  if ($('#s-owm').value.trim()) patch.weather = { openWeatherMapKey: $('#s-owm').value.trim() };
  if ($('#s-openaip').value.trim()) patch.openAip = { apiKey: $('#s-openaip').value.trim() };
  await fetch('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
  });
  // Apply units immediately, no reload needed.
  state.units = patch.ui.units;
  applyUnits();
  $('#s-saved').textContent = '✓ saved';
  setTimeout(() => ($('#s-saved').textContent = ''), 3000);
  loadSettings();
});

// Re-render everything that shows units when the unit system changes.
function applyUnits() {
  renderAircraft();
  if (state.selected) updateDetailLive(state.aircraft.get(state.selected));
  if (typeof loadWeather === 'function') loadWeather(); // wind unit may change
}
$('#s-browser-perm').addEventListener('click', async () => {
  const perm = await Notification.requestPermission();
  toast({ kind: 'test', title: 'Browser notifications', message: `Permission: ${perm}` });
});
$('#s-test-notify').addEventListener('click', async () => {
  await fetch('/api/notify/test', { method: 'POST' });
});
$('#s-padb-refresh').addEventListener('click', async () => {
  $('#s-padb-meta').textContent = 'Downloading… (a few MB, can take a moment)';
  const res = await fetch('/api/planedb/refresh', { method: 'POST' });
  const data = await res.json();
  $('#s-padb-meta').textContent = res.ok ? `✓ ${data.rows.toLocaleString()} aircraft loaded` : `Failed: ${data.error}`;
});

// ----------------------------------------------------------------- boot
// ----------------------------------------------------------------- weather widget
// WMO weather code -> { icon (day/night), label }
function wxCondition(code, isDay) {
  const sun = isDay ? '☀️' : '🌙';
  const partly = isDay ? '⛅' : '☁️';
  const map = {
    0: [sun, 'Clear'], 1: [partly, 'Mainly clear'], 2: [partly, 'Partly cloudy'], 3: ['☁️', 'Overcast'],
    45: ['🌫️', 'Fog'], 48: ['🌫️', 'Rime fog'],
    51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Dense drizzle'],
    56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
    61: ['🌧️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
    66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
    71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['🌨️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
    80: ['🌦️', 'Light showers'], 81: ['🌦️', 'Showers'], 82: ['⛈️', 'Violent showers'],
    85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'],
    95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm w/ hail'], 99: ['⛈️', 'Thunderstorm w/ hail']
  };
  return map[code] || ['🌡️', 'Weather'];
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => (deg == null ? '' : COMPASS[Math.round(deg / 45) % 8]);

async function loadWeather() {
  const wx = $('#wx');
  try {
    const res = await fetch('/api/weather/current');
    if (!res.ok) { wx.classList.add('hidden'); return; }
    const w = await res.json();
    const [icon, label] = wxCondition(w.code, w.isDay);
    $('#wx-cond').textContent = icon;
    $('#wx-temp').textContent = w.temp != null ? `${Math.round(w.temp)}°C` : '—';
    if (w.windKmh != null) {
      const aviation = state.units === 'aviation';
      const v = aviation ? Math.round(w.windKmh / 1.852) : Math.round(w.windKmh);
      $('#wx-wind').textContent = `${v} ${aviation ? 'kt' : 'km/h'}${w.windDir != null ? ' ' + compass(w.windDir) : ''}`;
    } else $('#wx-wind').textContent = '—';
    $('#wx-hum').textContent = w.humidity != null ? `${Math.round(w.humidity)}%` : '—';
    $('#wx-rain').textContent = w.precipMm != null ? `${w.precipMm.toFixed(1)} mm` : '—';
    wx.title = `${label} · feels ${w.feels != null ? Math.round(w.feels) + '°C' : '—'} · updated ${fmt.time(w.ts)}`;
    wx.classList.remove('hidden');
  } catch {
    wx.classList.add('hidden');
  }
}

(async function boot() {
  try {
    state.config = await (await fetch('/api/config')).json();
    state.units = state.config.ui?.units || 'aviation';
  } catch { /* server starting */ }
  loadZones();
  connectStream();
  loadWeather();
  setInterval(loadWeather, 600000); // refresh every 10 min
  if (Notification.permission === 'default') {
    // unobtrusive: ask once after a short delay
    setTimeout(() => Notification.requestPermission(), 4000);
  }
})();
