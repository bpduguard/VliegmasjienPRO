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

// Escape untrusted text before putting it in innerHTML / tooltips. Aircraft
// callsigns are broadcast over the air (attacker-controlled), and operator /
// type / tags / airport names come from third-party feeds — so anything that
// originates outside our own code is escaped. (A strict CSP is the backstop.)
const esc = (v) => (v == null ? '' : String(v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

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
    if (btn.dataset.tab !== 'arrivals') stopArrivalsBoard(); // stop the board's timers when leaving it
    if (btn.dataset.tab !== 'detections') stopDetections();
    if (btn.dataset.tab === 'map') setTimeout(() => { map.invalidateSize(); renderAircraft(); }, 50);
    if (btn.dataset.tab === 'arrivals') loadArrivals();
    if (btn.dataset.tab === 'detections') loadDetections();
    if (btn.dataset.tab === 'stats') loadStats();
    if (btn.dataset.tab === 'watchlist') loadWatchlist();
    if (btn.dataset.tab === 'spotted') loadSpotted();
    if (btn.dataset.tab === 'zones') loadZones();
    if (btn.dataset.tab === 'alerts') loadAlerts();
    if (btn.dataset.tab === 'weather') loadWeatherTab();
    if (btn.dataset.tab === 'skywatch') loadSkyWatch();
    if (btn.dataset.tab === 'settings') loadSettings();
  })
);
// Catch up the map view when the page becomes visible again after being hidden.
document.addEventListener('visibilitychange', () => { if (mapVisible()) renderAircraft(); });

// ----------------------------------------------------------------- auth (public / private split)
state.auth = { passwordSet: false, authenticated: false };
const isAuthed = () => !!state.auth.authenticated;

async function loadAuth() {
  try { state.auth = await (await fetch('/api/auth/status')).json(); }
  catch { state.auth = { passwordSet: false, authenticated: false }; }
  applyAuthMode();
}

function applyAuthMode() {
  const authed = isAuthed();
  document.body.classList.toggle('mode-auth', authed);
  document.body.classList.toggle('mode-public', !authed);
  const btn = $('#auth-btn');
  if (btn) { btn.textContent = authed ? '🔓 Logout' : '🔒 Login'; btn.title = authed ? 'Log out' : 'Log in for full access'; }
  renderAuthGate();
}

function gotoSettings() {
  $$('#tabs button').forEach((b) => b.classList.remove('active'));
  $('#tabs button[data-tab="settings"]').classList.add('active');
  $$('.tab').forEach((t) => t.classList.remove('active'));
  $('#tab-settings').classList.add('active');
}

$('#auth-btn').addEventListener('click', () => {
  if (isAuthed()) logout();
  else { gotoSettings(); setTimeout(() => $('#auth-gate input')?.focus(), 60); }
});

function authMsg(t, cls) { const el = $('#auth-msg'); if (el) { el.textContent = t; el.className = 'auth-msg ' + (cls || ''); } }

function renderAuthGate() {
  const gate = $('#auth-gate'); if (!gate) return;
  if (isAuthed()) {
    const twoFA = state.auth.twoFactorEnabled;
    gate.innerHTML = `<div class="auth-card"><h3>🔓 Authenticated — full access</h3>
      <p class="muted">Visitors without the password get the public view: the map, statistics and spotted list, with the
        receiver location and any location-revealing feature (distance rings, range outline, heatmap, distances) hidden.</p>
      <div class="row"><button id="auth-logout">Log out</button><button id="auth-change">Change password…</button></div>
      <div id="auth-change-form" class="hidden">
        <div class="row"><input id="auth-cur" type="password" placeholder="current password" /></div>
        <div class="row"><input id="auth-new" type="password" placeholder="new password (min 8)" />
          <button id="auth-change-save" class="primary">Save</button></div>
      </div>
      <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
      <div class="row" style="margin-bottom:4px"><strong>Two-factor authentication (2FA)</strong>
        <span class="${twoFA ? 'ok' : 'muted'}" style="font-size:0.85rem">${twoFA ? '● enabled' : '○ disabled'}</span></div>
      ${twoFA
        ? `<p class="muted">A 6-digit authenticator code is required at login.</p>
           <button id="twofa-disable-btn">Disable 2FA…</button>
           <div id="twofa-disable-form" class="hidden" style="margin-top:8px">
             <div class="row"><input id="twofa-dis-pw" type="password" placeholder="password" />
               <input id="twofa-dis-code" inputmode="numeric" maxlength="6" placeholder="2FA code" style="width:120px" />
               <button id="twofa-dis-save" class="danger">Disable</button></div>
           </div>`
        : `<p class="muted">Add a second factor: scan the QR with Google Authenticator / Authy and enter the code to confirm.</p>
           <button id="twofa-enable-btn" class="primary">Enable 2FA…</button>
           <div id="twofa-enroll" class="hidden" style="margin-top:10px"></div>`}
      <div class="auth-msg" id="auth-msg"></div></div>`;
    $('#auth-logout').addEventListener('click', logout);
    $('#auth-change').addEventListener('click', () => $('#auth-change-form').classList.toggle('hidden'));
    $('#auth-change-save').addEventListener('click', changePassword);
    if (twoFA) {
      $('#twofa-disable-btn').addEventListener('click', () => $('#twofa-disable-form').classList.toggle('hidden'));
      $('#twofa-dis-save').addEventListener('click', disable2fa);
    } else {
      $('#twofa-enable-btn').addEventListener('click', begin2faEnroll);
    }
  } else if (state.auth.passwordSet) {
    const twoFA = state.auth.twoFactorEnabled;
    gate.innerHTML = `<div class="auth-card"><h3>🔒 Log in</h3>
      <p class="muted">Enter the password to unlock all features — Settings, Watchlist, Zones, Alerts, the receiver location,
        distance rings, range outline and heatmap.</p>
      <div class="row"><input id="auth-pw" type="password" placeholder="password" /></div>
      ${twoFA ? `<div class="row"><input id="auth-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6-digit 2FA code" /></div>` : ''}
      <div class="row"><button id="auth-login" class="primary">Log in</button></div>
      <div class="auth-msg" id="auth-msg"></div></div>`;
    const go = () => login($('#auth-pw').value, $('#auth-code')?.value);
    $('#auth-login').addEventListener('click', go);
    $('#auth-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('#auth-code')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  } else {
    gate.innerHTML = `<div class="auth-card"><h3>🔑 Set up a password</h3>
      <p class="muted">No password is configured yet. Create one to protect the private side of this tracker. Until you do,
        everything runs in the restricted <strong>public</strong> view (receiver location hidden).</p>
      <div class="row"><input id="auth-new1" type="password" placeholder="new password (min 8)" /></div>
      <div class="row"><input id="auth-new2" type="password" placeholder="confirm password" />
        <button id="auth-setup" class="primary">Create password</button></div>
      <div class="auth-msg" id="auth-msg"></div></div>`;
    const go = () => setupPassword($('#auth-new1').value, $('#auth-new2').value);
    $('#auth-setup').addEventListener('click', go);
    $('#auth-new2').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
}

async function login(pw, code) {
  const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw, code }) });
  if (r.ok) { location.reload(); return; }
  const j = await r.json().catch(() => ({}));
  authMsg(j.error || (r.status === 429 ? 'Too many attempts — please wait.' : 'Login failed'), 'err');
}

// ---- 2FA enrollment / disable (authenticated) ----
async function begin2faEnroll() {
  const box = $('#twofa-enroll');
  box.classList.remove('hidden');
  box.innerHTML = '<span class="muted">Generating…</span>';
  let d = {};
  try { d = await (await fetch('/api/auth/2fa/setup', { method: 'POST' })).json(); } catch { /* ignore */ }
  if (!d.secret) { box.innerHTML = '<span class="auth-msg err">Could not start 2FA setup.</span>'; return; }
  box.innerHTML = `
    ${d.qr ? `<img class="twofa-qr" src="${d.qr}" alt="2FA QR code" />` : ''}
    <div class="muted" style="font-size:0.8rem">Or enter this key manually:</div>
    <div class="twofa-secret">${d.secret.replace(/(.{4})/g, '$1 ').trim()}</div>
    <div class="row" style="margin-top:8px"><input id="twofa-code" inputmode="numeric" maxlength="6" placeholder="code from app" style="width:140px" />
      <button id="twofa-confirm" class="primary">Verify &amp; enable</button></div>`;
  const go = async () => {
    const r = await fetch('/api/auth/2fa/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: $('#twofa-code').value }) });
    if (r.ok) location.reload();
    else authMsg((await r.json().catch(() => ({}))).error || '2FA enable failed', 'err');
  };
  $('#twofa-confirm').addEventListener('click', go);
  $('#twofa-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function disable2fa() {
  const r = await fetch('/api/auth/2fa/disable', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: $('#twofa-dis-pw').value, code: $('#twofa-dis-code').value })
  });
  if (r.ok) location.reload();
  else authMsg((await r.json().catch(() => ({}))).error || 'Could not disable 2FA', 'err');
}
async function setupPassword(p1, p2) {
  if ((p1 || '').length < 8) return authMsg('Password must be at least 8 characters', 'err');
  if (p1 !== p2) return authMsg('Passwords do not match', 'err');
  const r = await fetch('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: p1 }) });
  if (r.ok) location.reload();
  else authMsg((await r.json().catch(() => ({}))).error || 'Setup failed', 'err');
}
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
}
async function changePassword() {
  const r = await fetch('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: $('#auth-cur').value, password: $('#auth-new').value }) });
  if (r.ok) authMsg('Password changed ✓', 'ok');
  else authMsg((await r.json().catch(() => ({}))).error || 'Change failed', 'err');
}

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
    || $('#heatmap-toggle').checked || $('#airspace-toggle').checked || $('#metar-toggle').checked
    || $('#webcam-toggle').checked;
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
    const op = esc([a.operator, a.type].filter(Boolean).join(' · '));
    const from = esc(a.origin ? (a.origin.iata || a.origin.icao || a.origin.name || '?') : '?');
    const fromTitle = esc(a.origin ? [a.origin.name, a.origin.country].filter(Boolean).join(', ') : 'unknown origin');
    return `<tr data-hex="${esc(a.hex)}">
      <td><b>${esc(a.callsign)}</b>${op ? `<br><span class="muted">${op}</span>` : ''}</td>
      <td title="${fromTitle}">${from}</td>
      <td>${fmt.time(a.arrivalMs)}</td>
      <td>${a.etaSec != null ? fmt.dur(a.etaSec) : '—'}</td>
    </tr>`;
  }).join('');
  const title = esc([ap.iata || ap.icao, ap.name].filter(Boolean).join(' · ') || 'Airport');
  return `<div class="arr-popup">
    <div class="arr-title">🛬 ${title}${ap.country ? ` <span class="muted">${esc(ap.country)}</span>` : ''}</div>
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

// ----------------------------------------------------------------- airport webcams layer
// Markers at airports/locations with known webcam feeds; clicking embeds the live
// feed in-app with a switcher when a location has several. Built-in list + Windy.
const webcamLayer = L.layerGroup();
let webcamTimer = null;
let wcFeeds = [], wcIdx = 0; // the currently-open location's feeds + selected index

const wcShort = (s) => (s && s.length > 18 ? s.slice(0, 17) + '…' : (s || 'Webcam'));

async function drawWebcams() {
  const b = map.getBounds();
  try {
    const url = `/api/webcams?n=${b.getNorth()}&s=${b.getSouth()}&e=${b.getEast()}&w=${b.getWest()}`;
    const data = await (await fetch(url)).json();
    webcamLayer.clearLayers();
    const list = (data.webcams || []).filter((c) => !state.webcamAirportsOnly || c.isAirport);
    for (const c of list) {
      if (c.lat == null || c.lon == null) continue;
      const nFeeds = c.feeds.length;
      const label = esc(c.icao || wcShort(c.name));
      const icon = L.divIcon({
        className: 'webcam-icon',
        html: `<div class="webcam-pin${c.isAirport ? ' is-airport' : ''}"><span class="webcam-code">📷 ${label}</span>${nFeeds > 1 ? `<span class="webcam-badge">${nFeeds}</span>` : ''}</div>`,
        iconSize: [64, 22], iconAnchor: [32, 11]
      });
      L.marker([c.lat, c.lon], { icon, zIndexOffset: 900 })
        .addTo(webcamLayer)
        .on('click', () => openWebcam(c));
    }
    if (!list.length && !state.webcamHinted) {
      state.webcamHinted = true;
      toast({ kind: 'test', title: 'Webcams',
        message: state.webcamAirportsOnly
          ? 'No webcams at airports in this area. Turn off “Airports only”, or pan to a field.'
          : data.hasKey
            ? 'No webcams found in this area. Pan/zoom around.'
            : 'No feeds here yet. Add your own in Settings → Webcams, or add a free Windy Webcams API key to discover more.' });
    }
  } catch { /* ignore */ }
}

function openWebcam(c) {
  wcFeeds = c.feeds || [];
  wcIdx = 0;
  if (!wcFeeds.length) return;
  let title = c.icao ? `📷 ${c.name} (${c.icao})` : `📷 ${c.name}`;
  if (c.near && !c.icao) title += ` · near ${c.near.icao || c.near.name} (${c.near.distKm} km)`;
  $('#wc-title').textContent = title;
  $('#webcam-panel').classList.remove('hidden');
  showWebcamFeed();
}
function showWebcamFeed() {
  const f = wcFeeds[wcIdx];
  if (!f) return;
  $('#wc-frame').src = f.embed;
  $('#wc-open').href = f.embed;
  $('#wc-count').textContent = `${wcIdx + 1}/${wcFeeds.length}`;
  $('#wc-feedtitle').textContent = f.title || '';
  const multi = wcFeeds.length > 1;
  $('#wc-prev').style.visibility = multi ? 'visible' : 'hidden';
  $('#wc-next').style.visibility = multi ? 'visible' : 'hidden';
  $('#wc-count').style.visibility = multi ? 'visible' : 'hidden';
}
function closeWebcam() {
  $('#webcam-panel').classList.add('hidden');
  $('#wc-frame').src = 'about:blank'; // stop the stream
}
$('#wc-prev').addEventListener('click', () => { wcIdx = (wcIdx - 1 + wcFeeds.length) % wcFeeds.length; showWebcamFeed(); });
$('#wc-next').addEventListener('click', () => { wcIdx = (wcIdx + 1) % wcFeeds.length; showWebcamFeed(); });
$('#wc-close').addEventListener('click', closeWebcam);

$('#webcam-toggle').addEventListener('change', (e) => {
  state.webcamOn = e.target.checked;
  $('#webcam-opts').classList.toggle('hidden', !state.webcamOn);
  if (state.webcamOn) {
    webcamLayer.addTo(map);
    drawWebcams();
    map.on('moveend', drawWebcams);
  } else {
    map.off('moveend', drawWebcams);
    map.removeLayer(webcamLayer);
    webcamLayer.clearLayers();
    closeWebcam();
  }
  refreshLayersBtn();
});
$('#webcam-airports-only').addEventListener('change', (e) => {
  state.webcamAirportsOnly = e.target.checked;
  state.webcamHinted = false;
  if (state.webcamOn) drawWebcams();
});

// Settings: manage custom webcam feeds
async function loadWebcamCustom() {
  try {
    const { custom } = await (await fetch('/api/webcams/custom')).json();
    $('#wc-custom-list').innerHTML = (custom && custom.length)
      ? custom.map((e) => {
          const f = (e.feeds && e.feeds[0]) || {};
          const ap = [e.icao, e.name].filter(Boolean).join(' · ') || '—';
          return `<div class="wc-custom-row">
            <span class="wc-c-ap">${esc(ap)}</span>
            <span class="wc-c-title">${esc(f.title || '')}</span>
            <span class="wc-c-embed muted" title="${esc(f.embed || '')}">${esc(f.embed || '')}</span>
            ${e.id ? `<button class="wc-c-del" data-id="${esc(e.id)}">delete</button>` : ''}
          </div>`;
        }).join('')
      : '<span class="muted">No custom feeds yet.</span>';
  } catch { /* not authed / offline */ }
}
$('#wc-add-lookup').addEventListener('click', async () => {
  const ident = $('#wc-add-icao').value.trim();
  if (!ident) return;
  try {
    const r = await fetch(`/api/airports/lookup?ident=${encodeURIComponent(ident)}`);
    if (!r.ok) { $('#wc-add-msg').textContent = 'Airport not found — load the frequency database (below) or enter coordinates manually.'; return; }
    const a = await r.json();
    $('#wc-add-name').value = a.name || '';
    $('#wc-add-lat').value = a.lat; $('#wc-add-lon').value = a.lon;
    $('#wc-add-msg').textContent = `Found ${a.ident} — ${a.name}`;
  } catch { /* ignore */ }
});
$('#wc-add-btn').addEventListener('click', async () => {
  const body = {
    icao: $('#wc-add-icao').value.trim(), name: $('#wc-add-name').value.trim(),
    lat: $('#wc-add-lat').value.trim(), lon: $('#wc-add-lon').value.trim(),
    title: $('#wc-add-title').value.trim(), embed: $('#wc-add-embed').value.trim()
  };
  const r = await fetch('/api/webcams/custom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('#wc-add-msg').textContent = data.error || 'Failed to add.'; return; }
  ['#wc-add-icao', '#wc-add-name', '#wc-add-lat', '#wc-add-lon', '#wc-add-title', '#wc-add-embed'].forEach((s) => ($(s).value = ''));
  $('#wc-add-msg').textContent = data.warning || '✓ Feed added.';
  loadWebcamCustom();
  if (state.webcamOn) drawWebcams();
});
$('#wc-custom-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.wc-c-del');
  if (!btn) return;
  await fetch(`/api/webcams/custom/${btn.dataset.id}`, { method: 'DELETE' });
  loadWebcamCustom();
  if (state.webcamOn) drawWebcams();
});

// ----------------------------------------------------------------- arrivals board (FIDS tab)
// A live airport-style arrivals board. Data (routes + ETA) is refreshed from the
// server every ~12s; the clock and ETA countdowns tick every second in between so
// the board feels live without hammering the backend.
const arrivalsBoardState = { data: [], filter: 'all', dataTimer: null, tickTimer: null };
const STATUS_CLASS = { 'Landing': 'st-landing', 'Approaching': 'st-appr', 'Descending': 'st-desc', 'En route': 'st-enroute' };

function loadArrivals() {
  stopArrivalsBoard();
  fetchArrivalsBoard();
  arrivalsBoardState.dataTimer = setInterval(fetchArrivalsBoard, 12000);
  arrivalsBoardState.tickTimer = setInterval(renderArrivalsBoard, 1000);
}
function stopArrivalsBoard() {
  if (arrivalsBoardState.dataTimer) { clearInterval(arrivalsBoardState.dataTimer); arrivalsBoardState.dataTimer = null; }
  if (arrivalsBoardState.tickTimer) { clearInterval(arrivalsBoardState.tickTimer); arrivalsBoardState.tickTimer = null; }
}
async function fetchArrivalsBoard() {
  try {
    const d = await (await fetch('/api/arrivals/board')).json();
    arrivalsBoardState.data = d.arrivals || [];
    refreshArrDestFilter();
    renderArrivalsBoard();
  } catch { /* keep last-known board */ }
}

// Populate the destination dropdown from the current data, preserving selection.
function refreshArrDestFilter() {
  const sel = $('#arr-dest-filter');
  const dests = new Map(); // code -> label
  for (const a of arrivalsBoardState.data) {
    const code = a.destination.iata || a.destination.icao;
    if (code && !dests.has(code)) dests.set(code, a.destination.name ? `${code} — ${a.destination.name}` : code);
  }
  const cur = arrivalsBoardState.filter;
  const opts = ['<option value="all">All destinations</option>']
    .concat([...dests.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([code, label]) => `<option value="${esc(code)}">${esc(label)}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = [...dests.keys()].includes(cur) || cur === 'all' ? cur : 'all';
  arrivalsBoardState.filter = sel.value;
}

function renderArrivalsBoard() {
  const now = Date.now();
  $('#arr-clock').textContent = new Date(now).toLocaleTimeString();
  const filter = arrivalsBoardState.filter;
  const rows = arrivalsBoardState.data.filter((a) =>
    filter === 'all' || a.destination.iata === filter || a.destination.icao === filter);
  $('#arr-count').textContent = `${rows.length} inbound`;

  const empty = $('#arr-empty');
  if (!rows.length) {
    $('#arr-rows').innerHTML = '';
    empty.textContent = arrivalsBoardState.data.length
      ? 'No inbound flights for this destination right now.'
      : 'No inbound flights with a known route yet — routes are looked up as airliners are tracked.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  $('#arr-rows').innerHTML = rows.map((a) => {
    const eta = a.arrivalMs - now;              // live countdown
    const mins = Math.round(eta / 60000);
    const count = eta <= 0 ? 'due' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
    const from = a.origin ? (a.origin.iata || a.origin.icao || '???') : '???';
    const fromTitle = esc(a.origin ? [a.origin.name, a.origin.country].filter(Boolean).join(', ') : 'unknown origin');
    const to = a.destination.iata || a.destination.icao || '???';
    const toTitle = esc([a.destination.name, a.destination.country].filter(Boolean).join(', ') || 'unknown');
    const acLine = esc([a.operator, a.typeName || a.type].filter(Boolean).join(' · ') || (a.registration || ''));
    const prog = a.progress != null ? Math.round(a.progress * 100) : null;
    const progBar = prog == null
      ? '<span class="muted">—</span>'
      : `<div class="arr-prog" title="${prog}% of route flown"><div class="arr-prog-fill" style="width:${prog}%"></div><span class="arr-plane" style="left:${prog}%">✈</span></div>`;
    const stCls = STATUS_CLASS[a.status] || 'st-enroute';
    return `<tr data-hex="${esc(a.hex)}" title="Show ${esc(a.callsign)} on the map">
      <td class="arr-eta"><b>${fmt.time(a.arrivalMs)}</b><span class="arr-count">${count}</span></td>
      <td class="arr-flight">${esc(a.callsign)}${a.registration ? `<span class="arr-reg">${esc(a.registration)}</span>` : ''}</td>
      <td class="col-ac"><span class="muted">${acLine || '—'}</span></td>
      <td class="arr-code" title="${fromTitle}">${esc(from)}</td>
      <td class="arr-code" title="${toTitle}">${esc(to)}</td>
      <td class="col-dist">${a.flownKm != null ? esc(fmt.dist(a.flownKm)) : '—'}</td>
      <td class="col-dist">${esc(fmt.dist(a.toGoKm))}</td>
      <td class="col-prog">${progBar}</td>
      <td><span class="arr-status ${stCls}">${esc(a.status)}</span></td>
    </tr>`;
  }).join('');
}

// Row click → jump to the map and select that aircraft (if still live).
$('#arr-rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-hex]');
  if (!tr) return;
  const hex = tr.dataset.hex;
  $('#tabs button[data-tab="map"]').click();
  if (state.aircraft.has(hex)) selectAircraft(hex, true);
});
$('#arr-dest-filter').addEventListener('change', (e) => {
  arrivalsBoardState.filter = e.target.value;
  renderArrivalsBoard();
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

// ---- METAR decoder: turn a raw report into a token-by-token explanation ----
const METAR_KEYWORDS = new Set(['METAR', 'SPECI', 'COR', 'AUTO', 'NOSIG', 'CAVOK', 'BECMG', 'TEMPO',
  'NSC', 'NCD', 'SKC', 'CLR', 'NSW', 'RMK']);
const WX_DESC = { MI: 'shallow', BC: 'patches of', PR: 'partial', DR: 'low drifting', BL: 'blowing', SH: 'showers of', TS: 'thunderstorm', FZ: 'freezing' };
const WX_PHEN = { DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets', GR: 'hail', GS: 'small hail', UP: 'unknown precip', BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash', DU: 'widespread dust', SA: 'sand', HZ: 'haze', PY: 'spray', PO: 'dust/sand whirls', SQ: 'squalls', FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm' };
const CLOUD_COVER = { FEW: 'Few clouds', SCT: 'Scattered clouds', BKN: 'Broken clouds', OVC: 'Overcast', VV: 'Vertical visibility' };

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Returns a plain-English weather string (e.g. "+TSRA" -> "heavy thunderstorm rain") or null.
function describeWx(s) {
  let str = s, prefix = '';
  const im = /^(-|\+|VC)/.exec(str);
  if (im) { prefix = { '-': 'light ', '+': 'heavy ', VC: 'in the vicinity: ' }[im[1]]; str = str.slice(im[1].length); }
  const words = []; let matched = false;
  while (str.length >= 2) {
    const code = str.slice(0, 2);
    if (WX_DESC[code]) words.push(WX_DESC[code]);
    else if (WX_PHEN[code]) words.push(WX_PHEN[code]);
    else break;
    matched = true; str = str.slice(2);
  }
  if (!matched || str.length) return null;
  return (prefix + words.join(' ')).trim();
}

function describeMetarToken(t, couldBeStation) {
  let m;
  if (couldBeStation && /^[A-Z]{4}$/.test(t)) return 'Reporting station';
  if ((m = /^(\d{2})(\d{2})(\d{2})Z$/.exec(t))) return `Observed on the ${ordinal(+m[1])} at ${m[2]}:${m[3]} UTC`;
  if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(t))) {
    const unit = { KT: 'kt', MPS: 'm/s', KMH: 'km/h' }[m[4]];
    if (m[1] === '000' && m[2] === '00') return 'Wind calm';
    const dir = m[1] === 'VRB' ? 'variable direction' : `from ${parseInt(m[1], 10)}°`;
    return `Wind ${dir} at ${parseInt(m[2], 10)} ${unit}${m[3] ? `, gusting ${parseInt(m[3], 10)} ${unit}` : ''}`;
  }
  if ((m = /^(\d{3})V(\d{3})$/.exec(t))) return `Wind direction varying between ${parseInt(m[1], 10)}° and ${parseInt(m[2], 10)}°`;
  if ((m = /^(\d{4})(NDV)?$/.exec(t))) return m[1] === '9999' ? 'Visibility 10 km or more' : `Visibility ${parseInt(m[1], 10).toLocaleString()} m`;
  if ((m = /^(M)?(\d+(?:\/\d+)?)SM$/.exec(t))) return `Visibility ${m[1] ? 'less than ' : ''}${m[2]} statute mile(s)`;
  if ((m = /^R(\d{2}[LCR]?)\/([MP]?)(\d{3,4})/.exec(t))) return `Runway ${m[1]} visual range ${m[2] === 'M' ? 'less than ' : m[2] === 'P' ? 'more than ' : ''}${parseInt(m[3], 10)} m/ft`;
  if ((m = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/.exec(t))) {
    const alt = (parseInt(m[2], 10) * 100).toLocaleString();
    if (m[1] === 'VV') return `Vertical visibility ${alt} ft`;
    const type = m[3] === 'CB' ? ' (cumulonimbus)' : m[3] === 'TCU' ? ' (towering cumulus)' : '';
    return `${CLOUD_COVER[m[1]]} at ${alt} ft${type}`;
  }
  if ((m = /^(M)?(\d{2})\/(M)?(\d{2})$/.exec(t))) return `Temperature ${(m[1] ? '-' : '') + parseInt(m[2], 10)}°C, dew point ${(m[3] ? '-' : '') + parseInt(m[4], 10)}°C`;
  if ((m = /^(M)?(\d{2})\/+$/.exec(t))) return `Temperature ${(m[1] ? '-' : '') + parseInt(m[2], 10)}°C, dew point not reported`;
  if ((m = /^Q(\d{3,4})$/.exec(t))) return `Altimeter (QNH) ${parseInt(m[1], 10)} hPa`;
  if ((m = /^A(\d{4})$/.exec(t))) return `Altimeter ${(parseInt(m[1], 10) / 100).toFixed(2)} inHg`;
  if ((m = /^RE(.+)$/.exec(t))) return `Recent ${describeWx(m[1]) || m[1]}`;
  if (/^WS/.test(t)) return 'Wind shear';
  return describeWx(t) || '—';
}

function decodeMetar(raw) {
  if (!raw) return [];
  const rows = [];
  let stationSeen = false, inRmk = false;
  for (const t of raw.trim().split(/\s+/)) {
    if (inRmk) { rows.push([t, '(remark)']); continue; }
    let d;
    switch (t) {
      case 'METAR': d = 'Routine aerodrome weather report'; break;
      case 'SPECI': d = 'Special (unscheduled) report'; break;
      case 'COR': d = 'Corrected report'; break;
      case 'AUTO': d = 'Automated report (no human observer)'; break;
      case 'CAVOK': d = 'Ceiling & visibility OK — vis ≥10 km, no cloud below 5000 ft / no CB, no significant weather'; break;
      case 'NOSIG': d = 'No significant change expected in the next 2 hours'; break;
      case 'BECMG': d = 'Becoming — a lasting change is expected'; break;
      case 'TEMPO': d = 'Temporary fluctuations expected'; break;
      case 'NSC': d = 'No significant cloud'; break;
      case 'NCD': d = 'No cloud detected (automatic station)'; break;
      case 'SKC': case 'CLR': d = 'Sky clear'; break;
      case 'NSW': d = 'No significant weather'; break;
      case 'RMK': d = 'Remarks follow'; inRmk = true; break;
      default: d = describeMetarToken(t, !stationSeen);
    }
    if (!stationSeen && /^[A-Z]{4}$/.test(t) && !METAR_KEYWORDS.has(t)) stationSeen = true;
    rows.push([t, d || '—']);
  }
  return rows;
}

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
  const decoded = decodeMetar(m.raw);
  const decodeTable = decoded.length
    ? `<div class="metar-decode-h muted">Decoded report</div>
       <table class="metar-decode"><tbody>${decoded.map(([tok, desc]) =>
         `<tr><td class="mt-tok">${esc(tok)}</td><td>${esc(desc)}</td></tr>`).join('')}</tbody></table>`
    : '';
  return `<div class="metar-pop">
    <div class="arr-title">${esc(m.id)}${m.name ? ` · ${esc(m.name)}` : ''}</div>
    <div><span class="fltcat" style="background:${color}">${esc(m.fltCat) || '—'}</span></div>
    <table class="arr-table"><tbody>${body}</tbody></table>
    ${m.raw ? `<div class="metar-raw">${esc(m.raw)}</div>` : ''}
    ${decodeTable}
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
    }).bindPopup(metarPopup(m), { maxWidth: 340, maxHeight: 360 }).bindTooltip(m.id, { direction: 'top' }).addTo(metarLayer);
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
    .map((f) => `<tr><td class="ft">${esc(f.type || '')}</td><td>${esc(f.mhz)}</td><td class="fd">${esc(f.description || '')}</td></tr>`)
    .join('');
  const where = esc([ap.municipality, ap.country].filter(Boolean).join(', '));
  return `<div class="freq-pop"><div class="freq-h"><b>${esc(ap.ident)}</b> ${esc(ap.name || '')}<div class="muted">${where}</div></div>
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
  refreshTrackHud();
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
  if (ac) drawSelTrail();
}

// ---- altitude-graded track colouring (shared by the live selected trail and the
// historical tracks). Aviation convention: low altitude = warm, high = cool.
const ALT_MAX = 40000; // ft — top of the colour scale
function altColor(alt) {
  if (alt == null) return '#9aa7bd';
  const a = Math.max(0, Math.min(ALT_MAX, alt));
  return `hsl(${Math.round((a / ALT_MAX) * 280)}, 85%, 55%)`;
}
const altBand = (alt) => (alt == null ? -1 : Math.round(Math.max(0, Math.min(ALT_MAX, alt)) / ALT_MAX * 24));
const ALT_GRADIENT = (() => {
  const s = [];
  for (let i = 0; i <= 10; i++) s.push(`${altColor((i / 10) * ALT_MAX)} ${i * 10}%`);
  return `linear-gradient(to right, ${s.join(',')})`;
})();

// Draw `pts` ([lat,lon,alt,ts]) into `layer`, one polyline per altitude band so
// the path reads as a smooth gradient without thousands of layers. A time gap
// becomes a dashed amber connector with end dots.
function drawAltTrack(layer, pts, weight) {
  const P = pts.filter((p) => p[0] != null && p[1] != null);
  if (!P.length) return;
  let seg = [[P[0][0], P[0][1]]], band = altBand(P[0][2]), segAlt = P[0][2];
  const flush = () => { if (seg.length >= 2) L.polyline(seg, { color: altColor(segAlt), weight, opacity: 0.9 }).addTo(layer); };
  for (let i = 1; i < P.length; i++) {
    if (P[i][3] - P[i - 1][3] > TRAIL_GAP_MS) {
      flush();
      const a = [P[i - 1][0], P[i - 1][1]], b = [P[i][0], P[i][1]];
      L.polyline([a, b], { color: '#fbbf24', weight: 2, opacity: 0.85, dashArray: '3 8' })
        .bindTooltip('Signal gap', { sticky: true }).addTo(layer);
      L.circleMarker(a, { radius: 3, color: '#fbbf24', weight: 1.5, fillColor: '#1b2238', fillOpacity: 1 }).addTo(layer);
      L.circleMarker(b, { radius: 3, color: '#fbbf24', weight: 1.5, fillColor: '#1b2238', fillOpacity: 1 }).addTo(layer);
      seg = [[P[i][0], P[i][1]]]; band = altBand(P[i][2]); segAlt = P[i][2];
    } else {
      seg.push([P[i][0], P[i][1]]);
      const b = altBand(P[i][2]);
      if (b !== band) { flush(); seg = [[P[i][0], P[i][1]]]; band = b; segAlt = P[i][2]; }
    }
  }
  flush();
}

// The live selected trail, coloured by altitude.
function drawSelTrail() {
  selTrailLayer.clearLayers();
  const pts = [...selTrailPoints.values()].sort((a, b) => a[3] - b[3]);
  if (pts.length >= 1) drawAltTrack(selTrailLayer, pts, 2.5);
  refreshTrackHud();
}

// Historical track: the recorded path of a *past* sighting session, drawn when
// the user clicks a date in the "seen before" list. Its own layer + style so it's
// clearly distinct from the live trail. Only one shown at a time.
const histTrackLayer = L.layerGroup().addTo(map);
const scrubLayer = L.layerGroup().addTo(map); // the moving scrubber marker
let histTrackKey = null;   // `${hex}:${from}` currently shown, or null
let histTrackPts = [];     // raw track objects {lat,lon,alt,ts,gs} for the scrubber

function clearHistTrack() {
  histTrackLayer.clearLayers();
  histTrackPts = [];
  histTrackKey = null;
  hideTrackScrub();
  refreshTrackHud();
  $$('#d-history .hist-line.active').forEach((r) => r.classList.remove('active'));
}

async function toggleHistTrack(hex, from, to, row) {
  const key = `${hex}:${from}`;
  if (histTrackKey === key) { clearHistTrack(); return; } // clicking the active date hides it
  clearHistTrack();
  row.classList.add('active');
  try {
    const r = await fetch(`/api/aircraft/${hex}/track?from=${from}&to=${to}`);
    if (state.selected !== hex) return;
    if (!r.ok) { row.classList.remove('active'); return; }
    const { track } = await r.json();
    const pts = (track || []).filter((p) => p.lat != null && p.lon != null);
    if (pts.length < 2) {
      row.classList.remove('active');
      toast({ kind: 'test', title: 'Historical track',
        message: 'No recorded track for this session — it is older than the replay retention window (see Settings).' });
      return;
    }
    histTrackKey = key;
    drawHistTrack(pts);
  } catch { row.classList.remove('active'); }
}

function drawHistTrack(track) {
  histTrackLayer.clearLayers();
  histTrackPts = track.filter((p) => p.lat != null && p.lon != null);
  const pts = histTrackPts.map((p) => [p.lat, p.lon, p.alt, p.ts]);
  if (!pts.length) return;
  drawAltTrack(histTrackLayer, pts, 3.5); // coloured by altitude
  const start = pts[0], end = pts[pts.length - 1];
  L.circleMarker([start[0], start[1]], { radius: 5, color: '#22c55e', weight: 2, fillColor: '#0a1024', fillOpacity: 1 })
    .bindTooltip(`Track start · ${fmt.dateTime(start[3])}`).addTo(histTrackLayer);
  L.circleMarker([end[0], end[1]], { radius: 5, color: '#ef4444', weight: 2, fillColor: '#0a1024', fillOpacity: 1 })
    .bindTooltip(`Track end · ${fmt.dateTime(end[3])}`).addTo(histTrackLayer);
  // Stop following the live plane so the fit doesn't get yanked away, then frame it.
  state.follow = false; $('#d-follow').classList.remove('active');
  if (state.autoFollow) { state.autoFollow = false; $('#autofollow-btn').classList.remove('active'); }
  if (!$('#tab-map').classList.contains('active')) $('#tabs button[data-tab="map"]').click();
  setTimeout(() => map.fitBounds(L.latLngBounds(pts.map((p) => [p[0], p[1]])), { padding: [40, 40], maxZoom: 11 }), 60);
  showTrackScrub();
  refreshTrackHud();
}

// ---- altitude legend + historical-track time scrubber (one bottom-of-map HUD)
// The legend shows whenever any trail is drawn; the scrubber only for a
// historical track (it has a fixed, finite set of timestamped points).
function refreshTrackHud() {
  const hud = $('#track-hud');
  const hasHist = histTrackLayer.getLayers().length > 0;
  const hasSel = selTrailLayer.getLayers().length > 0;
  if (!hasHist && !hasSel) { hud.classList.add('hidden'); return; }
  $('#hud-bar').style.background = ALT_GRADIENT;
  $('#hud-hi').textContent = state.units === 'metric' ? `${Math.round(ALT_MAX * 0.3048 / 100) / 10} km` : `${ALT_MAX / 1000}k ft`;
  $('#hud-lo').textContent = 'grd';
  hud.classList.toggle('has-scrub', hasHist);
  hud.classList.remove('hidden');
}
function showTrackScrub() {
  const slider = $('#scrub-range');
  if (histTrackPts.length < 2) return;
  slider.max = histTrackPts.length - 1;
  slider.value = histTrackPts.length - 1; // start at the latest point
  updateTrackScrub(histTrackPts.length - 1);
}
function updateTrackScrub(idx) {
  scrubLayer.clearLayers();
  const p = histTrackPts[idx];
  if (!p) return;
  L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: altColor(p.alt), fillOpacity: 1 })
    .addTo(scrubLayer);
  const parts = [fmt.dateTime(p.ts), fmt.alt(p.alt)];
  if (p.gs != null) parts.push(fmt.spd(p.gs));
  $('#scrub-readout').textContent = parts.join(' · ');
}
function hideTrackScrub() { scrubLayer.clearLayers(); $('#scrub-readout').textContent = ''; }
$('#scrub-range').addEventListener('input', (e) => updateTrackScrub(+e.target.value));

// Delegated click handler for the "seen before" rows (attached once).
$('#d-history').addEventListener('click', (e) => {
  const row = e.target.closest('.hist-line[data-from]');
  if (!row || !state.selected) return;
  toggleHistTrack(state.selected, +row.dataset.from, +row.dataset.to, row);
});

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
    const labelText = esc(ac.flight || ac.registration || ac.hex.toUpperCase());
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
      drawSelTrail();
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
  ['flight', 'Callsign', (ac) => `${flagHtml(ac.country)}${esc(ac.flight || ac.registration || ac.hex.toUpperCase())}`],
  ['registration', 'Reg', (ac) => esc(ac.registration) || '—'],
  ['type', 'Type', (ac) => esc(ac.type) || '—'],
  ['airline', 'Airline / operator', (ac) => esc(ac.airline || ac.operator) || '—'],
  ['alt', () => unitLabels().alt, (ac) => fmt.altN(ac.alt)],
  ['gs', () => unitLabels().spd, (ac) => fmt.spdN(ac.gs)],
  ['vr', () => unitLabels().vr, (ac) => fmt.vrN(ac.vr)],
  ['distKm', 'Dist km', (ac) => ac.distKm ?? '—'],
  ['squawk', 'Squawk', (ac) => esc(ac.squawk) || '—'],
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
    // hide the distance-from-receiver column for public (anonymous) viewers
    const cols = isAuthed() ? LIST_COLUMNS : LIST_COLUMNS.filter(([k]) => k !== 'distKm');
    const head = cols.map(
      ([k, label]) => {
        const text = typeof label === 'function' ? label() : label;
        return `<th data-key="${k}" class="${k === key ? 'sorted' : ''}">${text}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
      }
    ).join('');
    const body = rows
      .map(
        (ac) => `<tr class="${rowClasses(ac, '')}" data-hex="${ac.hex}" style="box-shadow: inset 4px 0 0 ${sourceColor(ac.source)}">
          ${cols.map(([, , render]) => `<td>${render(ac)}</td>`).join('')}
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
          <div class="cs">${flagHtml(ac.country)}${esc(ac.flight || ac.registration || ac.hex.toUpperCase())}</div>
          <div class="meta">${esc(ac.type || ac.typeName || '')}</div>
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
  if (hex !== state.selected) clearHistTrack(); // drop a previous plane's historical track
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
  if (ac.emergency) badges.push(`<span class="badge emerg">EMERGENCY ${esc(ac.squawk || '')}</span>`);
  if (ac.padbCategory) badges.push(`<span class="badge">${esc(ac.padbCategory)}</span>`);
  (ac.padbTags || []).forEach((t) => badges.push(`<span class="badge">${esc(t)}</span>`));
  $('#d-badges').innerHTML = badges.join('');

  const cells = [
    ['Altitude', fmt.alt(ac.alt)],
    ['Ground speed', fmt.spd(ac.gs)],
    ['Vertical rate', fmt.vr(ac.vr)],
    ['Track', ac.track != null ? Math.round(ac.track) + '°' : '—'],
    ['Squawk', esc(ac.squawk) || '—'],
    // distance-from-receiver only for authenticated viewers
    ...(isAuthed() ? [['Distance', fmt.dist(ac.distKm)]] : []),
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
        // only allow http(s) links (no javascript: URLs); escape the credit text
        const link = /^https?:\/\//i.test(photo.link || '') ? esc(photo.link) : '#';
        $('#d-photo').innerHTML = `<a href="${link}" target="_blank" rel="noopener">
          <img src="/api/photo/${esc(hex)}" alt="aircraft photo" /></a>
          <div class="credit">© ${esc(photo.photographer)} / planespotters.net</div>`;
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
      if (d.route.airline?.name) html += `<div class="muted" style="margin-bottom:6px">${esc(d.route.airline.name)}</div>`;
      html += `<div class="route-box${low ? ' route-suspect' : ''}">
        <div class="route-airport"><div class="code">${esc(o?.iata || o?.icao || '?')}</div>
          <div class="name">${o ? esc(`${o.municipality || o.name}, ${o.country}`) : 'Unknown'}</div></div>
        <div class="route-arrow">→</div>
        <div class="route-airport" style="text-align:right"><div class="code">${esc(dst?.iata || dst?.icao || '?')}</div>
          <div class="name">${dst ? esc(`${dst.municipality || dst.name}, ${dst.country}`) : 'Unknown'}</div></div>
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
      // Rows are clickable (auth-only) to draw that session's recorded track.
      const clickable = isAuthed();
      $('#d-history').innerHTML = history
        .slice(0, 12)
        .map(
          (h) => `<div class="hist-line${clickable ? ' hist-clickable' : ''}"${clickable ? ` data-from="${h.first_seen}" data-to="${h.last_seen}"` : ''}>${fmt.dateTime(h.first_seen)} — ${fmt.dur((h.last_seen - h.first_seen) / 1000)}${h.callsign ? ' · ' + esc(h.callsign) : ''}${h.max_alt ? ' · max ' + fmt.alt(h.max_alt) : ''}${h.min_dist_km != null ? ' · closest ' + h.min_dist_km.toFixed(1) + ' km' : ''}${clickable ? '<span class="hist-track-hint">▸ track</span>' : ''}</div>`
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
  clearHistTrack();
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
      // authenticated: centre on (and mark) the receiver
      centeredOnce = true;
      map.setView([snap.receiver.lat, snap.receiver.lon], 9);
      receiverMarker = L.circleMarker([snap.receiver.lat, snap.receiver.lon], {
        radius: 6, color: '#38bdf8', fillOpacity: 0.9
      }).bindTooltip('Receiver').addTo(map);
      if (state.ringsOn) drawRings(); // receiver now known
      loadWeather(); // location available -> fetch local weather
    } else if (!centeredOnce && !isAuthed()) {
      // public: no receiver location — fit the view to the aircraft instead
      const pts = snap.aircraft.filter((a) => a.lat != null).map((a) => [a.lat, a.lon]);
      if (pts.length) { centeredOnce = true; try { map.fitBounds(L.latLngBounds(pts).pad(0.25)); } catch { /* ignore */ } }
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
  el.className = `toast ${typeof kind === 'string' ? kind.replace(/[^\w-]/g, '') : ''}`;
  el.innerHTML = `<div class="t">${esc(title)}</div><div class="m">${esc(message || '')}</div>`;
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
    <div class="card"><div class="num">${(s.firstSeen?.totalOperators ?? 0).toLocaleString()}</div><div class="lbl">operators (all-time)</div></div>
    <div class="card"><div class="num">${(s.firstSeen?.totalTypes ?? 0).toLocaleString()}</div><div class="lbl">types (all-time)</div></div>`;

  // Aircraft per day — vertical bars, value on hover, sparse date labels.
  const nDays = s.perDay.length;
  const maxDay = Math.max(1, ...s.perDay.map((d) => d.aircraft));
  const labelEvery = Math.max(1, Math.ceil(nDays / 8));
  $('#chart-perday').innerHTML = nDays
    ? s.perDay
        .map(
          (d, i) => `<div class="day-col" title="${esc(d.day)}: ${d.aircraft.toLocaleString()} aircraft · ${d.sightings.toLocaleString()} sightings">
            <div class="day-val">${d.aircraft.toLocaleString()}</div>
            <div class="day-track"><div class="day-fill" style="height:${Math.max(2, (d.aircraft / maxDay) * 100)}%"></div></div>
            <div class="day-x">${i % labelEvery === 0 ? esc(d.day.slice(5)) : ''}</div>
          </div>`
        )
        .join('')
    : '<span class="muted">No data yet</span>';

  hbar('#chart-types', s.topTypes.map((t) => [t.type, t.count]));
  hbar('#chart-airlines', s.topAirlines.map((t) => [t.airline, t.count]));
  hbar('#chart-dest', (s.topDestinations || []).map((t) => [t.code, t.count]),
    { empty: 'No routes resolved yet — this fills in as flights are looked up.' });
  hbar('#chart-origin', (s.topOrigins || []).map((t) => [t.code, t.count]),
    { empty: 'No routes resolved yet — this fills in as flights are looked up.' });
  // Categories are coloured by their map colour (identity), not rank.
  hbar('#chart-categories', s.categories.map((t) => [t.category, t.count, CLASS_COLORS[t.category] || CLASS_COLORS.unknown]));

  // "New to your coverage" — first-ever sightings that fall in the selected period.
  const fs = s.firstSeen || {};
  fsList('#fs-operators', fs.newOperators || [], 'name');
  fsList('#fs-types', fs.newTypes || [], 'type');
}

// A dated list of "first seen this period" entries (operators or types).
function fsList(sel, rows, key) {
  const el = $(sel);
  el.innerHTML = rows.length
    ? rows.map((r) => `<div class="fs-row" title="First seen ${esc(new Date(r.first_seen).toLocaleString())}">
        <span class="fs-name">${esc(r[key] || '—')}</span>
        <span class="fs-meta">${esc(new Date(r.first_seen).toLocaleDateString())}${r.count > 1 ? ` · ${Number(r.count).toLocaleString()}×` : ''}</span>
      </div>`).join('')
    : '<span class="muted">Nothing new in this period.</span>';
}

// Horizontal magnitude bars. rows = [[label, count, colorOverride?], …].
function hbar(sel, rows, opts = {}) {
  const el = $(sel);
  if (!rows.length) { el.innerHTML = `<span class="muted">${esc(opts.empty || 'No data yet')}</span>`; return; }
  const max = Math.max(1, ...rows.map((r) => r[1]));
  el.innerHTML = rows
    .map(([lbl, cnt, color]) => {
      const pct = Math.max(1.5, (cnt / max) * 100);
      const fill = color
        ? `background:${color}`
        : 'background:linear-gradient(90deg,#38bdf8,#0ea5e9)';
      return `<div class="hbar-row" title="${esc(lbl)}: ${Number(cnt).toLocaleString()}">
        <div class="hbar-label">${esc(lbl)}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${pct}%;${fill}"></div></div>
        <div class="hbar-val">${Number(cnt).toLocaleString()}</div>
      </div>`;
    })
    .join('');
}
$('#stats-days').addEventListener('change', loadStats);

// ----------------------------------------------------------------- watchlist
async function loadWatchlist() {
  const { watchlist } = await (await fetch('/api/watchlist')).json();
  $('#wl-table tbody').innerHTML = watchlist
    .map(
      (w) => `<tr>
        <td>${esc(w.icao) || '—'}</td><td>${esc(w.registration) || '—'}</td><td>${esc(w.callsign) || '—'}</td>
        <td>${esc(w.operator) || '—'}</td><td>${esc(w.type) || '—'}</td><td>${esc(w.category) || '—'}</td>
        <td>${w.notify ? '🔔' : '—'}</td>
        <td><button class="del" data-id="${esc(w.id)}">delete</button></td>
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
          (r) => `<div class="padb-hit"><b>${esc(r.icao)}</b><span>${esc(r.registration)}</span>
          <span class="grow">${esc(r.operator)} — ${esc(r.type)} <span class="muted">(${esc(r.category)})</span></span>
          <button data-icao="${esc(r.icao)}" class="padb-add">+ watch</button></div>`
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

// ----------------------------------------------------------------- detections
const detState = { data: [], filter: 'all', timer: null };
const DET_META = {
  squawk:    { icon: '🆘', label: 'Squawk' },
  orbit:     { icon: '🔄', label: 'Orbit / loiter' },
  descent:   { icon: '⚠️', label: 'Emergency descent' },
  integrity: { icon: '🛑', label: 'Data integrity' },
  rarity:    { icon: '✨', label: 'Rarity' },
  survey:    { icon: '🗺️', label: 'Survey / patrol' },
  goaround:  { icon: '🛫', label: 'Go-around' },
  military:  { icon: '🪖', label: 'Military' }
};

function loadDetections() {
  stopDetections();
  fetchDetections();
  detState.timer = setInterval(fetchDetections, 6000);
}
function stopDetections() {
  if (detState.timer) { clearInterval(detState.timer); detState.timer = null; }
}
async function fetchDetections() {
  try {
    const { detections } = await (await fetch('/api/detections')).json();
    detState.data = detections || [];
    renderDetections();
  } catch { /* keep last */ }
}
function renderDetections() {
  const now = Date.now();
  const rows = detState.data.filter((d) => detState.filter === 'all' || d.type === detState.filter);
  $('#det-count').textContent = rows.length ? `${rows.length} shown` : '';
  if (!rows.length) {
    $('#det-list').innerHTML = `<div class="det-empty muted">${detState.data.length
      ? 'No detections of this type.'
      : 'No anomalies detected yet. Detectors run continuously on the live stream — squawk emergencies, orbits, emergency descents, spoofing signatures and rarities will appear here.'}</div>`;
    return;
  }
  $('#det-list').innerHTML = rows.map((d) => {
    const m = DET_META[d.type] || { icon: '•', label: d.type };
    const metrics = d.metrics
      ? Object.entries(d.metrics).map(([k, v]) => `<span class="det-metric">${esc(k)}: <b>${esc(String(v))}</b></span>`).join('')
      : '';
    const ac = d.callsign || d.registration || (d.hex ? d.hex.toUpperCase() : '');
    return `<div class="det-card sev-${esc(d.severity)}"${d.hex ? ` data-hex="${esc(d.hex)}"` : ''}>
      <div class="det-ico">${m.icon}</div>
      <div class="det-body">
        <div class="det-title">${esc(d.title)}</div>
        <div class="det-detail">${esc(d.detail)}</div>
        <div class="det-meta"><span class="det-sev sev-${esc(d.severity)}">${esc(d.severity)}</span>
          <span class="det-type">${esc(m.label)}</span>
          ${ac ? `<span class="det-ac">${esc(ac)}</span>` : ''}
          <span class="det-time">${fmt.dateTime(d.ts)}</span>${metrics}</div>
      </div>
    </div>`;
  }).join('');
}
$('#det-filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.det-chip');
  if (!chip) return;
  detState.filter = chip.dataset.dtype;
  $$('#det-filters .det-chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderDetections();
});
$('#det-list').addEventListener('click', (e) => {
  const card = e.target.closest('.det-card[data-hex]');
  if (!card) return;
  const hex = card.dataset.hex;
  $('#tabs button[data-tab="map"]').click();
  if (state.aircraft.has(hex)) selectAircraft(hex, true);
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
    return `<span title="${esc(o ? o.name + ', ' + o.country : '?')} → ${esc(d ? d.name + ', ' + d.country : '?')}">${esc(o?.iata || o?.icao || '?')} → ${esc(d?.iata || d?.icao || '?')}</span>${badge}`;
  }
  return '<span class="muted">no route</span>';
}

function spottedPhotoHtml(s) {
  // Load straight from the server-side image proxy (cached on disk, reliable).
  // onerror swaps in a ✈ placeholder when there's no photo.
  const hex = esc(String(s.hex || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6));
  return `<a href="https://www.planespotters.net/hex/${hex.toUpperCase()}" target="_blank" rel="noopener" title="photos on planespotters.net">
    <img class="spotted-thumb" src="/api/photo/${hex}" loading="lazy" alt="" data-fallback="1"></a>`;
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
          const tags = (s.tags || []).filter(Boolean).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ');
          const label = esc(s.callsign || s.registration || s.hex.toUpperCase());
          const closest = s.minDistKm != null ? `${s.minDistKm.toFixed(1)} km` : '—';
          const link = /^https?:\/\//i.test(s.link || '') ? esc(s.link) : '';
          return `<tr data-hex="${esc(s.hex)}" data-cs="${esc(s.callsign || '')}">
            <td class="spotted-photo" data-hex="${esc(s.hex)}">${spottedPhotoHtml(s)}</td>
            <td>${flagHtml(s.country)}<b>${label}</b>${s.registration && s.registration !== (s.callsign || s.registration || s.hex.toUpperCase()) ? ` <span class="muted">${esc(s.registration)}</span>` : ''}
              ${link ? ` <a href="${link}" target="_blank" rel="noopener" title="plane-alert-db link">↗</a>` : ''}</td>
            <td>${esc(s.operator) || '—'}</td>
            <td>${esc(s.type || s.icaoType) || '—'}</td>
            <td>${esc(s.category) || '—'}</td>
            <td>${tags || '—'}</td>
            <td>${s.sessions}×</td>
            <td>${fmt.dateTime(s.firstSeen)}</td>
            <td>${fmt.dateTime(s.lastSeen)}</td>
            <td class="auth-only">${closest}</td>
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

// Replace a broken/absent photo with a ✈ placeholder. Done via a capture-phase
// listener (image 'error' doesn't bubble) instead of an inline onerror handler,
// so the strict Content-Security-Policy (no inline scripts) stays intact.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.dataset.fallback) {
    const cell = img.closest('.spotted-photo') || img.parentElement;
    if (cell) cell.innerHTML = '<span class="ph-skel ph-none">✈</span>';
  }
}, true);

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
  loadWebcamCustom();
  $('#s-src-mode').value = c.source?.mode || 'json';
  $('#s-sbs-host').value = c.source?.sbsHost || '';
  $('#s-sbs-port').value = c.source?.sbsPort || 30003;
  toggleSourceRows();
  $('#s-dump-url').value = c.dump1090Url;
  $('#s-poll').value = c.pollIntervalMs;
  $('#s-rlat').value = c.receiver.lat ?? '';
  $('#s-rlon').value = c.receiver.lon ?? '';
  $('#s-retention').value = c.retentionDays;
  $('#s-replay-retention').value = c.replayRetentionDays;
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
  $('#s-notify-weather').checked = c.notifyExtremeWeather;
  const det = c.detections || {};
  $('#s-det-enabled').checked = det.enabled !== false;
  $('#s-det-squawk').checked = det.squawk !== false;
  $('#s-det-orbit').checked = det.orbit !== false;
  $('#s-det-descent').checked = det.emergencyDescent !== false;
  $('#s-det-integrity').checked = det.integrity !== false;
  $('#s-det-rarity').checked = det.rarity !== false;
  $('#s-det-survey').checked = det.survey !== false;
  $('#s-det-goaround').checked = det.goAround !== false;
  $('#s-det-military').checked = det.military !== false;
  $('#s-det-notify').checked = det.notify !== false;
  $('#s-det-confirm').value = det.confirmSeconds ?? 30;
  $('#s-milfeed-enabled').checked = c.militaryFeed?.enabled !== false;
  $('#s-bortle').value = String(c.skywatch?.bortle ?? 4);
  $('#s-owm').value = '';
  $('#s-owm').placeholder = c.weather.hasOwmKey ? 'key configured ✓ (enter to replace)' : '(optional)';
  $('#s-openaip').value = '';
  $('#s-openaip').placeholder = c.openAip?.hasKey ? 'key configured ✓ (enter to replace)' : '(optional)';
  $('#s-windy').value = '';
  $('#s-windy').placeholder = c.webcams?.hasWindyKey ? 'key configured ✓ (enter to replace)' : '(optional)';
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
    replayRetentionDays: Math.max(1, parseInt($('#s-replay-retention').value, 10) || 3),
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
    notifyExtremeWeather: $('#s-notify-weather').checked,
    detections: {
      enabled: $('#s-det-enabled').checked,
      squawk: $('#s-det-squawk').checked,
      orbit: $('#s-det-orbit').checked,
      emergencyDescent: $('#s-det-descent').checked,
      integrity: $('#s-det-integrity').checked,
      rarity: $('#s-det-rarity').checked,
      survey: $('#s-det-survey').checked,
      goAround: $('#s-det-goaround').checked,
      military: $('#s-det-military').checked,
      notify: $('#s-det-notify').checked,
      confirmSeconds: Math.max(0, Math.min(600, parseInt($('#s-det-confirm').value, 10) || 30))
    },
    militaryFeed: { enabled: $('#s-milfeed-enabled').checked },
    ui: { units: $('#s-units').value }
  };
  patch.skywatch = { bortle: parseInt($('#s-bortle').value, 10) || 4 };
  if ($('#s-owm').value.trim()) patch.weather = { openWeatherMapKey: $('#s-owm').value.trim() };
  if ($('#s-openaip').value.trim()) patch.openAip = { apiKey: $('#s-openaip').value.trim() };
  if ($('#s-windy').value.trim()) patch.webcams = { windyKey: $('#s-windy').value.trim() };
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
  refreshTrackHud(); // altitude-legend labels are unit-dependent
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
  if (!isAuthed()) { wx.classList.add('hidden'); return; } // receiver weather is private
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

// ----------------------------------------------------------------- weather tab
// Wind is shown in the user's chosen unit; temperature stays °C (the norm for
// weather, in both metric and aviation modes).
function wxWind(kmh, dir) {
  if (kmh == null) return '—';
  const aviation = state.units === 'aviation';
  const v = aviation ? Math.round(kmh / 1.852) : Math.round(kmh);
  return `${v} ${aviation ? 'kt' : 'km/h'}${dir != null ? ' ' + compass(dir) : ''}`;
}
const wxTemp = (c) => (c == null ? '—' : `${Math.round(c)}°`);
function wxHourLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function wxDateHeading(iso) {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
const WARN_ORDER = { severe: 0, warning: 1, advisory: 2 };

// Cache-busted, no-store fetch so the browser (or a proxy / Cloudflare Tunnel)
// can never hand back a stale weather/radar response.
const freshFetch = (url) => fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store' });

async function loadWeatherTab() {
  if (!isAuthed()) return;
  const err = $('#wx-error');
  err.classList.add('hidden');
  try {
    const [fRes, mRes] = await Promise.all([
      freshFetch('/api/weather/forecast'),
      freshFetch('/api/weather/metar-nearest').catch(() => null)
    ]);
    if (!fRes.ok) {
      const j = await fRes.json().catch(() => ({}));
      err.textContent = j.error === 'no receiver location set'
        ? 'Set your receiver location in Settings to see local weather.'
        : `Weather unavailable: ${j.error || fRes.status}`;
      err.classList.remove('hidden');
      return;
    }
    const f = await fRes.json();
    renderWxWarnings(f.warnings || []);
    renderWxNow(f.current, f.daily?.[0]);
    renderWxHourly(f.hourly || []);
    renderWxDaily(f.daily || []);
    renderWxMetar(mRes && mRes.ok ? await mRes.json() : { station: null });
    initWxRadar();
    $('#wx-updated').textContent = `updated ${fmt.time(Date.now())}`;
  } catch (e) {
    err.textContent = 'Weather unavailable — check your connection.';
    err.classList.remove('hidden');
  }
  startWxAutoRefresh();
}

// Keep the tab live: refresh every 5 min while it's the visible tab (Open-Meteo
// updates hourly, RainViewer ~every 10 min, METAR ~hourly). Paused when the tab
// isn't showing so it costs nothing in the background.
let wxAutoTimer = null;
function wxTabVisible() {
  return !document.hidden && $('#tab-weather').classList.contains('active');
}
function startWxAutoRefresh() {
  if (wxAutoTimer) return;
  wxAutoTimer = setInterval(() => { if (wxTabVisible()) loadWeatherTab(); }, 5 * 60000);
}
document.addEventListener('visibilitychange', () => { if (wxTabVisible()) loadWeatherTab(); });
$('#wx-refresh').addEventListener('click', () => loadWeatherTab());

function renderWxWarnings(warnings) {
  const box = $('#wx-warnings');
  box.innerHTML = '';
  if (!warnings.length) {
    box.innerHTML = '<div class="wx-warn wx-warn-none">✓ No extreme conditions in the forecast.</div>';
    return;
  }
  // dedupe identical kind+level+day already handled server-side; show all, sorted.
  for (const w of [...warnings].sort((a, b) => (WARN_ORDER[a.level] - WARN_ORDER[b.level]) || a.date.localeCompare(b.date))) {
    const el = document.createElement('div');
    el.className = `wx-warn wx-warn-${esc(w.level)}`;
    el.innerHTML =
      `<span class="wx-warn-ico">${esc(w.icon)}</span>` +
      `<span class="wx-warn-txt"><b>${esc(w.title)}</b> · ${esc(w.dayLabel)}` +
      `<span class="wx-warn-detail">${esc(w.detail)}</span></span>` +
      `<span class="wx-warn-lvl">${esc(w.level)}</span>`;
    box.appendChild(el);
  }
}

function renderWxNow(c, today) {
  const el = $('#wx-now');
  if (!c) { el.innerHTML = '<div class="wx-loading">No data.</div>'; return; }
  const [icon, label] = wxCondition(c.code, c.isDay);
  const hiLo = today
    ? `<span class="wx-hilo">H ${wxTemp(today.tmax)} · L ${wxTemp(today.tmin)}</span>` : '';
  el.innerHTML =
    `<div class="wx-now-main">` +
    `<span class="wx-now-ico">${esc(icon)}</span>` +
    `<div class="wx-now-t"><span class="wx-now-temp">${wxTemp(c.temp)}<span class="wx-unit">C</span></span>` +
    `<span class="wx-now-label">${esc(label)}</span>${hiLo}</div></div>` +
    `<div class="wx-now-grid">` +
    wxStat('Feels like', wxTemp(c.feels)) +
    wxStat('Wind', wxWind(c.windKmh, c.windDir)) +
    wxStat('Gusts', c.gustKmh != null ? wxWind(c.gustKmh) : '—') +
    wxStat('Humidity', c.humidity != null ? `${Math.round(c.humidity)}%` : '—') +
    wxStat('Precip', c.precipMm != null ? `${c.precipMm.toFixed(1)} mm` : '—') +
    wxStat('Cloud', c.cloud != null ? `${Math.round(c.cloud)}%` : '—') +
    wxStat('Pressure', c.pressure != null ? `${Math.round(c.pressure)} hPa` : '—') +
    `</div>`;
}
const wxStat = (k, v) => `<div class="wx-stat"><span class="wx-stat-k">${esc(k)}</span><span class="wx-stat-v">${esc(v)}</span></div>`;

function renderWxHourly(hourly) {
  const box = $('#wx-hourly');
  box.innerHTML = '';
  const now = Date.now();
  // next ~36 hours from now (covers rest of today + tomorrow)
  const upcoming = hourly.filter((h) => new Date(h.time).getTime() >= now - 3600000).slice(0, 36);
  if (!upcoming.length) { box.innerHTML = '<div class="wx-loading">No hourly data.</div>'; return; }
  let lastDay = '';
  for (const h of upcoming) {
    const dayKey = h.time.slice(0, 10);
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const sep = document.createElement('div');
      sep.className = 'wx-hour-day';
      sep.textContent = wxDateHeading(h.time);
      box.appendChild(sep);
    }
    const [icon] = wxCondition(h.code, h.isDay);
    const cell = document.createElement('div');
    cell.className = 'wx-hour';
    const pop = h.precipProb != null && h.precipProb > 0 ? `<span class="wx-hour-pop">${Math.round(h.precipProb)}%</span>` : '<span class="wx-hour-pop">&nbsp;</span>';
    cell.innerHTML =
      `<span class="wx-hour-time">${esc(wxHourLabel(h.time))}</span>` +
      `<span class="wx-hour-ico">${esc(icon)}</span>` +
      `<span class="wx-hour-temp">${wxTemp(h.temp)}</span>` +
      pop +
      `<span class="wx-hour-wind">${esc(wxWind(h.windKmh))}</span>`;
    box.appendChild(cell);
  }
}

function renderWxDaily(daily) {
  const box = $('#wx-daily');
  box.innerHTML = '';
  if (!daily.length) { box.innerHTML = '<div class="wx-loading">No daily data.</div>'; return; }
  const lo = Math.min(...daily.map((d) => d.tmin).filter((v) => v != null));
  const hi = Math.max(...daily.map((d) => d.tmax).filter((v) => v != null));
  const span = Math.max(1, hi - lo);
  daily.forEach((d, i) => {
    const [icon, label] = wxCondition(d.code, 1);
    const row = document.createElement('div');
    row.className = 'wx-day';
    // temperature range bar positioned within the week's min/max
    const left = ((d.tmin - lo) / span) * 100;
    const width = ((d.tmax - d.tmin) / span) * 100;
    const pop = d.precipProb != null && d.precipProb > 0
      ? `<span class="wx-day-pop">💧${Math.round(d.precipProb)}%</span>` : '';
    row.innerHTML =
      `<span class="wx-day-name">${esc(i === 0 ? 'Today' : wxDateHeading(d.date))}</span>` +
      `<span class="wx-day-ico" title="${esc(label)}">${esc(icon)}</span>` +
      `<span class="wx-day-lo">${wxTemp(d.tmin)}</span>` +
      `<span class="wx-day-bar"><span class="wx-day-fill" style="margin-left:${left.toFixed(1)}%;width:${Math.max(6, width).toFixed(1)}%"></span></span>` +
      `<span class="wx-day-hi">${wxTemp(d.tmax)}</span>` +
      `<span class="wx-day-extra">${pop}<span class="wx-day-wind">💨${esc(wxWind(d.gustMax))}</span></span>`;
    box.appendChild(row);
  });
}

// METAR wind (aviationweather reports speed/gust in knots). Show in user units,
// appending the gust when present.
function metarWind(m) {
  if (m.wspd == null) return '—';
  const s = wxWind(m.wspd * 1.852, m.wdir);
  if (!m.wgst) return s;
  const aviation = state.units === 'aviation';
  const g = aviation ? Math.round(m.wgst) : Math.round(m.wgst * 1.852);
  return `${s} G${g}`;
}
function renderWxMetar(data) {
  const box = $('#wx-metar');
  const m = data && data.station;
  if (!m) { box.innerHTML = '<p class="muted">No nearby station reporting.</p>'; return; }
  const CAT = { VFR: '#22c55e', MVFR: '#3b82f6', IFR: '#ef4444', LIFR: '#a855f7' };
  const catColor = CAT[m.fltCat] || 'var(--muted)';
  const age = m.obsTime ? `${Math.max(0, Math.round((Date.now() / 1000 - m.obsTime) / 60))} min ago` : '';
  box.innerHTML =
    `<div class="wx-metar-head"><b>${esc(m.id || '—')}</b>` +
    (m.name ? ` <span class="muted">${esc(m.name)}</span>` : '') +
    (m.distKm != null ? ` <span class="muted">· ${esc(m.distKm)} km away</span>` : '') +
    (m.fltCat ? ` <span class="wx-fltcat" style="background:${catColor}">${esc(m.fltCat)}</span>` : '') +
    `</div>` +
    `<div class="wx-metar-grid">` +
    wxStat('Temp', m.temp != null ? `${Math.round(m.temp)}°C` : '—') +
    wxStat('Dewpoint', m.dewp != null ? `${Math.round(m.dewp)}°C` : '—') +
    wxStat('Wind', metarWind(m)) +
    wxStat('Visibility', m.visib != null ? `${m.visib} sm` : '—') +
    wxStat('Pressure', m.altim != null ? `${Math.round(m.altim)} hPa` : '—') +
    (age ? wxStat('Observed', age) : '') +
    `</div>` +
    (m.raw ? `<code class="wx-metar-raw">${esc(m.raw)}</code>` : '');
}

// ---- RainViewer animated radar mini-map (created once, reused) --------------
let wxRadar = null; // { map, frames, layers, idx, timer, playing, cloudLayer }
async function initWxRadar() {
  const rcv = state.config?.receiver;
  const center = (rcv && rcv.lat != null && rcv.lon != null) ? [rcv.lat, rcv.lon] : map.getCenter();
  if (!wxRadar) {
    const rmap = L.map('wx-radar', { center, zoom: 7, zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 12 }).addTo(rmap);
    if (rcv && rcv.lat != null) {
      L.circleMarker(center, { radius: 5, color: '#38bdf8', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.7 }).addTo(rmap);
    }
    wxRadar = { map: rmap, frames: [], layers: [], idx: 0, timer: null, playing: true, cloudLayer: null };
    $('#wx-radar-play').addEventListener('click', toggleWxRadar);
    $('#wx-owm-clouds').addEventListener('change', (e) => {
      if (!wxRadar) return;
      if (e.target.checked) {
        wxRadar.cloudLayer = L.tileLayer('/api/weather/owm/clouds_new/{z}/{x}/{y}', { opacity: 0.45 }).addTo(wxRadar.map);
      } else if (wxRadar.cloudLayer) {
        wxRadar.map.removeLayer(wxRadar.cloudLayer); wxRadar.cloudLayer = null;
      }
    });
  } else {
    wxRadar.map.setView(center, wxRadar.map.getZoom());
  }
  setTimeout(() => wxRadar.map.invalidateSize(), 60);
  if (state.config?.weather?.hasOwmKey) $('#wx-owm-toggle-wrap').style.display = '';
  await loadWxRadarFrames();
}

async function loadWxRadarFrames() {
  try {
    const rv = await (await freshFetch('/api/weather/rainviewer')).json();
    const past = rv.radar?.past || [];
    const nowcast = rv.radar?.nowcast || [];
    const frames = [...past, ...nowcast].slice(-16);
    if (!frames.length || !wxRadar) return;
    // clear old
    wxRadar.layers.forEach((l) => wxRadar.map.removeLayer(l));
    wxRadar.layers = frames.map((fr) =>
      L.tileLayer(`${rv.host}${fr.path}/256/{z}/{x}/{y}/4/1_1.png`, { opacity: 0, maxZoom: 12 }).addTo(wxRadar.map));
    wxRadar.frames = frames;
    wxRadar.idx = past.length ? past.length - 1 : 0;
    showWxRadarFrame(wxRadar.idx);
    startWxRadarAnim();
  } catch { /* ignore */ }
}

function showWxRadarFrame(i) {
  if (!wxRadar) return;
  wxRadar.layers.forEach((l, j) => l.setOpacity(j === i ? 0.72 : 0));
  const fr = wxRadar.frames[i];
  if (fr) {
    const t = new Date(fr.time * 1000);
    const future = fr.time * 1000 > Date.now();
    $('#wx-radar-time').textContent = `${future ? 'forecast ' : ''}${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}
function startWxRadarAnim() {
  if (!wxRadar) return;
  clearInterval(wxRadar.timer);
  wxRadar.timer = setInterval(() => {
    if (!wxRadar || !wxRadar.playing || !wxRadar.frames.length) return;
    wxRadar.idx = (wxRadar.idx + 1) % wxRadar.frames.length;
    showWxRadarFrame(wxRadar.idx);
  }, 700);
}
function toggleWxRadar() {
  if (!wxRadar) return;
  wxRadar.playing = !wxRadar.playing;
  $('#wx-radar-play').textContent = wxRadar.playing ? '⏸ Pause' : '▶ Play';
}

// ----------------------------------------------------------------- sky watch tab
// All timestamps from the server are raw UTC ms; format them in the *receiver's*
// timezone (utcOffsetSeconds) so times are correct even for a remote viewer.
function skyTime(ms, offsetSec) {
  if (ms == null) return '—';
  const d = new Date(ms + (offsetSec || 0) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function skyDayLabel(ms, offsetSec, i) {
  if (i === 0) return 'Tonight';
  if (i === 1) return 'Tomorrow';
  return new Date(ms + (offsetSec || 0) * 1000)
    .toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
const MOON_EMOJI = {
  'New Moon': '🌑', 'Waxing crescent': '🌒', 'First quarter': '🌓', 'Waxing gibbous': '🌔',
  'Full Moon': '🌕', 'Waning gibbous': '🌖', 'Last quarter': '🌗', 'Waning crescent': '🌘'
};
const RATING_CLASS = { Excellent: 'exc', Good: 'good', Fair: 'fair', Poor: 'poor', Bad: 'bad' };
const TYPE_LABEL = {
  galaxy: 'Galaxy', open: 'Open cluster', globular: 'Globular cluster', nebula: 'Nebula',
  planetary: 'Planetary nebula', double: 'Double star', planet: 'Planet', moon: 'Moon'
};

// Deterministic tiny PRNG so illustrations are stable per object.
function seeded(id) {
  let s = 0;
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}
// A clean inline-SVG illustration per object type (no external images → works
// offline, no CSP/privacy issues). Representative, clearly not a photograph.
function skyArt(o) {
  const rnd = seeded(o.id);
  const dots = (n, spread, cx = 32, cy = 32, r0 = 1) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), spread) * 26;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r0 + rnd() * 0.8).toFixed(1)}" fill="#e8eefc" opacity="${(0.5 + rnd() * 0.5).toFixed(2)}"/>`;
    }
    return s;
  };
  let inner = '';
  switch (o.type) {
    case 'galaxy':
      inner = `<defs><radialGradient id="g-${o.id}"><stop offset="0%" stop-color="#fff7e6"/><stop offset="40%" stop-color="#cdd7ff"/><stop offset="100%" stop-color="#20294a" stop-opacity="0"/></radialGradient></defs>` +
        `<g transform="rotate(-25 32 32)"><ellipse cx="32" cy="32" rx="27" ry="11" fill="url(#g-${o.id})"/>` +
        `<ellipse cx="32" cy="32" rx="9" ry="9" fill="#fff3d6"/>` + dots(26, 2.2) + `</g>`;
      break;
    case 'globular':
      inner = dots(120, 3.4, 32, 32, 0.7);
      break;
    case 'open':
      inner = dots(22, 1.1, 32, 32, 1.3);
      break;
    case 'nebula':
      inner = `<defs><radialGradient id="n-${o.id}"><stop offset="0%" stop-color="#ff9ecb"/><stop offset="55%" stop-color="#8a6bff" stop-opacity="0.55"/><stop offset="100%" stop-color="#20294a" stop-opacity="0"/></radialGradient></defs>` +
        `<ellipse cx="30" cy="34" rx="26" ry="20" fill="url(#n-${o.id})"/>` + dots(16, 1.4);
      break;
    case 'planetary':
      inner = `<defs><radialGradient id="p-${o.id}"><stop offset="0%" stop-color="#20294a" stop-opacity="0"/><stop offset="55%" stop-color="#20294a" stop-opacity="0"/><stop offset="70%" stop-color="#57e6c3"/><stop offset="100%" stop-color="#2a7bff" stop-opacity="0.1"/></radialGradient></defs>` +
        `<circle cx="32" cy="32" r="20" fill="url(#p-${o.id})"/><circle cx="32" cy="32" r="2.4" fill="#eafcff"/>` + dots(10, 1.2);
      break;
    case 'double':
      inner = dots(12, 1.5) + `<circle cx="26" cy="34" r="4.5" fill="#ffd27f"/><circle cx="39" cy="29" r="3.6" fill="#9ec7ff"/>`;
      break;
    case 'planet': {
      const col = { mercury: '#b7b7ad', venus: '#f4e2a1', mars: '#e2734a', jupiter: '#d9b38c', saturn: '#e6cc8f', uranus: '#9fe8e0', neptune: '#5b7bff' }[o.id] || '#cbd5f5';
      inner = `<circle cx="32" cy="32" r="17" fill="${col}"/>` +
        (o.id === 'jupiter' ? `<path d="M15 28 h34 M15 34 h34" stroke="#b98a63" stroke-width="2" opacity="0.5"/>` : '') +
        (o.id === 'saturn' ? `<g transform="rotate(-18 32 32)"><ellipse cx="32" cy="32" rx="27" ry="8" fill="none" stroke="#e6cc8f" stroke-width="3"/><ellipse cx="32" cy="32" rx="27" ry="8" fill="none" stroke="#8a733f" stroke-width="1"/></g>` : '') +
        `<circle cx="26" cy="26" r="15" fill="#000" opacity="0.12"/>`;
      break;
    }
    case 'moon': {
      const illum = (o.moonIllum ?? 50) / 100;
      const waning = /Waning|Last/.test(o.moonPhase || '');
      const off = (waning ? -1 : 1) * (1 - illum) * 34;
      inner = `<defs><clipPath id="m-${o.id}"><circle cx="32" cy="32" r="20"/></clipPath></defs>` +
        `<circle cx="32" cy="32" r="20" fill="#3a4260"/>` +
        `<circle cx="${(32 + off).toFixed(1)}" cy="32" r="20" fill="#eef1f7" clip-path="url(#m-${o.id})"/>` +
        `<g clip-path="url(#m-${o.id})" fill="#c9cfdd" opacity="0.7"><circle cx="26" cy="26" r="3"/><circle cx="38" cy="34" r="4"/><circle cx="30" cy="40" r="2.4"/></g>`;
      break;
    }
    default:
      inner = dots(20, 1.5);
  }
  return `<svg viewBox="0 0 64 64" class="sky-art-svg" aria-hidden="true"><rect width="64" height="64" fill="#0a1024"/>${inner}</svg>`;
}

async function loadSkyWatch() {
  if (!isAuthed()) return;
  const err = $('#sky-error');
  err.classList.add('hidden');
  $('#sky-hero').innerHTML = '<div class="wx-loading">Assessing the sky…</div>';
  try {
    const res = await fetch('/api/skywatch');
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      err.textContent = j.error === 'no receiver location set'
        ? 'Set your receiver location in Settings to use Sky Watch.'
        : `Sky Watch unavailable: ${j.error || res.status}`;
      err.classList.remove('hidden');
      $('#sky-hero').innerHTML = '';
      return;
    }
    const d = await res.json();
    renderSkyHero(d);
    renderSkyNights(d);
    renderSkyObjects(d);
  } catch {
    err.textContent = 'Sky Watch unavailable — check your connection.';
    err.classList.remove('hidden');
    $('#sky-hero').innerHTML = '';
  }
}

function renderSkyHero(d) {
  const t = d.nights[0];
  const off = d.utcOffsetSeconds;
  const cls = RATING_CLASS[t.rating] || 'fair';
  const window = t.hasDark
    ? `Dark sky (no twilight) from <b>${skyTime(t.darkStart, off)}</b> to <b>${skyTime(t.darkEnd, off)}</b>`
    : 'No astronomical darkness tonight (sky never fully dark)';
  const moonUp = t.moonUpFrac > 5 ? `up ${t.moonUpFrac}% of the dark hours` : 'below the horizon';
  const precipLabel = t.precipProb == null ? '—'
    : t.dry ? 'Staying dry'
    : `${t.precipProb}% chance${t.precipMm ? ` · ${t.precipMm} mm` : ''}`;
  const dewLabel = t.dewSpread == null ? '—'
    : t.dewSpread <= 1 ? `Likely · ${t.dewSpread}°C spread`
    : t.dewSpread <= 3 ? `Possible · ${t.dewSpread}°C spread`
    : `Unlikely · ${t.dewSpread}°C spread`;
  $('#sky-hero').innerHTML =
    `<div class="sky-score sky-${cls}">` +
    `<svg viewBox="0 0 120 120" class="sky-ring"><circle cx="60" cy="60" r="52" class="sky-ring-bg"/>` +
    `<circle cx="60" cy="60" r="52" class="sky-ring-fg" stroke-dasharray="${(t.score / 100 * 326.7).toFixed(1)} 326.7" transform="rotate(-90 60 60)"/></svg>` +
    `<div class="sky-score-num">${t.score}<span>/100</span></div></div>` +
    `<div class="sky-hero-body">` +
    `<div class="sky-verdict sky-${cls}-txt">${esc(t.rating)} conditions tonight</div>` +
    `<div class="sky-window">${window}</div>` +
    `<div class="sky-reasons">${(t.reasons || []).map((r) => `<span class="sky-chip">${esc(r)}</span>`).join('')}</div>` +
    `<div class="sky-cond">` +
    skyCond('☁️', 'Cloud cover', t.cloud != null ? `${t.cloud}%` : '—') +
    skyCond('🌧️', 'Precipitation', precipLabel) +
    skyCond(MOON_EMOJI[t.moonPhase] || '🌙', 'Moon', `${t.moonIllum}% · ${esc(t.moonPhase)}`) +
    skyCond('🌫️', 'Moon in dark sky', moonUp) +
    skyCond('💦', 'Dew on optics', dewLabel) +
    skyCond('💧', 'Humidity', t.humidity != null ? `${t.humidity}%` : '—') +
    skyCond('🏙️', 'Light pollution', `Bortle ${d.bortle} — ${esc(d.bortleLabel)}`) +
    skyCond('✨', 'Faintest star (est.)', `mag ${d.nelm}`) +
    `</div></div>`;
}
const skyCond = (icon, k, v) =>
  `<div class="sky-cond-item"><span class="sky-cond-ico">${icon}</span><div><span class="sky-cond-k">${esc(k)}</span><span class="sky-cond-v">${esc(v)}</span></div></div>`;

function renderSkyNights(d) {
  const box = $('#sky-nights');
  box.innerHTML = '';
  d.nights.forEach((n, i) => {
    const cls = RATING_CLASS[n.rating] || 'fair';
    const row = document.createElement('div');
    row.className = 'sky-night';
    row.innerHTML =
      `<span class="sky-night-day">${esc(skyDayLabel(n.dateMs, d.utcOffsetSeconds, i))}</span>` +
      `<span class="sky-night-moon" title="${esc(n.moonPhase)}">${MOON_EMOJI[n.moonPhase] || '🌙'} ${n.moonIllum}%</span>` +
      `<span class="sky-night-cloud" title="Cloud cover">☁️ ${n.cloud != null ? n.cloud + '%' : '—'}</span>` +
      `<span class="sky-night-bar"><span class="sky-night-fill sky-${cls}-bg" style="width:${n.score}%"></span></span>` +
      `<span class="sky-night-rating sky-${cls}-txt">${esc(n.rating)} ${n.score}</span>`;
    box.appendChild(row);
  });
}

function renderSkyObjects(d) {
  const box = $('#sky-objects');
  box.innerHTML = '';
  $('#sky-obj-note').textContent = d.objects.length ? '· sorted by how well-placed they are' : '';
  if (!d.objects.length) {
    box.innerHTML = '<p class="muted">Nothing well-placed during tonight’s dark window — try another night.</p>';
    return;
  }
  for (const o of d.objects) {
    const card = document.createElement('div');
    card.className = 'sky-obj';
    const moonExtra = o.type === 'moon' ? '' : ` · mag ${o.mag}`;
    card.innerHTML =
      `<div class="sky-obj-art">${skyArt(o)}</div>` +
      `<div class="sky-obj-body">` +
      `<div class="sky-obj-head"><span class="sky-obj-name">${esc(o.name)}</span>` +
      `<span class="sky-obj-type">${esc(TYPE_LABEL[o.type] || o.type)}</span></div>` +
      `<div class="sky-obj-meta">${esc(o.con)}${moonExtra} · <span class="sky-obj-inst">${esc(o.instrument)}</span></div>` +
      `<div class="sky-obj-where">🧭 Look <b>${esc(o.dir)}</b>, <b>${o.peakAlt}°</b> up · best around <b>${skyTime(o.bestTimeMs, d.utcOffsetSeconds)}</b></div>` +
      `<div class="sky-obj-info">${esc(o.info)}</div>` +
      `</div>`;
    box.appendChild(card);
  }
}

(async function boot() {
  await loadAuth();
  await loadAuth();
  try {
    state.config = await (await fetch('/api/config')).json();
    state.units = state.config.ui?.units || 'aviation';
  } catch { /* server starting */ }
  if (isAuthed()) loadZones();
  connectStream();
  if (isAuthed()) {
    loadWeather();
    setInterval(loadWeather, 600000); // refresh every 10 min
  }
  if (Notification.permission === 'default') {
    // unobtrusive: ask once after a short delay
    setTimeout(() => Notification.requestPermission(), 4000);
  }
})();
