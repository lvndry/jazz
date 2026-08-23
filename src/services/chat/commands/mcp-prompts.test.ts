import { describe, expect, test } from "bun:test";
import type { MCPPromptArgument, MCPPromptMessage } from "@/core/types/mcp";
import { bindPromptArguments, flattenPromptMessages } from "./handler";

const declared: readonly MCPPromptArgument[] = [
  { name: "title", required: true },
  { name: "body", required: false },
];

describe("bindPromptArguments", () => {
  test("binds explicit name=value pairs in any order", () => {
    expect(bindPromptArguments(declared, ["body=details", "title=Bug"])).toEqual({
      title: "Bug",
      body: "details",
    });
  });

  test("treats a bare trailing phrase as the single remaining argument", () => {
    // `/srv:issue the login page is broken` should not become title="the".
    expect(
      bindPromptArguments([{ name: "title", required: true }], ["the", "page", "broke"]),
    ).toEqual({ title: "the page broke" });
  });

  test("fills several unbound arguments positionally", () => {
    expect(bindPromptArguments(declared, ["Bug", "details"])).toEqual({
      title: "Bug",
      body: "details",
    });
  });

  test("mixes a named pair with a bare remainder", () => {
    expect(bindPromptArguments(declared, ["title=Bug", "the", "rest"])).toEqual({
      title: "Bug",
      body: "the rest",
    });
  });

  test("keeps an = that is not a declared argument name as text", () => {
    expect(bindPromptArguments([{ name: "query", required: true }], ["a=b"])).toEqual({
      query: "a=b",
    });
  });

  test("returns nothing for a prompt that declares no arguments", () => {
    expect(bindPromptArguments([], ["ignored"])).toEqual({});
  });
});

describe("flattenPromptMessages", () => {
  test("joins text blocks", () => {
    const messages: readonly MCPPromptMessage[] = [
      { role: "user", content: { type: "text", text: "first" } },
      { role: "assistant", content: { type: "text", text: "second" } },
    ];

    expect(flattenPromptMessages(messages)).toBe("first\n\nsecond");
  });

  test("inlines an embedded resource's text", () => {
    const messages: readonly MCPPromptMessage[] = [
      { role: "user", content: { type: "resource", resource: { text: "file body" } } },
    ];

    expect(flattenPromptMessages(messages)).toBe("file body");
  });

  test("skips content with no text form", () => {
    const messages: readonly MCPPromptMessage[] = [
      { role: "user", content: { type: "image", data: "base64" } },
      { role: "user", content: { type: "text", text: "caption" } },
    ];

    expect(flattenPromptMessages(messages)).toBe("caption");
  });

  test("returns empty string when nothing is renderable", () => {
    expect(flattenPromptMessages([{ role: "user", content: { type: "image" } }])).toBe("");
    expect(flattenPromptMessages([])).toBe("");
  });
});
