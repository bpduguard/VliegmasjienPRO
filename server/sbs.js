// SBS/BaseStation (port 30003) TCP client — an alternative data source for
// receivers that only expose the beast-style network ports instead of the
// dump1090 web server's aircraft.json.
//
// SBS message fields (comma separated):
//  0 "MSG", 1 transmission type, 4 hex ident, 10 callsign, 11 altitude,
//  12 ground speed, 13 track, 14 lat, 15 lon, 16 vertical rate, 17 squawk,
//  18 alert, 19 emergency, 20 SPI, 21 is_on_ground
import net from 'node:net';

const acMap = new Map(); // hex -> partial state
const state = { connected: false, error: null, messages: 0, target: null };

let socket = null;
let reconnectTimer = null;
let buffer = '';

export function sbsStatus() {
  return { ...state };
}

export function ensureSbs(host, port) {
  const target = `${host}:${port}`;
  if (state.target === target && (socket || reconnectTimer)) return;
  stopSbs();
  state.target = target;
  connect(host, port);
}

export function stopSbs() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) { socket.destroy(); socket = null; }
  state.connected = false;
  state.target = null;
  buffer = '';
}

function connect(host, port) {
  socket = net.connect({ host, port, family: 0 });
  socket.setKeepAlive(true, 30000);
  socket.on('connect', () => {
    state.connected = true;
    state.error = null;
    console.log(`[sbs] connected to ${host}:${port}`);
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      parseLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
    if (buffer.length > 65536) buffer = ''; // garbage guard
  });
  const onDown = (err) => {
    state.connected = false;
    if (err) state.error = err.message;
    if (socket) { socket.destroy(); socket = null; }
    if (!reconnectTimer && state.target) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (state.target) connect(host, port);
      }, 5000);
    }
  };
  socket.on('error', onDown);
  socket.on('close', () => onDown());
}

function parseLine(line) {
  const f = line.trim().split(',');
  if (f[0] !== 'MSG') return;
  const hex = (f[4] || '').trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return;
  state.messages++;
  let a = acMap.get(hex);
  if (!a) { a = { hex, msgs: 0 }; acMap.set(hex, a); }
  a.msgs++;
  a.ts = Date.now();
  const type = f[1];
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; };
  switch (type) {
    case '1': { // identification
      const cs = (f[10] || '').trim();
      if (cs) a.flight = cs;
      break;
    }
    case '2': // surface position
    case '3': { // airborne position
      const alt = num(f[11]); if (alt !== undefined) a.alt = alt;
      const lat = num(f[14]); const lon = num(f[15]);
      if (lat !== undefined && lon !== undefined) { a.lat = lat; a.lon = lon; }
      if (f[21] !== undefined && f[21] !== '') a.onGround = f[21].trim() === '-1' || f[21].trim() === '1';
      if (type === '2') a.onGround = true;
      break;
    }
    case '4': { // velocity
      const gs = num(f[12]); if (gs !== undefined) a.gs = gs;
      const trk = num(f[13]); if (trk !== undefined) a.track = trk;
      const vr = num(f[16]); if (vr !== undefined) a.vr = vr;
      break;
    }
    case '5': // surveillance altitude
    case '7': { // air-to-air
      const alt = num(f[11]); if (alt !== undefined) a.alt = alt;
      break;
    }
    case '6': { // surveillance id (squawk)
      const sq = (f[17] || '').trim();
      if (sq) a.squawk = sq;
      const alt = num(f[11]); if (alt !== undefined) a.alt = alt;
      break;
    }
  }
  if (f[19] !== undefined && f[19].trim() === '-1') a.emergencyFlag = true;
}

// Produce an aircraft.json-shaped snapshot so the tracker can consume SBS data
// through the exact same code path as the HTTP source.
export function sbsSnapshot() {
  const now = Date.now();
  const aircraft = [];
  for (const [hex, a] of acMap) {
    if (now - a.ts > 120000) { acMap.delete(hex); continue; }
    aircraft.push({
      hex,
      flight: a.flight,
      alt_baro: a.onGround ? 'ground' : a.alt,
      gs: a.gs,
      track: a.track,
      lat: a.lat,
      lon: a.lon,
      baro_rate: a.vr,
      squawk: a.squawk,
      emergency: a.emergencyFlag ? 'general' : undefined,
      seen: (now - a.ts) / 1000,
      messages: a.msgs
    });
  }
  return { now: now / 1000, messages: state.messages, aircraft };
}
