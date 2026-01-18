import type { CalendarEvent, CalendarInfo } from "../../../types/calendar";

/**
 * Calendar tools shared utilities
 */

/**
 * Helper function to format date/time for display
 */
export function formatDateTime(dt: { dateTime?: string; date?: string; timeZone?: string }): string {
  if (dt.dateTime) {
    const date = new Date(dt.dateTime);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()} ${dt.timeZone ? `(${dt.timeZone})` : ""}`;
  }
  if (dt.date) {
    return `${dt.date} (All-day)`;
  }
  return "No time specified";
}

/**
 * Format event for display
 */
export function formatEventForDisplay(event: CalendarEvent): string {
  const parts = [
    `📅 ${event.summary}`,
    `   ID: ${event.id}`,
    `   ⏰ Start: ${formatDateTime(event.start)}`,
    `   ⏰ End: ${formatDateTime(event.end)}`,
  ];

  if (event.description) parts.push(`   📝 ${event.description}`);
  if (event.location) parts.push(`   📍 ${event.location}`);
  if (event.attendees && event.attendees.length > 0) {
    parts.push(`   👥 Attendees (${event.attendees.length}):`);
    event.attendees.slice(0, 5).forEach((a) => {
      const status = a.responseStatus ? ` [${a.responseStatus}]` : "";
      parts.push(`      - ${a.displayName || a.email}${status}`);
    });
    if (event.attendees.length > 5) {
      parts.push(`      ... and ${event.attendees.length - 5} more`);
    }
  }
  if (event.status) parts.push(`   Status: ${event.status}`);
  if (event.htmlLink) parts.push(`   🔗 ${event.htmlLink}`);

  return parts.join("\\n");
}

/**
 * Format events list for display
 */
export function formatEventsForDisplay(events: CalendarEvent[]): string {
  if (events.length === 0) return "No events found";
  return events.map((e) => formatEventForDisplay(e)).join("\\n\\n");
}

/**
 * Format calendar for display
 */
export function formatCalendarForDisplay(calendar: CalendarInfo): string {
  const parts = [
    `📆 ${calendar.summary}${calendar.primary ? " (Primary)" : ""}`,
    `   ID: ${calendar.id}`,
    `   Timezone: ${calendar.timeZone}`,
  ];
  if (calendar.description) parts.push(`   Description: ${calendar.description}`);
  if (calendar.accessRole) parts.push(`   Access: ${calendar.accessRole}`);
  return parts.join("\\n");
}

/**
 * Format calendars list for display
 */
export function formatCalendarsForDisplay(calendars: CalendarInfo[]): string {
  if (calendars.length === 0) return "No calendars found";
  return calendars.map((c) => formatCalendarForDisplay(c)).join("\\n\\n");
}
