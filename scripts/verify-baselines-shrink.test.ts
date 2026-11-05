import { describe, expect, it } from "bun:test";
import {
  findBaselineIncreases,
  flattenCastBaseline,
  flattenSuppressions,
} from "./verify-baselines-shrink";

const FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);

describe("findBaselineIncreases", () => {
  const base = flattenSuppressions({
    "packages/a.ts": { curly: { count: 2 }, "id-length": { count: 1 } },
  });

  it("accepts an unchanged baseline", () => {
    expect(findBaselineIncreases(base, base)).toEqual([]);
  });

  it("accepts a removed entry and a lowered count", () => {
    const head = flattenSuppressions({ "packages/a.ts": { curly: { count: 1 } } });
    expect(findBaselineIncreases(base, head)).toEqual([]);
  });

  it("rejects an added file entry", () => {
    const head = flattenSuppressions({
      "packages/a.ts": { curly: { count: 2 }, "id-length": { count: 1 } },
      "packages/b.ts": { curly: { count: 1 } },
    });
    expect(findBaselineIncreases(base, head)).toEqual(["added: packages/b.ts | curly (1)"]);
  });

  it("rejects an added rule on an existing file", () => {
    const head = flattenSuppressions({
      "packages/a.ts": {
        curly: { count: 2 },
        "id-length": { count: 1 },
        "prettier/prettier": { count: 1 },
      },
    });
    expect(findBaselineIncreases(base, head)).toHaveLength(1);
  });

  it("rejects a raised count", () => {
    const head = flattenSuppressions({
      "packages/a.ts": { curly: { count: 3 }, "id-length": { count: 1 } },
    });
    expect(findBaselineIncreases(base, head)).toEqual(["raised: packages/a.ts | curly (2 -> 3)"]);
  });

  it("rejects a count that is not a number", () => {
    const head = flattenSuppressions({ "packages/a.ts": { curly: { count: "many" } } });
    expect(findBaselineIncreases(base, head)).toHaveLength(1);
  });
});

describe("cast baseline", () => {
  const base = flattenCastBaseline({ "packages/a.ts": { [FINGERPRINT]: 1 } });

  it("rejects a new fingerprint and a raised count, accepts removal", () => {
    expect(
      findBaselineIncreases(
        base,
        flattenCastBaseline({
          "packages/a.ts": { [FINGERPRINT]: 1, [OTHER_FINGERPRINT]: 1 },
        }),
      ),
    ).toHaveLength(1);
    expect(
      findBaselineIncreases(base, flattenCastBaseline({ "packages/a.ts": { [FINGERPRINT]: 2 } })),
    ).toHaveLength(1);
    expect(findBaselineIncreases(base, flattenCastBaseline({}))).toEqual([]);
  });
});
