/**
 * Timezone-aware "when" spec parsing for reminders
 */

/** Offset (ms) that must be subtracted from a UTC instant to reach wall time in `tz`. */
function tzOffsetMs(epoch: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epoch));
  const field: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") field[part.type] = Number(part.value);
  }
  const asIfUtc = Date.UTC(
    field["year"] ?? 1970,
    (field["month"] ?? 1) - 1,
    field["day"] ?? 1,
    field["hour"] ?? 0,
    field["minute"] ?? 0,
    field["second"] ?? 0,
  );
  return asIfUtc - epoch;
}

/** The calendar Y/M/D that `epoch` falls on in `tz`. */
export function zonedDateParts(
  epoch: number,
  tz: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epoch));
  const field: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") field[part.type] = Number(part.value);
  }
  return { year: field["year"] ?? 1970, month: field["month"] ?? 1, day: field["day"] ?? 1 };
}

/**
 * Convert a wall-clock time in an IANA timezone to an epoch.
 *
 * Date.UTC rollover handles day values crossing month or year boundaries.
 * Invalid timezone names throw RangeError from Intl.DateTimeFormat.
 */
export function wallClockToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(firstPass, tz);
}

const WEEKDAY_NUMBERS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const DAYS_PER_WEEK = 7;

/** Day of week (0 = Sunday) that `epoch` falls on in `tz`. */
export function zonedWeekday(epoch: number, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
    .format(new Date(epoch))
    .toLowerCase();
  return WEEKDAY_NUMBERS[name] ?? 0;
}

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a "when" spec into an absolute epoch-ms, or null if unparseable.
 * Supports relative durations (30m, 2h, 1h30m, 90s, 1d), a 24h clock time
 * (HH:MM → next occurrence), "tomorrow HH:MM", a weekday and time
 * ("tue 20:00" → next occurrence of that weekday), and an absolute
 * "YYYY-MM-DD HH:MM". Clock times are interpreted in the caller's IANA `tz` so
 * "18:00" means 6pm where the sender is. An absolute date may resolve to a time
 * in the past; callers decide what to do with that.
 * Invalid timezone names throw RangeError from Intl.DateTimeFormat.
 */
export function parseWhen(spec: string, now: number, tz: string): number | null {
  const trimmed = spec.trim().toLowerCase();

  const absolute = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ]|,\s*)+(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (absolute) {
    const year = Number(absolute[1]);
    const month = Number(absolute[2]);
    const day = Number(absolute[3]);
    const hours = Number(absolute[4]);
    const minutes = Number(absolute[5]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) return null;
    return wallClockToEpoch(year, month, day, hours, minutes, tz);
  }

  const weekday = /^(?:next\s+)?([a-z]{3,9})\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  const weekdayNumber = weekday ? WEEKDAY_NUMBERS[weekday[1] ?? ""] : undefined;
  if (weekday && weekdayNumber !== undefined) {
    const hours = Number(weekday[2]);
    const minutes = Number(weekday[3]);
    if (hours > 23 || minutes > 59) return null;
    const today = zonedDateParts(now, tz);
    const daysAhead = (weekdayNumber - zonedWeekday(now, tz) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
    const fireAt = wallClockToEpoch(
      today.year,
      today.month,
      today.day + daysAhead,
      hours,
      minutes,
      tz,
    );
    if (fireAt > now) return fireAt;
    return wallClockToEpoch(
      today.year,
      today.month,
      today.day + daysAhead + DAYS_PER_WEEK,
      hours,
      minutes,
      tz,
    );
  }

  const tomorrow = /^tomorrow\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  const clock = tomorrow ?? /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    const today = zonedDateParts(now, tz);
    const dayOffset = tomorrow ? 1 : 0;
    let fireAt = wallClockToEpoch(
      today.year,
      today.month,
      today.day + dayOffset,
      hours,
      minutes,
      tz,
    );
    if (!tomorrow && fireAt <= now) {
      fireAt = wallClockToEpoch(today.year, today.month, today.day + 1, hours, minutes, tz);
    }
    return fireAt;
  }

  let totalMs = 0;
  for (const match of trimmed.matchAll(/(\d+)\s*([smhd])/g)) {
    totalMs += Number(match[1]) * (DURATION_UNIT_MS[match[2] ?? ""] ?? 0);
  }
  const leftover = trimmed.replace(/(\d+)\s*([smhd])/g, "").trim();
  if (totalMs > 0 && leftover === "") return now + totalMs;

  return null;
}
