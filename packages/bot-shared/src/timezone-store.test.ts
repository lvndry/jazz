import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BOT_DEFAULT_TIMEZONE_ENV, chatZone, hasChatTz, setTzForChat } from "./timezone-store";

const FILE = "test-tz.json";

describe("a conversation's zone", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-tz-test-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("a chat that never ran /tz has no zone, whatever the server's TZ is", () => {
    expect(chatZone(dataDir, FILE, 1, { TZ: "Asia/Tokyo" })).toBeUndefined();
    expect(hasChatTz(dataDir, FILE, 1)).toBe(false);
  });

  test("a stored /tz choice is the chat setting", () => {
    setTzForChat(dataDir, FILE, 1, "Europe/Paris");
    expect(chatZone(dataDir, FILE, 1, { TZ: "Asia/Tokyo" })).toEqual({
      zone: "Europe/Paris",
      source: "chat-setting",
    });
    expect(chatZone(dataDir, FILE, 2, {})).toBeUndefined();
  });

  test("the operator's explicit default applies to chats with no choice", () => {
    expect(chatZone(dataDir, FILE, 1, { [BOT_DEFAULT_TIMEZONE_ENV]: "America/Chicago" })).toEqual({
      zone: "America/Chicago",
      source: "user-config",
    });
  });

  test("an invalid operator default is ignored", () => {
    expect(chatZone(dataDir, FILE, 1, { [BOT_DEFAULT_TIMEZONE_ENV]: "Nowhere" })).toBeUndefined();
  });
});
