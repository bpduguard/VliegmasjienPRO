# Changelog

The app version is shown in **Settings** and reported by `GET /api/status`.

## 1.31.0
Code review + optimisation pass (functionality preserved; verified with tests).

**SD-card wear reduced** (the main goal — fewer writes = longer card life):
- **One commit per poll** instead of two: the replay track points now flush inside the same
  transaction as the sightings, halving WAL commits in the hot loop.
- **Sighting rows are rewritten at most every ~10 s per aircraft** (was every poll, ~2 s). Peak
  altitude/speed and closest approach are kept in memory and a final flush on expiry captures the exact
  last-seen, so **no statistic is lost** — verified. Quiet polls now produce no write at all.
- **SQLite tuned for flash**: check-point 4× less often, WAL size capped, temp/scratch kept in RAM (no
  temp files on the card), larger page cache to cut read I/O.
- CPU/power: the per-aircraft SSE snapshot is no longer built when **no browser is connected**.

**Bugs fixed (from a full review):**
- **Security:** two stored-XSS holes where an aircraft's (over-the-air, attacker-controlled) callsign
  was inserted into the Alerts table and the Spotted route cell without escaping — now escaped.
- **Leaks:** SSE reconnect could spawn multiple parallel streams during an outage (now one); the
  detection cooldown map could grow unbounded when notifications were off (now capped).
- **CSV imports** (watchlist + aircraft-DB) now use a quote-aware parser, so operator/model fields
  containing commas no longer shift every following column.
- Minor: `onGround` no longer flips to airborne on a message that omits altitude; the RainViewer radar
  animation idles when the Weather tab isn't showing; removed a duplicate startup call.

## 1.30.0
- **Finer aircraft categories** — the classifier now splits **helicopter**, **glider** and **drone/UAV**
  out of the old "other"/"private" catch-alls, using the ADS-B emitter category (A7/B1/B6/B7) and type
  designators. Physical class is decided before role (a helicopter is a helicopter whatever callsign it
  flies), and light-aircraft *type codes* (not just the emitter category) now count as **private/GA** —
  so "other" shrinks to genuinely unclassifiable known types. The new categories flow everywhere: marker
  **colours**, the map **filter chips** (🚁 helicopters, 🪂 gliders, 🛸 drones), and the Statistics
  **Categories** chart. *("other" = a known type in no specific bucket; "unknown" = no type at all.
  Existing sightings keep the label they were logged with, so the split fills in for traffic seen from
  now on.)*

## 1.29.0
- **Multiple data sources** — feed the map from more than one receiver (e.g. a second or mobile Pi).
  In *Settings → Receiver → Extra sources*, add any number of `aircraft.json` URLs; each shows **live
  health** (reachable / aircraft count / error) and an enable toggle. Aircraft are **merged by ICAO
  address** — positions come from the aircraft itself so two receivers never conflict; the freshest fix
  wins and gaps are filled from the other feed. Each aircraft is **tagged with the receivers that saw
  it** ("Received by: Home, Mobile" in the detail panel). The **range outline stays tied to your primary
  receiver** so a mobile source can't inflate your home coverage map. You can also **name** the primary
  source. Fully backward compatible — single-source setups are unaffected.

## 1.28.3
- **The webcams layer is now honest about what it shows.** The Windy Webcams API returns *all* nearby
  cams (beaches, city centres, highways…), not just airports, so:
  - Renamed the layer **📷 Airport webcams → 📷 Webcams**.
  - Auto-discovered cams are now labelled by **their own name** (no longer stamped with a nearby
    airport's name); the nearest airport is shown only as **context** ("· near EHAM (2 km)"). Feeds you
    add yourself keep their airport name.
  - New **Airports only** toggle (Layers menu) narrows the auto-discovered cams to those actually at/near
    a field — flagged when within ~3 km of a known airport or tagged as an aviation cam by Windy. Airport
    cams get a violet marker; other cams are muted.

## 1.28.2
- **Webcam feeds now play inline instead of opening a new tab** — for feeds whose source allows
  embedding. Pasted YouTube links (`watch?v=`, `youtu.be/…`, `/live/…`) are auto-converted to proper
  `/embed/` URLs with muted-autoplay, so they start playing inside the app. Adding a feed from a host
  the browser can't embed (anything outside YouTube / Windy) now saves with a clear warning instead of
  silently linking out. Removed the two placeholder built-in feeds (invalid IDs) that caused the
  "clicking play opens a new tab" confusion — populate the layer via Settings → Airport webcams and/or a
  Windy key. (A feed that opens a new tab means its owner disabled embedding — no app can override that.)

## 1.28.1
- **Manage custom webcam feeds from Settings** (no more editing `config.json`). *Settings → Airport
  webcams* now has an add/remove editor: enter an ICAO and hit **Look up ✈** to autofill the airport
  name and coordinates from the frequency database (or type them in), give the feed a title and an
  embed URL, and add it. Feeds are listed with a delete button, and the map layer refreshes live.
  Backed by `GET/POST/DELETE /api/webcams/custom` and `GET /api/airports/lookup` (all auth-only).

## 1.28.0
- **New Airport webcams map layer.** Toggle **📷 Airport webcams** in the Layers menu to see airports
  with live webcam feeds; clicking a marker plays the feed **inside the app**, with a **◀ ▶ switcher**
  when an airport has several. Two sources, merged and clustered per airport:
  - a small **built-in / user-curated list** that works with no key (`config.webcams.custom` — each entry
    is `{ icao, name, lat, lon, feeds:[{ title, embed }] }`, where `embed` is any iframe URL such as a
    YouTube live embed), and
  - the **Windy Webcams API** (optional free key from api.windy.com, added in *Settings → Airport
    webcams*) for automatic discovery of webcams at airports across the map.
  The key stays server-side (a proxy fetches Windy); results are cached. The Content-Security-Policy now
  allows embedding YouTube and Windy webcam players. *(The two shipped built-in feeds are examples —
  replace/extend them with feeds you know work via `config.webcams.custom`.)*

## 1.27.0
- **Rarity memory is now permanent + surfaced in Statistics.** The rarity detector's "have I seen this
  operator/type before?" memory used to be re-derived from the sightings table, so it only reached back
  as far as the history-retention window (default 30 days) and forgot older operators on restart. It now
  lives in dedicated `known_operators` / `known_types` ledgers (with first-seen, last-seen and a sighting
  count) that are **never pruned or purged** — so "first time in your coverage" means genuinely all-time.
  On upgrade the ledgers are backfilled from your existing sightings, so you won't get a flood of
  first-time flags for aircraft you've already seen.
- The **Statistics tab** uses this data: two new all-time cards (**distinct operators** and **types**
  ever seen) and a **"New to your coverage"** section listing the operators and types whose first-ever
  sighting falls in the selected period, with the date.

## 1.26.4
- **Detections wait for anomalies to persist before flagging them — much less noise.** A new
  **Confirmation time** (Settings → Detections, default 30 s) sets how long a pattern must hold before
  it's reported:
  - **Squawk** — an emergency code must persist a few seconds (capped at 8 s), so a single garbled
    Mode-S sweep showing a one-frame 7500/7700 no longer raises a false alarm.
  - **Emergency descent** — the descent rate is now averaged over the confirmation window itself, so
    only a descent *sustained* that long counts; a brief step-down is diluted and ignored.
  - **Loiter/orbit** and **survey/patrol** — must hold the pattern for the confirmation time across
    analysis passes before flagging.
  - **Impossible kinematics** — now needs three consecutive impossible fixes (was two).
  Raise the confirmation time if you still see noise (fewer false positives, slightly slower to alert);
  lower it to catch things faster.

## 1.26.3
- **Emergency-descent detector: far fewer false positives.** It no longer trusts the raw reported
  vertical rate (a single spiky `baro_rate` sample would fire on an aircraft in level cruise). Instead it
  measures the *observed* altitude loss over a ~15–30 s window — which also smooths sparse-coverage
  jitter — and only alerts on a sustained > 4000 fpm loss above FL200, corroborated by the reported rate.
  A stuck/spiky vertical rate with no real altitude change no longer triggers it.
- **Squawk detections now explain the code.** Each squawk alert spells out what the code means, e.g.
  *"7700 is the general emergency code — the crew is declaring an emergency (mayday / pan-pan)"*, and
  likewise for 7500 (hijack), 7600 (radio failure), 0033 (NL parachute ops) and 7000 (VFR conspicuity).

## 1.26.2
- **Far fewer false positives from the integrity detector.** The ADS-B integrity/spoofing checks are
  only as trustworthy as the coverage they run on, so they now run only on fixes worth trusting:
  - **Trusted sources only** — direct ADS-B (1090/UAT) and ADS-R. MLAT, TIS-B, ADS-C and Mode-S are
    skipped, since their jitter/latency was the main cause of phantom "teleports" and speed mismatches.
  - **Position-quality gate** — fixes with low NIC/NACp are skipped rather than judged.
  - **Distinct fixes with the real elapsed time** — a stale position repeated across polls (common in
    thin coverage) no longer looks like a jump the instant a fresh fix arrives; the baseline keeps the
    timestamp of when the position actually last changed. This was the single biggest false-positive source.
  - **Confirmation before alerting** — impossible kinematics now needs two consecutive impossible fixes
    (a one-off decode glitch that snaps back is ignored); the speed/position mismatch needs a short
    interval and three sustained fixes; and a NIC collapse needs two consecutive low fixes.

## 1.26.1
- **Detections notifications can be turned off.** A new *Send notifications for detections* toggle in
  Settings → Detections. When off, detections still appear in the Detections tab but fire no
  notifications (no toast/browser/Pushover/Discord) and aren't written to the alert log; de-duplication
  still applies. On by default.
- **Naming consistency (layer vs tab).** A map overlay is a "layer"; a separate page is a "tab". The
  anomaly-detection feature lives on a page, so it's no longer called the "Detection & anomaly layer" —
  the tab page and its Settings section are now titled **Detections** (master switch: *Enable anomaly
  detection*). Genuine map overlays (arrivals, aerospace, frequencies, range, weather, METAR, airspace)
  keep the "layer" wording.

## 1.26.0
- **Detection & anomaly layer — phase 2.** Three more detectors join the layer:
  - **Survey / patrol grid** — repeated parallel legs on one axis with ~180° reversals and roughly
    constant spacing (pipeline patrol, aerial photogrammetry, calibration flights). Uses circular
    statistics on the doubled leg heading so it needs a genuine "mowing the lawn" pattern — straight
    cruises, zig-zags and orbits don't trip it.
  - **Go-around / missed approach** — descended low near a towered airport while *not* climbing (the
    approach), then climbed away > 500 fpm without touching down. The "not climbing while low" gate is
    what separates it from an ordinary departure. Uses a nearby-airport index built from the frequency
    database (AGL ≈ MSL for near-sea-level fields; runway alignment is approximated by proximity).
  - **Military / state fleet feed** — cross-references your traffic against the pre-classified military
    endpoint published by **adsb.lol / adsb.fi**, hardening the military classification and flagging
    listed airframes as they enter coverage. External source; on by default, fails soft, toggle in Settings.
  The Detections tab gains Survey / Go-around / Military filters and Settings toggles for each. Refreshing
  the frequency database now also rebuilds the go-around airport index.

## 1.25.0
- **New Detection & anomaly layer (phase 1).** A set of anomaly detectors that run entirely on the live
  ADS-B stream you already ingest — no extra data source — surfaced in a new **Detections** tab and
  through the normal alert/notification pipeline. ADS-B is unauthenticated, so the stream is treated as
  untrusted input. Detectors are edge-triggered (fire on a transition/episode, not steady state):
  - **Squawk watch** — 7500/7600/7700 + NL 7000 (VFR) / 0033 (para) — alerts on the *transition*.
  - **Loiter / orbit** — > 720° of cumulative turn within a ~3 NM radius (police/medevac/ISR/survey).
  - **Emergency descent** — sustained < −4000 fpm above FL200 (depressurisation signature).
  - **ADS-B integrity / spoofing** — impossible kinematics (position jump > Mach 2), reserved/unallocated
    ICAO address blocks, NIC position-quality collapse, and ground-speed vs. position-delta mismatch.
  - **Rarity scoring** — first-time aircraft **type** or **operator** in your coverage; self-tunes from
    your own history (seeded from the sightings DB) and warms up so a fresh install doesn't flag everything.
  Each detector can be toggled in Settings. The Detections tab filters by category, colour-codes by
  severity, shows the driving metrics, and links back to the aircraft on the map. New auth-only endpoint
  `GET /api/detections`. *(Phase 2 — survey-grid, go-around/missed-approach, and the external military
  feed — is not included yet.)*

## 1.24.1
- 🐛 Easter-egg fix: the arcade game only launched on the exact phrase "space invaders", so typing just
  "invaders" did nothing. The search-box trigger now also accepts "invaders" (case-insensitive and
  whitespace-tolerant), while normal searches are unaffected.

## 1.24.0
- **New Arrivals tab — a live airport-style arrivals board (FIDS).** A flat, always-sorted-by-ETA list
  of every tracked flight with a known, plausible destination route: **flight** (callsign + aircraft +
  operator), **from** / **to** airport, **ETA** (arrival clock time + a live countdown), **distance
  flown** and **still to go**, a **progress bar** with a moving plane, and a live **status**
  (En route / Descending / Approaching / Landing). A destination dropdown filters the board to a single
  airport, the header clock and countdowns tick every second, and the data refreshes every ~12s.
  Clicking a row jumps to the map and selects that aircraft. Complements the existing map arrivals
  layer; backed by a new `GET /api/arrivals/board` endpoint.

## 1.23.0
- **Altitude-coloured tracks + a time scrubber.** Both the live selected trail and the historical
  tracks are now coloured by **altitude** (aviation convention: low = warm, high = cool), drawn as a
  smooth gradient (one polyline per altitude band, so it stays light) with signal gaps still shown as
  dashed connectors. A small **altitude legend** appears at the bottom of the map whenever a trail is
  shown. For a historical track there's also a **time scrubber**: drag it to move a marker along the
  recorded path and read the exact **time · altitude · speed** at that point. All values respect your
  metric/aviation unit choice.

## 1.22.1
- Added a **Replay / track retention (days)** setting to *Settings → Receiver* (was only configurable
  in `config.json` before). It controls how far back the map **Replay** and the new per-session
  **historical tracks** go — higher keeps more, at the cost of more SD-card use. Sits next to the
  existing History retention field, which is now labelled to clarify it governs Spotted / Statistics /
  the alert log.

## 1.22.0
- **Historical tracks from the "seen before" list.** Click an aircraft, then click any date in its
  seen-before history and the **recorded flight path for that session** is drawn on the map — a violet
  track with a green start / red end marker and dashed connectors across signal gaps, auto-framed to
  fit. Click the same date again to hide it. Recorded tracks go back as far as the **replay retention
  window** (`replayRetentionDays`, default 3 days); older sessions show a note that no track was kept.
  New endpoint `GET /api/aircraft/:hex/track?from&to` (auth-only — many stored tracks together would
  outline the receiver's coverage), so the clickable dates appear only when logged in.

## 1.21.3
- **Sky Watch now factors in whether it stays dry and the dew point.** The observing score for each
  night now penalises **precipitation** during the dark window (rain/snow ends a session — a strong
  penalty on the worst hourly chance and any accumulation) and **dew/fog on your optics**, derived from
  the smallest **temperature − dew-point spread** over the window (≤1 °C → "Dew/fog likely", ≤3 °C →
  "Dew possible"). The tonight panel gains two tiles — **Precipitation** ("Staying dry" or the chance +
  mm) and **Dew on optics** (likelihood + the °C spread) — and the reasons/verdict reflect both. Pulls a
  new hourly **dew point** field from the Open-Meteo forecast.

## 1.21.2
- **Weather tab: fixed stale rain radar + made the whole tab live.** The RainViewer frame list (which
  only spans ~2 hours) could be served from a browser/proxy cache — including through a Cloudflare
  Tunnel — leaving the radar animating **old, even day-old, frames**. The radar (and forecast + METAR)
  responses are now sent `Cache-Control: no-store` and fetched cache-busted, so they're always current.
- The Weather tab now **auto-refreshes every 5 minutes** while it's the visible tab (and immediately when
  you switch back to it), with a manual **↻ Refresh** button and an **"updated HH:MM"** timestamp. It
  costs nothing while the tab isn't showing.

## 1.21.1
- **Stability / Raspberry Pi hardening** (no feature or behaviour changes). Aimed at the write
  pressure and failure modes that can stall or wear out a Pi over long uptimes:
  - **SQLite now writes far more gently to the SD card.** Enabled `synchronous = NORMAL` under WAL
    (the SQLite-recommended setting — it stops fsync'ing on every commit, only at checkpoints, with
    no risk of corruption), added a `busy_timeout`, and **batch a whole poll's sightings into one
    transaction** instead of one disk commit per aircraft. Together these cut SD-card writes — and
    the synchronous stalls that block the event loop — dramatically on busy feeds.
  - **Prepared statements are cached** instead of recompiled for every aircraft on every poll — less
    CPU (and therefore less power draw, which matters on a marginal supply).
  - **Process-level crash guards**: a stray unhandled promise rejection or exception (a background
    lookup, a client vanishing mid-write) is now logged and survived instead of taking the whole app
    down. SSE writes are guarded and abrupt client disconnects are handled cleanly.
  - **docker-compose guardrails**: a container **memory limit** (with swap disabled, so nothing
    thrashes the SD card under pressure) so a worst case can't freeze the whole Pi, plus a
    **healthcheck** so a hung app shows up as `unhealthy` in `docker ps`. Note: on Raspberry Pi OS
    the memory cgroup is off by default, so the limit only applies after adding
    `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt` and rebooting (documented
    in the README) — until then Docker warns and discards it, harmlessly.
  - See the new **Stability & Raspberry Pi tips** section in the README — a full-system hang or
    spontaneous reboot is almost always **power (use the official 5 V/5 A supply), SD-card health, or
    cooling**, which these app changes reduce load on but cannot fully substitute for.

## 1.21.0
- **New Sky Watch tab** (authenticated) — a stargazing forecast that answers "is tonight (or one of
  the next nights) good for looking at the stars from *here*?" It fuses the weather with real
  astronomy, all computed on-device (no external astronomy API):
  - A **tonight verdict** with a 0–100 observing score and a rating (Excellent → Bad), the real
    **astronomical-dark-sky window** (Sun 18° below the horizon — not just sunset), and the main
    limiting factors. Correctly reports "no astronomical darkness" on high-latitude summer nights.
  - A **conditions panel**: cloud cover (from the Open-Meteo forecast over the dark hours), the
    **Moon** (phase, % illuminated, and how much of the dark window it's above the horizon),
    humidity, your **Bortle** light-pollution class, and the estimated faintest visible star.
  - A **5-night outlook** so you can pick the best upcoming night at a glance.
  - **Best objects tonight**: the Moon, planets (Mercury–Neptune) and a curated deep-sky catalogue
    (galaxies, nebulae, star clusters, double stars), filtered to what's actually above the horizon
    during darkness and ranked by how well-placed they are. Each shows **where to look** (compass
    direction + height above the horizon), **when** it's highest, its magnitude, a naked-eye /
    binoculars / telescope hint, a short description, and a clean illustration.
  - Positions of the Sun, Moon and planets come from standard low-precision models (NOAA/Meeus for
    Sun & Moon; the JPL approximate Keplerian elements for the planets) — accuracy well under a
    degree, validated against solstice/equinox declinations, Moon-phase geometry and transit
    altitudes across both hemispheres.
- New **Bortle light-pollution** setting (Settings → Sky Watch) so the estimate matches your site.
- New endpoint: `GET /api/skywatch` (auth-only). Object illustrations are drawn locally as SVG, so
  the tab works offline and hot-links nothing.

## 1.20.0
- **New Weather tab** (authenticated only — it reveals the receiver location) that combines every
  weather source into one trustworthy view for the location set in Settings:
  - **Current conditions** (temperature, feels-like, wind, gusts, humidity, precipitation, cloud,
    pressure) from **Open-Meteo**, which blends national weather-service models (DWD ICON, ECMWF, GFS,
    Météo-France…).
  - **Nearest observed METAR** from **aviationweather.gov (NOAA)** — a ground-truth cross-check of the
    forecast, with flight category, distance and the raw report. The search box widens automatically
    until it finds a reporting station.
  - **Today & tomorrow** hourly strip and a **7-day forecast** with proportional temperature-range bars,
    rain probability and gust info.
  - A **live RainViewer rain-radar** mini-map centred on the receiver, animated past→nowcast, with an
    optional OpenWeatherMap cloud overlay when a key is configured.
  - **Extreme-condition warnings** (heat, cold, damaging winds, heavy rain, snow, thunderstorms, extreme
    UV) derived from the trusted forecast with conservative thresholds and escalating severity
    (advisory / warning / severe). Clearly labelled as **derived guidance, not official government
    alerts**.
- New **"Notify about extreme weather"** setting: sends a notification (browser / Pushover / Discord)
  when a warning- or severe-level condition is forecast for **today or tomorrow** at your location,
  de-duplicated per day/condition. Backed by a server-side scheduler (checks every 30 min), mirroring
  the satellite-pass notifier.
- New endpoints: `GET /api/weather/forecast` and `GET /api/weather/metar-nearest` (both auth-only).

## 1.19.0
- **Statistics page redesign + bar-length bug fix.** The horizontal bars were all rendering nearly
  full regardless of value (a stray `flex:1` from the per-day chart leaked into them), so magnitudes
  were unreadable. Rebuilt the bars on a CSS grid so their length is now **truly proportional** to the
  count, over a recessive track, with tabular-aligned values and hover highlighting. The "aircraft per
  day" chart no longer overlaps its labels (values on hover, sparse date ticks). Category bars are now
  coloured by their map colour (airline/military/emergency…).
- New **Top destinations** and **Top departure airports** stats — the busiest arrival/departure airports
  among the flights you've tracked. Origin/destination are recorded per sighting from the cross-checked
  route lookups (new `origin`/`destination` columns, migrated in automatically); the charts fill in as
  routes resolve.

## 1.18.2
- Add a ready-to-use **`cloudflared` service** to `docker-compose.yml` (token-based Cloudflare Tunnel)
  behind an opt-in **compose profile** — `docker compose --profile cloudflared up -d` — so it has no
  effect on a normal `docker compose up -d`. Added `.env.example` (tunnel token + `TRUST_PROXY`) and
  `.env` to `.gitignore`.

## 1.18.1
- **Reverse-proxy / Cloudflare Tunnel friendliness.** The session cookie now gets the **Secure** flag
  (and HSTS is sent) automatically when the request arrives over HTTPS via `X-Forwarded-Proto` — so it's
  protected behind a tunnel while still working over plain HTTP on the LAN. Set `TRUST_PROXY=1` to make
  brute-force lockouts and auth logging use the **real client IP** (`CF-Connecting-IP` / first
  `X-Forwarded-For` hop) instead of the tunnel's loopback address. See the README's *Cloudflare Tunnel*
  notes (disable Rocket Loader / JS minify so the strict CSP isn't broken; SSE works via the keep-alive
  ping).

## 1.18.0
- **Security hardening against the OWASP Top 10.** Strict **Content-Security-Policy** (`script-src 'self'`,
  no inline scripts, `frame-ancestors 'none'`) plus `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, COOP/CORP and conditional HSTS; `X-Powered-By` removed. All
  third-party data rendered in the UI (callsigns, operators, route/airport names, METAR, photo credits,
  watchlist/plane-alert-db fields…) is **HTML-escaped**, and the one inline `onerror` handler was
  removed so the CSP can stay strict. Server adds a **prototype-pollution guard** in the config merge,
  an **SSRF guard** on the aircraft-DB import URL (http/https only, no redirects), a generic error
  handler (no stack traces), and an API 404 fallback. Auth: minimum password length raised to 8, the
  **session secret rotates on password change** (logging out other sessions), and failed logins /
  lockouts are logged. (`npm audit`: 0 known vulnerabilities.) See **SECURITY.md** for the full mapping.

## 1.17.0
- **Optional two-factor authentication (2FA)** for the authenticated login. Enable it in Settings —
  scan the QR with Google Authenticator / Authy (or paste the key) and confirm a code; afterwards login
  requires the password **and** a 6-digit TOTP code. Disable needs the password + a current code.
  Standard RFC 6238 TOTP, implemented on `node:crypto` (no third-party auth library).
- **Brute-force protection on login.** Failed attempts are throttled with a small delay and an
  escalating per-client lockout (locked after 5 failures, doubling from 30 s up to 15 min), plus a
  global flood guard — applied to both the password and the 2FA code. Lockouts return HTTP 429 with a
  `Retry-After`.

## 1.16.0
- **Public / authenticated split** (single password, no RBAC). Anonymous visitors get a **public view**
  — Map, Statistics and Spotted only — that **never reveals the receiver's location**: the receiver
  marker, distance rings, range outline and heatmap layers, the per-aircraft/closest distances, the
  receiver-weather widget, and Zones/Watchlist/Alerts/Settings are all hidden, and the **server strips**
  the receiver coordinates + distances from the public API (and SSE) so they can't be read directly or
  trilaterated. The public map shows a footer noting it's a self-hosted ADS-B receiver map (aircraft in
  range only) with a link to the repo. Log in with the password to unlock everything. If no password is
  set yet, the **Settings tab prompts you to create one** (after which you're logged in). The password
  is stored only as a scrypt hash; sessions are signed HMAC cookies.

## 1.15.0
- 🥚 **Easter egg.** Type a certain two-word arcade classic into the map search box and press Enter…
  the map turns into a game where the aircraft currently on your screen (and new ones as they appear)
  become the invaders to shoot down. Arrow keys / A–D to move, Space to fire, Esc to quit. Persistent
  highscores (`/api/invaders/highscores`). (No spoilers here — go find it.)

## 1.14.2
- METAR popups now include a **decoded breakdown** of the raw report — each token explained in plain
  English in a table (e.g. `31006KT` → "Wind from 310° at 6 kt", `9999` → "Visibility 10 km or more",
  `FEW040` → "Few clouds at 4,000 ft", `Q1026` → "Altimeter (QNH) 1026 hPa", `NOSIG` → "No significant
  change expected…"). Handles wind/gusts/variable, visibility (m & SM), clouds, weather phenomena
  (rain/fog/thunderstorm…), temp/dew (incl. negatives), QNH/inHg, trends and remarks.

## 1.14.1
- **Richer notifications.** Alerts now include more about the aircraft and its location: registration
  and squawk, altitude with a climb/descent arrow, speed, **heading with a compass direction**, the
  route (origin → destination) when known, distance from the receiver, the nearest place name, the
  **exact coordinates**, and a **tappable map link**. Altitude/speed respect your metric/aviation unit
  setting. Pushover links straight to the map location; the Discord embed gets dedicated fields
  (Reg / Altitude / Speed / Heading / Squawk / Location / Coordinates) with a clickable map link.

## 1.14.0
- New **🛫 Airspace (OpenAIP)** map layer — controlled-airspace overlay (CTR / TMA / CTA / classes)
  from [OpenAIP](https://www.openaip.net). Needs a free OpenAIP API key (Settings ▸ Aeronautical
  layers); the key is kept server-side and the tiles are proxied + cached.
- New **🌬 Aviation weather (METAR)** map layer — current METARs from NOAA's
  [aviationweather.gov](https://aviationweather.gov) (free, no key) as colour-coded station markers by
  flight category (VFR / MVFR / IFR / LIFR). Click a station for decoded wind, visibility, temperature,
  altimeter and the raw METAR. Stations refresh as you pan/zoom.

## 1.13.1
- Fix **bogus same-airport routes** (e.g. "LHR → LHR") shown as ✓ confirmed. adsbdb sometimes returns a
  degenerate route whose origin equals its destination; the app trusted it and even marked it confirmed
  because the cross-check only tested whether each airport *appeared anywhere* in hexdb's route (so
  "LHR" matched the "LHR–BRU" list twice). Now a same-airport route from adsbdb is treated as no route,
  so the real route from hexdb (LHR → BRU) is used; and confirmation requires the **origin and
  destination to match in order**, which also stops reversed routes being falsely confirmed.

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
