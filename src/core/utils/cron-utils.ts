import cronParser from "cron-parser";

/**
 * Normalize a cron expression to 6-field format (with seconds).
 * If the expression has 5 fields, prepend "0 " for seconds.
 * If it already has 6 fields, return as-is.
 */
export function normalizeCronExpression(schedule: string): string {
  const trimmed = schedule.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    return `0 ${trimmed}`;
  }
  return trimmed;
}

/**
 * Validate a cron expression.
 * Returns true if valid, false otherwise.
 * Supports both 5-field (standard cron) and 6-field (with seconds) formats.
 */
export function isValidCronExpression(cron: string): boolean {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) {
      return false;
    }

    const normalized = normalizeCronExpression(cron);
    cronParser.parse(normalized);
    return true;
  } catch {
    return false;
  }
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Format hour and minute as a short time string (e.g. "8:00 AM", "12:30 PM").
 */
function formatTime(hour: number, minute: number): string {
  if (hour === 0 && minute === 0) return "midnight";
  if (hour === 12 && minute === 0) return "12:00 PM";
  const period = hour < 12 ? "AM" : "PM";
  const h = hour % 12 || 12;
  const m = minute === 0 ? "" : `:${minute.toString().padStart(2, "0")}`;
  return `${h}${m} ${period}`;
}

/**
 * Return a human-readable description of a 5-field cron schedule, or null if not describable.
 * Used when listing workflows so users see "Daily at 8:00 AM" instead of "0 8 * * *".
 *
 * Unsupported (raw cron is shown): Minute: ranges, lists, step with offset (only step from 0 or from * supported).
 * Hour: ranges, lists (only * or N or every-N-hours supported). Day-of-month: ranges, lists, steps (only * or single N).
 * Month: any non-wildcard. Day-of-week: step, named days (only * ? digit range list supported).
 * Combinations like every-N-min every-M-hours or multiple times per day are not described.
 */
export function describeCronSchedule(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minStr = parts[0] ?? "";
  const hourStr = parts[1] ?? "";
  const domStr = parts[2] ?? "";
  const monthStr = parts[3] ?? "";
  const dowStr = parts[4] ?? "";

  // Only describe simple crons: integers or * or step like */15, and ranges like 1-5
  const toNum = (s: string): number | null => {
    const n = parseInt(s, 10);
    return s === "*" || s === "?" ? null : Number.isNaN(n) ? null : n;
  };

  const minute = toNum(minStr);
  const hour = toNum(hourStr);
  const dom = toNum(domStr);

  // Minute step: */15 or 0/15 → every 15 minutes
  let minuteStepRaw: string | null = null;
  if (minStr.startsWith("*/") && minStr.length > 2) {
    minuteStepRaw = minStr.slice(2);
  } else if (minStr.startsWith("0/") && minStr.length > 2) {
    minuteStepRaw = minStr.slice(2);
  }
  const minuteStep =
    minuteStepRaw !== null ? parseInt(minuteStepRaw, 10) : null;
  const minuteStepValid =
    minuteStep !== null &&
    !Number.isNaN(minuteStep) &&
    minuteStep >= 1 &&
    minuteStep <= 59;

  // Hour step: */2 → every 2 hours
  const hourStep =
    hourStr.length > 2 && hourStr.startsWith("*/")
      ? parseInt(hourStr.slice(2), 10)
      : null;
  const hourStepValid =
    hourStep !== null && Number.isInteger(hourStep) && hourStep >= 1 && hourStep <= 23;

  // Day-of-week: single day, range (1-5), or list (1,3,5)
  let dowLabel: string | null = null;
  let dowIsList = false;
  if (dowStr === "*" || dowStr === "?") {
    dowLabel = null;
  } else if (/^\d$/.test(dowStr)) {
    const d = parseInt(dowStr, 10);
    dowLabel = DAY_NAMES[d % 7] ?? null;
  } else if (/^[0-6]-[0-6]$/.test(dowStr)) {
    const rangeParts = dowStr.split("-").map((x) => parseInt(x, 10));
    const a = rangeParts[0];
    const b = rangeParts[1];
    if (a !== undefined && b !== undefined) {
      if (a === 1 && b === 5) dowLabel = "weekdays";
      else if (a === 0 && b === 6) dowLabel = "every day";
      else dowLabel = `${DAY_NAMES[a % 7]}-${DAY_NAMES[b % 7]}`;
    }
  } else if (/^(\d,)*\d$/.test(dowStr)) {
    const list = dowStr.split(",").map((x) => parseInt(x.trim(), 10));
    if (list.length > 0 && list.every((n) => n >= 0 && n <= 6)) {
      dowLabel = list.map((d) => DAY_NAMES_SHORT[d % 7]).join(", ");
      dowIsList = true;
    }
  }

  // Every minute
  if (minStr === "*" && hourStr === "*" && domStr === "*" && monthStr === "*" && (dowStr === "*" || dowStr === "?")) {
    return "Every minute";
  }

  // Every N minutes on specific day(s): */15 * * * 5 → "Every 15 minutes on Fridays"
  if (
    minuteStepValid &&
    dowLabel &&
    hourStr === "*" &&
    domStr === "*" &&
    monthStr === "*"
  ) {
    let onDay: string;
    if (dowLabel === "weekdays") {
      onDay = " on weekdays";
    } else if (dowLabel === "every day") {
      onDay = "";
    } else if (dowIsList) {
      onDay = ` on ${dowLabel}`;
    } else {
      onDay = ` on ${dowLabel}s`;
    }
    return minuteStep === 1
      ? `Every minute${onDay}`
      : `Every ${minuteStep} minutes${onDay}`;
  }

  // Every N minutes (all days)
  if (minuteStepValid && hourStr === "*" && domStr === "*" && monthStr === "*" && (dowStr === "*" || dowStr === "?")) {
    return minuteStep === 1 ? "Every minute" : `Every ${minuteStep} minutes`;
  }

  // Every N hours: 0 */2 * * *
  if (
    minute === 0 &&
    hourStepValid &&
    domStr === "*" &&
    monthStr === "*" &&
    (dowStr === "*" || dowStr === "?")
  ) {
    return hourStep === 1 ? "Every hour" : `Every ${hourStep} hours`;
  }

  // Every hour (at minute 0)
  if (minute === 0 && hourStr === "*" && domStr === "*" && monthStr === "*" && (dowStr === "*" || dowStr === "?")) {
    return "Every hour";
  }

  // Daily at HH:MM
  if (domStr === "*" && monthStr === "*" && (dowStr === "*" || dowStr === "?")) {
    if (hour !== null && minute !== null) {
      const time = formatTime(hour, minute);
      return `Daily at ${time}`;
    }
  }

  // Weekly: e.g. 0 9 * * 1 → Mondays at 9 AM; 0 9 * * 1,3,5 → Mon, Wed, Fri at 9 AM
  if (dowLabel && domStr === "*" && monthStr === "*" && hour !== null && minute !== null) {
    const time = formatTime(hour, minute);
    if (dowLabel === "weekdays") return `Weekdays at ${time}`;
    if (dowLabel === "every day") return `Daily at ${time}`;
    return dowIsList ? `${dowLabel} at ${time}` : `${dowLabel}s at ${time}`;
  }

  // Monthly on day N: 0 0 1 * *
  if (dom !== null && monthStr === "*" && (dowStr === "*" || dowStr === "?")) {
    if (hour !== null && minute !== null) {
      const time = formatTime(hour, minute);
      const ord =
        dom === 1 ? "1st" : dom === 2 ? "2nd" : dom === 3 ? "3rd" : `${dom}th`;
      return `Monthly on the ${ord} at ${time}`;
    }
  }

  return null;
}
