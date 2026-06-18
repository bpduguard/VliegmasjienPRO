# Changelog

The app version is shown in **Settings** and reported by `GET /api/status`.

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
