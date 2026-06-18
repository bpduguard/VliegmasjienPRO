# Changelog

The app version is shown in **Settings** and reported by `GET /api/status`.

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
