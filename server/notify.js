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

  // Estimate where the aircraft is (nearest village/town/city) and add it to the
  // message. Only runs past the cooldown gate, so lookups stay rare.
  let place = null;
  if (Number.isFinite(aircraft?.lat) && Number.isFinite(aircraft?.lon)) {
    place = await reverseGeocode(aircraft.lat, aircraft.lon);
  }
  if (place) message = `${message}\n📍 ${place}`;

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
      hex: aircraft?.hex,
      callsign: aircraft?.flight,
      browser: !!cfg.browserNotifications.enabled
    });
  }

  const jobs = [];
  if (cfg.pushover.enabled && cfg.pushover.token && cfg.pushover.user) {
    jobs.push(sendPushover(cfg.pushover, title, message, url));
  }
  if (cfg.discord.enabled && cfg.discord.webhookUrl) {
    jobs.push(sendDiscord(cfg.discord.webhookUrl, title, message, kind, aircraft, url, place));
  }
  await Promise.allSettled(jobs);
  return true;
}

async function sendPushover(po, title, message, url) {
  try {
    const body = new URLSearchParams({
      token: po.token,
      user: po.user,
      title,
      message,
      priority: String(po.priority ?? 0)
    });
    if (url) { body.set('url', url); body.set('url_title', 'Open tracker'); }
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

async function sendDiscord(webhookUrl, title, message, kind, aircraft, url, place) {
  try {
    const embed = {
      title,
      description: message,
      color: KIND_COLORS[kind] ?? 0x64748b,
      timestamp: new Date().toISOString(),
      footer: { text: 'VliegmasjienPRO' }
    };
    if (url) embed.url = url;
    if (aircraft?.hex) {
      embed.fields = [
        { name: 'ICAO', value: aircraft.hex, inline: true },
        ...(aircraft.flight ? [{ name: 'Callsign', value: aircraft.flight, inline: true }] : []),
        ...(Number.isFinite(aircraft.alt_baro) ? [{ name: 'Altitude', value: `${aircraft.alt_baro} ft`, inline: true }] : []),
        ...(Number.isFinite(aircraft.gs) ? [{ name: 'Speed', value: `${Math.round(aircraft.gs)} kt`, inline: true }] : []),
        ...(place ? [{ name: 'Location', value: place, inline: true }] : [])
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
