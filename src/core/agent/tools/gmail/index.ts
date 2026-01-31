/**
 * Gmail Tools Module
 *
 * Provides organized access to Gmail operations through a unified namespace.
 * Tools are organized by operation type:
 * - Read operations: Safe, read-only Gmail commands
 * - Write operations: Approval-required destructive commands (return ApprovalToolPair)
 */

// Re-export from individual tool modules
import { createAddLabelsToEmailTool } from "./addLabels";
import { createBatchModifyEmailsTool } from "./batchModify";
import { createCreateLabelTool } from "./createLabel";
import { createDeleteEmailTools } from "./deleteEmail";
import { createDeleteLabelTools } from "./deleteLabel";
import { createGetEmailTool } from "./getEmail";
import { createListEmailsTool } from "./listEmails";
import { createListLabelsTool } from "./listLabels";
import { createRemoveLabelsFromEmailTool } from "./removeLabels";
import { createSearchEmailsTool } from "./searchEmails";
import { createSendEmailTool } from "./sendEmail";
import { createTrashEmailTools } from "./trashEmail";
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
 * // Create write tools (return { approval, execute } pair)
 * const trashTools = gmail.trashEmail();
 * const deleteTools = gmail.deleteEmail();
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

  // === Write Operations (approval required - return ApprovalToolPair) ===

  /** Move email to trash (returns { approval, execute }) */
  trashEmail: createTrashEmailTools,

  /** Permanently delete an email (returns { approval, execute }) */
  deleteEmail: createDeleteEmailTools,

  /** Delete a label (returns { approval, execute }) */
  deleteLabel: createDeleteLabelTools,
} as const;

// Export individual tool creators
export {
  createAddLabelsToEmailTool,
  createBatchModifyEmailsTool,
  createCreateLabelTool,
  createDeleteEmailTools,
  createDeleteLabelTools,
  createGetEmailTool,
  createListEmailsTool,
  createListLabelsTool,
  createRemoveLabelsFromEmailTool,
  createSearchEmailsTool,
  createSendEmailTool,
  createTrashEmailTools,
  createUpdateLabelTool,
};
