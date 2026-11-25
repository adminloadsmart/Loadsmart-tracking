// Indian vehicle registration numbers, as VAHAN stores them (same rule as the portal's
// Create trip form).
//   State series: state/UT code + RTO (1–2 digits) + series (0–3 letters) + number (4 digits),
//                 e.g. PB65RF6106, DL1CAB1234, HR84A4138.
//   BH series:    year (2 digits) + "BH" + number (4 digits) + 1–2 letters, e.g. 22BH1234AA.

/** State and union-territory codes in use (old OR / UA plates included). */
const STATE_CODES = new Set([
  'AN',
  'AP',
  'AR',
  'AS',
  'BR',
  'CG',
  'CH',
  'DD',
  'DL',
  'DN',
  'GA',
  'GJ',
  'HP',
  'HR',
  'JH',
  'JK',
  'KA',
  'KL',
  'LA',
  'LD',
  'MH',
  'ML',
  'MN',
  'MP',
  'MZ',
  'NL',
  'OD',
  'OR',
  'PB',
  'PY',
  'RJ',
  'SK',
  'TG',
  'TN',
  'TR',
  'TS',
  'UA',
  'UK',
  'UP',
  'WB',
]);

const STATE_SERIES_RE = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/;
const BH_SERIES_RE = /^\d{2}BH\d{4}[A-Z]{1,2}$/;

/** Whether an already normalised number (upper case, no spaces or dashes) is a registration. */
export function isValidVehicleNumber(number: string): boolean {
  if (BH_SERIES_RE.test(number)) return true;
  const match = STATE_SERIES_RE.exec(number);
  return !!match && STATE_CODES.has(match[1]) && Number(match[2]) > 0;
}
