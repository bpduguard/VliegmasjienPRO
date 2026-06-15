// ICAO 24-bit address → country (ISO 3166-1 alpha-2), using the standard
// Mode-S address block allocation. Used to show a country flag per aircraft.
// Ranges are [startHex, endHex, iso2]; looked up by the aircraft's hex.

const RANGES = [
  ['004000', '0043FF', 'ZW'], ['006000', '006FFF', 'MZ'], ['008000', '00FFFF', 'ZA'],
  ['010000', '017FFF', 'EG'], ['018000', '01FFFF', 'LY'], ['020000', '027FFF', 'MA'],
  ['028000', '02FFFF', 'TN'], ['030000', '0303FF', 'BW'], ['032000', '032FFF', 'BI'],
  ['034000', '034FFF', 'CM'], ['035000', '0353FF', 'KM'], ['036000', '036FFF', 'CG'],
  ['038000', '038FFF', 'CI'], ['03E000', '03EFFF', 'GA'], ['040000', '040FFF', 'ET'],
  ['042000', '042FFF', 'GQ'], ['044000', '044FFF', 'GH'], ['046000', '046FFF', 'GN'],
  ['048000', '0483FF', 'GW'], ['04A000', '04A3FF', 'LS'], ['04C000', '04CFFF', 'KE'],
  ['050000', '050FFF', 'LR'], ['054000', '054FFF', 'MG'], ['058000', '058FFF', 'MW'],
  ['05A000', '05A3FF', 'MV'], ['05C000', '05CFFF', 'ML'], ['05E000', '05E3FF', 'MR'],
  ['060000', '0603FF', 'MU'], ['062000', '062FFF', 'NE'], ['064000', '064FFF', 'NG'],
  ['068000', '068FFF', 'UG'], ['06A000', '06A3FF', 'QA'], ['06C000', '06CFFF', 'CF'],
  ['06E000', '06EFFF', 'RW'], ['070000', '070FFF', 'SN'], ['074000', '0743FF', 'SC'],
  ['076000', '0763FF', 'SL'], ['078000', '078FFF', 'SO'], ['07A000', '07A3FF', 'SZ'],
  ['07C000', '07CFFF', 'SD'], ['080000', '080FFF', 'TZ'], ['084000', '084FFF', 'TD'],
  ['088000', '088FFF', 'TG'], ['08A000', '08AFFF', 'UG'], ['08C000', '08CFFF', 'BF'],
  ['090000', '090FFF', 'CD'], ['094000', '0943FF', 'AO'], ['096000', '0963FF', 'BJ'],
  ['098000', '0983FF', 'CV'], ['09A000', '09A3FF', 'DJ'], ['09C000', '09CFFF', 'GM'],
  ['09E000', '09E3FF', 'BF'], ['0A0000', '0A7FFF', 'DZ'], ['0A8000', '0A8FFF', 'BS'],
  ['0AA000', '0AA3FF', 'BB'], ['0AB000', '0AB3FF', 'BZ'], ['0AC000', '0ACFFF', 'CO'],
  ['0AE000', '0AEFFF', 'CR'], ['0B0000', '0B0FFF', 'CU'], ['0B2000', '0B2FFF', 'SV'],
  ['0B4000', '0B4FFF', 'GT'], ['0B6000', '0B6FFF', 'GY'], ['0B8000', '0B8FFF', 'HT'],
  ['0BA000', '0BAFFF', 'HN'], ['0BC000', '0BC3FF', 'VC'], ['0BE000', '0BEFFF', 'JM'],
  ['0C0000', '0C0FFF', 'NI'], ['0C2000', '0C2FFF', 'PA'], ['0C4000', '0C4FFF', 'DO'],
  ['0C6000', '0C6FFF', 'TT'], ['0C8000', '0C8FFF', 'SR'], ['0CA000', '0CA3FF', 'AG'],
  ['0CC000', '0CC3FF', 'GD'], ['0D0000', '0D7FFF', 'MX'], ['0D8000', '0DFFFF', 'VE'],
  ['100000', '1FFFFF', 'RU'],
  ['201000', '2013FF', 'NA'], ['202000', '2023FF', 'ER'],
  ['300000', '33FFFF', 'IT'], ['340000', '37FFFF', 'ES'], ['380000', '3BFFFF', 'FR'],
  ['3C0000', '3FFFFF', 'DE'],
  ['400000', '43FFFF', 'GB'], ['440000', '447FFF', 'AT'], ['448000', '44FFFF', 'BE'],
  ['450000', '457FFF', 'BG'], ['458000', '45FFFF', 'DK'], ['460000', '467FFF', 'FI'],
  ['468000', '46FFFF', 'GR'], ['470000', '477FFF', 'HU'], ['478000', '47FFFF', 'NO'],
  ['480000', '487FFF', 'NL'], ['488000', '48FFFF', 'PL'], ['490000', '497FFF', 'PT'],
  ['498000', '49FFFF', 'CZ'], ['4A0000', '4A7FFF', 'RO'], ['4A8000', '4AFFFF', 'SE'],
  ['4B0000', '4B7FFF', 'CH'], ['4B8000', '4BFFFF', 'TR'], ['4C0000', '4C7FFF', 'RS'],
  ['4C8000', '4C83FF', 'CY'], ['4CA000', '4CAFFF', 'IE'], ['4CC000', '4CCFFF', 'IS'],
  ['4D0000', '4D03FF', 'LU'], ['4D2000', '4D23FF', 'MT'], ['4D4000', '4D43FF', 'MC'],
  ['500000', '5003FF', 'SM'], ['501000', '5013FF', 'AL'], ['501C00', '501FFF', 'HR'],
  ['502C00', '502FFF', 'LV'], ['503C00', '503FFF', 'LT'], ['504C00', '504FFF', 'MD'],
  ['505C00', '505FFF', 'SK'], ['506C00', '506FFF', 'SI'], ['507C00', '507FFF', 'UZ'],
  ['508000', '50FFFF', 'UA'], ['510000', '5103FF', 'BY'], ['511000', '5113FF', 'EE'],
  ['512000', '5123FF', 'MK'], ['513000', '5133FF', 'BA'], ['514000', '5143FF', 'GE'],
  ['515000', '5153FF', 'TJ'], ['516000', '5163FF', 'ME'],
  ['600000', '6003FF', 'AM'], ['600800', '600BFF', 'AZ'], ['601000', '6013FF', 'KG'],
  ['601800', '601BFF', 'TM'], ['680000', '6803FF', 'BT'], ['681000', '6813FF', 'FM'],
  ['682000', '6823FF', 'MN'], ['683000', '6833FF', 'KZ'], ['684000', '6843FF', 'PW'],
  ['700000', '700FFF', 'AF'], ['702000', '702FFF', 'BD'], ['704000', '704FFF', 'MM'],
  ['706000', '706FFF', 'KW'], ['708000', '708FFF', 'LA'], ['70A000', '70AFFF', 'NP'],
  ['70C000', '70C3FF', 'OM'], ['70E000', '70EFFF', 'KH'], ['710000', '717FFF', 'SA'],
  ['718000', '71FFFF', 'KR'], ['720000', '727FFF', 'KP'], ['728000', '72FFFF', 'IQ'],
  ['730000', '737FFF', 'IR'], ['738000', '73FFFF', 'IL'], ['740000', '747FFF', 'JO'],
  ['748000', '74FFFF', 'LB'], ['750000', '757FFF', 'MY'], ['758000', '75FFFF', 'PH'],
  ['760000', '767FFF', 'PK'], ['768000', '76FFFF', 'SG'], ['770000', '777FFF', 'LK'],
  ['778000', '77FFFF', 'SY'], ['780000', '7BFFFF', 'CN'], ['7C0000', '7FFFFF', 'AU'],
  ['800000', '83FFFF', 'IN'], ['840000', '87FFFF', 'JP'], ['880000', '887FFF', 'TH'],
  ['888000', '88FFFF', 'VN'], ['890000', '890FFF', 'YE'], ['894000', '894FFF', 'BH'],
  ['895000', '8953FF', 'BN'], ['896000', '896FFF', 'AE'], ['897000', '8973FF', 'SB'],
  ['898000', '898FFF', 'PG'], ['899000', '8993FF', 'TW'], ['8A0000', '8A7FFF', 'ID'],
  ['900000', '9003FF', 'MH'], ['901000', '9013FF', 'CK'], ['902000', '9023FF', 'WS'],
  ['A00000', 'AFFFFF', 'US'],
  ['C00000', 'C3FFFF', 'CA'], ['C80000', 'C87FFF', 'NZ'], ['C88000', 'C88FFF', 'FJ'],
  ['C8A000', 'C8A3FF', 'NR'], ['C8C000', 'C8C3FF', 'LK'], ['C8D000', 'C8D3FF', 'CK'],
  ['C8E000', 'C8E3FF', 'TO'], ['C90000', 'C903FF', 'KI'], ['C91000', 'C913FF', 'VU'],
  ['E00000', 'E3FFFF', 'AR'], ['E40000', 'E7FFFF', 'BR'], ['E80000', 'E80FFF', 'CL'],
  ['E84000', 'E84FFF', 'EC'], ['E88000', 'E88FFF', 'PY'], ['E8C000', 'E8CFFF', 'PE'],
  ['E90000', 'E90FFF', 'UY'], ['E94000', 'E94FFF', 'BO']
].map(([a, b, c]) => [parseInt(a, 16), parseInt(b, 16), c]).sort((x, y) => x[0] - y[0]);

const cache = new Map(); // hex -> iso2 | null

export function icaoToCountry(hex) {
  hex = (hex || '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  if (cache.has(hex)) return cache.get(hex);
  const n = parseInt(hex, 16);
  // binary search over sorted ranges
  let lo = 0, hi = RANGES.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end, iso] = RANGES[mid];
    if (n < start) hi = mid - 1;
    else if (n > end) lo = mid + 1;
    else { found = iso; break; }
  }
  if (cache.size > 20000) cache.clear();
  cache.set(hex, found);
  return found;
}
