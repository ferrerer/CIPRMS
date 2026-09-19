// Country lookup used ONLY for geographical resolution (map location). It is a
// separate, read-only layer: nothing here ever rewrites a partnership's stored
// `country` string — Reports and every other consumer keep seeing exactly what
// was entered (so "Philippines"/"philipines" stay distinct there, by design).
//
// A country string is recognized only when it matches a canonical name, a
// short alias that is unambiguous (e.g. "USA"), or an ISO 3166-1 alpha-2 code.
// Anything else — junk, a city typed into the country box, or a misspelling —
// is NOT resolved to a guessed country. A misspelling can at most yield a
// *suggestion* (suggestCountry) for a person to confirm; it is never applied
// automatically.
//
// Coordinates are approximate representative points (widely published
// geographic-center values, rounded to 2 decimals) used only for the
// country-level "approximate" fallback marker. A country missing from this
// table simply stays unresolved rather than being given an invented point.

// [canonical name, ISO2, lat, lng]
const COUNTRY_TABLE = [
  ['Philippines', 'PH', 12.88, 121.77],
  ['Japan', 'JP', 36.20, 138.25],
  ['South Korea', 'KR', 35.91, 127.77],
  ['North Korea', 'KP', 40.34, 127.51],
  ['China', 'CN', 35.86, 104.20],
  ['Taiwan', 'TW', 23.70, 121.00],
  ['Hong Kong', 'HK', 22.32, 114.17],
  ['Macau', 'MO', 22.20, 113.54],
  ['Vietnam', 'VN', 14.06, 108.28],
  ['Thailand', 'TH', 15.87, 100.99],
  ['Malaysia', 'MY', 4.21, 101.98],
  ['Singapore', 'SG', 1.35, 103.82],
  ['Indonesia', 'ID', -0.79, 113.92],
  ['Cambodia', 'KH', 12.57, 104.99],
  ['Laos', 'LA', 19.86, 102.50],
  ['Myanmar', 'MM', 21.91, 95.96],
  ['Brunei', 'BN', 4.54, 114.73],
  ['India', 'IN', 20.59, 78.96],
  ['Pakistan', 'PK', 30.38, 69.35],
  ['Bangladesh', 'BD', 23.68, 90.36],
  ['Sri Lanka', 'LK', 7.87, 80.77],
  ['Nepal', 'NP', 28.39, 84.12],
  ['Australia', 'AU', -25.27, 133.78],
  ['New Zealand', 'NZ', -40.90, 174.89],
  ['Fiji', 'FJ', -17.71, 178.07],
  ['Canada', 'CA', 56.13, -106.35],
  ['United States', 'US', 37.09, -95.71],
  ['Mexico', 'MX', 23.63, -102.55],
  ['Brazil', 'BR', -14.24, -51.93],
  ['Argentina', 'AR', -38.42, -63.62],
  ['Chile', 'CL', -35.68, -71.54],
  ['Colombia', 'CO', 4.57, -74.30],
  ['Peru', 'PE', -9.19, -75.02],
  ['United Kingdom', 'GB', 55.38, -3.44],
  ['Ireland', 'IE', 53.41, -8.24],
  ['Germany', 'DE', 51.17, 10.45],
  ['France', 'FR', 46.23, 2.21],
  ['Spain', 'ES', 40.46, -3.75],
  ['Portugal', 'PT', 39.40, -8.22],
  ['Italy', 'IT', 41.87, 12.57],
  ['Netherlands', 'NL', 52.13, 5.29],
  ['Belgium', 'BE', 50.50, 4.47],
  ['Switzerland', 'CH', 46.82, 8.23],
  ['Austria', 'AT', 47.52, 14.55],
  ['Sweden', 'SE', 60.13, 18.64],
  ['Norway', 'NO', 60.47, 8.47],
  ['Denmark', 'DK', 56.26, 9.50],
  ['Finland', 'FI', 61.92, 25.75],
  ['Poland', 'PL', 51.92, 19.15],
  ['Czech Republic', 'CZ', 49.82, 15.47],
  ['Greece', 'GR', 39.07, 21.82],
  ['Russia', 'RU', 61.52, 105.32],
  ['Turkey', 'TR', 38.96, 35.24],
  ['Israel', 'IL', 31.05, 34.85],
  ['Saudi Arabia', 'SA', 23.89, 45.08],
  ['United Arab Emirates', 'AE', 23.42, 53.85],
  ['Qatar', 'QA', 25.35, 51.18],
  ['Egypt', 'EG', 26.82, 30.80],
  ['South Africa', 'ZA', -30.56, 22.94],
  ['Nigeria', 'NG', 9.08, 8.68],
  ['Kenya', 'KE', -0.02, 37.91]
];

// Unambiguous alternate spellings only. "Korea" alone is deliberately absent:
// it could mean North or South Korea, and the system must not guess.
const ALIASES = {
  'usa': 'US', 'us': 'US', 'u s': 'US', 'u s a': 'US', 'united states of america': 'US',
  'uk': 'GB', 'u k': 'GB', 'great britain': 'GB', 'britain': 'GB',
  'republic of korea': 'KR', 'korea republic of': 'KR',
  'russian federation': 'RU',
  'viet nam': 'VN',
  'uae': 'AE',
  'peoples republic of china': 'CN', 'prc': 'CN',
  'czechia': 'CZ',
  'burma': 'MM',
  'turkiye': 'TR',
  'hong kong sar': 'HK'
};

function normalizeKey(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,'\u2019`"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

const BY_CODE = {};
const BY_NAME_KEY = {};
COUNTRY_TABLE.forEach(([name, code, lat, lng]) => {
  const entry = { name, code, lat, lng };
  BY_CODE[code] = entry;
  BY_NAME_KEY[normalizeKey(name)] = entry;
});

// Returns { name, code, lat, lng } for a recognized country string, else null.
function resolveCountry(raw) {
  const key = normalizeKey(raw);
  if (!key) return null;
  if (BY_NAME_KEY[key]) return BY_NAME_KEY[key];
  if (ALIASES[key]) return BY_CODE[ALIASES[key]] || null;
  // A bare 2-letter ISO code (e.g. "PH", "jp") is unambiguous.
  if (/^[a-z]{2}$/.test(key) && BY_CODE[key.toUpperCase()]) return BY_CODE[key.toUpperCase()];
  return null;
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// A "did you mean" hint for a country string that did NOT resolve. Display
// only — the caller must never apply it without a person choosing to.
function suggestCountry(raw) {
  const key = normalizeKey(raw);
  if (!key || key.length < 5 || resolveCountry(raw)) return null;
  const limit = key.length >= 8 ? 2 : 1;
  let best = null, bestDist = 99, tie = false;
  for (const [nameKey, entry] of Object.entries(BY_NAME_KEY)) {
    const d = editDistance(key, nameKey);
    if (d < bestDist) { best = entry; bestDist = d; tie = false; }
    else if (d === bestDist && best && entry.code !== best.code) tie = true;
  }
  return best && bestDist <= limit && !tie ? best.name : null;
}

module.exports = { resolveCountry, suggestCountry, normalizeKey, COUNTRY_TABLE };
