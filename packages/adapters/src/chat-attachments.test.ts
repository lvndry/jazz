import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachChat, detachChat, heldByChatElsewhere } from "./chat-attachments";

let attachments: string;

beforeEach(() => {
  attachments = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-chat-attachments-test-"));
});

afterEach(() => {
  fs.rmSync(attachments, { recursive: true, force: true });
});

function attachAs(owner: { readonly pid: number; readonly host: string }): void {
  fs.mkdirSync(path.join(attachments, "agent-1"), { recursive: true });
  fs.writeFileSync(path.join(attachments, "agent-1", "conv-1.json"), JSON.stringify(owner));
}

async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("chat attachments", () => {
  test("this process's own attachment does not hold the conversation against itself", () => {
    attachChat("agent-1", "conv-1", attachments);
    expect(heldByChatElsewhere("agent-1", "conv-1", attachments)).toBe(false);
  });

  test("a live chat in another process holds its conversation, and only that one", () => {
    attachAs({ pid: process.ppid, host: os.hostname() });
    expect(heldByChatElsewhere("agent-1", "conv-1", attachments)).toBe(true);
    expect(heldByChatElsewhere("agent-1", "conv-2", attachments)).toBe(false);
    expect(heldByChatElsewhere("agent-2", "conv-1", attachments)).toBe(false);
  });

  test("a chat whose process died holds nothing", async () => {
    attachAs({ pid: await exitedPid(), host: os.hostname() });
    expect(heldByChatElsewhere("agent-1", "conv-1", attachments)).toBe(false);
  });

  test("a chat on another host holds nothing, since it cannot be checked from here", () => {
    attachAs({ pid: process.ppid, host: `${os.hostname()}-elsewhere` });
    expect(heldByChatElsewhere("agent-1", "conv-1", attachments)).toBe(false);
  });

  test("detaching removes only this process's attachment", () => {
    attachAs({ pid: process.ppid, host: os.hostname() });
    detachChat("agent-1", "conv-1", attachments);
    expect(heldByChatElsewhere("agent-1", "conv-1", attachments)).toBe(true);

    attachChat("agent-1", "conv-1", attachments);
    detachChat("agent-1", "conv-1", attachments);
    expect(fs.existsSync(path.join(attachments, "agent-1", "conv-1.json"))).toBe(false);
  });

  test("an unreadable attachment holds nothing", () => {
    fs.mkdirSync(path.join(attachments, "agent-1"), { recursive: true });
    fs.writeFileSync(path.join(attachments, "agent-1", "conv-1.json"), "{not json");
    expect(heldByChatElsewhere("agent-1", "conv-1", attachments)).toBe(false);
  });
});
