# ✈ VliegmasjienPRO

A fancy, self-hosted flight tracker for your **dump1090 / readsb** receiver — like tar1090, but with
zones, notifications, statistics, weather radar, replay, arrivals-by-airport and live **ISS / Hubble**
tracking. Designed to run in Docker on a **Raspberry Pi 5** (arm64) next to your existing dump1090
container.

## Features

- 🗺 **Live map** (Leaflet, dark & light) with rotating plane icons, labels, and **follow mode**,
  plus **🎯 Auto-follow** — automatically centres on and shows details of the newest aircraft, holding
  each for at least 10 s before switching to a newer arrival. Clicking an aircraft shows its **full
  trail** (kept until it leaves the map), with **signal gaps drawn as dashed connectors**
- 📊 **Live data** per aircraft: altitude, ground speed, vertical rate, track, squawk, signal, distance…
- 🌦 **Weather overlay** you can toggle: rain radar via RainViewer (no API key needed) + optional
  OpenWeatherMap cloud layer
- 📍 **Zones**: circles with a radius in km. Get notified when an aircraft *enters* a zone, and see an
  **estimated time of entry** for approaching aircraft
- 🔔 **Notifications**: **Pushover**, **Discord webhooks** and **browser notifications** — with a
  configurable cooldown so you don't get spammed. Each alert includes the aircraft's **estimated
  location** (nearest village/town/city, e.g. *📍 near Aarschot, Belgium*, reverse-geocoded via
  OpenStreetMap Nominatim — free, no key)
- 🛰 **Spotted** tab: a log of plane-alert-db aircraft your receiver has actually seen (operator, type,
  category, tags, route, how often/when, closest approach) — filterable by today / past week / past month,
  sortable, and paginated (choose page size + step through pages)
- ⭐ **Watchlist** based on the same resource **planefence / plane-alert** uses
  ([plane-alert-db](https://github.com/sdr-enthusiasts/plane-alert-db)): search the database, add
  aircraft by ICAO hex / registration / callsign, or import any plane-alert-db–format CSV
- 🛫 **Routes**: origin & destination airports + airline (via adsbdb.com), distance flown / to go and a
  computed **ETA at destination**; "tracked since" shows when you first picked up the flight
- 🧮 **Filters**: airlines / military / private / business / emergency, plus a free-text airline filter.
  **Military** is detected even without readsb `dbFlags` — from military ICAO address blocks, air-force
  callsign prefixes (GAF, BAF, RCH, CTM, NATO…) and military-only type designators
- 📈 **Statistics** with a configurable retention period: aircraft per day, top types, top airlines,
  categories — and a per-aircraft **sighting history** ("seen before") when you click a plane.
  Settings shows the **on-disk size of the retained log** and a **Purge log now** button to clear it
  and reclaim the space
- 🌡 **Current-weather widget** in the top bar (temperature, wind, humidity, rain) for the receiver's
  location, via Open-Meteo — no API key
- 📷 **Aircraft photos** via planespotters.net
- 🎨 **Reception-source colours**: aircraft-list rows are tinted by how the position was received
  (ADS-B, ADS-R, TIS-B, MLAT, Mode-S, ADS-C) — see the on-map Legend
- ⏪ **Replay**: pick a day and replay the recorded traffic on the map at 1×–600× speed, with a
  scrubber and play/pause
- 📡 **Range outline** overlay — your receiver's *actual* coverage shape (farthest aircraft seen per
  bearing), accumulated over time and persisted; resettable in Settings
- 🛬 **Arrivals** overlay — groups tracked aircraft by their destination airport and shows, per airport,
  a table of inbound flights with arrival time, time-to-go, the flight, and its departure airport
- 🛰 **Aerospace** overlay — live **ISS** and **Hubble** tracking with ground tracks, propagated with
  satellite.js (SGP4) from **CelesTrak** TLEs. Optional **visible-pass notifications** alert you ~1h
  before the ISS/Hubble makes a pass visible from your location (dark sky), with the time and
  rise/set direction
- 🔥 **Heatmap** overlay (tar1090-style) — a density map of where aircraft have flown over a selectable
  time window (1h–3 days), built from the recorded position log
- 🛫 **Airspace** overlay — controlled airspace (CTR/TMA/CTA/classes) from **OpenAIP** (free API key);
  and 🌬 **Aviation weather (METAR)** overlay — colour-coded station markers by flight category
  (VFR/MVFR/IFR/LIFR) with decoded wind/visibility/altimeter, from **aviationweather.gov** (no key)
- ⊚ **Distance rings** overlay (10/25/50/100/200/400 km around the receiver) and 🏳 **country flags**
  per aircraft in the list (from the ICAO address). The app **version** is shown in Settings
  (see [CHANGELOG.md](CHANGELOG.md))
- 📻 **Communication-frequencies layer**: a toggleable map overlay showing airport radio frequencies
  (tower, ground, approach, ATIS…) for airports near your view, from the public-domain
  [OurAirports](https://ourairports.com/data/) dataset — downloaded once, then served locally and offline
- 🚨 Optional alerts for **any military** aircraft and **emergency squawks** (7500/7600/7700)

## Quick start (Raspberry Pi 5 / Docker)

```bash
git clone https://github.com/bpduguard/VliegmasjienPRO.git
cd VliegmasjienPRO

# point it at your dump1090 (adjust IP/port to your setup):
export DUMP1090_URL=http://192.168.1.50:8080/data/aircraft.json

docker compose up -d --build
```

Open **http://\<your-pi\>:8390** — done. The receiver location is auto-detected from dump1090's
`receiver.json` when available (you can set it manually in *Settings*).

> **Where is my aircraft.json?** dump1090-fa: `http://<host>:8080/data/aircraft.json` ·
> readsb/tar1090 setups often serve it at `http://<host>/tar1090/data/aircraft.json`.
> Any URL that returns the standard `aircraft.json` works.

### No web server? Use the beasthost ports (SBS)

If your dump1090/readsb container only exposes the network ports (the ones other trackers use as a
"beasthost"), VliegmasjienPRO can connect to the **SBS/BaseStation output on port 30003** directly:

```bash
export SOURCE_MODE=sbs SBS_HOST=192.168.1.50 SBS_PORT=30003
docker compose up -d --build
```

(or switch the data source in *Settings → Receiver*). Port reference for a typical receiver:

| Port | Protocol | Supported |
|---|---|---|
| 30003 | SBS / BaseStation text (decoded) | ✅ use this one |
| 30005 | Beast binary (raw Mode-S) | ❌ binary feed for feeders — use 30003 or aircraft.json |
| 30105 / 30205 | MLAT results | ❌ feeder plumbing |
| 30978 / 30987 | UAT / dump978 (978 MHz, US) | ❌ |

Note: the SBS feed carries positions, altitude, speed, callsign and squawk, but not the extra fields
the JSON source has (registration/type hints, military dbFlags, signal strength) — plane-alert-db
enrichment still fills in most of that. With SBS, set the receiver location manually in Settings
(there is no `receiver.json` to auto-detect from).

If dump1090 runs as a container on the same Docker network, uncomment the `networks` section in
`docker-compose.yml` and use the container name in `DUMP1090_URL`.

## First-run checklist

1. **Settings → plane-alert-db → Refresh database now** — downloads the same CSV planefence/plane-alert
   uses (~tens of thousands of interesting aircraft) for enrichment, categories and watchlist search.
2. **Settings → Notifications** — add your Pushover token/user key and/or Discord webhook URL, then hit
   *Send test notification*. Optionally tick **"Notify ~1h before a visible ISS / Hubble pass"** to get
   alerted before the station/telescope is overhead on a dark, clear evening.
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

Everything can be configured in the web UI (*Settings* tab). Environment variables only **seed the
first run** — once you save a value in Settings it lives in the data volume and is what's used on every
later start, so the app never "forgets" a URL you set in the UI:

| Variable | Purpose |
|---|---|
| `DUMP1090_URL` | Initial URL of `aircraft.json` (default source) |
| `SOURCE_MODE` | `json` (default) or `sbs` for BaseStation TCP |
| `SBS_HOST` / `SBS_PORT` | Beasthost address + SBS port (default 30003) when `SOURCE_MODE=sbs` |
| `OWM_API_KEY` | Optional OpenWeatherMap key for the cloud layer (rain radar needs no key) |
| `OPENAIP_API_KEY` | Optional OpenAIP key for the controlled-airspace layer |
| `PORT` | HTTP port (default 8390) |
| `DATA_DIR` | Data directory (default `/data` in Docker) |

> **Changing a URL later:** because the saved value wins, editing the env var after the first run has no
> effect — change it in *Settings → Receiver* instead (or delete `config.json` from the data volume to
> re-seed from the environment).

## External services used

| Service | Used for | Key needed |
|---|---|---|
| [plane-alert-db](https://github.com/sdr-enthusiasts/plane-alert-db) | watchlist data, categories, operator/type enrichment | no |
| [adsbdb.com](https://www.adsbdb.com) | callsign → route (origin/destination, airline) | no |
| [hexdb.io](https://hexdb.io) | second callsign → route source (cross-checked with adsbdb) | no |
| [planespotters.net](https://www.planespotters.net) | aircraft photos | no |
| [OurAirports](https://ourairports.com/data/) | airport communication frequencies (map layer) | no |
| [Open-Meteo](https://open-meteo.com) | current weather at the receiver (top-bar widget) | no |
| [RainViewer](https://www.rainviewer.com) | rain radar overlay | no |
| [OpenWeatherMap](https://openweathermap.org) | extra cloud layer (optional) | free key |
| [CelesTrak](https://celestrak.org) | orbital elements (TLEs) for the ISS/Hubble (Aerospace layer) | no |
| [Nominatim](https://nominatim.openstreetmap.org) | reverse geocode aircraft location in notifications | no |
| [OpenAIP](https://www.openaip.net) | controlled-airspace tile overlay (Airspace layer) | free key |
| [aviationweather.gov](https://aviationweather.gov) | METARs for the aviation-weather layer | no |

Notes on route/ETA data: adsbdb provides the airports for a callsign, not the airline's schedule. The
**ETA at destination** is computed live from position, ground speed and remaining great-circle
distance; "tracked since" is when *your receiver* first saw the flight.

### Routes / photos show "unavailable"?

Route lookups (adsbdb), aircraft photos (planespotters) and the plane-alert-db download all need
**outbound internet** from the container. If the detail panel says *"Route unavailable — … check the
container's internet access"*, your Docker network or firewall is blocking egress to those hosts. The
live map, zones, statistics and "seen before" history all keep working offline — only the enrichment
that calls external APIs needs internet. (The "seen before" history is stored locally in SQLite and is
independent of any external service.)

**Photos loading only sometimes?** The app uses planespotters' public photo *API* (not the website,
which has a separate human-check), but that API rate-limits. VliegmasjienPRO sends a descriptive
User-Agent, throttles requests, honours `429 Retry-After`, **caches every result** (so each aircraft is
fetched once), and serves images through an on-disk proxy — so once an aircraft has been seen, its photo
loads instantly and reliably. The first sighting of many new aircraft at once may fill in gradually as
the throttle works through them. If the API rate-limits, the app backs off automatically and retries —
just give it a few minutes (`/api/status` reports a photo "rate limited" note while it's cooling down).

### How trustworthy is a route? (✓ confirmed / ⚠ flagged)

Routes come from callsign databases ([adsbdb](https://www.adsbdb.com) and [hexdb.io](https://hexdb.io),
both free, no key), which map a **callsign** to its *usual* origin/destination. Airlines reuse the same
callsign for different city pairs, so a single database can be stale or simply not the flight happening
right now. VliegmasjienPRO improves trust two ways:

- **Two sources** — it cross-checks adsbdb against hexdb. When both agree the route is marked
  **✓ confirmed**; when they disagree it's flagged ⚠ and the ETA is withheld. hexdb can also fill in
  routes adsbdb is missing.
- **Geometry** — it checks the route against the aircraft's **actual position and heading**. If the
  plane is well off the direct corridor between the two airports, or clearly not heading toward the
  listed destination, the route is flagged regardless of what the databases say.

There's no free, no-key API for the *true* live route (FR24/RadarBox APIs are paid), so cross-checking +
geometry is the most reliable way to keep routes honest without a subscription.

### Registration & aircraft type (empty Reg/Type columns)

Plain **dump1090-fa** (and the SBS feed) only broadcast position, callsign and altitude — they do **not**
include each aircraft's registration or ICAO type. Only **readsb/tar1090** add those (`r`/`t`) from a
bundled database. So on a plain dump1090 the Reg/Type columns and the type statistics start out empty.

VliegmasjienPRO fills this in automatically: every new aircraft is looked up once (by ICAO hex) and
**cached locally in SQLite**, so the list, type filters and statistics populate over time and the lookup
is then instant and offline. You can watch the cache grow in *Settings → Aircraft database*.

If your receiver/host has no outbound internet (Settings shows a "lookup problem"), or you want the whole
database loaded at once, use **Settings → Aircraft database → Import** with either:

- a CSV with a header naming the columns — `icao24,registration,typecode[,operator]` (the
  [OpenSky aircraft database](https://opensky-network.org/datasets/metadata/) format works directly), or
- a newline-delimited JSON file in [basic-ac-db](https://github.com/wiedehopf/basic-ac-db) form
  (`{"icao":"…","reg":"…","icaotype":"…"}` per line).

The cleanest fix of all, if you can, is to run **readsb/tar1090** as your decoder — then `r`/`t` arrive in
`aircraft.json` natively with no lookups needed.

> So to answer "1900 planes but only 2 types — is this an issue?": it's expected with a plain dump1090
> that doesn't send types, and only the handful matched by plane-alert-db showed up. With the per-hex
> lookup (or an import) the type breakdown becomes representative.

### Communication frequencies layer

The **📻 Freqs** toggle on the map shows airport radio frequencies near your current view. The first
time, download the data in *Settings → Communication frequencies → Download frequencies now* (a few MB
from OurAirports); after that it's stored locally and works offline. Pan/zoom and the airports in view
update automatically; click a 📻 pin to see that airport's tower/ground/approach/ATIS/etc. frequencies.

### Reception-source colours & filter (incl. MLAT)

Each aircraft-list row (and a badge in the detail panel) is coloured by **how its position was received**:
ADS-B, ADS-R, TIS-B, MLAT, Mode-S or ADS-C — derived from the `type`/`mlat` fields dump1090/readsb
report. The on-map **Legend** explains the colours, and the **📡 Source ▾** menu lets you show/hide each
source (e.g. show only MLAT). MLAT traffic appears automatically when your feed provides it (readsb,
tar1090 or PiAware merge MLAT results into `aircraft.json`); the app can't compute MLAT itself, since
multilateration needs several time-synced receivers feeding an MLAT server.

### Replay

Click **⏮ Replay** on the map to scrub through a past day. The app continuously records a position
point per aircraft (every ~8s) into the data volume; pick a **day**, hit play, and choose a **speed**
(1×–600×). A scrubber lets you jump to any time, and **✕ Live** returns to the live map. Replay history
is kept for `replayRetentionDays` (default **3 days**, configurable) since it's far higher-volume than
the statistics log — bump it up if you have the disk for it.

### Units & icons

*Settings → Receiver → Units* switches the whole UI between **metric** (altitude in m, speed in km/h,
vertical rate in m/s; distance is always km) and **aviation** (ft / kt / fpm). The map pictograms are
shaped by aircraft type — airliner, heavy/widebody, light single-engine, helicopter, military/fast jet,
glider, drone and on-ground — with colour showing the role; the **Legend** button on the map explains
them.

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
                                ├─► SQLite (/data) — sightings, history, stats, alert log, replay tracks
                                ├─► zones + watchlist + military/emergency ─┐
                                ├─► CelesTrak TLEs → SGP4 pass predictor ───┼─► Pushover / Discord / browser
                                │   (visible ISS/Hubble passes)             │   (+ Nominatim place name)
                                └─► enrichment: plane-alert-db, adsbdb/hexdb routes, planespotters photos
```

The browser computes ISS/Hubble positions and ground tracks locally with **satellite.js** from the
server-cached CelesTrak TLEs, and runs the live map, list, arrivals and trail rendering.
