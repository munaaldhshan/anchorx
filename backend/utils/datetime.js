// Timezone-aware date helpers. Sessions/stats store `dateStr` in the user's
// local calendar day (frontend-supplied), so any server-side computation that
// derives an hour-of-day or a "today" boundary must use the user's IANA
// timezone rather than the server's. See User.settings.timezone.

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** True if `tz` is an IANA zone Intl can resolve. */
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Break a Date into local-time pieces for the given IANA timezone.
 * Returns { year, month, day, hour (0-23), minute, weekday (0=Sun), dateStr }.
 * Falls back to UTC for an unknown timezone.
 */
export function toUserDate(date, tz = 'UTC') {
  const zone = isValidTimezone(tz) ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12:   false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(date);

  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;   // some engines emit '24' for midnight

  return {
    year:    Number(get('year')),
    month:   Number(get('month')),
    day:     Number(get('day')),
    hour,
    minute:  Number(get('minute')),
    weekday: WEEKDAY[get('weekday')] ?? 0,
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Current calendar date (YYYY-MM-DD) in the user's timezone. */
export function userTodayStr(tz = 'UTC') {
  return toUserDate(new Date(), tz).dateStr;
}

/** Shift a YYYY-MM-DD string by n days (negative = backward). Pure UTC math, DST-safe. */
export function shiftDateStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Whole-day difference toStr - fromStr (both YYYY-MM-DD). */
export function diffDays(fromStr, toStr) {
  const a = Date.parse(`${fromStr}T00:00:00Z`);
  const b = Date.parse(`${toStr}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Day-of-week (0=Sun) for a YYYY-MM-DD string, independent of server tz. */
export function weekdayOfDateStr(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

// ─── Day bucketing (the single place "which local day?" is decided) ─────────
// Storage rule: every instant is a UTC Date. A *day* is always a user-local
// calendar date (YYYY-MM-DD) derived from an instant + an IANA zone, here.
// Never use Date#getHours / getDay / setHours on the server: they read the
// server's own zone (UTC on Render), not the user's.

/**
 * The timezone to bucket by. Accepts an IANA string or a user doc
 * ({ settings: { timezone } }); anything unusable resolves to 'UTC'.
 */
export function resolveTimezone(tzOrUser) {
  const tz = typeof tzOrUser === 'string' ? tzOrUser : tzOrUser?.settings?.timezone;
  return isValidTimezone(tz) ? tz : 'UTC';
}

/** Local calendar day (YYYY-MM-DD) an instant falls on in `tz`. */
export function localDayOf(date, tz = 'UTC') {
  return toUserDate(date, tz).dateStr;
}

/** Local hour-of-day (0-23) of an instant in `tz`. */
export function localHourOf(date, tz = 'UTC') {
  return toUserDate(date, tz).hour;
}

/** Local weekday (0=Sun..6=Sat) of an instant in `tz`. */
export function localWeekdayOf(date, tz = 'UTC') {
  return toUserDate(date, tz).weekday;
}

/** Local "HH:MM" of an instant in `tz` (display layer). */
export function formatLocalHHMM(date, tz = 'UTC') {
  const p = toUserDate(date, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

// Offset (ms) of `tz` from UTC at `instantMs`: local wall clock read as if it
// were UTC, minus the instant itself. +3h for Istanbul, −4h for New York (EDT).
function tzOffsetMs(instantMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get('hour') === 24 ? 0 : get('hour');
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * UTC instant at which local day `dateStr` begins in `tz` (DST-aware). For the
 * rare zones whose clocks skip midnight, returns the first instant that is on
 * `dateStr`.
 */
export function localDayStartUtc(dateStr, tz = 'UTC') {
  const zone = resolveTimezone(tz);
  const [y, m, d] = dateStr.split('-').map(Number);
  const wallMidnight = Date.UTC(y, m - 1, d);
  // Two passes: the offset at the first guess may differ from the offset at
  // the true instant when a DST transition sits between them.
  let t = wallMidnight - tzOffsetMs(wallMidnight, zone);
  t = wallMidnight - tzOffsetMs(t, zone);
  // Midnight fell in a DST gap → we landed on the previous day; step forward.
  while (localDayOf(new Date(t), zone) < dateStr) t += 3_600_000;
  return new Date(t);
}

/** [start, end) UTC instants covering local day `dateStr` in `tz`. */
export function localDayRangeUtc(dateStr, tz = 'UTC') {
  return {
    start: localDayStartUtc(dateStr, tz),
    end:   localDayStartUtc(shiftDateStr(dateStr, 1), tz),
  };
}
