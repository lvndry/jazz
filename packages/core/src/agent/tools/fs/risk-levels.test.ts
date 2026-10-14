import { describe, expect, it } from "bun:test";
import { createCpTools } from "./cp";
import { createMkdirTools } from "./mkdir";
import { createMvTools } from "./mv";

describe("file tool risk levels", () => {
  for (const [name, createTools] of [
    ["mv", createMvTools],
    ["cp", createCpTools],
  ] as const) {
    it(`${name} is low-risk unless force replaces the destination`, () => {
      const { approval, execute } = createTools();
      const args = { source: "a.txt", destination: "b.txt" };

      expect(approval.resolveRiskLevel?.(args)).toBe("low-risk");
      expect(approval.resolveRiskLevel?.({ ...args, force: true })).toBe("high-risk");
      expect(execute.resolveRiskLevel?.({ ...args, force: true })).toBe("high-risk");
    });
  }

  it("mkdir is low-risk", () => {
    expect(createMkdirTools().approval.riskLevel).toBe("low-risk");
  });
});
