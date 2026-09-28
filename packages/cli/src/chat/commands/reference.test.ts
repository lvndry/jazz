import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CHAT_COMMANDS } from "./constants";
import { chatReferenceRegions, renderChatCommandTable, replaceGeneratedRegions } from "./reference";

const DOCS_PATH = path.join(import.meta.dir, "../../../../../docs/commands.md");

describe("docs/commands.md in-chat reference", () => {
  it("matches the tables generated from CHAT_COMMANDS and the keymaps", () => {
    const markdown = readFileSync(DOCS_PATH, "utf-8");
    expect(
      replaceGeneratedRegions(markdown, chatReferenceRegions()),
      "docs/commands.md is stale: run `bun run docs:chat-commands`",
    ).toBe(markdown);
  });

  it("lists every built-in command and alias", () => {
    const table = renderChatCommandTable();
    for (const command of CHAT_COMMANDS) {
      expect(table).toContain(`\`/${command.name}`);
      for (const alias of command.aliases ?? []) {
        expect(table).toContain(`\`/${alias}\``);
      }
    }
  });

  it("escapes pipes so a usage string stays in one cell", () => {
    expect(renderChatCommandTable()).toContain("`/theme [name] [dark\\|light]`");
  });

  it("refuses a page whose markers are missing", () => {
    expect(() => replaceGeneratedRegions("no markers here", chatReferenceRegions())).toThrow(
      "Missing",
    );
  });
});
