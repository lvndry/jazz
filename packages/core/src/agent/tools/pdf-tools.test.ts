import { describe, expect, it } from "bun:test";
import { pdfFilenameFromTitle, resolvePdfOutputPath } from "./pdf-tools";

describe("pdfFilenameFromTitle", () => {
  it("slugifies a title", () => {
    expect(pdfFilenameFromTitle("Q3 Revenue Report")).toBe("q3-revenue-report.pdf");
  });

  it("collapses punctuation rather than emitting it into a filename", () => {
    expect(pdfFilenameFromTitle("Notes: 2026 — draft!")).toBe("notes-2026-draft.pdf");
  });

  it("falls back for a title with nothing usable in it", () => {
    // "???.pdf" would slug to an empty name and produce a dotfile.
    expect(pdfFilenameFromTitle("???")).toBe("document.pdf");
  });

  it("bounds the length", () => {
    expect(pdfFilenameFromTitle("word ".repeat(60)).length).toBeLessThanOrEqual(84);
  });
});

describe("resolvePdfOutputPath", () => {
  it("defaults to the working directory, not jazz's own data directory", () => {
    // The whole reason this tool differs from create_web_app: someone running `jazz run` in a
    // terminal wants the file where they are, not buried in ~/.jazz.
    const resolved = resolvePdfOutputPath({ title: "My Report" }, "/work/project");
    expect(resolved).toBe("/work/project/my-report.pdf");
  });

  it("resolves an explicit relative path against the working directory", () => {
    const resolved = resolvePdfOutputPath(
      { title: "ignored", path: "out/report.pdf" },
      "/work/project",
    );
    expect(resolved).toBe("/work/project/out/report.pdf");
  });

  it("honours an absolute path verbatim", () => {
    const resolved = resolvePdfOutputPath({ title: "ignored", path: "/tmp/x.pdf" }, "/work");
    expect(resolved).toBe("/tmp/x.pdf");
  });
});
