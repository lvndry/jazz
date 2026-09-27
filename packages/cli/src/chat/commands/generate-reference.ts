/**
 * Regenerates the in-chat command and keyboard tables inside `docs/commands.md`
 * from `CHAT_COMMANDS` and the keymaps, so the page cannot drift from what
 * /help and the parser actually do. Only the regions between the marker
 * comments are rewritten; the prose around them is hand-written.
 *
 * Run with `bun run docs:chat-commands` from the repository root. Importing
 * this module rewrites the page, so nothing else imports it.
 * `reference.test.ts` fails in CI when the page is stale.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chatReferenceRegions, replaceGeneratedRegions } from "./reference";

const DOC = path.join(import.meta.dir, "../../../../../docs/commands.md");

const current = readFileSync(DOC, "utf-8");
const updated = replaceGeneratedRegions(current, chatReferenceRegions());
if (updated === current) {
  console.log("docs/commands.md is up to date.");
} else {
  writeFileSync(DOC, updated);
  console.log("Updated docs/commands.md.");
}
