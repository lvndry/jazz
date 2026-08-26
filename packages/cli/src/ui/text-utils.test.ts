import { describe, expect, it } from "bun:test";
import { findNextWordBoundary, findPrevWordBoundary, isWordChar } from "./text-utils";

describe("text-utils", () => {
  describe("isWordChar", () => {
    it("should return true for letters", () => {
      expect(isWordChar("a")).toBe(true);
      expect(isWordChar("z")).toBe(true);
      expect(isWordChar("A")).toBe(true);
      expect(isWordChar("Z")).toBe(true);
    });

    it("should return true for digits", () => {
      expect(isWordChar("0")).toBe(true);
      expect(isWordChar("9")).toBe(true);
    });

    it("should return true for underscore", () => {
      expect(isWordChar("_")).toBe(true);
    });

    it("should return false for spaces", () => {
      expect(isWordChar(" ")).toBe(false);
      expect(isWordChar("\t")).toBe(false);
    });

    it("should return false for punctuation", () => {
      expect(isWordChar(".")).toBe(false);
      expect(isWordChar(",")).toBe(false);
      expect(isWordChar("-")).toBe(false);
      expect(isWordChar("/")).toBe(false);
    });
  });

  describe("findPrevWordBoundary", () => {
    it("should return 0 when at start", () => {
      expect(findPrevWordBoundary("hello world", 0)).toBe(0);
    });

    it("should find start of current word when in middle", () => {
      expect(findPrevWordBoundary("hello world", 8)).toBe(6); // In "world" -> start of "world"
    });

    it("should find start of previous word when at word boundary", () => {
      // At the end of "world" (position 11), should go to start of "world" (position 6)
      expect(findPrevWordBoundary("hello world", 11)).toBe(6);
    });

    it("should skip spaces to previous word", () => {
      // At space between words, should go to start of "hello"
      expect(findPrevWordBoundary("hello world", 5)).toBe(0);
    });

    it("should handle multiple spaces", () => {
      expect(findPrevWordBoundary("hello   world", 8)).toBe(0); // In spaces -> hello
    });

    it("should handle empty string", () => {
      expect(findPrevWordBoundary("", 0)).toBe(0);
    });

    it("should handle single word", () => {
      expect(findPrevWordBoundary("hello", 5)).toBe(0);
      expect(findPrevWordBoundary("hello", 3)).toBe(0);
    });
  });

  describe("findNextWordBoundary", () => {
    it("should return length when at end", () => {
      expect(findNextWordBoundary("hello world", 11)).toBe(11);
    });

    it("should find end of current word when in middle", () => {
      expect(findNextWordBoundary("hello world", 2)).toBe(5); // In "hello" -> end of "hello"
    });

    it("should skip spaces to next word end", () => {
      expect(findNextWordBoundary("hello world", 5)).toBe(11); // At end of "hello" -> end of "world"
    });

    it("should find end of first word from start", () => {
      expect(findNextWordBoundary("hello world", 0)).toBe(5);
    });

    it("should handle multiple spaces", () => {
      expect(findNextWordBoundary("hello   world", 5)).toBe(13); // After "hello" -> end of "world"
    });

    it("should handle empty string", () => {
      expect(findNextWordBoundary("", 0)).toBe(0);
    });

    it("should handle single word", () => {
      expect(findNextWordBoundary("hello", 0)).toBe(5);
      expect(findNextWordBoundary("hello", 2)).toBe(5);
    });
  });

  describe("word boundary edge cases", () => {
    it("should handle punctuation as non-word chars", () => {
      // "hello.world" - dot is non-word, so we have two words
      expect(findNextWordBoundary("hello.world", 0)).toBe(5);
      expect(findPrevWordBoundary("hello.world", 11)).toBe(6);
    });

    it("should handle paths", () => {
      // "/Users/foo/bar" - slashes are non-word chars
      expect(findNextWordBoundary("/Users/foo/bar", 0)).toBe(6); // "Users"
      expect(findPrevWordBoundary("/Users/foo/bar", 14)).toBe(11); // "bar"
    });

    it("should handle snake_case as single word", () => {
      // Underscores are word chars, so snake_case is one word
      expect(findNextWordBoundary("hello_world foo", 0)).toBe(11);
      expect(findPrevWordBoundary("foo hello_world", 15)).toBe(4);
    });

    it("should handle camelCase as single word", () => {
      // No uppercase detection, so camelCase is one word
      expect(findNextWordBoundary("helloWorld foo", 0)).toBe(10);
    });

    it("should handle numbers in words", () => {
      expect(findNextWordBoundary("test123 foo", 0)).toBe(7);
      expect(findPrevWordBoundary("foo test123", 11)).toBe(4);
    });
  });
});
