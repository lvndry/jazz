/**
 * Calendar Tools Module
 *
 * Provides organized access to Google Calendar operations through a unified namespace.
 * Tools are organized by operation type:
 * - Read operations: Safe, read-only calendar commands
 * - Write operations: Approval-required destructive commands
 */

// Re-export from individual tool modules
import { createCreateCalendarEventTool, createExecuteCreateCalendarEventTool } from "./createEvent";
import { createDeleteCalendarEventTool, createExecuteDeleteCalendarEventTool } from "./deleteEvent";
import { createGetCalendarEventTool } from "./getEvent";
import { createGetUpcomingEventsTool } from "./getUpcoming";
import { createListCalendarsTool } from "./listCalendars";
import { createListCalendarEventsTool } from "./listEvents";
import { createQuickAddCalendarEventTool, createExecuteQuickAddCalendarEventTool } from "./quickAdd";
import { createSearchCalendarEventsTool } from "./searchEvents";
import { createUpdateCalendarEventTool, createExecuteUpdateCalendarEventTool } from "./updateEvent";

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
 * // Create write tools (require approval)
 * const createTool = calendar.createEvent();
 * const updateTool = calendar.updateEvent();
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

  // === Write Operations (approval required) ===

  /** Create a new calendar event */
  createEvent: createCreateCalendarEventTool,

  /** Update an existing calendar event */
  updateEvent: createUpdateCalendarEventTool,

  /** Delete a calendar event */
  deleteEvent: createDeleteCalendarEventTool,

  /** Quick add event from natural language */
  quickAdd: createQuickAddCalendarEventTool,

  // === Execute Tools (internal - called after approval) ===

  /** Execute create event after approval */
  executeCreateEvent: createExecuteCreateCalendarEventTool,

  /** Execute update event after approval */
  executeUpdateEvent: createExecuteUpdateCalendarEventTool,

  /** Execute delete event after approval */
  executeDeleteEvent: createExecuteDeleteCalendarEventTool,

  /** Execute quick add after approval */
  executeQuickAdd: createExecuteQuickAddCalendarEventTool,
} as const;

// Export individual tool creators for backwards compatibility
export {
  createCreateCalendarEventTool,
  createDeleteCalendarEventTool,
  createExecuteCreateCalendarEventTool,
  createExecuteDeleteCalendarEventTool,
  createExecuteQuickAddCalendarEventTool,
  createExecuteUpdateCalendarEventTool,
  createGetCalendarEventTool,
  createGetUpcomingEventsTool,
  createListCalendarsTool,
  createListCalendarEventsTool,
  createQuickAddCalendarEventTool,
  createSearchCalendarEventsTool,
  createUpdateCalendarEventTool,
};

/**
 * Export all calendar tools as an array (for registration)
 */
export const calendarTools = [
  createListCalendarEventsTool(),
  createGetCalendarEventTool(),
  createCreateCalendarEventTool(),
  createExecuteCreateCalendarEventTool(),
  createUpdateCalendarEventTool(),
  createExecuteUpdateCalendarEventTool(),
  createDeleteCalendarEventTool(),
  createExecuteDeleteCalendarEventTool(),
  createSearchCalendarEventsTool(),
  createListCalendarsTool(),
  createQuickAddCalendarEventTool(),
  createExecuteQuickAddCalendarEventTool(),
  createGetUpcomingEventsTool(),
];
