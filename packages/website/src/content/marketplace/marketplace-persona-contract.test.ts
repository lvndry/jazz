/**
 * Validates that every website-owned marketplace persona follows the runtime's
 * placeholder and frontmatter contract before the site publishes it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const MARKETPLACE_DIR = dirname(fileURLToPath(import.meta.url));
const KNOWN_PLACEHOLDERS = new Set(["{agentName}", "{agentDescription}", "{environment}"]);

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("marketplace persona contract", () => {
  const personaNames = readdirSync(MARKETPLACE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  test("personas directory is discoverable", () => {
    expect(personaNames.length).toBeGreaterThan(0);
  });

  for (const persona of personaNames) {
    const content = readFileSync(join(MARKETPLACE_DIR, persona, "PERSONA.md"), "utf-8");

    test(`${persona}: each placeholder appears at most once`, () => {
      for (const placeholder of KNOWN_PLACEHOLDERS) {
        const occurrences = countOccurrences(content, placeholder);
        expect(
          occurrences,
          `${placeholder} appears ${occurrences} times in ${persona}/PERSONA.md — .replace substitutes only the first`,
        ).toBeLessThanOrEqual(1);
      }
    });

    test(`${persona}: no unknown placeholder-like tokens`, () => {
      const candidates = content.match(/\{[a-zA-Z]+\}/g) ?? [];
      for (const candidate of candidates) {
        expect(
          KNOWN_PLACEHOLDERS.has(candidate),
          `unknown placeholder ${candidate} in ${persona}`,
        ).toBe(true);
      }
    });

    test(`${persona}: frontmatter has name and description`, () => {
      expect(content.startsWith("---\n")).toBe(true);
      const frontmatter = content.slice(4, content.indexOf("\n---", 4));
      expect(frontmatter).toContain(`name: ${persona}`);
      expect(frontmatter).toContain("description:");
    });
  }
});
