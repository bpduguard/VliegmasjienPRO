// Backup & restore: bundle the database (a consistent snapshot), the settings and
// the reference/cache files from DATA_DIR into a single ZIP the user can download,
// and restore selected parts of it later. Uses adm-zip so both directions are
// handled by a well-tested library (a corrupt backup would be worse than none).
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { DATA_DIR, loadConfig } from './config.js';
import { VERSION } from './version.js';
import { backupDatabaseTo, restoreTablesFrom } from './db.js';

const DB_ENTRY = 'db/vliegmasjien.db';
const SETTINGS_FILES = ['config.json'];
// Non-DB reference/cache files that travel under the "reference data" category.
const REFERENCE_FILES = [
  'range.json', 'plane-alert-db.csv', 'plane-alert-db.meta.json',
  'frequencies.meta.json', 'tle.json', 'invaders-highscores.json'
];
// Live DB files are never added raw — the consistent snapshot goes in as DB_ENTRY.
const SKIP = new Set(['vliegmasjien.db', 'vliegmasjien.db-wal', 'vliegmasjien.db-shm']);

export function createBackup() {
  const zip = new AdmZip();
  // Consistent DB snapshot (VACUUM INTO a temp file, add it, delete the temp).
  const tmp = path.join(DATA_DIR, `.backup-${Date.now()}.db`);
  try {
    backupDatabaseTo(tmp);
    zip.addFile(DB_ENTRY, fs.readFileSync(tmp));
  } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }

  // Everything else in DATA_DIR (config + reference/cache files), skipping the
  // live DB files and any temp/hidden files.
  const included = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (SKIP.has(f) || f.startsWith('.')) continue;
    const p = path.join(DATA_DIR, f);
    try {
      if (fs.statSync(p).isFile()) { zip.addFile(f, fs.readFileSync(p)); included.push(f); }
    } catch { /* ignore unreadable */ }
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    app: 'VliegmasjienPRO', version: VERSION, createdAt: Date.now(), database: true, files: included
  }, null, 2)));
  return zip.toBuffer();
}

// Peek at an uploaded backup without applying it.
export function readManifest(zipBuffer) {
  try {
    const zip = new AdmZip(zipBuffer);
    const e = zip.getEntry('manifest.json');
    const m = e ? JSON.parse(e.getData().toString()) : {};
    if (!zip.getEntry(DB_ENTRY) && !zip.getEntry('config.json')) return { error: 'This ZIP is not a VliegmasjienPRO backup.' };
    return { app: m.app || null, version: m.version || null, createdAt: m.createdAt || null };
  } catch { return { error: 'Could not read the file as a ZIP backup.' }; }
}

export function restoreBackup(zipBuffer, sel) {
  const zip = new AdmZip(zipBuffer);
  const files = [];
  const writeIfPresent = (name) => {
    const e = zip.getEntry(name);
    if (e) { fs.writeFileSync(path.join(DATA_DIR, name), e.getData()); files.push(name); }
  };

  if (sel.settings) { SETTINGS_FILES.forEach(writeIfPresent); loadConfig(); }
  if (sel.reference) REFERENCE_FILES.forEach(writeIfPresent);

  // Database tables, by category.
  const groups = [];
  if (sel.history) groups.push('history');
  if (sel.tracks) groups.push('tracks');
  if (sel.reference) groups.push('reference');
  let tables = [];
  if (groups.length) {
    const e = zip.getEntry(DB_ENTRY);
    if (e) {
      const tmp = path.join(DATA_DIR, `.restore-${Date.now()}.db`);
      fs.writeFileSync(tmp, e.getData());
      try { tables = restoreTablesFrom(tmp, groups); }
      finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    }
  }
  return { files, tables };
}
