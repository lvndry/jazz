import { describe, expect, it } from "bun:test";
import { generateConversationId, generateSessionId } from "./manager";

describe("Session Manager", () => {
  describe("generateSessionId", () => {
    it("should include agent name as prefix", () => {
      const sessionId = generateSessionId("test-agent");
      expect(sessionId.startsWith("test-agent-")).toBe(true);
    });

    it("should follow format: agentName-YYYYMMDD-HHmmss", () => {
      const sessionId = generateSessionId("myagent");
      // Format: myagent-YYYYMMDD-HHmmss
      expect(sessionId).toMatch(/^myagent-\d{8}-\d{6}$/);
    });

    it("should handle agent names with special characters", () => {
      const sessionId = generateSessionId("my-cool-agent");
      expect(sessionId.startsWith("my-cool-agent-")).toBe(true);
    });

    it("should handle empty agent name", () => {
      const sessionId = generateSessionId("");
      // Should still have the date format
      expect(sessionId).toMatch(/^-\d{8}-\d{6}$/);
    });

    it("should generate different session IDs for different agents", () => {
      const id1 = generateSessionId("agent1");
      const id2 = generateSessionId("agent2");
      expect(id1).not.toBe(id2);
    });

    it("should generate consistent date format", () => {
      const sessionId = generateSessionId("test");
      const parts = sessionId.split("-");

      // test-YYYYMMDD-HHmmss splits into ["test", "YYYYMMDD", "HHmmss"]
      expect(parts.length).toBe(3);

      const datePart = parts[1];
      const timePart = parts[2];

      // Date should be 8 digits
      expect(datePart).toMatch(/^\d{8}$/);
      // Time should be 6 digits
      expect(timePart).toMatch(/^\d{6}$/);

      // Validate date is reasonable (year starts with 20)
      expect(datePart?.startsWith("20")).toBe(true);
    });
  });

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
