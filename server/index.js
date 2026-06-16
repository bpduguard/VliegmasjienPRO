import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { loadConfig, getConfig, saveConfig, publicConfig } from './config.js';
import { initDb, aircraftHistory, recentAlerts, statsSummary, aircraftDbCount, bulkImportAircraftDb } from './db.js';
import {
  loadPlaneDbFromDisk, refreshPlaneDb, planeDbMeta, planeDbLookup, planeDbSearch, aircraftDbError
} from './enrich.js';
import { lookupPhoto } from './enrich.js';
import {
  startTracker, snapshot, aircraftDetail, trackerStatus, setTrackerBroadcast
} from './tracker.js';
import { setBroadcast, notify } from './notify.js';
import { refreshFrequencies, frequenciesMeta } from './freq.js';
import { airportFreqsInBounds, replayBounds, replayFrame } from './db.js';
import { VERSION } from './version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8390;

loadConfig();
initDb();
loadPlaneDbFromDisk();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// Leaflet is served locally so the app works without internet/CDN access.
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
// Bundled SVG country flags (served locally so they render everywhere incl. Windows).
app.use('/vendor/flag-icons', express.static(path.join(__dirname, '..', 'node_modules', 'flag-icons')));

// ------------------------------------------------------------------ SSE stream
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}
setBroadcast(broadcast);
setTrackerBroadcast(broadcast);

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(`event: aircraft\ndata: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ------------------------------------------------------------------ aircraft
app.get('/api/aircraft', (req, res) => res.json(snapshot()));

app.get('/api/aircraft/:hex', async (req, res) => {
  const detail = await aircraftDetail(req.params.hex);
  if (!detail) return res.status(404).json({ error: 'aircraft not currently tracked' });
  res.json(detail);
});

app.get('/api/aircraft/:hex/photo', async (req, res) => {
  res.json({ photo: await lookupPhoto(req.params.hex) });
});

app.get('/api/aircraft/:hex/history', (req, res) => {
  res.json({ history: aircraftHistory(req.params.hex) });
});

// ------------------------------------------------------------------ stats & alerts
app.get('/api/stats', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7));
  res.json(statsSummary(days));
});

app.get('/api/alerts', (req, res) => res.json({ alerts: recentAlerts(150) }));

app.get('/api/status', (req, res) =>
  res.json({
    ...trackerStatus(),
    planeDb: planeDbMeta(),
    aircraftDb: { count: aircraftDbCount(), error: aircraftDbError() },
    version: VERSION
  })
);

// ------------------------------------------------------------------ aircraft DB
// Bulk import a hex→registration/type[/operator] dataset (CSV or NDJSON) for
// users whose receiver/firewall can't do per-hex lookups, or who want the whole
// database loaded at once. Accepts a `url` to fetch or a pasted `csv` body.
app.post('/api/aircraftdb/import', async (req, res) => {
  try {
    let text = req.body?.csv;
    if (!text && req.body?.url) {
      const r = await fetch(req.body.url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) return res.status(502).json({ error: `download failed: HTTP ${r.status}` });
      text = await r.text();
    }
    if (!text) return res.status(400).json({ error: 'provide a url or csv body' });
    const rows = parseAircraftDataset(text);
    if (!rows.length) return res.status(400).json({ error: 'no usable rows (need hex,registration,type columns)' });
    const n = bulkImportAircraftDb(rows);
    res.json({ imported: n, count: aircraftDbCount() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse either NDJSON (one JSON object per line, basic-ac-db style:
// {icao,reg,icaotype,...}) or CSV with a header naming the columns.
function parseAircraftDataset(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const trimmed = lines.find((l) => l.trim());
  if (trimmed && trimmed.trim().startsWith('{')) {
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        const hex = (o.icao || o.hex || o.icao24 || '').toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(hex)) continue;
        out.push({
          hex,
          registration: o.reg || o.registration || o.r || '',
          type: o.icaotype || o.icao_type || o.typecode || o.t || '',
          typeLong: o.type || o.model || '',
          operator: o.ownop || o.operator || o.registered_owner || ''
        });
      } catch { /* skip bad line */ }
    }
    return out;
  }
  // CSV with header
  const header = (lines[0] || '').split(',').map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
  const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iHex = col('icao24', 'icao', 'hex');
  const iReg = col('registration', 'reg', 'r');
  const iType = col('typecode', 'icaotype', 'icao_type', 'type', 't');
  const iOwner = col('operator', 'ownop', 'registered_owner', 'owner');
  if (iHex < 0) return out;
  for (let n = 1; n < lines.length; n++) {
    const c = lines[n].split(',').map((v) => v.replace(/^["']|["']$/g, '').trim());
    const hex = (c[iHex] || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) continue;
    out.push({
      hex,
      registration: iReg >= 0 ? c[iReg] : '',
      type: iType >= 0 ? c[iType] : '',
      operator: iOwner >= 0 ? c[iOwner] : ''
    });
  }
  return out;
}

// ------------------------------------------------------------------ config
app.get('/api/config', (req, res) => res.json(publicConfig()));

app.post('/api/config', (req, res) => {
  const patch = req.body || {};
  // Don't let masked secrets ('••••') overwrite real ones.
  for (const sect of ['pushover', 'discord']) {
    if (patch[sect]) {
      for (const [k, v] of Object.entries(patch[sect])) {
        if (typeof v === 'string' && v.includes('••')) delete patch[sect][k];
      }
    }
  }
  saveConfig(patch);
  res.json(publicConfig());
});

// ------------------------------------------------------------------ zones
app.get('/api/zones', (req, res) => res.json({ zones: getConfig().zones }));

app.post('/api/zones', (req, res) => {
  const { name, lat, lon, radiusKm, notify: doNotify = true, color } = req.body || {};
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusKm)) {
    return res.status(400).json({ error: 'name, lat, lon and radiusKm are required' });
  }
  const zones = [...getConfig().zones, {
    id: crypto.randomUUID(), name, lat, lon,
    radiusKm: Math.max(0.1, radiusKm), notify: doNotify, color: color || '#3b82f6'
  }];
  saveConfig({ zones });
  res.json({ zones });
});

app.put('/api/zones/:id', (req, res) => {
  const zones = getConfig().zones.map((z) => (z.id === req.params.id ? { ...z, ...req.body, id: z.id } : z));
  saveConfig({ zones });
  res.json({ zones });
});

app.delete('/api/zones/:id', (req, res) => {
  const zones = getConfig().zones.filter((z) => z.id !== req.params.id);
  saveConfig({ zones });
  res.json({ zones });
});

// ------------------------------------------------------------------ watchlist
app.get('/api/watchlist', (req, res) => res.json({ watchlist: getConfig().watchlist }));

app.post('/api/watchlist', (req, res) => {
  const e = req.body || {};
  if (!e.icao && !e.registration && !e.callsign) {
    return res.status(400).json({ error: 'icao, registration or callsign required' });
  }
  const entry = {
    id: crypto.randomUUID(),
    icao: (e.icao || '').toLowerCase(),
    registration: e.registration || '',
    callsign: e.callsign || '',
    operator: e.operator || '',
    type: e.type || '',
    icaoType: e.icaoType || '',
    category: e.category || '',
    tags: e.tags || [],
    link: e.link || '',
    notify: e.notify !== false
  };
  // de-dupe by icao
  const watchlist = getConfig().watchlist.filter((w) => !entry.icao || w.icao !== entry.icao);
  watchlist.push(entry);
  saveConfig({ watchlist });
  res.json({ watchlist });
});

app.delete('/api/watchlist/:id', (req, res) => {
  const watchlist = getConfig().watchlist.filter((w) => w.id !== req.params.id);
  saveConfig({ watchlist });
  res.json({ watchlist });
});

// Import a CSV in plane-alert-db format directly into the watchlist.
app.post('/api/watchlist/import', (req, res) => {
  const { csv } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'csv body field required' });
  let added = 0;
  const watchlist = [...getConfig().watchlist];
  const existing = new Set(watchlist.map((w) => w.icao));
  for (const line of csv.split(/\r?\n/)) {
    if (!line || line.startsWith('$ICAO') || line.startsWith('#')) continue;
    const c = line.split(',');
    const hex = (c[0] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex) || existing.has(hex)) continue;
    watchlist.push({
      id: crypto.randomUUID(),
      icao: hex,
      registration: (c[1] || '').trim(),
      callsign: '',
      operator: (c[2] || '').trim(),
      type: (c[3] || '').trim(),
      icaoType: (c[4] || '').trim(),
      category: (c[9] || '').trim(),
      tags: [c[6], c[7], c[8]].map((t) => (t || '').trim()).filter(Boolean),
      link: (c[10] || '').trim(),
      notify: true
    });
    existing.add(hex);
    added++;
  }
  saveConfig({ watchlist });
  res.json({ watchlist, added });
});

// ------------------------------------------------------------------ plane-alert-db
app.get('/api/planedb/meta', (req, res) => res.json(planeDbMeta()));

app.post('/api/planedb/refresh', async (req, res) => {
  try {
    res.json(await refreshPlaneDb());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/planedb/search', (req, res) => res.json({ results: planeDbSearch(req.query.q) }));

app.get('/api/planedb/:hex', (req, res) => res.json({ entry: planeDbLookup(req.params.hex) }));

// ------------------------------------------------------------------ weather
// RainViewer frame metadata proxy (avoids CORS surprises and centralizes caching).
let rainviewerCache = { ts: 0, data: null };
app.get('/api/weather/rainviewer', async (req, res) => {
  if (Date.now() - rainviewerCache.ts < 60000 && rainviewerCache.data) {
    return res.json(rainviewerCache.data);
  }
  try {
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
      signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    rainviewerCache = { ts: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// OpenWeatherMap tile proxy so the API key never reaches the browser.
app.get('/api/weather/owm/:layer/:z/:x/:y', async (req, res) => {
  const key = getConfig().weather.openWeatherMapKey;
  if (!key) return res.status(404).json({ error: 'no OpenWeatherMap key configured' });
  const { layer, z, x, y } = req.params;
  if (!/^[a-z_]+$/.test(layer)) return res.status(400).end();
  try {
    const r = await fetch(
      `https://tile.openweathermap.org/map/${layer}/${z}/${x}/${y}.png?appid=${key}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=300');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// ------------------------------------------------------------------ replay
app.get('/api/replay/bounds', (req, res) => res.json(replayBounds()));

app.get('/api/replay/frame', (req, res) => {
  const at = parseInt(req.query.at, 10);
  if (!Number.isFinite(at)) return res.status(400).json({ error: 'at (ms) required' });
  const window = Math.min(600000, Math.max(1000, parseInt(req.query.window, 10) || 60000));
  res.json({ at, aircraft: replayFrame(at, window) });
});

// ------------------------------------------------------------------ frequencies
app.get('/api/frequencies/meta', (req, res) => res.json(frequenciesMeta()));

app.post('/api/frequencies/refresh', async (req, res) => {
  try {
    res.json(await refreshFrequencies());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Airports (with comm frequencies) within the given map bounds.
app.get('/api/frequencies', (req, res) => {
  const n = parseFloat(req.query.n);
  const s = parseFloat(req.query.s);
  const e = parseFloat(req.query.e);
  const w = parseFloat(req.query.w);
  if ([n, s, e, w].some((v) => !Number.isFinite(v))) {
    return res.status(400).json({ error: 'n, s, e, w bounds required' });
  }
  const limit = Math.min(800, Math.max(1, parseInt(req.query.limit, 10) || 500));
  res.json({ airports: airportFreqsInBounds(s, w, n, e, limit) });
});

// ------------------------------------------------------------------ test notification
app.post('/api/notify/test', async (req, res) => {
  await notify({
    key: null,
    kind: 'test',
    title: '🔔 VliegmasjienPRO test notification',
    message: 'If you can read this, notifications are working.',
    aircraft: null
  });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`VliegmasjienPRO listening on http://0.0.0.0:${PORT}`);
  startTracker();
});
