# Changelog

The app version is shown in **Settings** and reported by `GET /api/status`.

## 1.13.0
- New **🔥 Heatmap** map layer (Layers menu), like tar1090's: a density heatmap of where aircraft
  have actually flown, built from the recorded position log. Pick a time window (last 1 / 6 / 24 hours
  or 3 days) and the busiest areas glow hottest. Positions are binned and counted server-side (so the
  payload stays small) and drawn with `leaflet.heat`; intensity is log-compressed so busy airways near
  the receiver don't wash out the fainter edges. Coverage spans up to your replay retention window.

## 1.12.1
- Settings page now has a footer with the app version and a link to the GitHub repository
  (github.com/bpduguard/VliegmasjienPRO). Brought the README up to date (removed the long-gone
  "Claude lookup" mention; documented Aerospace, Arrivals, auto-follow, full trails and pass alerts).

## 1.12.0
- New **visible-pass notifications** for the **ISS** and **Hubble** (Settings ▸ Notifications). When
  enabled, you get an alert **~1 hour before** the satellite makes a pass that is actually *visible*
  from your receiver location — i.e. it rises high enough (≥10°), the **sky is dark** (sun past civil
  dusk) and the satellite is sunlit. The message gives the **start time**, the **direction it rises
  and sets** (e.g. "rising in the SW, setting in the NE"), the peak elevation and how long it's
  visible. Predicted server-side with SGP4 (satellite.js) from the CelesTrak TLEs, a low-precision
  solar-position model for darkness/illumination, checked every 5 minutes, and de-duplicated so each
  pass alerts once. Delivered over the same Pushover / Discord / browser channels.

## 1.11.1
- Remove the **James Webb (JWST)** notice from the Aerospace layer. JWST orbits Sun–Earth L2
  (~1.5 million km away) and has no ground track over Earth, so it isn't trackable on a map — the layer
  now only includes the genuinely trackable ISS and Hubble.

## 1.11.0
- New **🛰 Aerospace** map layer (Layers menu): live tracking of the **ISS** and the **Hubble Space
  Telescope** with their **ground tracks** (~95 min of orbit, past + ahead). Positions are propagated
  in the browser with **satellite.js (SGP4)** from **CelesTrak** Two-Line Element sets — the standard,
  free, trustworthy public source — which the server proxies and caches (refreshed ~every 6 h, kept on
  disk across restarts). Click a satellite for its latitude/longitude, altitude and speed.

## 1.10.1
- **Performance / resource optimizations** (no behaviour or feature changes):
  - The browser no longer rebuilds the map markers and aircraft list (every ~2 s) while the **map isn't
    on screen** — when another tab is open or the browser tab is backgrounded. Live data keeps flowing;
    the view catches up instantly on return. Big CPU/battery saving, especially on phones.
  - The detail-panel endpoint no longer rebuilds the *entire* aircraft snapshot (and re-slices every
    aircraft's trail) just to read one aircraft — it builds only that one now.
  - The map pictogram (`iconKind`) is memoized per aircraft, so its regexes don't re-run for every
    aircraft on every snapshot — only when the type/category changes.

## 1.10.0
- **Full selected-aircraft trail with visible gaps.** The trail of the clicked aircraft is no longer
  capped to a sliding window — it now shows the **complete path since the aircraft appeared** and keeps
  growing until the aircraft leaves the map (or you deselect it). **Gaps** (signal loss between two
  points) are drawn as a **dashed amber connector with end dots** instead of a misleading straight line.
  The full path is assembled client-side from the live feed plus the detail endpoint's full trail, so
  the SSE snapshot payload stays small (it still carries only the recent tail per aircraft).

## 1.9.0
- New **🛬 Arrivals** map layer (Layers menu). Groups the aircraft currently on the map by their
  **destination airport** and drops a marker at each airport; clicking it shows a table of inbound
  flights with **arrival time**, **time until arrival**, the flight (callsign, operator, type) and
  **where it departed from**. ETAs use ground speed toward the destination; routes come from the
  cross-checked adsbdb/hexdb cache, and implausible routes (off-corridor / flying away / source
  conflict) are filtered out so the list stays trustworthy. Refreshes every 15 s (without closing a
  popup you're reading); clicking a row selects that aircraft on the map.

## 1.8.0
- New **Auto-follow** mode (🎯 button on the map toolbar): automatically follows the **newest**
  aircraft — keeps it centred on the map and opens its detail panel. It holds each aircraft for at
  least **10 seconds**, then switches to a newer arrival when one appears. Clicking any aircraft, or
  closing the detail panel, hands control back to you and turns auto-follow off; opening Replay also
  disables it. Respects the current filters (only follows visible aircraft).

## 1.7.1
- **Better military recognition.** Military aircraft that fly with airline-style callsigns (e.g.
  **GAF** German Air Force, **BAF** Belgian Air Force, **RCH** US "Reach", **CTM** French Cotam, **NATO**)
  were being tagged **airline** on the map. Recognition no longer depends on the readsb/tar1090
  `dbFlags` bit (plain dump1090-fa never sends it) or plane-alert-db membership — a new check uses
  three always-available signals, applied *before* the airline rule: **military ICAO address blocks**
  (per-nation military hex allocations, incl. the US `ADF7C8–AFFFFF` range), **military callsign
  prefixes**, and **military-only type designators** (fast jets, A400M, C-130, C-17, P-8…). Civil
  traffic is unaffected (KLM/Ryanair/Cessna stay as they were; civil An-124 operators aren't swept up).

## 1.7.0
- Notifications now include the aircraft's **estimated location** — e.g. `📍 near Aarschot, Belgium`
  — reverse-geocoded from its position to the nearest village/town/city via OpenStreetMap Nominatim
  (free, no key). Appears in Pushover, Discord (as a *Location* field), and browser/toast alerts.
  The lookup only runs for alerts that actually fire (past the cooldown), is cached on a ~1 km grid,
  and is skipped gracefully when there's no position or no internet. Override the endpoint with
  `NOMINATIM_BASE` if you self-host one.

## 1.6.1
- Fix **map replay freezing** while the clock kept running (pausing and resuming temporarily
  un-stuck it). The playback loop stamped its fetch throttle at the *start* of each frame request and
  never waited for one to finish, so once a frame query took longer than the 350 ms throttle (more
  likely as the track log grows), it launched overlapping requests that piled up on the server and
  each invalidated the previous one — so no frame ever rendered. Replay now keeps only **one frame
  request in flight** and measures the throttle from when it **completes**, with an 8 s safety timeout
  so a stalled request can't wedge playback.

## 1.6.0
- Settings now shows the **on-disk size of the log data** — the retention-governed history
  (sightings powering Spotted/Statistics), the alert log, and the replay trail — along with row
  counts and the total database file size, measured with SQLite's `dbstat`.
- New **Purge log now** button to clear all that log data on demand and **reclaim the disk space**
  (runs `VACUUM` + truncates the WAL so the file actually shrinks). Reference/cache tables (aircraft
  DB, photos, frequencies) are kept. The readout refreshes immediately after purging.

## 1.5.3
- **Alerts** tab: pagination, matching the Spotted tab. Pick a page size (10 / 25 / 50 / 100 / All)
  and step through with **‹ Prev / Next ›** plus windowed page numbers. The pager is now a shared
  helper used by both tabs.

## 1.5.2
- Spotted tab: new **All (full history)** period option. The previous widest filter ("Past month")
  was hard-capped at 30 days, so it could never show more than that even with a longer history
  retention. "All" now shows every aircraft still retained, so the Spotted window always matches your
  **log/stats retention** (`retentionDays` in Settings, default 30 days) — there was never a separate,
  shorter retention for this list. Note: the same plane-alert-db aircraft tend to recur daily, so
  today/week/month often show the same count; only their *Times* and *First seen* differ.

## 1.5.1
- Spotted tab: **pagination**. Pick how many aircraft to show per page (10 / 25 / 50 / 100 / All)
  and step through them with **‹ Prev / Next ›** plus a windowed row of page numbers (a few either
  side of the current page, with first/last shortcuts). Only the rows on the visible page fetch their
  routes now, so large spotted lists stay snappy. Changing the period, page size, or sort resets to
  page 1.

## 1.5.0
- New **Range outline** map layer: your receiver's *actual* coverage shape, drawn as a polygon from the
  farthest aircraft seen in each 1° bearing sector. It accumulates over time, persists across restarts,
  and can be reset from Settings. Toggle it from Layers ▸ Range outline (distinct from the perfect
  Distance rings).

## 1.4.1
- Fix tabs (e.g. **Spotted**) disappearing on narrower windows. The top bar had no wrap/scroll, so the
  weather widget plus seven tabs could overflow and clip tabs off the right edge. The bar now wraps
  cleanly to extra rows instead of hiding anything.

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
