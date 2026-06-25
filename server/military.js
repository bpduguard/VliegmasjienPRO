// Military aircraft recognition that doesn't rely on the readsb/tar1090 `dbFlags`
// bit (plain dump1090-fa never sends it) or plane-alert-db membership. Uses three
// always-available signals: the ICAO 24-bit address (states allocate distinct
// blocks to their armed forces), the callsign's telephony prefix (air forces use
// assigned ICAO designators like GAF/RCH/CTM), and military-only type designators.

// Military ICAO 24-bit address sub-allocations. These are the narrow, well-known
// military blocks within each country's civil range — kept tight on purpose so we
// don't sweep up civil traffic. [startHex, endHex].
const MIL_HEX_RANGES = [
  ['ADF7C8', 'AFFFFF'], // United States
  ['33FF00', '33FFFF'], // Italy
  ['3AA000', '3AAFFF'], // France
  ['3B7000', '3BFFFF'], // France
  ['3EA000', '3EBFFF'], // Germany
  ['3F4000', '3FBFFF'], // Germany
  ['400000', '40003F'], // United Kingdom
  ['43C000', '43CFFF'], // United Kingdom
  ['444000', '446FFF'], // Austria
  ['44F000', '44FFFF'], // Belgium
  ['457000', '457FFF'], // Bulgaria
  ['45F400', '45F4FF'], // Denmark
  ['468000', '4683FF'], // Greece
  ['473C00', '473C0F'], // Hungary
  ['478100', '4781FF'], // Norway
  ['480000', '480FFF'], // Netherlands
  ['48D800', '48D87F'], // Poland
  ['497C00', '497CFF'], // Portugal
  ['498420', '49842F'], // Czech Republic
  ['4B7000', '4B7FFF'], // Switzerland
  ['4B8200', '4B82FF'], // Turkey
  ['738000', '73FFFF'], // Israel
].map(([a, b]) => [parseInt(a, 16), parseInt(b, 16)]).sort((x, y) => x[0] - y[0]);

const milHexCache = new Map(); // hex -> bool
export function isMilitaryHex(hex) {
  hex = (hex || '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return false;
  if (milHexCache.has(hex)) return milHexCache.get(hex);
  const n = parseInt(hex, 16);
  let hit = false;
  for (const [lo, hi] of MIL_HEX_RANGES) {
    if (n < lo) break;
    if (n <= hi) { hit = true; break; }
  }
  milHexCache.set(hex, hit);
  return hit;
}

// ICAO telephony/callsign prefixes assigned to military operators. These are
// distinct from civil airline codes, so an airline-style callsign starting with
// one of these (e.g. GAF123, RCH285, BAF456) is military, not an airliner.
const MIL_CALLSIGN_PREFIXES = new Set([
  'RCH', 'CNV', 'SAM', 'PAT',          // United States (Reach, Navy Convoy, Special Air Mission, Army)
  'RRR',                               // United Kingdom (RAF "Ascot")
  'GAF', 'GAM',                        // Germany (Luftwaffe)
  'CTM', 'FAF', 'FNY', 'CEF',          // France (Cotam, Air Force, Navy) / Czech AF (CEF)
  'BAF',                               // Belgium
  'NAF',                               // Netherlands / Nigeria air force
  'IAM',                               // Italy
  'AME',                               // Spain (Aire)
  'CFC',                               // Canada
  'NATO', 'MAGMA',                     // NATO
  'DAF',                               // Denmark
  'SVF',                               // Sweden
  'ASY',                               // Australia (Aussie)
  'HUAF', 'PLF',                       // Hungary / Poland
]);

export function isMilitaryCallsign(flight) {
  const f = (flight || '').trim().toUpperCase();
  // 4-letter designators first (NATO, MAGMA, HUAF), then the usual 3-letter+digit
  const m4 = /^([A-Z]{4})\d/.exec(f);
  if (m4 && MIL_CALLSIGN_PREFIXES.has(m4[1])) return true;
  const m3 = /^([A-Z]{3})\d/.exec(f);
  if (m3 && MIL_CALLSIGN_PREFIXES.has(m3[1])) return true;
  return false;
}

// ICAO type designators that are essentially military-only — fast jets plus
// dedicated transports/tankers/special-mission types that have no civil use, so
// they're safe to treat as military regardless of callsign or operator.
const MIL_TYPES =
  /^(F1[045]|F16|F18|F117|F22|F35|F4|F5|EUFI|TYPH|RFAL|GR[0-9]|MIG[0-9]|SU[0-9]{2}|J39|A10|HARR|HUNT|TOR|B1|B2|B52|A400|C130|C30J|C17|C5M?|K35R|KC13|KC10|KC46|E3[A-Z]{2}|E6|E8|P8|P3|RC13|OC13|WC13|U2|NIMR|C160|E2|C2)(?![A-Z0-9])/;

export function isMilitaryType(type) {
  return !!type && MIL_TYPES.test(type.toUpperCase());
}

// Combined check used by classify(). `ac.military` (readsb dbFlags) and
// plane-alert-db "mil" tags are handled by the caller; this adds the
// always-available signals.
export function isMilitaryAircraft(ac) {
  return (
    isMilitaryHex(ac.hex) ||
    isMilitaryCallsign(ac.flight) ||
    isMilitaryType(ac.type)
  );
}
