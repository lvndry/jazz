/**
 * Calendar Tools Module
 *
 * Provides organized access to Google Calendar operations through a unified namespace.
 * Tools are organized by operation type:
 * - Read operations: Safe, read-only calendar commands
 * - Write operations: Approval-required destructive commands (return ApprovalToolPair)
 */

// Re-export from individual tool modules
import { createCalendarEventTools } from "./createEvent";
import { createDeleteCalendarEventTools } from "./deleteEvent";
import { createGetCalendarEventTool } from "./getEvent";
import { createGetUpcomingEventsTool } from "./getUpcoming";
import { createListCalendarsTool } from "./listCalendars";
import { createListCalendarEventsTool } from "./listEvents";
import { createQuickAddCalendarEventTools } from "./quickAdd";
import { createSearchCalendarEventsTool } from "./searchEvents";
import { createUpdateCalendarEventTools } from "./updateEvent";

/**
 * Calendar tools namespace
 *
 * Usage:
 * ```typescript
 * import { calendar } from "./calendar";
 *
 * // Create read-only tools
 * const listTool = calendar.listEvents();
 * const getTool = calendar.getEvent();
 *
 * // Create write tools (return { approval, execute } pair)
 * const createTools = calendar.createEvent();
 * const updateTools = calendar.updateEvent();
 * ```
 */
export const calendar = {
  // === Read Operations (safe - no approval needed) ===

  /** List events from a calendar */
  listEvents: createListCalendarEventsTool,

  /** Get a specific event by ID */
  getEvent: createGetCalendarEventTool,

  /** Search for events using text query */
  searchEvents: createSearchCalendarEventsTool,

  /** List all accessible calendars */
  listCalendars: createListCalendarsTool,

  /** Get upcoming events starting from now */
  getUpcoming: createGetUpcomingEventsTool,

  // === Write Operations (approval required - return ApprovalToolPair) ===

  /** Create a new calendar event (returns { approval, execute }) */
  createEvent: createCalendarEventTools,

  /** Update an existing calendar event (returns { approval, execute }) */
  updateEvent: createUpdateCalendarEventTools,

  /** Delete a calendar event (returns { approval, execute }) */
  deleteEvent: createDeleteCalendarEventTools,

  /** Quick add event from natural language (returns { approval, execute }) */
  quickAdd: createQuickAddCalendarEventTools,
} as const;

// Export individual tool creators
export {
  createCalendarEventTools,
  createDeleteCalendarEventTools,
  createGetCalendarEventTool,
  createGetUpcomingEventsTool,
  createListCalendarsTool,
  createListCalendarEventsTool,
  createQuickAddCalendarEventTools,
  createSearchCalendarEventsTool,
  createUpdateCalendarEventTools,
};
