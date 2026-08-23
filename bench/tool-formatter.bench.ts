// Tool results are the largest strings in the system (file reads, greps,
// diffs); formatting runs once per tool call, at peak byte volume.
import chalk from "chalk";
import { bench, report } from "./harness";
import { formatToolResult } from "../src/core/utils/tool-formatter";

chalk.level = 3;

function fileReadResult(approximateBytes: number): string {
  let content = "";
  let lineNumber = 0;
  while (content.length < approximateBytes) {
    lineNumber += 1;
    content += `${String(lineNumber)}\tconst value${String(lineNumber)} = compute(${String(lineNumber)});\n`;
  }
  return content;
}

const smallResult = fileReadResult(1_000);
const mediumResult = fileReadResult(100_000);
const largeResult = fileReadResult(1_000_000);

const results = [
  bench("formatToolResult 1KB", () => {
    formatToolResult("read_file", smallResult);
  }),
  bench(
    "formatToolResult 100KB",
    () => {
      formatToolResult("read_file", mediumResult);
    },
    { iterations: 60 },
  ),
  bench(
    "formatToolResult 1MB",
    () => {
      formatToolResult("read_file", largeResult);
    },
    { iterations: 10, warmupIterations: 2 },
  ),
];

report("tool-formatter", results);
