// Military / state fleet feed. Cross-references the live stream against the
// pre-classified military endpoint that adsb.lol and adsb.fi publish (a global
// list of known military/state ICAO hexes). We only keep the hex set and use it
// to (a) harden the military classification and (b) raise a detection when a
// listed airframe appears in coverage. Fails soft: if the fetch fails, the set
// simply isn't updated and the heuristic classifier still runs.
import { getConfig } from './config.js';

const USER_AGENT = 'VliegmasjienPRO/1.x (+https://github.com/bpduguard/vliegmasjienpro)';
let milHexes = new Set();
let lastOk = 0;

export function isMilitaryHex(hex) { return milHexes.has(hex); }
export function milFeedStatus() { return { count: milHexes.size, lastOk }; }

export async function refreshMilFeed() {
  const cfg = getConfig();
  if (cfg.militaryFeed?.enabled === false) return;
  const url = cfg.militaryFeed?.url || 'https://api.adsb.lol/v2/mil';
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.warn('[mil] feed HTTP', res.status); return; }
    const data = await res.json();
    const list = data.ac || data.aircraft || [];
    const set = new Set();
    for (const a of list) {
      const h = (a.hex || a.icao || '').toLowerCase().replace('~', '');
      if (h) set.add(h);
    }
    if (set.size) {
      milHexes = set; lastOk = Date.now();
      console.log(`[mil] military fleet list: ${set.size} aircraft`);
    }
  } catch (e) {
    console.warn('[mil] feed error:', e.message);
  }
}

export function startMilFeed() {
  const cfg = getConfig();
  if (cfg.militaryFeed?.enabled === false) return;
  refreshMilFeed();
  const min = Math.max(5, cfg.militaryFeed?.refreshMin || 10);
  setInterval(refreshMilFeed, min * 60000);
}
