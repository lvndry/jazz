import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { conversationKey, isIncognito, setIncognito, startNewConversation } from "./sessions";

const CHANNEL = "123456789012345678";
const OTHER = "223456789012345678";

describe("sessions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-discord-sessions-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("conversationKey / startNewConversation", () => {
    it("defaults to the raw channel id before any /new", () => {
      expect(conversationKey(tmpDir, CHANNEL)).toBe(CHANNEL);
    });

    it("rotates to a new key each time /new is called", () => {
      startNewConversation(tmpDir, CHANNEL);
      expect(conversationKey(tmpDir, CHANNEL)).toBe(`${CHANNEL}-1`);
      startNewConversation(tmpDir, CHANNEL);
      expect(conversationKey(tmpDir, CHANNEL)).toBe(`${CHANNEL}-2`);
    });

    it("keeps other channels' epochs isolated", () => {
      startNewConversation(tmpDir, CHANNEL);
      expect(conversationKey(tmpDir, OTHER)).toBe(OTHER);
    });
  });

  describe("isIncognito / setIncognito", () => {
    it("defaults to false", () => {
      expect(isIncognito(tmpDir, CHANNEL)).toBe(false);
    });

    it("turns on and off independently per channel", () => {
      setIncognito(tmpDir, CHANNEL, true);
      expect(isIncognito(tmpDir, CHANNEL)).toBe(true);
      expect(isIncognito(tmpDir, OTHER)).toBe(false);

      setIncognito(tmpDir, CHANNEL, false);
      expect(isIncognito(tmpDir, CHANNEL)).toBe(false);
    });

    it("never writes conversation content to disk — only the boolean flag", () => {
      setIncognito(tmpDir, CHANNEL, true);
      const raw = fs.readFileSync(path.join(tmpDir, "dc-incognito.json"), "utf8");
      expect(JSON.parse(raw)).toEqual({ [CHANNEL]: true });
    });

    it("preserves an unparsable file instead of clobbering other channels' flags", () => {
      const filePath = path.join(tmpDir, "dc-incognito.json");
      fs.writeFileSync(filePath, "not json");

      setIncognito(tmpDir, CHANNEL, true);

      expect(fs.existsSync(`${filePath}.corrupt`)).toBe(true);
      expect(isIncognito(tmpDir, CHANNEL)).toBe(true);
    });
  });
});
