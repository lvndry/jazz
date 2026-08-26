import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { describe, expect, it } from "bun:test";

describe("Session Manager", () => {
  describe("generateConversationId", () => {
    it("should generate unique IDs", () => {
      const id1 = generateConversationId();
      const id2 = generateConversationId();
      expect(id1).not.toBe(id2);
    });

    it("should generate many unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateConversationId());
      }
      expect(ids.size).toBe(100);
    });

    it("should return a string", () => {
      const id = generateConversationId();
      expect(typeof id).toBe("string");
    });

    it("should have reasonable length for short-uuid", () => {
      const id = generateConversationId();
      // short-uuid typically generates 22-character strings
      expect(id.length).toBeGreaterThanOrEqual(10);
      expect(id.length).toBeLessThanOrEqual(30);
    });

    it("should only contain URL-safe characters", () => {
      const id = generateConversationId();
      // short-uuid uses flickrBase58 by default which is alphanumeric
      expect(id).toMatch(/^[a-zA-Z0-9]+$/);
    });
  });
});
