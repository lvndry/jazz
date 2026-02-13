/**
 * Filesystem Tools Module
 *
 * Provides organized access to filesystem operations through a unified namespace.
 * Tools are organized by operation type:
 * - Navigation: pwd, cd, ls, stat
 * - Read: readFile, readPdf, head, tail
 * - Search: grep, find
 * - Write: writeFile, editFile, mkdir, rm (approval required)
 *
 * Search tools have clear, non-overlapping purposes:
 * - **find**: Locate files/directories by name, glob, or path pattern.
 * - **grep**: Search inside file contents for text or regex patterns.
 *
 * Write tools use defineApprovalTool to create approval + execution pairs.
 */

// Re-export from individual tool modules
import { createCdTool } from "./cd";
import { createEditFileTools } from "./edit";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createHeadTool } from "./head";
import { createLsTool } from "./ls";
import { createMkdirTools } from "./mkdir";
import { createPdfPageCountTool } from "./pdfPageCount";
import { createPwdTool } from "./pwd";
import { createReadFileTool } from "./read";
import { createReadPdfTool } from "./readPdf";
import { createRmTools } from "./rm";
import { createStatTool } from "./stat";
import { createTailTool } from "./tail";
import { createWriteFileTools } from "./write";

// Create tool pairs for approval-required operations
const writeFileTools = createWriteFileTools();
const editFileTools = createEditFileTools();
const mkdirTools = createMkdirTools();
const rmTools = createRmTools();

/**
 * Filesystem tools namespace
 *
 * Usage:
 * ```typescript
 * import { fs } from "./fs";
 *
 * // Create navigation tools
 * const pwdTool = fs.pwd();
 * const lsTool = fs.ls();
 *
 * // Create read tools
 * const readTool = fs.read();
 *
 * // Register write tools (approval + execution)
 * yield* registerTool(fs.write.approval);
 * yield* registerTool(fs.write.execute);
 * // Or use fs.write.all() to get both as an array
 * ```
 */
export const fs = {
  // === Navigation (safe - no approval needed) ===

  /** Print working directory */
  pwd: createPwdTool,

  /** Change directory */
  cd: createCdTool,

  /** List directory contents */
  ls: createLsTool,

  /** Get file/directory status and metadata */
  stat: createStatTool,

  // === Read Operations (safe - no approval needed) ===

  /** Read file contents */
  read: createReadFileTool,

  /** Read PDF file contents */
  readPdf: createReadPdfTool,

  /** Get total pages in a PDF file */
  pdfPageCount: createPdfPageCountTool,

  /** Read first N lines of a file */
  head: createHeadTool,

  /** Read last N lines of a file */
  tail: createTailTool,

  // === Search Operations (safe - no approval needed) ===

  /** Search file contents with patterns (ripgrep with grep fallback) */
  grep: createGrepTool,

  /** Find files and directories by name/glob/path (fast-glob with fd/find fallback) */
  find: createFindTool,

  // === Write Operations (approval required) ===
  // These return ApprovalToolPair with .approval, .execute, and .all()

  /** Write content to a file - returns { approval, execute, all() } */
  write: () => writeFileTools,

  /** Edit a file with structured operations - returns { approval, execute, all() } */
  edit: () => editFileTools,

  /** Create a directory - returns { approval, execute, all() } */
  mkdir: () => mkdirTools,

  /** Remove files or directories - returns { approval, execute, all() } */
  rm: () => rmTools,
} as const;

// Export tool creators for direct access
export {
  createCdTool,
  createEditFileTools,
  createFindTool,
  createGrepTool,
  createHeadTool,
  createLsTool,
  createMkdirTools,
  createPwdTool,
  createReadFileTool,
  createReadPdfTool,
  createPdfPageCountTool,
  createRmTools,
  createStatTool,
  createTailTool,
  createWriteFileTools,
};
