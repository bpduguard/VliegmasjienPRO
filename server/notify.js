// Notification dispatch: Pushover, Discord webhook, and browser (via SSE event
// that the frontend turns into a Notification). Cooldowns prevent spam.
import { getConfig } from './config.js';
import { logAlert } from './db.js';
import { reverseGeocode } from './enrich.js';

const cooldowns = new Map(); // key -> last sent ts

let sseBroadcast = null;
export function setBroadcast(fn) {
  sseBroadcast = fn;
}

export function underCooldown(key) {
  const cfg = getConfig();
  const last = cooldowns.get(key) || 0;
  return Date.now() - last < cfg.notifyCooldownMin * 60000;
}

export async function notify({ key, title, message, kind, aircraft, url }) {
  if (key) {
    if (underCooldown(key)) return false;
    cooldowns.set(key, Date.now());
    if (cooldowns.size > 5000) {
      for (const k of cooldowns.keys()) { cooldowns.delete(k); if (cooldowns.size <= 4000) break; }
    }
  }
  const cfg = getConfig();

  // Add where the aircraft is: nearest village/town/city, its coordinates, and a
  // tappable map link. Only runs past the cooldown gate, so lookups stay rare.
  let place = null, coords = null, mapUrl = null;
  if (Number.isFinite(aircraft?.lat) && Number.isFinite(aircraft?.lon)) {
    place = await reverseGeocode(aircraft.lat, aircraft.lon);
    coords = `${aircraft.lat.toFixed(4)}, ${aircraft.lon.toFixed(4)}`;
    mapUrl = `https://www.google.com/maps?q=${aircraft.lat.toFixed(5)},${aircraft.lon.toFixed(5)}`;
  }
  if (place) message = `${message}\n📍 ${place}`;
  if (coords) message = `${message}\n${coords}`;

  logAlert(aircraft?.hex, aircraft?.flight, kind, `${title} — ${message}`);

  // Browser: always broadcast the event; the client decides whether to show a
  // Notification (per the browserNotifications setting + user permission).
  if (sseBroadcast) {
    sseBroadcast('alert', {
      ts: Date.now(),
      kind,
      title,
      message,
      place,
      lat: aircraft?.lat ?? null,
      lon: aircraft?.lon ?? null,
      mapUrl,
      hex: aircraft?.hex,
      callsign: aircraft?.flight,
      browser: !!cfg.browserNotifications.enabled
    });
  }

  // Prefer a caller-supplied link (e.g. watchlist link); otherwise link to the map.
  const linkUrl = url || mapUrl;
  const linkTitle = url ? 'Open tracker' : 'Open location in maps';

  const jobs = [];
  if (cfg.pushover.enabled && cfg.pushover.token && cfg.pushover.user) {
    jobs.push(sendPushover(cfg.pushover, title, message, linkUrl, linkTitle));
  }
  if (cfg.discord.enabled && cfg.discord.webhookUrl) {
    jobs.push(sendDiscord(cfg.discord.webhookUrl, title, message, kind, aircraft, linkUrl, place, coords));
  }
  await Promise.allSettled(jobs);
  return true;
}

async function sendPushover(po, title, message, url, urlTitle) {
  try {
    const body = new URLSearchParams({
      token: po.token,
      user: po.user,
      title,
      message,
      priority: String(po.priority ?? 0)
    });
    if (url) { body.set('url', url); body.set('url_title', urlTitle || 'Open'); }
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) console.warn('[notify] pushover failed:', res.status, await res.text());
  } catch (e) {
    console.warn('[notify] pushover error:', e.message);
  }
}

const KIND_COLORS = { zone: 0x3b82f6, watchlist: 0xf59e0b, military: 0x16a34a, emergency: 0xdc2626, test: 0x8b5cf6 };

async function sendDiscord(webhookUrl, title, message, kind, aircraft, url, place, coords) {
  try {
    const embed = {
      title,
      description: message,
      color: KIND_COLORS[kind] ?? 0x64748b,
      timestamp: new Date().toISOString(),
      footer: { text: 'VliegmasjienPRO' }
    };
    if (url) embed.url = url; // makes the title clickable (map link by default)
    if (aircraft?.hex) {
      embed.fields = [
        { name: 'ICAO', value: aircraft.hex, inline: true },
        ...(aircraft.flight ? [{ name: 'Callsign', value: aircraft.flight, inline: true }] : []),
        ...(aircraft.registration ? [{ name: 'Reg', value: aircraft.registration, inline: true }] : []),
        ...(Number.isFinite(aircraft.alt_baro) ? [{ name: 'Altitude', value: aircraft.onGround ? 'on ground' : `${aircraft.alt_baro} ft`, inline: true }] : []),
        ...(Number.isFinite(aircraft.gs) ? [{ name: 'Speed', value: `${Math.round(aircraft.gs)} kt`, inline: true }] : []),
        ...(Number.isFinite(aircraft.track) ? [{ name: 'Heading', value: `${Math.round(aircraft.track)}°`, inline: true }] : []),
        ...(aircraft.squawk ? [{ name: 'Squawk', value: String(aircraft.squawk), inline: true }] : []),
        ...(place ? [{ name: 'Location', value: place, inline: true }] : []),
        ...(coords ? [{ name: 'Coordinates', value: url ? `[${coords}](${url})` : coords, inline: true }] : [])
      ];
    }
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) console.warn('[notify] discord failed:', res.status, await res.text());
  } catch (e) {
    console.warn('[notify] discord error:', e.message);
  }
}
