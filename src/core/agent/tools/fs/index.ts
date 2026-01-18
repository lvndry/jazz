/**
 * Filesystem Tools Module
 *
 * Provides organized access to filesystem operations through a unified namespace.
 * Tools are organized by operation type:
 * - Navigation: pwd, cd, ls, stat
 * - Read: readFile, readPdf, head, tail
 * - Search: grep, find, findPath
 * - Write: writeFile, editFile, mkdir, rm (approval required)
 */


// Re-export from individual tool modules
import { createCdTool } from "./cd";
import { createEditFileTool, createExecuteEditFileTool } from "./edit";
import { createFindTool } from "./find";
import { createFindPathTool } from "./findPath";
import { createGrepTool } from "./grep";
import { createHeadTool } from "./head";
import { createLsTool } from "./ls";
import { createExecuteMkdirTool, createMkdirTool } from "./mkdir";
import { createPwdTool } from "./pwd";
import { createReadFileTool } from "./read";
import { createReadPdfTool } from "./readPdf";
import { createExecuteRmTool, createRmTool } from "./rm";
import { createStatTool } from "./stat";
import { createTailTool } from "./tail";
import { createExecuteWriteFileTool, createWriteFileTool } from "./write";

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
 * // Create write tools (require approval)
 * const writeTool = fs.write();
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

  /** Read first N lines of a file */
  head: createHeadTool,

  /** Read last N lines of a file */
  tail: createTailTool,

  // === Search Operations (safe - no approval needed) ===

  /** Search file contents with patterns */
  grep: createGrepTool,

  /** Find files and directories */
  find: createFindTool,

  /** Find files by path pattern */
  findPath: createFindPathTool,

  // === Write Operations (approval required) ===

  /** Write content to a file */
  write: createWriteFileTool,

  /** Edit a file with structured operations */
  edit: createEditFileTool,

  /** Create a directory */
  mkdir: createMkdirTool,

  /** Remove files or directories */
  rm: createRmTool,

  // === Execute Tools (internal - called after approval) ===

  /** Execute write after approval */
  executeWrite: createExecuteWriteFileTool,

  /** Execute edit after approval */
  executeEdit: createExecuteEditFileTool,

  /** Execute mkdir after approval */
  executeMkdir: createExecuteMkdirTool,

  /** Execute rm after approval */
  executeRm: createExecuteRmTool,
} as const;

// Export individual tool creators for backwards compatibility
export {
  createCdTool,
  createEditFileTool,
  createExecuteEditFileTool,
  createExecuteMkdirTool,
  createExecuteRmTool,
  createExecuteWriteFileTool,
  createFindPathTool,
  createFindTool,
  createGrepTool,
  createHeadTool,
  createLsTool,
  createMkdirTool,
  createPwdTool,
  createReadFileTool,
  createReadPdfTool,
  createRmTool,
  createStatTool,
  createTailTool,
  createWriteFileTool
};

