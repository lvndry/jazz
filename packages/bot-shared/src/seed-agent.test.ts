import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_BRIDGE_TOOLS } from "./seed-agent";

/**
 * The containerised bridges seed their template agent from a JSON file rather
 * than from this constant: their entrypoint substitutes a provider and model
 * into it with `sed`, long before any TypeScript runs, so it cannot import one.
 *
 * That leaves the same list written out three times with nothing keeping them
 * together - and drift is silent, because a tool added here simply never
 * reaches Telegram or Discord. Until the container path seeds itself through
 * `ensureSeedAgent` too, this is what notices.
 */
const TEMPLATES = [
  "../../telegram-bot/src/agent.telegram.json",
  "../../discord-bot/src/agent.discord.json",
] as const;

describe("DEFAULT_BRIDGE_TOOLS", () => {
  for (const relative of TEMPLATES) {
    const surface = relative.includes("telegram") ? "telegram" : "discord";

    test(`matches the ${surface} container template, which is seeded separately`, () => {
      const template = JSON.parse(readFileSync(join(import.meta.dir, relative), "utf8")) as {
        config: { tools: readonly string[] };
      };

      expect(template.config.tools).toEqual([...DEFAULT_BRIDGE_TOOLS]);
    });
  }
});
