import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { conversationKey, isIncognito, setIncognito, startNewConversation } from "./session-store";

const EPOCHS_FILE = "tg-sessions.json";
const INCOGNITO_FILE = "tg-incognito.json";
const SCOPE = "123456789012345678";
const OTHER = "223456789012345678";

describe("session store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-session-store-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("conversationKey / startNewConversation", () => {
    it("defaults to the raw scope id before any /new", () => {
      expect(conversationKey(tmpDir, EPOCHS_FILE, SCOPE)).toBe(SCOPE);
    });

    it("rotates to a new key each time /new is called", () => {
      startNewConversation(tmpDir, EPOCHS_FILE, SCOPE);
      expect(conversationKey(tmpDir, EPOCHS_FILE, SCOPE)).toBe(`${SCOPE}-1`);
      startNewConversation(tmpDir, EPOCHS_FILE, SCOPE);
      expect(conversationKey(tmpDir, EPOCHS_FILE, SCOPE)).toBe(`${SCOPE}-2`);
    });

    it("keeps other conversations' epochs isolated", () => {
      startNewConversation(tmpDir, EPOCHS_FILE, SCOPE);
      expect(conversationKey(tmpDir, EPOCHS_FILE, OTHER)).toBe(OTHER);
    });
  });

  describe("isIncognito / setIncognito", () => {
    it("defaults to false", () => {
      expect(isIncognito(tmpDir, INCOGNITO_FILE, SCOPE)).toBe(false);
    });

    it("turns on and off independently per conversation", () => {
      setIncognito(tmpDir, INCOGNITO_FILE, SCOPE, true);
      expect(isIncognito(tmpDir, INCOGNITO_FILE, SCOPE)).toBe(true);
      expect(isIncognito(tmpDir, INCOGNITO_FILE, OTHER)).toBe(false);

      setIncognito(tmpDir, INCOGNITO_FILE, SCOPE, false);
      expect(isIncognito(tmpDir, INCOGNITO_FILE, SCOPE)).toBe(false);
    });

    it("never writes conversation content to disk — only the boolean flag", () => {
      setIncognito(tmpDir, INCOGNITO_FILE, SCOPE, true);
      const raw = fs.readFileSync(path.join(tmpDir, INCOGNITO_FILE), "utf8");
      expect(JSON.parse(raw)).toEqual({ [SCOPE]: true });
    });

    it("preserves an unparsable file instead of clobbering other conversations' flags", () => {
      const filePath = path.join(tmpDir, INCOGNITO_FILE);
      fs.writeFileSync(filePath, "not json");

      setIncognito(tmpDir, INCOGNITO_FILE, SCOPE, true);

      expect(fs.existsSync(`${filePath}.corrupt`)).toBe(true);
      expect(isIncognito(tmpDir, INCOGNITO_FILE, SCOPE)).toBe(true);
    });
  });
});
