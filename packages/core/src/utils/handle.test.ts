import { describe, expect, it } from "bun:test";
import {
  findByNameOrIdPrefix,
  HANDLE_PATTERN,
  handleFrom,
  leadingWords,
  uniqueHandle,
} from "./handle";

describe("handleFrom", () => {
  it("keeps a suggestion that is already a handle", () => {
    expect(handleFrom("detach-to-prod", "goal")).toBe("detach-to-prod");
  });

  it("lowercases, drops punctuation and accents, and joins words with hyphens", () => {
    expect(handleFrom("  Detach To Prod!! ", "goal")).toBe("detach-to-prod");
    expect(handleFrom("Déploiement_final", "goal")).toBe("deploiement-final");
    expect(handleFrom("migrate--all---users", "goal")).toBe("migrate-all-users");
  });

  it("cuts to the pattern's word and length limits without a trailing hyphen", () => {
    expect(handleFrom("one two three four five six seven eight", "goal")).toBe(
      "one-two-three-four-five-six",
    );
    const long = handleFrom(`${"a".repeat(38)} bb`, "goal");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
    expect(HANDLE_PATTERN.test(long)).toBe(true);
  });

  it("falls back to the fallback when nothing usable is left", () => {
    expect(handleFrom(undefined, "goal")).toBe("goal");
    expect(handleFrom("", "goal")).toBe("goal");
    expect(handleFrom("本番へデプロイ", "goal")).toBe("goal");
    expect(handleFrom("!!!", "goal")).toBe("goal");
  });
});

describe("uniqueHandle", () => {
  it("returns the name when it is free", () => {
    expect(uniqueHandle("goal", new Set())).toBe("goal");
  });

  it("numbers a taken name with the first free suffix", () => {
    expect(uniqueHandle("goal", new Set(["goal", "goal-2"]))).toBe("goal-3");
  });

  it("keeps a numbered long name within the length limit", () => {
    const name = handleFrom("a".repeat(40), "goal");
    const numbered = uniqueHandle(name, new Set([name]));
    expect(numbered.length).toBeLessThanOrEqual(40);
    expect(HANDLE_PATTERN.test(numbered)).toBe(true);
  });
});

describe("findByNameOrIdPrefix", () => {
  const records = [
    { id: "3f2a91c0-aaaa", name: "deploy-watch" },
    { id: "3f2b0000-bbbb", name: "inbox-sweep" },
  ];
  const idOf = (record: { id: string }) => record.id;

  it("finds a record by its name before any id prefix", () => {
    expect(findByNameOrIdPrefix(records, "inbox-sweep", idOf)?.id).toBe("3f2b0000-bbbb");
  });

  it("accepts an id prefix that names only one record", () => {
    expect(findByNameOrIdPrefix(records, "3f2a", idOf)?.name).toBe("deploy-watch");
  });

  it("refuses an ambiguous or too-short prefix", () => {
    expect(findByNameOrIdPrefix(records, "3f2", idOf)).toBeUndefined();
    expect(
      findByNameOrIdPrefix([...records, { id: "3f2a0000", name: "x" }], "3f2a", idOf),
    ).toBeUndefined();
  });
});

describe("leadingWords", () => {
  it("takes the first meaningful words of the text", () => {
    expect(leadingWords("Check whether the deploy finished and tell me", 3)).toBe(
      "check deploy finished",
    );
    expect(leadingWords("Read status.txt in the current directory", 3)).toBe("read status txt");
  });

  it("is empty when the text has only filler words", () => {
    expect(leadingWords("if it is the", 3)).toBe("");
  });
});
