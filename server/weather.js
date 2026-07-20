// Weather: trusted current conditions + multi-day forecast for the configured
// receiver location, plus derivation of extreme-condition warnings and a
// scheduler that can notify about them.
//
// Sources (all free, no scraping):
//   • Open-Meteo (https://open-meteo.com) — current, hourly and daily forecast.
//     Open-Meteo blends national weather-service models (DWD ICON, ECMWF, GFS,
//     Météo-France…), so the numbers are model guidance from official providers.
//   • aviationweather.gov METAR — the nearest *observed* report, used as a
//     ground-truth cross-check of the forecast (handled in index.js).
//
// The warnings below are DERIVED by us from the trusted forecast using fixed
// thresholds — they are not official government watches/warnings. The UI labels
// them as such.
import { getConfig } from './config.js';
import { extFetch } from './enrich.js';
import { notify } from './notify.js';

const OPEN_METEO_BASE = process.env.OPEN_METEO_BASE || 'https://api.open-meteo.com/v1/forecast';
const FORECAST_DAYS = 7;
const CACHE_TTL = 10 * 60000; // 10 min — Open-Meteo updates hourly at most

let cache = { key: '', ts: 0, data: null };

// Fetch current + hourly + daily forecast for a location. Cached per rounded
// coordinate so paging around the app doesn't hammer the API.
export async function getForecast(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (cache.data && cache.key === key && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  const url =
    `${OPEN_METEO_BASE}?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,' +
    'wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,is_day' +
    '&hourly=temperature_2m,apparent_temperature,dew_point_2m,precipitation_probability,precipitation,weather_code,' +
    'wind_speed_10m,wind_gusts_10m,cloud_cover,relative_humidity_2m,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,' +
    'precipitation_sum,precipitation_probability_max,precipitation_hours,snowfall_sum,' +
    'wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset' +
    `&wind_speed_unit=kmh&timezone=auto&forecast_days=${FORECAST_DAYS}`;

  const resp = await extFetch(url, { signal: AbortSignal.timeout(12000) });
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const j = await resp.json();

  const cur = j.current || {};
  const current = {
    temp: cur.temperature_2m ?? null,
    feels: cur.apparent_temperature ?? null,
    humidity: cur.relative_humidity_2m ?? null,
    windKmh: cur.wind_speed_10m ?? null,
    gustKmh: cur.wind_gusts_10m ?? null,
    windDir: cur.wind_direction_10m ?? null,
    precipMm: cur.precipitation ?? null,
    pressure: cur.pressure_msl ?? null,
    cloud: cur.cloud_cover ?? null,
    code: cur.weather_code ?? null,
    isDay: cur.is_day ?? 1,
    time: cur.time ?? null
  };

  const d = j.daily || {};
  const daily = (d.time || []).map((date, i) => ({
    date,
    code: d.weather_code?.[i] ?? null,
    tmax: d.temperature_2m_max?.[i] ?? null,
    tmin: d.temperature_2m_min?.[i] ?? null,
    appMax: d.apparent_temperature_max?.[i] ?? null,
    appMin: d.apparent_temperature_min?.[i] ?? null,
    precip: d.precipitation_sum?.[i] ?? null,
    precipProb: d.precipitation_probability_max?.[i] ?? null,
    precipHours: d.precipitation_hours?.[i] ?? null,
    snow: d.snowfall_sum?.[i] ?? null,
    windMax: d.wind_speed_10m_max?.[i] ?? null,
    gustMax: d.wind_gusts_10m_max?.[i] ?? null,
    windDir: d.wind_direction_10m_dominant?.[i] ?? null,
    uvMax: d.uv_index_max?.[i] ?? null,
    sunrise: d.sunrise?.[i] ?? null,
    sunset: d.sunset?.[i] ?? null
  }));

  const h = j.hourly || {};
  const hourly = (h.time || []).map((time, i) => ({
    time,
    temp: h.temperature_2m?.[i] ?? null,
    feels: h.apparent_temperature?.[i] ?? null,
    dewPoint: h.dew_point_2m?.[i] ?? null,
    precipProb: h.precipitation_probability?.[i] ?? null,
    precip: h.precipitation?.[i] ?? null,
    code: h.weather_code?.[i] ?? null,
    windKmh: h.wind_speed_10m?.[i] ?? null,
    gustKmh: h.wind_gusts_10m?.[i] ?? null,
    cloud: h.cloud_cover?.[i] ?? null,
    humidity: h.relative_humidity_2m?.[i] ?? null,
    isDay: h.is_day?.[i] ?? 1
  }));

  const data = { tz: j.timezone || 'auto', utcOffsetSeconds: j.utc_offset_seconds ?? 0, current, daily, hourly, ts: Date.now() };
  cache = { key, ts: Date.now(), data };
  return data;
}

// --------------------------------------------------------------- warnings
// Fixed thresholds on the trusted forecast. Each level escalates: advisory <
// warning < severe. Kept deliberately conservative so an "extreme" warning
// really is unusual weather. km/h for wind, °C for temp, mm/day for rain.
const THUNDER_CODES = new Set([95, 96, 99]);

function pick(value, [warn, severe]) {
  if (value == null) return null;
  if (value >= severe) return 'severe';
  if (value >= warn) return 'warning';
  return null;
}
function pickLow(value, [warn, severe]) {
  if (value == null) return null;
  if (value <= severe) return 'severe';
  if (value <= warn) return 'warning';
  return null;
}

// Evaluate one forecast day, returning any triggered warnings.
function warningsForDay(day) {
  const out = [];
  const add = (level, kind, icon, title, detail) => out.push({ date: day.date, level, kind, icon, title, detail });

  let lvl;
  if ((lvl = pick(day.appMax, [34, 40]))) {
    add(lvl, 'heat', '🥵', lvl === 'severe' ? 'Extreme heat' : 'Heat',
      `Feels-like up to ${Math.round(day.appMax)}°C (air ${Math.round(day.tmax)}°C).`);
  }
  if ((lvl = pickLow(day.appMin, [-12, -20]))) {
    add(lvl, 'cold', '🥶', lvl === 'severe' ? 'Extreme cold' : 'Cold',
      `Feels-like down to ${Math.round(day.appMin)}°C (air ${Math.round(day.tmin)}°C).`);
  }
  if ((lvl = pick(day.gustMax, [70, 100]))) {
    add(lvl, 'wind', '💨', lvl === 'severe' ? 'Damaging winds' : 'High winds',
      `Gusts up to ${Math.round(day.gustMax)} km/h.`);
  }
  if ((lvl = pick(day.precip, [30, 60]))) {
    add(lvl, 'rain', '🌊', lvl === 'severe' ? 'Very heavy rain' : 'Heavy rain',
      `${Math.round(day.precip)} mm over ${Math.round(day.precipHours || 0)} h — flooding possible.`);
  }
  if ((lvl = pick(day.snow, [5, 20]))) {
    add(lvl, 'snow', '❄️', lvl === 'severe' ? 'Heavy snow' : 'Snow',
      `${day.snow.toFixed(1)} cm of snow expected.`);
  }
  if (THUNDER_CODES.has(day.code)) {
    add(day.code === 95 ? 'warning' : 'severe', 'storm', '⛈️', 'Thunderstorms',
      day.code === 95 ? 'Thunderstorms likely.' : 'Thunderstorms with hail likely.');
  }
  if ((lvl = pick(day.uvMax, [8, 11]))) {
    add(lvl, 'uv', '🔆', lvl === 'severe' ? 'Extreme UV' : 'Very high UV',
      `UV index up to ${Math.round(day.uvMax)}.`);
  }
  return out;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(dateStr, todayStr, tomorrowStr) {
  if (dateStr === todayStr) return 'Today';
  if (dateStr === tomorrowStr) return 'Tomorrow';
  const parts = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return DAY_LABELS[d.getUTCDay()];
}

// All warnings across the forecast, most-severe first, tagged with a friendly
// day label. `todayStr` is injectable for testing.
export function weatherWarnings(forecast, todayStr) {
  if (!forecast?.daily?.length) return [];
  const today = todayStr || forecast.daily[0].date;
  const tIdx = forecast.daily.findIndex((d) => d.date === today);
  const tomorrow = forecast.daily[(tIdx < 0 ? 0 : tIdx) + 1]?.date;
  const rank = { severe: 0, warning: 1, advisory: 2 };
  const all = [];
  for (const day of forecast.daily) {
    if (day.date < today) continue;
    for (const w of warningsForDay(day)) {
      all.push({ ...w, dayLabel: dayLabel(day.date, today, tomorrow) });
    }
  }
  all.sort((a, b) => (rank[a.level] - rank[b.level]) || a.date.localeCompare(b.date));
  return all;
}

// --------------------------------------------------------- notifications
const notified = new Map(); // key -> ts (dedupe + prune)

// `nowMs` injectable for testing.
export async function checkWeatherNotifications(nowMs = Date.now()) {
  const cfg = getConfig();
  if (!cfg.notifyExtremeWeather) return;
  const r = cfg.receiver;
  if (r?.lat == null || r?.lon == null) return;

  let forecast;
  try { forecast = await getForecast(r.lat, r.lon); } catch { return; }
  const today = forecast.daily?.[0]?.date;
  const tomorrow = forecast.daily?.[1]?.date;
  const warnings = weatherWarnings(forecast);

  for (const w of warnings) {
    // Only alert about genuinely extreme conditions for today/tomorrow.
    if (w.level === 'advisory') continue;
    if (w.date !== today && w.date !== tomorrow) continue;
    const key = `wx:${w.date}:${w.kind}:${w.level}`;
    if (notified.has(key)) continue;
    notified.set(key, nowMs);
    notify({
      key,
      kind: 'weather',
      title: `${w.icon} ${w.level === 'severe' ? 'SEVERE — ' : ''}${w.title} ${w.dayLabel.toLowerCase()}`,
      message: `${w.detail}\nExtreme-weather warning for your location (derived from the forecast — not an official government alert).`
    });
  }
  // prune anything older than 2 days
  for (const [k, ts] of notified) {
    if (ts < nowMs - 2 * 86400000) notified.delete(k);
  }
}

let wxTimer = null;
export function startWeatherNotifier() {
  setTimeout(() => { checkWeatherNotifications().catch(() => {}); }, 45000);
  wxTimer = setInterval(() => { checkWeatherNotifications().catch(() => {}); }, 30 * 60000); // every 30 min
}
