/**
 * Wall-clock time in IANA timezone → UTC ISO string for Soul + Supabase.
 */
import { DateTime } from 'luxon';

function normalizeNaiveIso(s) {
  s = (s || '').trim();
  if (s.length === 16 && s.includes('T')) s += ':00';
  return s;
}

/**
 * @param {string} naiveIso - e.g. 2025-03-17T00:00:00 (no offset)
 * @param {string} tzName - IANA e.g. UTC, America/Chicago
 * @returns {string} e.g. 2025-03-17T05:00:00.000Z
 */
export function wallToUtcIso(naiveIso, tzName) {
  naiveIso = normalizeNaiveIso(naiveIso);
  if (!naiveIso || !naiveIso.includes('T')) {
    throw new Error('date_from / date_to must be valid local datetimes.');
  }
  let name = (tzName || 'UTC').trim() || 'UTC';
  if (name.toUpperCase() === 'GMT') name = 'UTC';
  const dt = DateTime.fromISO(naiveIso, { zone: name });
  if (!dt.isValid) throw new Error(`Unknown timezone: ${name}`);
  return dt.toUTC().toISO();
}

export function expandUtcEndInclusive(dateToZ) {
  if (!dateToZ.endsWith('Z')) return dateToZ;
  const d = DateTime.fromISO(dateToZ, { zone: 'utc' });
  if (d.hour === 23 && d.minute === 59 && d.second === 0) {
    return d.set({ second: 59, millisecond: 999 }).toISO();
  }
  return dateToZ;
}
