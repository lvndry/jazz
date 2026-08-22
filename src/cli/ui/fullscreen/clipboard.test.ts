import { describe, expect, it } from "bun:test";
import {
  clipboardWriteCommands,
  flattenPaste,
  normalizePaste,
  pasteTextFromEvent,
  selectedTextFromRenderer,
} from "./clipboard";

describe("normalizePaste", () => {
  it("turns every newline flavour into \\n so a paste does not submit", () => {
    expect(normalizePaste("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips ANSI so a coloured copy does not inject escape sequences", () => {
    expect(normalizePaste("\u001b[31mred\u001b[0m")).toBe("red");
  });
});

describe("flattenPaste", () => {
  it("keeps a one-line field from growing a second row", () => {
    expect(flattenPaste("a\r\nb")).toBe("a b");
  });
});

describe("pasteTextFromEvent", () => {
  it("reads OpenTUI's bytes payload and the text getter some builds add", () => {
    expect(pasteTextFromEvent({ text: "hello\r\nthere" })).toBe("hello\nthere");
    expect(pasteTextFromEvent({ bytes: new TextEncoder().encode("from bytes") })).toBe(
      "from bytes",
    );
    expect(pasteTextFromEvent({})).toBe("");
  });
});

describe("clipboardWriteCommands", () => {
  it("uses pbcopy, clip, and the Linux clipboard writers", () => {
    expect(clipboardWriteCommands("darwin")).toEqual([{ cmd: "pbcopy", args: [] }]);
    expect(clipboardWriteCommands("win32")).toEqual([{ cmd: "clip", args: [] }]);
    expect(clipboardWriteCommands("linux")).toEqual([
      { cmd: "wl-copy", args: [] },
      { cmd: "xclip", args: ["-selection", "clipboard"] },
      { cmd: "xsel", args: ["--clipboard", "--input"] },
    ]);
  });
});

describe("selectedTextFromRenderer", () => {
  it("reads OpenTUI selection and ignores an empty or missing highlight", () => {
    expect(selectedTextFromRenderer({})).toBe("");
    expect(selectedTextFromRenderer({ hasSelection: false })).toBe("");
    expect(
      selectedTextFromRenderer({
        hasSelection: true,
        getSelection: () => null,
      }),
    ).toBe("");
    expect(
      selectedTextFromRenderer({
        hasSelection: true,
        getSelection: () => ({ getSelectedText: () => "\u001b[31mcopied\r\nline\u001b[0m" }),
      }),
    ).toBe("copied\nline");
  });
});
