import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * Persona files are substituted with String.replace (not replaceAll), so each
 * placeholder may appear at most once — a second occurrence ships to the model
 * as a literal token. This test locks that contract.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const PERSONA_SOURCES: [label: string, dir: string][] = [
  ["personas", join(REPO_ROOT, "personas")],
  ["marketplace/personas", join(REPO_ROOT, "marketplace/personas")],
];

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

describe.each(PERSONA_SOURCES)("persona placeholder contract (%s)", (label, dir) => {
  const personaNames = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  test("personas directory is discoverable", () => {
    expect(personaNames.length).toBeGreaterThan(0);
  });

  for (const persona of personaNames) {
    const path = join(dir, persona, "PERSONA.md");
    const content = readFileSync(path, "utf-8");

    test(`${persona}: each placeholder appears at most once`, () => {
      for (const placeholder of KNOWN_PLACEHOLDERS) {
        const occurrences = countOccurrences(content, placeholder);
        expect(
          occurrences,
          `${placeholder} appears ${occurrences} times in ${label}/${persona}/PERSONA.md — .replace substitutes only the first`,
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
