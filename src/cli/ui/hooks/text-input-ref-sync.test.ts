import { describe, expect, test } from "bun:test";
import {
  computeTextInputRefSync,
  type RefSyncState,
  type RefSyncInput,
} from "./text-input-ref-sync";

function state(overrides: Partial<RefSyncState> = {}): RefSyncState {
  return {
    valueRef: "",
    cursorRef: 0,
    lastSentValue: null,
    lastSentCursor: null,
    previousValue: "",
    previousCursor: 0,
    ...overrides,
  };
}

function input(value: string, cursor: number, state: RefSyncState): RefSyncInput {
  return { value, cursor, state };
}

describe("computeTextInputRefSync", () => {
  describe("no pending (lastSentValue === null)", () => {
    test("syncs refs from props", () => {
      const result = computeTextInputRefSync(
        input("hello", 5, state({ valueRef: "", cursorRef: 0 })),
      );
      expect(result.valueRef).toBe("hello");
      expect(result.cursorRef).toBe(5);
      expect(result.lastSentValue).toBe(null);
      expect(result.lastSentCursor).toBe(null);
    });

    test("overwrites refs when props change (e.g. external reset)", () => {
      const result = computeTextInputRefSync(
        input("", 0, state({ valueRef: "old", cursorRef: 3 })),
      );
      expect(result.valueRef).toBe("");
      expect(result.cursorRef).toBe(0);
    });
  });

  describe("pending and state caught up (value === lastSentValue)", () => {
    test("syncs refs and clears pending", () => {
      const result = computeTextInputRefSync(
        input("ab", 2, state({
          valueRef: "ab",
          cursorRef: 2,
          lastSentValue: "ab",
          lastSentCursor: 2,
          previousValue: "a",
          previousCursor: 1,
        })),
      );
      expect(result.valueRef).toBe("ab");
      expect(result.cursorRef).toBe(2);
      expect(result.lastSentValue).toBe(null);
      expect(result.lastSentCursor).toBe(null);
      expect(result.previousValue).toBe("ab");
      expect(result.previousCursor).toBe(2);
    });
  });

  describe("pending and state stale (value === previousValue)", () => {
    test("keeps refs so next key uses optimistic value (prevents reorder in long chats)", () => {
      // Simulate: user typed "a" then "b"; we sent "ab", but React re-rendered with stale value "a"
      const result = computeTextInputRefSync(
        input("a", 1, state({
          valueRef: "ab",
          cursorRef: 2,
          lastSentValue: "ab",
          lastSentCursor: 2,
          previousValue: "a",
          previousCursor: 1,
        })),
      );
      expect(result.valueRef).toBe("ab");
      expect(result.cursorRef).toBe(2);
      expect(result.lastSentValue).toBe("ab");
      expect(result.lastSentCursor).toBe(2);
    });

    test("keeps refs when cursor is also stale", () => {
      const result = computeTextInputRefSync(
        input("", 0, state({
          valueRef: "a",
          cursorRef: 1,
          lastSentValue: "a",
          lastSentCursor: 1,
          previousValue: "",
          previousCursor: 0,
        })),
      );
      expect(result.valueRef).toBe("a");
      expect(result.cursorRef).toBe(1);
    });
  });

  describe("pending and external update (value differs from both)", () => {
    test("syncs refs and clears pending (e.g. command suggestion)", () => {
      const result = computeTextInputRefSync(
        input("/help ", 6, state({
          valueRef: "ab",
          cursorRef: 2,
          lastSentValue: "ab",
          lastSentCursor: 2,
          previousValue: "a",
          previousCursor: 1,
        })),
      );
      expect(result.valueRef).toBe("/help ");
      expect(result.cursorRef).toBe(6);
      expect(result.lastSentValue).toBe(null);
      expect(result.lastSentCursor).toBe(null);
      expect(result.previousValue).toBe("/help ");
      expect(result.previousCursor).toBe(6);
    });

    test("syncs when value is empty (e.g. prompt reset)", () => {
      const result = computeTextInputRefSync(
        input("", 0, state({
          valueRef: "typed",
          cursorRef: 5,
          lastSentValue: "typed",
          lastSentCursor: 5,
          previousValue: "ty",
          previousCursor: 2,
        })),
      );
      expect(result.valueRef).toBe("");
      expect(result.cursorRef).toBe(0);
      expect(result.lastSentValue).toBe(null);
    });
  });

  describe("useTextInput behavior: rapid typing and external updates", () => {
    test("rapid typing: display value never reverts when re-renders have stale state", () => {
      // Simulate: user types "a", "b" quickly; re-renders (logs/stream) run with stale value between keys.
      // Ref-sync must keep refs so displayValue (valueRef) never reverts.

      // User typed "a": handler set valueRef="a", lastSent="a", previous=""
      let s: RefSyncState = state({
        valueRef: "a",
        cursorRef: 1,
        lastSentValue: "a",
        lastSentCursor: 1,
        previousValue: "",
        previousCursor: 0,
      });
      // Re-render with stale value "" (setState("a") not committed yet)
      let result = computeTextInputRefSync(input("", 0, s));
      expect(result.valueRef).toBe("a");
      expect(result.lastSentValue).toBe("a");

      // User typed "b": handler set valueRef="ab", lastSent="ab", previous="a"
      s = state({
        valueRef: "ab",
        cursorRef: 2,
        lastSentValue: "ab",
        lastSentCursor: 2,
        previousValue: "a",
        previousCursor: 1,
      });
      // Re-render with stale value "a"
      result = computeTextInputRefSync(input("a", 1, s));
      expect(result.valueRef).toBe("ab");
      expect(result.lastSentValue).toBe("ab");

      // Re-render with state caught up "ab"
      s = {
        valueRef: result.valueRef,
        cursorRef: result.cursorRef,
        lastSentValue: result.lastSentValue,
        lastSentCursor: result.lastSentCursor,
        previousValue: result.previousValue,
        previousCursor: result.previousCursor,
      };
      result = computeTextInputRefSync(input("ab", 2, s));
      expect(result.valueRef).toBe("ab");
      expect(result.lastSentValue).toBe(null);
    });

    test("external update after rapid typing: syncs to new value (e.g. command suggestion)", () => {
      // State: user had typed "ab", then selects command "/help " from suggestions
      const s = state({
        valueRef: "ab",
        cursorRef: 2,
        lastSentValue: "ab",
        lastSentCursor: 2,
        previousValue: "a",
        previousCursor: 1,
      });
      const result = computeTextInputRefSync(input("/help ", 6, s));
      expect(result.valueRef).toBe("/help ");
      expect(result.cursorRef).toBe(6);
      expect(result.lastSentValue).toBe(null);
      expect(result.lastSentCursor).toBe(null);
    });

    test("rapid typing then stale then external: display never shows stale, then shows external", () => {
      const s: RefSyncState = state({
        valueRef: "hello",
        cursorRef: 5,
        lastSentValue: "hello",
        lastSentCursor: 5,
        previousValue: "hell",
        previousCursor: 4,
      });

      // Stale render (value "hell" – our setState("hello") not committed)
      const stale = computeTextInputRefSync(input("hell", 4, s));
      expect(stale.valueRef).toBe("hello");

      // External update (e.g. prompt reset to "") – sync to new value
      const afterStale: RefSyncState = {
        valueRef: stale.valueRef,
        cursorRef: stale.cursorRef,
        lastSentValue: stale.lastSentValue,
        lastSentCursor: stale.lastSentCursor,
        previousValue: stale.previousValue,
        previousCursor: stale.previousCursor,
      };
      const external = computeTextInputRefSync(input("", 0, afterStale));
      expect(external.valueRef).toBe("");
      expect(external.lastSentValue).toBe(null);
    });
  });
});
