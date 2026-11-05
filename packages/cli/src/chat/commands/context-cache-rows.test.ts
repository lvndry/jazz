import { describe, expect, test } from "bun:test";
import { cacheContextRows } from "./context-cache-rows";

describe("cacheContextRows", () => {
  test("before any request there is nothing to report", () => {
    expect(cacheContextRows(undefined)).toEqual([
      { kind: "field", key: "cache", value: "no request yet" },
    ]);
  });

  test("a known rate is a field with the last change as its detail", () => {
    const [row] = cacheContextRows({ change: { reason: "none", changed: [] }, hitRate: 0.824 });
    expect(row).toMatchObject({ kind: "field", key: "cache", value: "82% hit" });
    expect(row?.kind === "field" ? row.detail : undefined).toContain("prefix unchanged");
  });

  test("an unreported rate says unknown rather than 0%", () => {
    const [row] = cacheContextRows({
      change: { reason: "tools-changed", changed: ["tools"] },
      hitRate: undefined,
    });
    expect(row).toMatchObject({ kind: "field", key: "cache", value: "unknown" });
  });
});
