/**
 * Filesystem Tools Module
 *
 * Provides organized access to filesystem operations through a unified namespace.
 * Tools are organized by operation type:
 * - Navigation: pwd, cd, ls, stat
 * - Read: readFile, readPdf
 * - Search: grep, find
 * - Write: writeFile, editFile, mkdir, rm, mv, cp (approval required)
 *
 * Search tools have clear, non-overlapping purposes:
 * - **find**: Locate files/directories by name, glob, or path pattern.
 * - **grep**: Search inside file contents for text or regex patterns.
 *
 * Write tools use defineApprovalTool to create approval + execution pairs.
 */

import { createCdTool } from "./cd";
import { createCpTools } from "./cp";
import { createEditFileTools } from "./edit";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createMkdirTools } from "./mkdir";
import { createMvTools } from "./mv";
import { createPdfPageCountTool } from "./pdfPageCount";
import { createPwdTool } from "./pwd";
import { createReadFileTool } from "./read";
import { createReadPdfTool } from "./readPdf";
import { createRmTools } from "./rm";
import { createStatTool } from "./stat";
import { createWriteFileTools } from "./write";

const writeFileTools = createWriteFileTools();
const editFileTools = createEditFileTools();
const mkdirTools = createMkdirTools();
const rmTools = createRmTools();
const mvTools = createMvTools();
const cpTools = createCpTools();

export const fs = {
  pwd: createPwdTool,
  cd: createCdTool,
  ls: createLsTool,
  stat: createStatTool,
  read: createReadFileTool,
  readPdf: createReadPdfTool,
  pdfPageCount: createPdfPageCountTool,
  grep: createGrepTool,
  find: createFindTool,
  write: () => writeFileTools,
  edit: () => editFileTools,
  mkdir: () => mkdirTools,
  rm: () => rmTools,
  mv: () => mvTools,
  cp: () => cpTools,
} as const;

export {
  createCdTool,
  createCpTools,
  createEditFileTools,
  createFindTool,
  createGrepTool,
  createLsTool,
  createMkdirTools,
  createMvTools,
  createPwdTool,
  createReadFileTool,
  createReadPdfTool,
  createPdfPageCountTool,
  createRmTools,
  createStatTool,
  createWriteFileTools,
};
