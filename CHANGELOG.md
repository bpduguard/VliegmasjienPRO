# Changelog

The app version is shown in **Settings** and reported by `GET /api/status`.

## 1.4.0
- More trustworthy routes via a **second source**: routes are now cross-checked between **adsbdb** and
  **hexdb.io** (both free, no key). When both agree (and the geometry fits), the route is marked
  **✓ confirmed**; when they disagree it's flagged as inaccurate (no ETA); hexdb can also supply routes
  adsbdb is missing. The Spotted tab's route column shows the same ✓/⚠ markers.

## 1.3.1
- More trustworthy routes. Database routes (from adsbdb) are keyed by callsign and can be stale/wrong
  for the actual flight, so the route is now **sanity-checked against the aircraft's real position and
  heading**: if the plane is well off the direct corridor between the listed airports, or clearly not
  heading toward the listed destination, the route is shown with a **⚠ warning** (and its ETA is
  suppressed) instead of being presented as fact.

## 1.3.0
- New **current-weather widget** in the top bar (next to the status light): condition icon,
  temperature, wind speed + direction, humidity and precipitation for the receiver's location, via
  **Open-Meteo** (free, no API key). Refreshes every 10 minutes; wind respects the metric/aviation
  unit setting.

## 1.2.2
- Fix unreliable aircraft photos. The app now sends a descriptive **User-Agent**, **throttles**
  planespotters requests and honours **HTTP 429 / Retry-After**, **persists** every result in SQLite
  (so each aircraft is looked up at most once per TTL), and serves images through a **caching image
  proxy** (`/api/photo/:hex`) that stores thumbnails on disk — so photos load consistently instead of
  sporadically. The same User-Agent now goes on the adsbdb and plane-alert-db requests too.

## 1.2.1
- Spotted tab: **sortable** columns (default = most recent spots first), an inline **plane photo**
  per row, and the **route shown automatically** (no more per-row lookup button). Photos/routes are
  fetched in the background and cached so re-sorting is instant.

## 1.2.0
- New **Spotted** tab: lists plane-alert-db aircraft your receiver has actually seen, with their
  details (operator, type, category, tags, registration), how often/when they were seen, closest
  approach, and an on-demand route lookup. Filter by Today / Past week / Past month.

## 1.1.1
- Switch the list **country flags** from emoji to bundled **SVG images** (`flag-icons`, served
  locally) so they render correctly on every OS, including Windows.

## 1.1.0
- Add a **distance-rings** map layer (10 / 25 / 50 / 100 / 200 / 400 km around the receiver), toggled
  from the Layers menu.
- Show a **country flag** per aircraft in the list views (from the ICAO 24-bit address allocation).
- Show the app **version** in the Settings tab; introduce versioning (`server/version.js`).

## 1.0.0
- Initial release: live Leaflet map, dump1090 JSON + SBS sources, zones with ETA, Pushover/Discord/
  browser notifications, plane-alert-db watchlist, routes/ETA, photos, statistics + history, weather
  overlay, frequencies layer, per-hex registration/type database, metric/aviation units, type-based
  pictograms, reception-source colours + filter, and map replay.
