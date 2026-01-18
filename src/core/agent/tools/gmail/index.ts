/**
 * Gmail Tools Module
 *
 * Provides organized access to Gmail operations through a unified namespace.
 * Tools are organized by operation type:
 * - Read operations: Safe, read-only Gmail commands
 * - Write operations: Approval-required destructive commands
 */

// Re-export from individual tool modules
import { createAddLabelsToEmailTool } from "./addLabels";
import { createBatchModifyEmailsTool } from "./batchModify";
import { createCreateLabelTool } from "./createLabel";
import { createDeleteEmailTool, createExecuteDeleteEmailTool } from "./deleteEmail";
import { createDeleteLabelTool, createExecuteDeleteLabelTool } from "./deleteLabel";
import { createGetEmailTool } from "./getEmail";
import { createListEmailsTool } from "./listEmails";
import { createListLabelsTool } from "./listLabels";
import { createRemoveLabelsFromEmailTool } from "./removeLabels";
import { createSearchEmailsTool } from "./searchEmails";
import { createSendEmailTool } from "./sendEmail";
import { createTrashEmailTool, createExecuteTrashEmailTool } from "./trashEmail";
import { createUpdateLabelTool } from "./updateLabel";

/**
 * Gmail tools namespace
 *
 * Usage:
 * ```typescript
 * import { gmail } from "./gmail";
 *
 * // Create read-only tools
 * const listTool = gmail.listEmails();
 * const getTool = gmail.getEmail();
 *
 * // Create write tools (require approval)
 * const trashTool = gmail.trashEmail();
 * const deleteTool = gmail.deleteEmail();
 * ```
 */
export const gmail = {
  // === Read Operations (safe - no approval needed) ===

  /** List emails from inbox */
  listEmails: createListEmailsTool,

  /** Get a specific email by ID */
  getEmail: createGetEmailTool,

  /** Search emails using Gmail query syntax */
  searchEmails: createSearchEmailsTool,

  /** Send email (creates draft) */
  sendEmail: createSendEmailTool,

  /** List all Gmail labels */
  listLabels: createListLabelsTool,

  /** Create a new label */
  createLabel: createCreateLabelTool,

  /** Update an existing label */
  updateLabel: createUpdateLabelTool,

  /** Add labels to an email */
  addLabels: createAddLabelsToEmailTool,

  /** Remove labels from an email */
  removeLabels: createRemoveLabelsFromEmailTool,

  /** Batch modify multiple emails */
  batchModify: createBatchModifyEmailsTool,

  // === Write Operations (approval required) ===

  /** Move email to trash */
  trashEmail: createTrashEmailTool,

  /** Permanently delete an email */
  deleteEmail: createDeleteEmailTool,

  /** Delete a label */
  deleteLabel: createDeleteLabelTool,

  // === Execute Tools (internal - called after approval) ===

  /** Execute trash email after approval */
  executeTrashEmail: createExecuteTrashEmailTool,

  /** Execute delete email after approval */
  executeDeleteEmail: createExecuteDeleteEmailTool,

  /** Execute delete label after approval */
  executeDeleteLabel: createExecuteDeleteLabelTool,
} as const;

// Export individual tool creators for backwards compatibility
export {
  createAddLabelsToEmailTool,
  createBatchModifyEmailsTool,
  createCreateLabelTool,
  createDeleteEmailTool,
  createDeleteLabelTool,
  createExecuteDeleteEmailTool,
  createExecuteDeleteLabelTool,
  createExecuteTrashEmailTool,
  createGetEmailTool,
  createListEmailsTool,
  createListLabelsTool,
  createRemoveLabelsFromEmailTool,
  createSearchEmailsTool,
  createSendEmailTool,
  createTrashEmailTool,
  createUpdateLabelTool,
};
