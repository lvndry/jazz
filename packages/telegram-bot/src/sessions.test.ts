import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { conversationKey, isIncognito, setIncognito, startNewConversation } from "./sessions";

describe("sessions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-telegram-sessions-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("conversationKey / startNewConversation", () => {
    it("defaults to the raw chat id before any /new", () => {
      expect(conversationKey(tmpDir, 42)).toBe("42");
    });

    it("rotates to a new key each time /new is called", () => {
      startNewConversation(tmpDir, 42);
      expect(conversationKey(tmpDir, 42)).toBe("42-1");
      startNewConversation(tmpDir, 42);
      expect(conversationKey(tmpDir, 42)).toBe("42-2");
    });

    it("keeps other chats' epochs isolated", () => {
      startNewConversation(tmpDir, 42);
      expect(conversationKey(tmpDir, 99)).toBe("99");
    });
  });

  describe("isIncognito / setIncognito", () => {
    it("defaults to false", () => {
      expect(isIncognito(tmpDir, 42)).toBe(false);
    });

    it("turns on and off independently per chat", () => {
      setIncognito(tmpDir, 42, true);
      expect(isIncognito(tmpDir, 42)).toBe(true);
      expect(isIncognito(tmpDir, 99)).toBe(false);

      setIncognito(tmpDir, 42, false);
      expect(isIncognito(tmpDir, 42)).toBe(false);
    });

    it("never writes conversation content to disk — only the boolean flag", () => {
      setIncognito(tmpDir, 42, true);
      const raw = fs.readFileSync(path.join(tmpDir, "tg-incognito.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({ "42": true });
    });

    it("preserves an unparsable file instead of clobbering other chats' flags", () => {
      const filePath = path.join(tmpDir, "tg-incognito.json");
      fs.writeFileSync(filePath, "not json");

      setIncognito(tmpDir, 42, true);

      expect(fs.existsSync(`${filePath}.corrupt`)).toBe(true);
      expect(isIncognito(tmpDir, 42)).toBe(true);
    });
  });
});
