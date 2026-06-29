// Configuration management. Config lives in DATA_DIR/config.json so it survives
// container rebuilds. Environment variables override file values for secrets.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // Data source: 'json' fetches aircraft.json over HTTP (dump1090-fa / readsb /
  // tar1090 web server) — richest data. 'sbs' connects to the BaseStation TCP
  // output (beasthost port 30003) for setups that only expose the net ports.
  source: {
    mode: process.env.SOURCE_MODE || 'json',
    sbsHost: process.env.SBS_HOST || 'dump1090',
    sbsPort: parseInt(process.env.SBS_PORT, 10) || 30003
  },
  // Where to fetch aircraft.json from. dump1090-fa / readsb / tar1090 all serve this.
  dump1090Url: process.env.DUMP1090_URL || 'http://dump1090:8080/data/aircraft.json',
  pollIntervalMs: 2000,
  // Receiver location (used as map center and for distance calculations).
  // Auto-detected from dump1090 receiver.json when possible.
  receiver: { lat: null, lon: null },
  // History / statistics retention in days (sightings + daily stats).
  retentionDays: 30,
  // Replay track-point retention in days. The tracks table is high-volume, so
  // it gets its own (shorter) retention than the sightings/stats.
  replayRetentionDays: 3,
  // Trail length per aircraft (number of recorded positions kept in memory).
  trailLength: 120,
  // Notifications
  pushover: { enabled: false, token: '', user: '', priority: 0 },
  discord: { enabled: false, webhookUrl: '' },
  browserNotifications: { enabled: true },
  // Cooldown so a plane circling a zone boundary doesn't spam (minutes).
  notifyCooldownMin: 15,
  // Zones: { id, name, lat, lon, radiusKm, notify: true, color }
  zones: [],
  // Watchlist: plane-alert-db compatible entries.
  // { icao, registration, operator, type, icaoType, group, tags:[], link, notify: true }
  watchlist: [],
  // Notify on any military / emergency aircraft regardless of watchlist.
  notifyMilitary: false,
  notifyEmergency: true,
  // Notify ~1h ahead when the ISS or Hubble makes a visible pass (dark sky) over
  // the receiver location.
  notifySatellitePasses: false,
  // plane-alert-db source (same resource planefence/plane-alert uses)
  planeAlertDbUrl: 'https://raw.githubusercontent.com/sdr-enthusiasts/plane-alert-db/main/plane-alert-db.csv',
  planeAlertDbAutoRefreshHours: 168,
  // Weather overlay
  weather: {
    // RainViewer radar needs no key. OpenWeatherMap layers need a free API key.
    openWeatherMapKey: process.env.OWM_API_KEY || ''
  },
  // OpenAIP (controlled-airspace tile overlay) — needs a free API key.
  openAip: { apiKey: process.env.OPENAIP_API_KEY || '' },
  // UI defaults
  ui: { darkMode: true, units: 'metric' }
};

let config = null;

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!extra || typeof extra !== 'object') return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* first run */
  }
  config = deepMerge(DEFAULTS, fileCfg);
  // Environment variables seed the *initial* defaults (see DEFAULTS above, which
  // read process.env). They must only apply on first run — once a value has been
  // saved through the UI it lives in config.json and the saved value wins. Applying
  // env on every load is what made the app "forget" a URL set in the UI after a
  // restart, because docker-compose always sets DUMP1090_URL (to its default).
  if (fileCfg.dump1090Url === undefined && process.env.DUMP1090_URL) config.dump1090Url = process.env.DUMP1090_URL;
  if (fileCfg.source?.mode === undefined && process.env.SOURCE_MODE) config.source.mode = process.env.SOURCE_MODE;
  if (fileCfg.source?.sbsHost === undefined && process.env.SBS_HOST) config.source.sbsHost = process.env.SBS_HOST;
  if (fileCfg.source?.sbsPort === undefined && process.env.SBS_PORT) config.source.sbsPort = parseInt(process.env.SBS_PORT, 10);
  if (fileCfg.weather?.openWeatherMapKey === undefined && process.env.OWM_API_KEY) {
    config.weather.openWeatherMapKey = process.env.OWM_API_KEY;
  }
  return config;
}

export function getConfig() {
  if (!config) loadConfig();
  return config;
}

export function saveConfig(patch) {
  config = deepMerge(getConfig(), patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

// Config sent to the browser — secrets are masked, only presence is exposed.
export function publicConfig() {
  const c = getConfig();
  const { auth, ...rest } = c; // never expose the password hash / session secret
  return {
    ...rest,
    pushover: { ...c.pushover, token: c.pushover.token ? '••••' : '', user: c.pushover.user ? '••••' : '' },
    discord: { ...c.discord, webhookUrl: c.discord.webhookUrl ? '••••' : '' },
    weather: { hasOwmKey: !!c.weather.openWeatherMapKey },
    openAip: { hasKey: !!c.openAip?.apiKey }
  };
}
