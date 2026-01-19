#!/usr/bin/env node
/* eslint-disable no-control-regex */
// Run with: node src/cli/ui/debug-parser.mjs
// Then press Option+Left, Option+Right to see how parseInput handles them

import { parseInput } from "../src/cli/ui/escape-sequence-parser.js";

const mockKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

console.log("Press keys to see how parseInput handles them. Ctrl+C to exit.\n");

let escapeBuffer = "";

process.stdin.on("data", (input) => {
  if (input === "\x03") {
    // Ctrl+C
    process.exit();
  }

  const hex = [...input].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
  console.log(`\n--- Input ---`);
  console.log(`Raw: "${input.replace(/\x1b/g, "ESC")}"`);
  console.log(`Hex: ${hex}`);
  console.log(`Buffer before: "${escapeBuffer.replace(/\x1b/g, "ESC")}"`);

  const result = parseInput(input, mockKey, escapeBuffer);
  escapeBuffer = result.newBuffer;

  console.log(`Result: ${result.parsed.type}`);
  console.log(`Buffer after: "${escapeBuffer.replace(/\x1b/g, "ESC")}"`);
});
