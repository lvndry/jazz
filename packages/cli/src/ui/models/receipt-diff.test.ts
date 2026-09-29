import { describe, expect, test } from "bun:test";
import { receiptDiffRows, receiptFromMeta, toolReceipt } from "./receipt";

const diffPreview = { lines: ["@@ -1 +1 @@", "-old", "+new", " same"], hiddenLines: 3 };

describe("file mutation receipt diff", () => {
  const receipt = toolReceipt({
    toolName: "edit_file",
    argsPreview: "src/app.ts  const renamed = 1",
    success: true,
    result: "{}",
    durationMs: 5,
    diffPreview,
  });

  test("keeps only the path in the arguments once a diff is shown", () => {
    expect(receipt.args).toBe("src/app.ts");
    expect(receipt.diffPreview).toEqual(diffPreview);
  });

  test("tags rows by change and ends with the expand hint", () => {
    expect(receiptDiffRows(receipt)).toEqual([
      { text: "@@ -1 +1 @@", role: "secondary" },
      { text: "-old", role: "error" },
      { text: "+new", role: "success" },
      { text: " same", role: "muted" },
      { text: "… 3 more lines · ctrl+e to expand", role: "muted" },
    ]);
  });

  test("omits the hint when nothing is hidden", () => {
    const whole = toolReceipt({
      toolName: "edit_file",
      success: true,
      result: "{}",
      durationMs: 5,
      diffPreview: { lines: ["+a"], hiddenLines: 0 },
    });
    expect(receiptDiffRows(whole)).toEqual([{ text: "+a", role: "success" }]);
  });

  test("survives the round trip through output metadata", () => {
    expect(receiptFromMeta(JSON.parse(JSON.stringify(receipt)))?.diffPreview).toEqual(diffPreview);
  });

  test("a failed call shows no diff", () => {
    const failed = toolReceipt({
      toolName: "edit_file",
      success: false,
      error: "boom",
      result: "{}",
      durationMs: 5,
      diffPreview,
    });
    expect(failed.diffPreview).toBeUndefined();
  });
});
