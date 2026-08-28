import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * Persona files are substituted with String.replace (NOT replaceAll), so each
 * placeholder may appear at most once per file — a second occurrence ships to
 * the model as a literal "{placeholder}" token. This test locks that contract
 * so persona edits can't silently break substitution.
 *
 * The environment facts block is injected by the runtime from a single canonical
 * template (shared.ts ENVIRONMENT_TEMPLATE). A persona drops an `{environment}`
 * token to control where the block sits mid-prompt; it may also hand-place the
 * individual {currentDate}, {osInfo}, ... placeholders for full in-place control.
 * All are optional in a persona file. This "at most once" rule keeps substitution
 * working. See agent-prompt-environment.test.ts for the injection behavior itself.
 */

const PERSONAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../personas");

// Identity placeholders, substituted from the agent's own config.
const IDENTITY_PLACEHOLDERS = ["{agentName}", "{agentDescription}"] as const;

// A single token that expands to the entire filled environment block in place.
// It is the only environment anchor — the runtime fills it from live system
// info, so personas never hand-place individual fields like {osInfo}.
const ENVIRONMENT_TOKEN = "{environment}";

const KNOWN_PLACEHOLDERS = new Set<string>([...IDENTITY_PLACEHOLDERS, ENVIRONMENT_TOKEN]);

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

const personaNames = readdirSync(PERSONAS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("persona placeholder contract", () => {
  test("personas directory is discoverable", () => {
    expect(personaNames.length).toBeGreaterThan(0);
  });

  for (const persona of personaNames) {
    const path = join(PERSONAS_DIR, persona, "persona.md");
    const content = readFileSync(path, "utf-8");

    test(`${persona}: each placeholder appears at most once`, () => {
      for (const placeholder of KNOWN_PLACEHOLDERS) {
        const occurrences = countOccurrences(content, placeholder);
        expect(
          occurrences,
          `${placeholder} appears ${occurrences} times in personas/${persona}/persona.md — .replace substitutes only the first`,
        ).toBeLessThanOrEqual(1);
      }
    });

    test(`${persona}: no unknown placeholder-like tokens`, () => {
      const known = KNOWN_PLACEHOLDERS;
      const candidates = content.match(/\{[a-zA-Z]+\}/g) ?? [];
      for (const candidate of candidates) {
        expect(known.has(candidate), `unknown placeholder ${candidate} in ${persona}`).toBe(true);
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
