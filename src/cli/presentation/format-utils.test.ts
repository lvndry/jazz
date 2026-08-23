import { describe, expect, it } from "bun:test";
import { spaceReasoningSections } from "./format-utils";

describe("spaceReasoningSections", () => {
  it("inserts a blank line after a **heading** that sits on the next line's paragraph", () => {
    expect(spaceReasoningSections("**Reviewing tests**\nConsidering flags.")).toBe(
      "**Reviewing tests**\n\nConsidering flags.",
    );
  });

  it("inserts a blank line before a heading that follows a paragraph", () => {
    expect(spaceReasoningSections("Considering flags.\n**Finding failures**\nMany passed.")).toBe(
      "Considering flags.\n\n**Finding failures**\n\nMany passed.",
    );
  });

  it("does not double a blank line that is already there", () => {
    expect(spaceReasoningSections("**Reviewing tests**\n\nConsidering flags.")).toBe(
      "**Reviewing tests**\n\nConsidering flags.",
    );
  });

  it("treats an ATX heading the same way", () => {
    expect(spaceReasoningSections("# Reviewing tests\nConsidering flags.")).toBe(
      "# Reviewing tests\n\nConsidering flags.",
    );
  });

  it("leaves inline bold in a sentence alone", () => {
    expect(spaceReasoningSections("Use **bun test** for this.")).toBe("Use **bun test** for this.");
  });
});
