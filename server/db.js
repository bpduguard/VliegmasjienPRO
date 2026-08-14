// SQLite persistence using node:sqlite (built into Node >= 22.13, no native build
// step — keeps the Docker image simple on arm64 / Raspberry Pi 5).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

let db;

export function initDb() {
  db = new DatabaseSync(path.join(DATA_DIR, 'vliegmasjien.db'));
  // Durability/wear tuning for the Raspberry Pi's SD card. Under WAL,
  // `synchronous = NORMAL` is the SQLite-recommended setting: it stops fsync'ing
  // the disk on *every* commit (only at checkpoints), which drastically cuts
  // SD-card writes and the synchronous stalls that block Node's event loop —
  // without any risk of database corruption (at worst the last few seconds of
  // logging are lost on a hard power cut). `busy_timeout` waits instead of
  // throwing if a checkpoint briefly holds the file.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 1000;
    CREATE TABLE IF NOT EXISTS sightings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hex TEXT NOT NULL,
      callsign TEXT,
      registration TEXT,
      type TEXT,
      category TEXT,
      airline TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      max_alt INTEGER,
      max_speed INTEGER,
      min_dist_km REAL
    );
    CREATE INDEX IF NOT EXISTS idx_sightings_hex ON sightings(hex);
    CREATE INDEX IF NOT EXISTS idx_sightings_last_seen ON sightings(last_seen);
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      hex TEXT,
      callsign TEXT,
      kind TEXT,
      message TEXT
    );
    -- Persistent hex -> aircraft database. Filled lazily (per-hex lookups) and/or
    -- by bulk import, so registration/type survive restarts and are served
    -- instantly offline. Plain dump1090-fa doesn't provide r/t per aircraft.
    CREATE TABLE IF NOT EXISTS aircraft_db (
      hex TEXT PRIMARY KEY,
      registration TEXT,
      type TEXT,
      type_long TEXT,
      operator TEXT,
      updated INTEGER NOT NULL
    );
    -- Cached aircraft photo metadata (planespotters). Persisted so each hex is
    -- looked up at most once per TTL — survives restarts, keeps API volume low.
    -- An empty thumb means "checked, no photo" (negative cache).
    CREATE TABLE IF NOT EXISTS photos (
      hex TEXT PRIMARY KEY,
      thumb TEXT,
      link TEXT,
      photographer TEXT,
      ts INTEGER NOT NULL
    );
    -- Airport communication frequencies (OurAirports). One row per airport that
    -- has at least one frequency; freqs is a JSON array of {type,description,mhz}.
    CREATE TABLE IF NOT EXISTS airport_freqs (
      ident TEXT PRIMARY KEY,
      name TEXT,
      municipality TEXT,
      country TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      freqs TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_freqs_lat ON airport_freqs(lat);
    -- Time-series position log powering the map replay. High-volume, so it has
    -- its own (shorter) retention than sightings (config.replayRetentionDays).
    CREATE TABLE IF NOT EXISTS tracks (
      ts INTEGER NOT NULL,
      hex TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      alt INTEGER,
      gs INTEGER,
      trk INTEGER,
      callsign TEXT,
      src TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_ts ON tracks(ts);
    CREATE INDEX IF NOT EXISTS idx_tracks_hex_ts ON tracks(hex, ts);
  `);
  // Migrations: add route origin/destination to existing sightings tables (for
  // the "top destinations / departed from" stats). Idempotent — ignore if present.
  for (const col of ['origin', 'destination']) {
    try { db.exec(`ALTER TABLE sightings ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
  }
  return db;
}

// Prepared-statement cache. node:sqlite compiles the SQL on every prepare(); the
// tracker runs the same handful of statements for every aircraft on every poll,
// so we compile each once and reuse it — meaningful CPU (and therefore power)
// savings on a Pi. Keyed by the (constant) SQL text.
const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

// Run `fn` inside a single transaction. Batching many small writes (e.g. a whole
// poll's sightings) into one commit turns N disk commits into one — fewer WAL
// frames and far less SD-card churn. Always rolls back on error and never leaves
// a transaction dangling.
export function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// --- aircraft database (hex -> reg/type/operator) ---------------------------

export function getAircraftDb(hex) {
  return prep('SELECT * FROM aircraft_db WHERE hex = ?').get((hex || '').toLowerCase()) || null;
}

const upsertAircraftStmt = () =>
  prep(
    `INSERT INTO aircraft_db (hex, registration, type, type_long, operator, updated)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(hex) DO UPDATE SET
       registration = COALESCE(NULLIF(excluded.registration,''), aircraft_db.registration),
       type = COALESCE(NULLIF(excluded.type,''), aircraft_db.type),
       type_long = COALESCE(NULLIF(excluded.type_long,''), aircraft_db.type_long),
       operator = COALESCE(NULLIF(excluded.operator,''), aircraft_db.operator),
       updated = excluded.updated`
  );

export function putAircraftDb({ hex, registration, type, typeLong, operator }) {
  if (!hex) return;
  upsertAircraftStmt().run(
    hex.toLowerCase(),
    registration || '',
    type || '',
    typeLong || '',
    operator || '',
    Date.now()
  );
}

// Bulk import for a hex,reg,type[,operator] dataset. Wrapped in a transaction.
export function bulkImportAircraftDb(rows) {
  const stmt = upsertAircraftStmt();
  const now = Date.now();
  db.exec('BEGIN');
  let n = 0;
  try {
    for (const r of rows) {
      if (!r.hex) continue;
      stmt.run(r.hex.toLowerCase(), r.registration || '', r.type || '', r.typeLong || '', r.operator || '', now);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

export function aircraftDbCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM aircraft_db').get().c;
}

// --- aircraft photos --------------------------------------------------------

export function getPhoto(hex) {
  return prep('SELECT * FROM photos WHERE hex = ?').get((hex || '').toLowerCase()) || null;
}

export function putPhoto(hex, photo) {
  prep('INSERT OR REPLACE INTO photos (hex, thumb, link, photographer, ts) VALUES (?,?,?,?,?)').run(
    (hex || '').toLowerCase(),
    photo?.thumb || '',
    photo?.link || '',
    photo?.photographer || '',
    Date.now()
  );
}

// --- airport frequencies ----------------------------------------------------

export function replaceAirportFreqs(rows) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO airport_freqs (ident, name, municipality, country, lat, lon, freqs) VALUES (?,?,?,?,?,?,?)'
  );
  db.exec('BEGIN');
  let n = 0;
  try {
    db.exec('DELETE FROM airport_freqs');
    for (const r of rows) {
      stmt.run(r.ident, r.name || '', r.municipality || '', r.country || '', r.lat, r.lon, JSON.stringify(r.freqs));
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

export function airportFreqsCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM airport_freqs').get().c;
}

// Bounding-box query (handles antimeridian-free common case). lon filter is a
// plain BETWEEN; callers pass normalized west<east bounds.
export function airportFreqsInBounds(s, w, n, e, limit = 500) {
  const rows = db
    .prepare(
      'SELECT * FROM airport_freqs WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT ?'
    )
    .all(s, n, w, e, limit);
  return rows.map((r) => ({
    ident: r.ident,
    name: r.name,
    municipality: r.municipality,
    country: r.country,
    lat: r.lat,
    lon: r.lon,
    freqs: JSON.parse(r.freqs)
  }));
}



// A "sighting" is one continuous session of an aircraft being received.
// If the same hex reappears within SESSION_GAP we extend the row, otherwise a
// new row is created — that gives the "seen in the past" history per plane.
const SESSION_GAP_MS = 30 * 60 * 1000;

export function upsertSighting(ac, now) {
  const row = prep('SELECT id, last_seen FROM sightings WHERE hex = ? ORDER BY last_seen DESC LIMIT 1')
    .get(ac.hex);
  if (row && now - row.last_seen < SESSION_GAP_MS) {
    prep(
      `UPDATE sightings SET
         last_seen = ?,
         callsign = COALESCE(NULLIF(?, ''), callsign),
         registration = COALESCE(NULLIF(?, ''), registration),
         type = COALESCE(NULLIF(?, ''), type),
         category = COALESCE(NULLIF(?, ''), category),
         airline = COALESCE(NULLIF(?, ''), airline),
         origin = COALESCE(NULLIF(?, ''), origin),
         destination = COALESCE(NULLIF(?, ''), destination),
         max_alt = MAX(COALESCE(max_alt, 0), COALESCE(?, 0)),
         max_speed = MAX(COALESCE(max_speed, 0), COALESCE(?, 0)),
         min_dist_km = CASE
           WHEN ? IS NULL THEN min_dist_km
           WHEN min_dist_km IS NULL THEN ?
           ELSE MIN(min_dist_km, ?) END
       WHERE id = ?`
    ).run(
      now,
      ac.flight || '',
      ac.registration || '',
      ac.type || '',
      ac.classification || '',
      ac.airline || '',
      ac.origin || '',
      ac.destination || '',
      Number.isFinite(ac.alt_baro) ? ac.alt_baro : null,
      Number.isFinite(ac.gs) ? Math.round(ac.gs) : null,
      ac.distKm ?? null,
      ac.distKm ?? null,
      ac.distKm ?? null,
      row.id
    );
    return row.id;
  }
  const res = prep(
      `INSERT INTO sightings (hex, callsign, registration, type, category, airline, origin, destination,
        first_seen, last_seen, max_alt, max_speed, min_dist_km)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      ac.hex,
      ac.flight || null,
      ac.registration || null,
      ac.type || null,
      ac.classification || null,
      ac.airline || null,
      ac.origin || null,
      ac.destination || null,
      now,
      now,
      Number.isFinite(ac.alt_baro) ? ac.alt_baro : null,
      Number.isFinite(ac.gs) ? Math.round(ac.gs) : null,
      ac.distKm ?? null
    );
  return res.lastInsertRowid;
}

export function aircraftHistory(hex, limit = 50) {
  return db
    .prepare('SELECT * FROM sightings WHERE hex = ? ORDER BY last_seen DESC LIMIT ?')
    .all(hex.toLowerCase(), limit);
}

export function logAlert(hex, callsign, kind, message) {
  prep('INSERT INTO alerts (ts, hex, callsign, kind, message) VALUES (?,?,?,?,?)').run(
    Date.now(),
    hex || null,
    callsign || null,
    kind,
    message
  );
}

export function recentAlerts(limit = 100) {
  return db.prepare('SELECT * FROM alerts ORDER BY ts DESC LIMIT ?').all(limit);
}

// Distinct aircraft types & operators ever recorded — seeds the rarity detector's
// "have I seen this before?" sets so first-time flags survive restarts.
export function loadKnownIdentities() {
  const types = new Set(
    db.prepare("SELECT DISTINCT type FROM sightings WHERE type IS NOT NULL AND type <> ''")
      .all().map((r) => r.type.toUpperCase())
  );
  const operators = new Set(
    db.prepare("SELECT DISTINCT airline FROM sightings WHERE airline IS NOT NULL AND airline <> ''")
      .all().map((r) => r.airline.trim().toLowerCase())
  );
  return { types, operators };
}

export function statsSummary(days = 7) {
  const since = Date.now() - days * 86400000;
  const perDay = db
    .prepare(
      `SELECT date(first_seen/1000, 'unixepoch') AS day,
              COUNT(*) AS sightings, COUNT(DISTINCT hex) AS aircraft
       FROM sightings WHERE first_seen >= ? GROUP BY day ORDER BY day`
    )
    .all(since);
  const topTypes = db
    .prepare(
      `SELECT type, COUNT(DISTINCT hex) AS count FROM sightings
       WHERE first_seen >= ? AND type IS NOT NULL AND type != ''
       GROUP BY type ORDER BY count DESC LIMIT 15`
    )
    .all(since);
  const topAirlines = db
    .prepare(
      `SELECT airline, COUNT(*) AS count FROM sightings
       WHERE first_seen >= ? AND airline IS NOT NULL AND airline != ''
       GROUP BY airline ORDER BY count DESC LIMIT 15`
    )
    .all(since);
  const categories = db
    .prepare(
      `SELECT category, COUNT(DISTINCT hex) AS count FROM sightings
       WHERE first_seen >= ? AND category IS NOT NULL AND category != ''
       GROUP BY category ORDER BY count DESC`
    )
    .all(since);
  const topDestinations = db
    .prepare(
      `SELECT destination AS code, COUNT(*) AS count FROM sightings
       WHERE first_seen >= ? AND destination IS NOT NULL AND destination != ''
       GROUP BY destination ORDER BY count DESC LIMIT 15`
    )
    .all(since);
  const topOrigins = db
    .prepare(
      `SELECT origin AS code, COUNT(*) AS count FROM sightings
       WHERE first_seen >= ? AND origin IS NOT NULL AND origin != ''
       GROUP BY origin ORDER BY count DESC LIMIT 15`
    )
    .all(since);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS sightings, COUNT(DISTINCT hex) AS aircraft FROM sightings WHERE first_seen >= ?`
    )
    .get(since);
  return { days, perDay, topTypes, topAirlines, categories, topDestinations, topOrigins, totals };
}

// Distinct aircraft seen since `since`, aggregated per hex (latest callsign,
// session count, first/last seen, max alt/speed, closest distance). Used by the
// "Spotted" tab after filtering to plane-alert-db members.
export function spottedSince(since, limit = 1000) {
  return db
    .prepare(
      `SELECT s.hex,
              COUNT(*) AS sessions,
              MIN(s.first_seen) AS first_seen,
              MAX(s.last_seen) AS last_seen,
              MAX(s.max_alt) AS max_alt,
              MAX(s.max_speed) AS max_speed,
              MIN(s.min_dist_km) AS min_dist_km,
              (SELECT callsign FROM sightings x
                 WHERE x.hex = s.hex AND x.callsign IS NOT NULL AND x.callsign != ''
                 ORDER BY x.last_seen DESC LIMIT 1) AS callsign,
              (SELECT registration FROM sightings x
                 WHERE x.hex = s.hex AND x.registration IS NOT NULL AND x.registration != ''
                 ORDER BY x.last_seen DESC LIMIT 1) AS registration
       FROM sightings s
       WHERE s.last_seen >= ?
       GROUP BY s.hex
       ORDER BY MAX(s.last_seen) DESC
       LIMIT ?`
    )
    .all(since, limit);
}

export function pruneOldData(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  db.prepare('DELETE FROM sightings WHERE last_seen < ?').run(cutoff);
  db.prepare('DELETE FROM alerts WHERE ts < ?').run(cutoff);
}

// The retention-governed "log" data: the spotted/stats history (sightings),
// the alert log, and the replay position trail. Reference/cache tables
// (aircraft_db, photos, airport_freqs) are deliberately excluded — they're not
// time-based logs and are expensive to rebuild.
const LOG_TABLES = ['sightings', 'alerts', 'tracks'];

// On-disk footprint of the log data plus the whole database file. Uses SQLite's
// dbstat virtual table to attribute pages (incl. indexes) to the log tables.
export function logStorageInfo() {
  const file = path.join(DATA_DIR, 'vliegmasjien.db');
  let fileBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fileBytes += fs.statSync(file + suffix).size; } catch { /* missing is fine */ }
  }
  // every DB object (the log tables themselves + their indexes) that counts as log
  const logNames = new Set(LOG_TABLES);
  for (const r of db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'").all()) {
    if (LOG_TABLES.includes(r.tbl_name)) logNames.add(r.name);
  }
  let logBytes = null;
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)'); // fold WAL pages in so dbstat is current
    logBytes = 0;
    for (const r of db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all()) {
      if (logNames.has(r.name)) logBytes += r.bytes || 0;
    }
  } catch { logBytes = null; }
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return {
    fileBytes,
    logBytes,
    sightings: count('sightings'),
    alerts: count('alerts'),
    tracks: count('tracks')
  };
}

// Manually clear all retention-governed log data and reclaim the disk space.
export function purgeLogs() {
  for (const t of LOG_TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.exec('VACUUM'); // rebuild the db file compactly, handing freed pages back to the OS
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // and shrink the -wal file back to 0 on disk
  return logStorageInfo();
}

// --- replay (position time-series) ------------------------------------------

const insertTrackStmt = () =>
  prep('INSERT INTO tracks (ts, hex, lat, lon, alt, gs, trk, callsign, src) VALUES (?,?,?,?,?,?,?,?,?)');

export function insertTracks(rows) {
  if (!rows.length) return 0;
  const stmt = insertTrackStmt();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(r.ts, r.hex, r.lat, r.lon, r.alt ?? null, r.gs ?? null, r.trk ?? null, r.callsign ?? null, r.src ?? null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

export function replayBounds() {
  const r = db.prepare('SELECT MIN(ts) AS min, MAX(ts) AS max, COUNT(*) AS count FROM tracks').get();
  return { min: r.min || null, max: r.max || null, count: r.count || 0 };
}

// Latest known position per aircraft within (at-windowMs, at].
export function replayFrame(at, windowMs, limit = 800) {
  return db
    .prepare(
      `SELECT t.hex, t.lat, t.lon, t.alt, t.gs, t.trk, t.callsign, t.src, t.ts
       FROM tracks t
       JOIN (SELECT hex, MAX(ts) AS mts FROM tracks WHERE ts > ? AND ts <= ? GROUP BY hex) m
         ON t.hex = m.hex AND t.ts = m.mts
       LIMIT ?`
    )
    .all(at - windowMs, at, limit);
}

export function pruneTracks(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  db.prepare('DELETE FROM tracks WHERE ts < ?').run(cutoff);
}

// Recorded position track for one aircraft within a time window (a past sighting
// session). Ordered oldest→newest. Only spans as far back as the replay retention
// (config.replayRetentionDays); older sightings have no stored track.
export function getAircraftTrack(hex, from, to, limit = 8000) {
  return prep(
    'SELECT ts, lat, lon, alt, gs, trk, callsign FROM tracks WHERE hex = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?'
  ).all((hex || '').toLowerCase(), from, to, limit);
}

// Density heatmap: bin recorded positions (since `sinceMs`) onto a `grid`-degree
// grid and count how many position reports fell in each cell. Returns the busiest
// cells (capped) as [latCenter, lonCenter, count] plus the peak count and the
// total number of points in the window.
export function heatmapCells(sinceMs, grid = 0.01, limit = 80000) {
  const total = db.prepare('SELECT COUNT(*) AS c FROM tracks WHERE ts >= ?').get(sinceMs).c;
  const rows = db.prepare(
    `SELECT CAST(lat / ? AS INT) AS gy, CAST(lon / ? AS INT) AS gx, COUNT(*) AS c
     FROM tracks WHERE ts >= ?
     GROUP BY gy, gx
     ORDER BY c DESC
     LIMIT ?`
  ).all(grid, grid, sinceMs, limit);
  let max = 0;
  const cells = rows.map((r) => {
    if (r.c > max) max = r.c;
    return [+((r.gy + 0.5) * grid).toFixed(5), +((r.gx + 0.5) * grid).toFixed(5), r.c];
  });
  return { cells, max, count: cells.length, total, grid, capped: rows.length >= limit };
}

export function tracksCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM tracks').get().c;
}
