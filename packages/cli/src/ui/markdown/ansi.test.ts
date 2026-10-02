import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import { stripAnsiCodes } from "../../utils/string-utils";
import { GLYPHS } from "../glyphs";
import { markdownToAnsi, type AnsiMarkdownOptions } from "./ansi";
import { parseInlineMarkdown } from "./inline";

const WIDTH = 88;
const glyphs = GLYPHS.unicode;

/**
 * The visible text, with every SGR/OSC 8 escape stripped, so structure asserts cleanly, and
 * pinned to the Unicode glyph set so the assertions don't depend on this process's own
 * terminal-capability detection.
 */
function plain(markdown: string, options: Partial<AnsiMarkdownOptions> = {}): string {
  return stripAnsiCodes(markdownToAnsi(markdown, { width: WIDTH, glyphs, ...options }));
}

describe("markdownToAnsi", () => {
  it("preserves wide graphemes in a fence at a one-cell width", () => {
    const text = "界👩‍💻e\u0301";
    const rendered = plain(`\`\`\`\n${text}\n\`\`\``, { width: 1, syntax: "hybrid" });
    expect(rendered.split("\n").slice(1, -1).join("")).toBe(text);
    expect(rendered.split("\n")).toHaveLength(5);
  });

  it("hard-wraps a long code line without losing indentation or content", () => {
    const text = "    " + "a".repeat(50_000);
    const rendered = plain(`\`\`\`txt\n${text}\n\`\`\``, { width: 80, syntax: "hybrid" });
    const lines = rendered.split("\n").slice(1, -1);
    expect(lines.join("")).toBe(text);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  it("returns empty text unchanged", () => {
    expect(markdownToAnsi("", { width: WIDTH })).toBe("");
  });

  it("wraps a paragraph at the available width", () => {
    const long = Array.from({ length: 20 }, (_, index) => `word${String(index)}`).join(" ");
    const lines = plain(long, { width: 120 }).split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120);
      if (line === lines[0]) expect(line.length).toBeGreaterThan(88);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  it("collapses runs of blank lines to one, and sets off headings, fences and tables", () => {
    // Forced explicitly: at level 0 a fence keeps its ``` markers (see the "bands a fence"
    // test below), which is what this test's expected output assumes.
    try {
      chalk.level = 0;
      const markdown = [
        "# Title",
        "",
        "",
        "",
        "Body text.",
        "",
        "```",
        "code",
        "```",
        "More.",
      ].join("\n");
      const lines = plain(markdown);
      expect(lines).toBe(
        ["Title", "", "Body text.", "", "```", "code", "```", "", "More."].join("\n"),
      );
    } finally {
      chalk.level = 0;
    }
  });

  it("gives a wrapped bullet's continuation lines the marker's own indent", () => {
    const markdown = "- one two three four five six seven eight nine ten eleven twelve thirteen";
    const lines = plain(markdown, { width: 30 }).split("\n");
    // Every list item, even at the top level, sits two cells in from the prose edge.
    expect(lines[0]?.startsWith("  ∙ ")).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.startsWith("    ")).toBe(true);
      expect(line).not.toContain("∙");
    }
  });

  it("nests a sub-list one marker-width deeper than its parent", () => {
    const markdown = ["- parent", "  - child"].join("\n");
    const lines = plain(markdown).split("\n");
    expect(lines[0]).toBe("  ∙ parent");
    expect(lines[1]).toBe("    ∙ child");
  });

  it("marks task list items done or open instead of a plain bullet", () => {
    const markdown = ["- [x] shipped", "- [ ] pending"].join("\n");
    const lines = plain(markdown).split("\n");
    expect(lines[0]).toBe("  ✓ shipped");
    expect(lines[1]).toBe("  ○ pending");
  });

  it("numbers an ordered list instead of turning it into bullets", () => {
    const markdown = ["1. first", "2. second"].join("\n");
    const lines = plain(markdown).split("\n");
    expect(lines).toEqual(["  1. first", "  2. second"]);
  });

  it("expands an emoji shortcode inline", () => {
    expect(plain("go :rocket: now")).toContain("🚀");
  });

  it("keeps a link's label and gives it a live target for the OSC 8 wrapper", () => {
    try {
      chalk.level = 3;
      const rendered = markdownToAnsi("a [jazz](https://jazz.sh) link", { width: WIDTH, glyphs });
      expect(rendered).toContain("\u001b]8;;https://jazz.sh\u0007");
      expect(stripAnsiCodes(rendered)).toBe("a jazz link");
    } finally {
      chalk.level = 0;
    }
  });

  it("preserves emphasis marks on Markdown link labels", () => {
    const spans = parseInlineMarkdown("**[jazz](https://jazz.sh)**", "text");
    expect(spans).toEqual([
      {
        text: "jazz",
        role: "link",
        bold: true,
        underline: true,
        link: "https://jazz.sh",
      },
    ]);
  });

  it("never emits a hyperlink escape when hyperlinks are off", () => {
    const rendered = markdownToAnsi("a [jazz](https://jazz.sh) link", {
      width: WIDTH,
      glyphs,
      hyperlinks: false,
    });
    expect(rendered).not.toContain("\u001b]8;;");
  });

  it("keeps a fence's own ``` markers in hybrid syntax mode, band-free", () => {
    const markdown = ["```bash", "echo hi", "```"].join("\n");
    const hybrid = plain(markdown, { syntax: "hybrid" });
    expect(hybrid.split("\n")).toEqual(["```bash", "echo hi", "```"]);
  });

  it("bands a fence in rendered syntax mode instead of keeping its ``` markers", () => {
    // Without colour a painted band is only padding, so rendered mode falls back to the
    // ``` markers too (see fenceLines) — the band only replaces them once colour is real.
    try {
      chalk.level = 3;
      const markdown = ["```bash", "echo hi", "```"].join("\n");
      const rendered = plain(markdown);
      expect(rendered).not.toContain("```");
      expect(rendered).toContain("echo hi");
      expect(rendered).toContain("bash");
    } finally {
      chalk.level = 0;
    }
  });

  it("lays a table out with a rule under the header and every row's inline code kept", () => {
    const markdown = [
      "| Package | Role |",
      "| :--- | ---: |",
      "| `@jazz/core` | Agent loop |",
    ].join("\n");
    const lines = plain(markdown).split("\n");
    expect(lines[0]).toContain("Package");
    expect(lines[0]).toContain("Role");
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toContain("@jazz/core");
  });

  it("keeps one blank line at a streamed slice's edge when asked to", () => {
    const withLeadingBlank = markdownToAnsi("\nBody.", {
      width: WIDTH,
      glyphs,
      keepEdgeBlankLines: true,
    });
    expect(withLeadingBlank.startsWith("\n")).toBe(true);
    const withoutOption = markdownToAnsi("\nBody.", { width: WIDTH, glyphs });
    expect(withoutOption.startsWith("\n")).toBe(false);
  });

  describe("wrapProse: false", () => {
    it("leaves a long paragraph as one line, for a renderer that reflows it itself", () => {
      const long = Array.from({ length: 20 }, (_, index) => `word${String(index)}`).join(" ");
      const line = plain(long, { width: 30, wrapProse: false });
      expect(line.split("\n")).toHaveLength(1);
      expect(line).toBe(long);
    });

    it("still breaks list items onto their own line, since that is structure, not a wrap", () => {
      const markdown = ["- first item", "- second item"].join("\n");
      const lines = plain(markdown, { wrapProse: false }).split("\n");
      expect(lines).toEqual(["  ∙ first item", "  ∙ second item"]);
    });

    it("leaves a long heading as one line too", () => {
      const heading = `# ${Array.from({ length: 15 }, (_, index) => `word${String(index)}`).join(" ")}`;
      const lines = plain(heading, { width: 30, wrapProse: false }).split("\n");
      expect(lines).toHaveLength(1);
    });

    it("still wraps a table to width, because a table's columns are layout, not running text", () => {
      const markdown = [
        "| Package | Role |",
        "| :--- | ---: |",
        "| `@jazz/core` | Agent loop |",
      ].join("\n");
      const withWrap = plain(markdown, { width: WIDTH });
      const withoutWrap = plain(markdown, { width: WIDTH, wrapProse: false });
      expect(withoutWrap).toBe(withWrap);
    });

    it("still bands a fence to width, for the same reason", () => {
      try {
        chalk.level = 3;
        const markdown = ["```bash", "echo hi", "```"].join("\n");
        const withWrap = plain(markdown, { width: WIDTH });
        const withoutWrap = plain(markdown, { width: WIDTH, wrapProse: false });
        expect(withoutWrap).toBe(withWrap);
      } finally {
        chalk.level = 0;
      }
    });
  });
});
