import { describe, expect, it } from "bun:test";
import { anchorsIn } from "./check-docs-links";

describe("anchorsIn", () => {
  it("slugs headings the way GitHub and the website do", () => {
    const anchors = anchorsIn(
      [
        "# Guard 1: budget pressure",
        "## What is _not_ a built-in tool",
        "## `config show` and [links](./x.md)",
        "## Setup",
        "## Setup",
      ].join("\n\n"),
    );
    expect([...anchors]).toEqual([
      "guard-1-budget-pressure",
      "what-is-not-a-built-in-tool",
      "config-show-and-links",
      "setup",
      "setup-1",
    ]);
  });

  it("ignores frontmatter and headings inside code fences", () => {
    const anchors = anchorsIn(
      ["---", "description: not a heading", "---", "", "```bash", "# a comment", "```"].join("\n"),
    );
    expect(anchors.size).toBe(0);
  });

  it("counts explicit HTML ids and names", () => {
    const anchors = anchorsIn('<a id="custom-anchor"></a>\n\n<a name="legacy"></a>');
    expect(anchors.has("custom-anchor")).toBe(true);
    expect(anchors.has("legacy")).toBe(true);
  });
});
