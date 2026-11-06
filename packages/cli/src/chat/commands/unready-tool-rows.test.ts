/**
 * The `/info` rows that tell a user why a tool was left out of their runs.
 * Run with `bun test packages/cli/src/chat/commands/unready-tool-rows.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { unreadyToolRows } from "./handler";

describe("unreadyToolRows", () => {
  it("shows web search as not configured with how to set it up", () => {
    const rows = unreadyToolRows([
      {
        name: "web_search",
        reason: "not_configured",
        remedy: "Run `jazz config set web_search.provider <provider>` and save its API key.",
      },
    ]);
    expect(rows).toEqual([
      {
        kind: "field",
        key: "web search",
        value: "not configured",
        detail: "Run `jazz config set web_search.provider <provider>` and save its API key.",
        tone: "muted",
      },
    ]);
  });

  it("shows nothing when every tool is ready", () => {
    expect(unreadyToolRows([])).toEqual([]);
  });
});
