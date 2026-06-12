// SQLite persistence using node:sqlite (built into Node >= 22.13, no native build
// step — keeps the Docker image simple on arm64 / Raspberry Pi 5).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';

let db;

export function initDb() {
  db = new DatabaseSync(path.join(DATA_DIR, 'vliegmasjien.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
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
  `);
  return db;
}

// A "sighting" is one continuous session of an aircraft being received.
// If the same hex reappears within SESSION_GAP we extend the row, otherwise a
// new row is created — that gives the "seen in the past" history per plane.
const SESSION_GAP_MS = 30 * 60 * 1000;

export function upsertSighting(ac, now) {
  const row = db
    .prepare('SELECT id, last_seen FROM sightings WHERE hex = ? ORDER BY last_seen DESC LIMIT 1')
    .get(ac.hex);
  if (row && now - row.last_seen < SESSION_GAP_MS) {
    db.prepare(
      `UPDATE sightings SET
         last_seen = ?,
         callsign = COALESCE(NULLIF(?, ''), callsign),
         registration = COALESCE(NULLIF(?, ''), registration),
         type = COALESCE(NULLIF(?, ''), type),
         category = COALESCE(NULLIF(?, ''), category),
         airline = COALESCE(NULLIF(?, ''), airline),
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
      Number.isFinite(ac.alt_baro) ? ac.alt_baro : null,
      Number.isFinite(ac.gs) ? Math.round(ac.gs) : null,
      ac.distKm ?? null,
      ac.distKm ?? null,
      ac.distKm ?? null,
      row.id
    );
    return row.id;
  }
  const res = db
    .prepare(
      `INSERT INTO sightings (hex, callsign, registration, type, category, airline,
        first_seen, last_seen, max_alt, max_speed, min_dist_km)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      ac.hex,
      ac.flight || null,
      ac.registration || null,
      ac.type || null,
      ac.classification || null,
      ac.airline || null,
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
  db.prepare('INSERT INTO alerts (ts, hex, callsign, kind, message) VALUES (?,?,?,?,?)').run(
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
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS sightings, COUNT(DISTINCT hex) AS aircraft FROM sightings WHERE first_seen >= ?`
    )
    .get(since);
  return { days, perDay, topTypes, topAirlines, categories, totals };
}

export function pruneOldData(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  db.prepare('DELETE FROM sightings WHERE last_seen < ?').run(cutoff);
  db.prepare('DELETE FROM alerts WHERE ts < ?').run(cutoff);
}
