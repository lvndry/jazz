import { describe, expect, it } from "bun:test";
import {
  describeArtifact,
  type GeneratedArtifact,
  parseGeneratedArtifact,
  parseGeneratedArtifacts,
} from "./artifact";

function artifact(overrides: Partial<GeneratedArtifact> = {}): GeneratedArtifact {
  return {
    kind: "pdf",
    path: "/tmp/report.pdf",
    mediaType: "application/pdf",
    tool: "create_pdf",
    source: "rendered",
    ...overrides,
  };
}

describe("parseGeneratedArtifact", () => {
  it("accepts a well-formed artifact", () => {
    expect(parseGeneratedArtifact(artifact())).toEqual(artifact());
  });

  it("keeps an optional title and omits an empty one", () => {
    expect(parseGeneratedArtifact(artifact({ title: "Q3 report" }))?.title).toBe("Q3 report");
    expect(parseGeneratedArtifact({ ...artifact(), title: "" })?.title).toBeUndefined();
  });

  it("rejects an unknown kind rather than passing it through", () => {
    // Custom and MCP tools can return anything, and this value ends up in the JSON envelope
    // that scripts and bridges consume.
    expect(parseGeneratedArtifact({ ...artifact(), kind: "spreadsheet" })).toBeNull();
  });

  it("rejects an unknown source", () => {
    // Provenance drives what the user is told about the file, so a bogus value must not survive.
    expect(parseGeneratedArtifact({ ...artifact(), source: "somewhere" })).toBeNull();
  });

  it("rejects missing or empty required fields", () => {
    expect(parseGeneratedArtifact({ ...artifact(), path: "" })).toBeNull();
    expect(parseGeneratedArtifact({ ...artifact(), mediaType: undefined })).toBeNull();
    expect(parseGeneratedArtifact({ ...artifact(), tool: "" })).toBeNull();
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "pdf", 42, []]) {
      expect(parseGeneratedArtifact(value)).toBeNull();
    }
  });
});

describe("parseGeneratedArtifacts", () => {
  it("keeps the valid entries and drops the rest", () => {
    // One malformed artifact should not cost the user the files that did work.
    const parsed = parseGeneratedArtifacts([artifact(), { kind: "nope" }, artifact()]);
    expect(parsed).toHaveLength(2);
  });

  it("is empty for anything that is not an array", () => {
    expect(parseGeneratedArtifacts(undefined)).toEqual([]);
    expect(parseGeneratedArtifacts({ kind: "pdf" })).toEqual([]);
  });
});

describe("describeArtifact", () => {
  it("always shows the path", () => {
    expect(describeArtifact(artifact())).toContain("/tmp/report.pdf");
  });

  it("marks model output as AI-generated", () => {
    const described = describeArtifact(
      artifact({ kind: "image", source: "model", tool: "generate_image" }),
    );
    expect(described).toContain("AI-generated");
  });

  it("does not mark a rendered chart as AI-generated", () => {
    // The point of tracking provenance: a chart screenshotted from HTML has exact numbers, and
    // calling it AI-generated would tell the reader not to trust figures they can trust.
    const described = describeArtifact(
      artifact({ kind: "image", tool: "create_web_app", source: "rendered", title: "Spending" }),
    );
    expect(described).not.toContain("AI-generated");
    expect(described).toContain("Spending");
  });
});
