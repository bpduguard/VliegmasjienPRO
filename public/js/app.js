/* VliegmasjienPRO frontend */
'use strict';

// ----------------------------------------------------------------- state
const state = {
  aircraft: new Map(), // hex -> aircraft
  receiver: null,
  selected: null,
  follow: false,
  filter: 'all',
  airlineQuery: '',
  showLabels: true,
  zones: [],
  config: null,
  weatherOn: false
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const fmt = {
  alt: (v) => (v == null ? '—' : v === 0 ? 'ground' : `${v.toLocaleString()} ft`),
  spd: (v) => (v == null ? '—' : `${Math.round(v)} kt (${Math.round(v * 1.852)} km/h)`),
  vr: (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v} fpm`),
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
    if (btn.dataset.tab === 'map') setTimeout(() => map.invalidateSize(), 50);
    if (btn.dataset.tab === 'stats') loadStats();
    if (btn.dataset.tab === 'watchlist') loadWatchlist();
    if (btn.dataset.tab === 'zones') loadZones();
    if (btn.dataset.tab === 'alerts') loadAlerts();
    if (btn.dataset.tab === 'settings') loadSettings();
  })
);

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

function planeSvg(color, track, onGround) {
  const rot = track ?? 0;
  const shape = onGround
    ? `<circle cx="13" cy="13" r="5" fill="${color}" stroke="#0b1220" stroke-width="1.2"/>`
    : `<path transform="rotate(${rot} 13 13)" fill="${color}" stroke="#0b1220" stroke-width="0.8"
        d="M13 1.5 L15 9 L24 14.5 L24 17 L15 14 L14.6 20.5 L17.5 23 L17.5 24.8 L13 23.4 L8.5 24.8 L8.5 23 L11.4 20.5 L11 14 L2 17 L2 14.5 L11 9 Z"/>`;
  return `<svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">${shape}</svg>`;
}

const markers = new Map(); // hex -> { marker, trail }

function classifiedVisible(ac) {
  if (state.filter !== 'all') {
    if (state.filter === 'emergency' && !ac.emergency) return false;
    if (state.filter !== 'emergency' && ac.classification !== state.filter) return false;
  }
  if (state.airlineQuery) {
    const q = state.airlineQuery.toLowerCase();
    const hay = `${ac.airline || ''} ${ac.airlineCallsign || ''} ${ac.flight || ''} ${ac.operator || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderAircraft() {
  const live = new Set();
  let visibleCount = 0;
  for (const ac of state.aircraft.values()) {
    if (ac.lat == null || ac.lon == null) continue;
    if (!classifiedVisible(ac)) continue;
    visibleCount++;
    live.add(ac.hex);
    const color = ac.emergency ? CLASS_COLORS.emergency : CLASS_COLORS[ac.classification] || CLASS_COLORS.unknown;
    const html = planeSvg(color, ac.track, ac.onGround);
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
    // selected: trail + follow
    if (state.selected === ac.hex) {
      const latlngs = (ac.trail || []).map((p) => [p[0], p[1]]);
      if (entry.trail) entry.trail.setLatLngs(latlngs);
      else entry.trail = L.polyline(latlngs, { color, weight: 2, opacity: 0.7 }).addTo(map);
      if (state.follow) map.panTo([ac.lat, ac.lon], { animate: true });
      updateDetailLive(ac);
    } else if (entry.trail) {
      map.removeLayer(entry.trail);
      entry.trail = null;
    }
  }
  // remove stale markers
  for (const [hex, entry] of markers) {
    if (!live.has(hex)) {
      map.removeLayer(entry.marker);
      if (entry.trail) map.removeLayer(entry.trail);
      markers.delete(hex);
    }
  }
  renderList(visibleCount);
}

// ----------------------------------------------------------------- aircraft list
function renderList(visibleCount) {
  $('#ac-count').textContent = `${visibleCount} aircraft`;
  const rows = [...state.aircraft.values()]
    .filter((ac) => classifiedVisible(ac))
    .sort((a, b) => (a.distKm ?? 9e9) - (b.distKm ?? 9e9))
    .slice(0, 150);
  const html = rows
    .map((ac) => {
      const cls = [
        'ac-row',
        ac.classification === 'military' ? 'mil' : '',
        ac.emergency ? 'emerg' : '',
        state.selected === ac.hex ? 'sel' : ''
      ].join(' ');
      return `<div class="${cls}" data-hex="${ac.hex}">
        <div>
          <div class="cs">${ac.flight || ac.registration || ac.hex.toUpperCase()}</div>
          <div class="meta">${ac.type || ac.typeName || ''}</div>
        </div>
        <div class="meta">${fmt.alt(ac.alt)}<br>${ac.distKm != null ? ac.distKm + ' km' : ''}</div>
      </div>`;
    })
    .join('');
  $('#ac-list').innerHTML = html;
}
$('#ac-list').addEventListener('click', (e) => {
  const row = e.target.closest('.ac-row');
  if (row) selectAircraft(row.dataset.hex, true);
});
$('#ac-list-collapse').addEventListener('click', () => $('#ac-list-panel').classList.toggle('collapsed'));

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
  state.selected = hex;
  state.follow = false;
  $('#d-follow').classList.remove('active');
  $('#detail').classList.remove('hidden');
  $('#d-ai').classList.add('hidden');
  $('#d-ai').textContent = '';
  const ac = state.aircraft.get(hex);
  if (ac && pan && ac.lat != null) map.panTo([ac.lat, ac.lon]);
  renderAircraft();
  updateDetailLive(ac);
  loadDetailExtras(hex);
}

function updateDetailLive(ac) {
  if (!ac) return;
  $('#d-callsign').textContent = ac.flight || ac.registration || ac.hex.toUpperCase();
  const subParts = [ac.hex.toUpperCase(), ac.registration, ac.typeName || ac.type, ac.airline || ac.operator].filter(Boolean);
  $('#d-sub').textContent = subParts.join(' · ');

  const badges = [];
  badges.push(`<span class="badge ${badgeClass(ac)}">${ac.classification}</span>`);
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
  // photo
  $('#d-photo').innerHTML = '';
  fetch(`/api/aircraft/${hex}/photo`)
    .then((r) => r.json())
    .then(({ photo }) => {
      if (state.selected !== hex) return;
      if (photo?.thumb) {
        $('#d-photo').innerHTML = `<a href="${photo.link}" target="_blank" rel="noopener">
          <img src="${photo.thumb}" alt="aircraft photo" /></a>
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
      if (!d.route) {
        $('#d-route').innerHTML = '<span class="muted">No route data for this callsign</span>';
        return;
      }
      const o = d.route.origin, dst = d.route.destination;
      let html = '';
      if (d.route.airline?.name) html += `<div class="muted" style="margin-bottom:6px">${d.route.airline.name}</div>`;
      html += `<div class="route-box">
        <div class="route-airport"><div class="code">${o?.iata || o?.icao || '?'}</div>
          <div class="name">${o ? `${o.municipality || o.name}, ${o.country}` : 'Unknown'}</div></div>
        <div class="route-arrow">→</div>
        <div class="route-airport" style="text-align:right"><div class="code">${dst?.iata || dst?.icao || '?'}</div>
          <div class="name">${dst ? `${dst.municipality || dst.name}, ${dst.country}` : 'Unknown'}</div></div>
      </div>`;
      const etas = [];
      if (d.distFromOriginKm != null) etas.push(`${d.distFromOriginKm} km flown from origin`);
      if (d.distToDestKm != null) etas.push(`${d.distToDestKm} km to go`);
      if (d.etaDestSec != null) {
        const eta = new Date(Date.now() + d.etaDestSec * 1000);
        etas.push(`<b>ETA ${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b> (~${fmt.dur(d.etaDestSec)})`);
      }
      etas.push(`tracked since ${fmt.time(d.firstSeen)}`);
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
            ${h.callsign ? ' · ' + h.callsign : ''}${h.max_alt ? ' · max ' + h.max_alt + ' ft' : ''}
            ${h.min_dist_km != null ? ' · closest ' + h.min_dist_km.toFixed(1) + ' km' : ''}</div>`
        )
        .join('');
    })
    .catch(() => {});
}

$('#d-close').addEventListener('click', () => {
  state.selected = null;
  state.follow = false;
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

// AI lookup (SSE stream)
let aiSource = null;
$('#d-ai-btn').addEventListener('click', () => {
  const hex = state.selected;
  if (!hex) return;
  if (aiSource) aiSource.close();
  const out = $('#d-ai');
  out.classList.remove('hidden');
  out.textContent = '🤖 Claude is looking up this aircraft…\n\n';
  let started = false;
  aiSource = new EventSource(`/api/aircraft/${hex}/ai`);
  aiSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.text) {
      if (!started) { out.textContent = ''; started = true; }
      out.textContent += data.text;
      out.scrollTop = out.scrollHeight;
    }
    if (data.error) { out.textContent = '⚠️ ' + data.error; aiSource.close(); }
    if (data.done) aiSource.close();
  };
  aiSource.onerror = () => aiSource.close();
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
async function loadAlerts() {
  const { alerts } = await (await fetch('/api/alerts')).json();
  $('#alerts-table tbody').innerHTML = alerts
    .map(
      (a) => `<tr><td>${fmt.dateTime(a.ts)}</td><td>${a.kind}</td>
        <td>${a.callsign || a.hex || '—'}</td><td>${a.message}</td></tr>`
    )
    .join('') || '<tr><td colspan="4" class="muted">No alerts yet</td></tr>';
}

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
  $('#s-po-enabled').checked = c.pushover.enabled;
  $('#s-po-token').value = c.pushover.token;
  $('#s-po-user').value = c.pushover.user;
  $('#s-dc-enabled').checked = c.discord.enabled;
  $('#s-dc-url').value = c.discord.webhookUrl;
  $('#s-browser-enabled').checked = c.browserNotifications.enabled;
  $('#s-cooldown').value = c.notifyCooldownMin;
  $('#s-notify-mil').checked = c.notifyMilitary;
  $('#s-notify-emerg').checked = c.notifyEmergency;
  $('#s-owm').value = '';
  $('#s-owm').placeholder = c.weather.hasOwmKey ? 'key configured ✓ (enter to replace)' : '(optional)';
  $('#s-anthropic').value = '';
  $('#s-anthropic').placeholder = c.anthropic.hasKey ? 'key configured ✓ (enter to replace)' : 'sk-ant-…';
  $('#s-anthropic-status').textContent = c.anthropic.hasKey ? `✓ AI enabled (${c.anthropic.model})` : 'AI disabled — no key';
  const meta = await (await fetch('/api/planedb/meta')).json();
  $('#s-padb-meta').textContent = meta.rows
    ? `${meta.rows.toLocaleString()} aircraft in DB, updated ${meta.updatedAt ? fmt.dateTime(meta.updatedAt) : '(bundled)'}`
    : 'Database not downloaded yet';
}
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
    notifyEmergency: $('#s-notify-emerg').checked
  };
  if ($('#s-owm').value.trim()) patch.weather = { openWeatherMapKey: $('#s-owm').value.trim() };
  if ($('#s-anthropic').value.trim()) patch.anthropic = { apiKey: $('#s-anthropic').value.trim() };
  await fetch('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
  });
  $('#s-saved').textContent = '✓ saved';
  setTimeout(() => ($('#s-saved').textContent = ''), 3000);
  loadSettings();
});
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
(async function boot() {
  try {
    state.config = await (await fetch('/api/config')).json();
  } catch { /* server starting */ }
  loadZones();
  connectStream();
  if (Notification.permission === 'default') {
    // unobtrusive: ask once after a short delay
    setTimeout(() => Notification.requestPermission(), 4000);
  }
})();
