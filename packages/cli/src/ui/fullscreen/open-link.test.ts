import { describe, expect, it } from "bun:test";
import { isOpenableLink, linkAtColumn } from "./open-link";

describe("isOpenableLink", () => {
  it("accepts web and mail addresses", () => {
    expect(isOpenableLink("https://example.com/guide")).toBe(true);
    expect(isOpenableLink("http://localhost:3000")).toBe(true);
    expect(isOpenableLink("mailto:someone@example.com")).toBe(true);
  });

  it("refuses local files, app schemes, and non-URLs", () => {
    expect(isOpenableLink("file:///etc/passwd")).toBe(false);
    expect(isOpenableLink("javascript:alert(1)")).toBe(false);
    expect(isOpenableLink("vscode://open?file=/tmp/x")).toBe(false);
    expect(isOpenableLink("./README.md")).toBe(false);
    expect(isOpenableLink("")).toBe(false);
  });
});

describe("linkAtColumn", () => {
  const segments = [
    { text: "read " },
    { text: "the guide", link: "https://example.com/guide" },
    { text: " first" },
  ];

  it("finds the link under a column inside its label", () => {
    expect(linkAtColumn(segments, 5)).toBe("https://example.com/guide");
    expect(linkAtColumn(segments, 13)).toBe("https://example.com/guide");
  });

  it("finds nothing beside the label or past the row", () => {
    expect(linkAtColumn(segments, 4)).toBeUndefined();
    expect(linkAtColumn(segments, 14)).toBeUndefined();
    expect(linkAtColumn(segments, 200)).toBeUndefined();
    expect(linkAtColumn(segments, -1)).toBeUndefined();
  });

  it("counts wide characters as two cells", () => {
    const wide = [{ text: "日本 " }, { text: "docs", link: "https://example.com" }];
    expect(linkAtColumn(wide, 4)).toBeUndefined();
    expect(linkAtColumn(wide, 5)).toBe("https://example.com");
  });
});
