#!/usr/bin/env node
// Run with: node src/cli/ui/debug-keys.mjs
// Then press Option+Left, Option+Right, etc. to see what sequences are sent
// Press Ctrl+C to exit

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

console.log("Press keys to see their escape sequences. Ctrl+C to exit.\n");

process.stdin.on("data", (key) => {
  if (key === "\x03") {
    // Ctrl+C
    process.exit();
  }

  const hex = [...key].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
  const escaped = key.replace(/\x1b/g, "ESC").replace(/\r/g, "\\r").replace(/\n/g, "\\n");

  console.log(`Key: "${escaped}"`);
  console.log(`Hex: ${hex}`);
  console.log(`Length: ${key.length}`);
  console.log("---");
});
