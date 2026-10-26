import { describe, expect, it } from "bun:test";
import { foldedLine, foldHint, foldOperation } from "./operation-fold";

const HEREDOC_COMMAND = `date "+%H:%M"\npython3 <<'EOF'\nprint("hi")\nEOF`;

describe("foldOperation", () => {
  it("keeps the first line whole and counts the rest", () => {
    expect(foldOperation(HEREDOC_COMMAND)).toEqual({ head: 'date "+%H:%M"', hiddenLines: 3 });
  });

  it("leaves a one-line operation unfolded", () => {
    expect(foldOperation("ls -la\n")).toEqual({ head: "ls -la", hiddenLines: 0 });
  });
});

describe("foldHint", () => {
  it("names the key and the count", () => {
    expect(foldHint(1)).toBe("ctrl+o for 1 more line");
    expect(foldHint(3)).toBe("ctrl+o for 3 more lines");
  });
});

describe("foldedLine", () => {
  it("counts what the first line leaves out", () => {
    expect(foldedLine(HEREDOC_COMMAND)).toBe('date "+%H:%M" (+3 lines)');
    expect(foldedLine("ls -la")).toBe("ls -la");
  });
});
