import { describe, expect, it } from "bun:test";
import { extractJsonObject } from "./json";

describe("extractJsonObject", () => {
  it("finds the last object in prose or a fenced block and rejects answers with none", () => {
    expect(
      extractJsonObject('Done.\n```json\n{"status":"blocked","summary":"x"}\n```', "status"),
    ).toEqual({ status: "blocked", summary: "x" });
    expect(
      extractJsonObject(
        'I used {braces} here. {"status":"question","question":"Which?"}',
        "status",
      ),
    ).toEqual({ status: "question", question: "Which?" });
    expect(() => extractJsonObject("All done, everything works.", "status")).toThrow();
  });

  it("reads a whole-answer value as is", () => {
    expect(extractJsonObject('  {"kind":"plan"}  ', "kind")).toEqual({ kind: "plan" });
  });
});
