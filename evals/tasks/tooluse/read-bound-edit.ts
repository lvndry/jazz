/**
 * End-to-end task for the read_file snapshot → edit_file contract. Similar blocks make
 * an ungrounded line edit visibly wrong, while the tool-call check keeps the task
 * about the built-in edit protocol rather than a shell rewrite of the whole file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask } from "../../types";

const original = [
  "export function totalInvoice(lines: number[]) {",
  "  return lines.reduce((sum, value) => sum + value, 0);",
  "}",
  "",
  "export function totalRefund(lines: number[]) {",
  "  return lines.reduce((sum, value) => sum + value, 0);",
  "}",
  "",
].join("\n");

const expected = original.replace(
  "export function totalRefund(lines: number[]) {\n  return lines.reduce((sum, value) => sum + value, 0);",
  "export function totalRefund(lines: number[]) {\n  return lines.reduce((sum, value) => sum - value, 0);",
);

export const tasks: EvalTask[] = [
  {
    id: "tooluse-read-bound-edit",
    domain: "tooluse",
    baseDifficulty: "medium",
    prompt:
      "In totals.ts, fix totalRefund so it subtracts each refund amount from the initial zero. Keep totalInvoice and every other line unchanged. Read the file and use edit_file for the change.",
    setup(workspaceDir) {
      writeFileSync(join(workspaceDir, "totals.ts"), original);
    },
    check(result, workspaceDir) {
      const actual = readFileSync(join(workspaceDir, "totals.ts"), "utf8");
      const usedRead = result.toolCalls.some((call) => call.name === "read_file");
      const usedEdit = result.toolCalls.some((call) => call.name === "edit_file");
      const pass = actual === expected && usedRead && usedEdit;
      return {
        pass,
        score: pass ? 1 : 0,
        detail: `file exact=${actual === expected}, read_file=${usedRead}, edit_file=${usedEdit}`,
      };
    },
  },
];
