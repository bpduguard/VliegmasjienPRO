# ✈ VliegmasjienPRO

A fancy, self-hosted flight tracker for your **dump1090 / readsb** receiver — like tar1090, but with
zones, notifications, statistics, weather radar and a Claude-powered aircraft lookup.
Designed to run in Docker on a **Raspberry Pi 5** (arm64) next to your existing dump1090 container.

## Features

- 🗺 **Live map** (Leaflet, dark & light) with rotating plane icons, labels, trails and **follow mode**
- 📊 **Live data** per aircraft: altitude, ground speed, vertical rate, track, squawk, signal, distance…
- 🌦 **Weather overlay** you can toggle: rain radar via RainViewer (no API key needed) + optional
  OpenWeatherMap cloud layer
- 📍 **Zones**: circles with a radius in km. Get notified when an aircraft *enters* a zone, and see an
  **estimated time of entry** for approaching aircraft
- 🔔 **Notifications**: **Pushover**, **Discord webhooks** and **browser notifications** — with a
  configurable cooldown so you don't get spammed
- ⭐ **Watchlist** based on the same resource **planefence / plane-alert** uses
  ([plane-alert-db](https://github.com/sdr-enthusiasts/plane-alert-db)): search the database, add
  aircraft by ICAO hex / registration / callsign, or import any plane-alert-db–format CSV
- 🛫 **Routes**: origin & destination airports + airline (via adsbdb.com), distance flown / to go and a
  computed **ETA at destination**; "tracked since" shows when you first picked up the flight
- 🧮 **Filters**: airlines / military / private / business / emergency, plus a free-text airline filter
- 📈 **Statistics** with a configurable retention period: aircraft per day, top types, top airlines,
  categories — and a per-aircraft **sighting history** ("seen before") when you click a plane
- 📷 **Aircraft photos** via planespotters.net
- 🤖 **Claude AI lookup**: select a plane and ask Claude for facts about the airframe, operator and the
  current flight (uses the Anthropic API with web search)
- 🚨 Optional alerts for **any military** aircraft and **emergency squawks** (7500/7600/7700)

## Quick start (Raspberry Pi 5 / Docker)

```bash
git clone https://github.com/bpduguard/VliegmasjienPRO.git
cd VliegmasjienPRO

# point it at your dump1090 (adjust IP/port to your setup):
export DUMP1090_URL=http://192.168.1.50:8080/data/aircraft.json
# optional: enable the Claude AI lookup
export ANTHROPIC_API_KEY=sk-ant-...

docker compose up -d --build
```

Open **http://\<your-pi\>:8390** — done. The receiver location is auto-detected from dump1090's
`receiver.json` when available (you can set it manually in *Settings*).

> **Where is my aircraft.json?** dump1090-fa: `http://<host>:8080/data/aircraft.json` ·
> readsb/tar1090 setups often serve it at `http://<host>/tar1090/data/aircraft.json`.
> Any URL that returns the standard `aircraft.json` works.

If dump1090 runs as a container on the same Docker network, uncomment the `networks` section in
`docker-compose.yml` and use the container name in `DUMP1090_URL`.

## First-run checklist

1. **Settings → plane-alert-db → Refresh database now** — downloads the same CSV planefence/plane-alert
   uses (~tens of thousands of interesting aircraft) for enrichment, categories and watchlist search.
2. **Settings → Notifications** — add your Pushover token/user key and/or Discord webhook URL, then hit
   *Send test notification*.
3. **Zones** — add a zone (use *Use map center* for coordinates), pick a radius in km.
4. **Watchlist** — search the plane-alert-db ("police", "A400", a registration…) and click *+ watch*,
   or import a CSV in plane-alert-db format.
5. Allow **browser notifications** when the browser asks (or via Settings).

## Updating

```bash
cd VliegmasjienPRO
git pull
docker compose up -d --build
```

Your configuration, watchlist, zones and statistics live in the `vliegmasjien-data` Docker volume and
survive updates and rebuilds.

## Configuration

Everything can be configured in the web UI (*Settings* tab). Environment variables override the saved
config for secrets and the receiver URL:

| Variable | Purpose |
|---|---|
| `DUMP1090_URL` | URL of `aircraft.json` (required) |
| `ANTHROPIC_API_KEY` | Enables the Claude AI aircraft lookup |
| `OWM_API_KEY` | Optional OpenWeatherMap key for the cloud layer (rain radar needs no key) |
| `PORT` | HTTP port (default 8390) |
| `DATA_DIR` | Data directory (default `/data` in Docker) |

## External services used

| Service | Used for | Key needed |
|---|---|---|
| [plane-alert-db](https://github.com/sdr-enthusiasts/plane-alert-db) | watchlist data, categories, operator/type enrichment | no |
| [adsbdb.com](https://www.adsbdb.com) | callsign → route (origin/destination, airline) | no |
| [planespotters.net](https://www.planespotters.net) | aircraft photos | no |
| [RainViewer](https://www.rainviewer.com) | rain radar overlay | no |
| [OpenWeatherMap](https://openweathermap.org) | extra cloud layer (optional) | free key |
| [Anthropic](https://platform.claude.com) | Claude AI aircraft lookup (optional) | API key |

Notes on route/ETA data: adsbdb provides the airports for a callsign, not the airline's schedule. The
**ETA at destination** is computed live from position, ground speed and remaining great-circle
distance; "tracked since" is when *your receiver* first saw the flight.

## Development

```bash
npm install
DUMP1090_URL=http://192.168.1.50:8080/data/aircraft.json npm start
# → http://localhost:8390
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`, so there are no native modules — which is also
why the Docker build is fast and painless on arm64).

## Architecture

```
dump1090 ──aircraft.json──► tracker (poll 2s) ──► SSE ──► browser (Leaflet map)
                                │
                                ├─► SQLite (/data) — sightings, history, stats, alert log
                                ├─► zones + watchlist matching ──► Pushover / Discord / browser
                                └─► enrichment: plane-alert-db, adsbdb routes, planespotters photos
```
