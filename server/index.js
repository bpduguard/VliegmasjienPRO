import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { loadConfig, getConfig, saveConfig, publicConfig } from './config.js';
import { initDb, aircraftHistory, recentAlerts, statsSummary } from './db.js';
import {
  loadPlaneDbFromDisk, refreshPlaneDb, planeDbMeta, planeDbLookup, planeDbSearch
} from './enrich.js';
import { lookupPhoto } from './enrich.js';
import {
  startTracker, snapshot, aircraftDetail, trackerStatus, setTrackerBroadcast
} from './tracker.js';
import { setBroadcast, notify } from './notify.js';
import { streamAircraftFacts, aiAvailable } from './ai.js';

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

app.get('/api/aircraft/:hex/ai', async (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  const detail = await aircraftDetail(req.params.hex);
  if (!detail) {
    res.write(`data: ${JSON.stringify({ error: 'Aircraft no longer tracked.' })}\n\n`);
    return res.end();
  }
  await streamAircraftFacts(detail, res);
});

// ------------------------------------------------------------------ stats & alerts
app.get('/api/stats', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7));
  res.json(statsSummary(days));
});

app.get('/api/alerts', (req, res) => res.json({ alerts: recentAlerts(150) }));

app.get('/api/status', (req, res) =>
  res.json({ ...trackerStatus(), planeDb: planeDbMeta(), ai: aiAvailable(), version: '1.0.0' })
);

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
  if (patch.anthropic?.apiKey && patch.anthropic.apiKey.includes('••')) delete patch.anthropic.apiKey;
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
