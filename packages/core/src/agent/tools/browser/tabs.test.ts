import { describe, expect, test } from "bun:test";
import {
  MAX_TAB_NAME_LENGTH,
  MAX_TABS,
  RefTable,
  TabRegistry,
  matchAdoptionCandidates,
  tabNameProblem,
} from "./tabs";

describe("tab names", () => {
  test("accepts lowercase words joined by single hyphens", () => {
    expect(tabNameProblem("checkout")).toBeUndefined();
    expect(tabNameProblem("order-status-2")).toBeUndefined();
  });

  test("rejects anything else, including the empty name and an over-long one", () => {
    for (const name of [
      "",
      "Checkout",
      "two words",
      "-leading",
      "trailing-",
      "double--hyphen",
      "under_score",
      "a".repeat(MAX_TAB_NAME_LENGTH + 1),
    ]) {
      expect(tabNameProblem(name)).toBeDefined();
    }
  });
});

describe("TabRegistry", () => {
  test("makes each added tab active and lists tabs in the order they opened", () => {
    const registry = new TabRegistry<string>();

    registry.add("main", "one");
    registry.add("checkout", "two");

    expect(registry.names()).toEqual(["main", "checkout"]);
    expect(registry.active()).toBe("checkout");
  });

  test("switches the active tab by name and refuses an unknown name", () => {
    const registry = new TabRegistry<string>();
    registry.add("main", "one");
    registry.add("checkout", "two");

    expect(registry.activate("main")).toBe("one");
    expect(registry.active()).toBe("main");
    expect(() => registry.activate("missing")).toThrow(
      'No tab named "missing". Open tabs: main, checkout.',
    );
  });

  test("refuses a duplicate name and an invalid one", () => {
    const registry = new TabRegistry<string>();
    registry.add("main", "one");

    expect(() => registry.add("main", "again")).toThrow('A tab named "main" is already open.');
    expect(() => registry.add("Not Valid", "x")).toThrow("lowercase words");
  });

  test("refuses to open more tabs than the cap and names the way out", () => {
    const registry = new TabRegistry<number>();
    for (let index = 0; index < MAX_TABS; index += 1) {
      registry.add(`tab-${String(index)}`, index);
    }

    expect(() => registry.add("one-too-many", 99)).toThrow(
      `already has ${String(MAX_TABS)} tabs open`,
    );
    expect(registry.size).toBe(MAX_TABS);
  });

  test("lets a closed tab's slot be used again", () => {
    const registry = new TabRegistry<number>(2);
    registry.add("a", 1);
    registry.add("b", 2);

    registry.remove("a");
    registry.add("c", 3);

    expect(registry.names()).toEqual(["b", "c"]);
  });

  test("moves the active tab to the most recently opened one when the active tab closes", () => {
    const registry = new TabRegistry<string>();
    registry.add("one", "1");
    registry.add("two", "2");
    registry.add("three", "3");
    registry.activate("one");

    registry.remove("one");

    expect(registry.active()).toBe("three");
  });

  test("leaves the active tab alone when another tab closes", () => {
    const registry = new TabRegistry<string>();
    registry.add("one", "1");
    registry.add("two", "2");

    registry.remove("one");

    expect(registry.active()).toBe("two");
  });

  test("has no active tab once the last one closes", () => {
    const registry = new TabRegistry<string>();
    registry.add("only", "x");

    registry.remove("only");

    expect(registry.active()).toBeUndefined();
    expect(() => registry.activate("only")).toThrow("no tab is open");
  });
});

describe("RefTable", () => {
  const refs = new Map([["e1", { backendNodeId: 7, label: 'button "Save"' }]]);

  test("finds a ref from the latest snapshot", () => {
    const table = new RefTable();
    table.replace(refs);

    expect(table.lookup("e1")).toEqual({ kind: "ok", backendNodeId: 7, label: 'button "Save"' });
  });

  test("reports a ref the snapshot never had as missing", () => {
    const table = new RefTable();
    table.replace(refs);

    expect(table.lookup("e9")).toEqual({ kind: "missing" });
  });

  test("reports every ref as stale after the page navigates, until the next snapshot", () => {
    const table = new RefTable();
    table.replace(refs);

    table.invalidate();

    expect(table.lookup("e1")).toEqual({ kind: "stale" });
    table.replace(refs);
    expect(table.lookup("e1").kind).toBe("ok");
  });
});

describe("matchAdoptionCandidates", () => {
  const candidates = [
    { page: "a", title: "Inbox (3) - Mail", url: "https://mail.example.com/u/0" },
    { page: "b", title: "Checkout", url: "https://shop.example.com/cart" },
    { page: "c", title: "Docs", url: "https://docs.example.com/" },
  ];

  test("matches the title or the address, ignoring case", () => {
    expect(matchAdoptionCandidates(candidates, "CHECKOUT").map((found) => found.page)).toEqual([
      "b",
    ]);
    expect(matchAdoptionCandidates(candidates, "shop.example").map((found) => found.page)).toEqual([
      "b",
    ]);
  });

  test("returns every tab a broad hint matches, so a caller can refuse an ambiguous one", () => {
    expect(matchAdoptionCandidates(candidates, "example.com")).toHaveLength(3);
  });

  test("matches nothing for an empty or blank hint", () => {
    expect(matchAdoptionCandidates(candidates, "")).toEqual([]);
    expect(matchAdoptionCandidates(candidates, "   ")).toEqual([]);
  });
});
