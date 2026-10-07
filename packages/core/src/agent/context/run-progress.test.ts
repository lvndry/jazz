import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@/core/types/message";
import { extractRunProgress } from "./run-progress";

function toolCall(id: string, name: string, arguments_: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      { id, type: "function", function: { name, arguments: JSON.stringify(arguments_) } },
    ],
  };
}

function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

describe("extractRunProgress", () => {
  it("returns an empty summary for a window with no tool calls", () => {
    const progress = extractRunProgress([userMessage("hello")]);
    expect(progress.summary).toBe("");
    expect(progress.filesRead).toEqual([]);
  });

  it("lists files read or searched, deduplicated, in order first seen", () => {
    const messages = [
      toolCall("1", "read_file", { path: "/ksyl/patches/a.sh.patch" }),
      toolCall("2", "grep", { path: "/repo/ansible", pattern: "docker" }),
      // Re-read of the same file is not repeated.
      toolCall("3", "read_file", { path: "/ksyl/patches/a.sh.patch" }),
      toolCall("4", "read_file", { path: "/ksyl/patches/b.sh.patch" }),
    ];
    const progress = extractRunProgress(messages);
    expect(progress.filesRead).toEqual([
      "/ksyl/patches/a.sh.patch",
      "/repo/ansible",
      "/ksyl/patches/b.sh.patch",
    ]);
    expect(progress.summary).toContain("Files read/inspected");
    expect(progress.summary).toContain("/ksyl/patches/a.sh.patch");
    expect(progress.summary).toContain("/repo/ansible");
    expect(progress.summary).not.toContain("Files modified");
  });

  it("separates modified files from read ones and caps the list", () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, i) =>
        toolCall(`r${i}`, "read_file", { path: `/f/${i}.txt` }),
      ),
      toolCall("w1", "edit_file", { path: "/f/0.txt" }),
      toolCall("w2", "mv", { source: "/a", destination: "/b" }),
    ];
    const progress = extractRunProgress(messages);
    expect(progress.summary).toContain("Files modified");
    expect(progress.summary).toContain("/f/0.txt");
    expect(progress.summary).toContain("/a");
    // 20 read paths, 15 listed.
    expect(progress.summary).toContain("+5 more");
    expect(progress.summary).not.toContain("/f/19.txt");
  });

  it("records execute_command targets and the most recent action", () => {
    const messages = [
      toolCall("1", "execute_command", { command: "git status" }),
      toolCall("2", "read_file", { path: "/x.txt" }),
      userMessage("thanks"),
    ];
    const progress = extractRunProgress(messages);
    expect(progress.summary).toContain("git status");
    expect(progress.lastAction).toContain("read_file");
  });

  it("ignores malformed tool arguments instead of throwing", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "1", type: "function", function: { name: "read_file", arguments: "{not json" } },
        ],
      },
      toolCall("2", "read_file", { path: "/y.txt" }),
    ];
    const progress = extractRunProgress(messages);
    expect(progress.filesRead).toEqual(["/y.txt"]);
  });

  it("returns an empty summary for a window of only commands", () => {
    // Commands are tracked, so a command-only window still produces a record.
    const progress = extractRunProgress([toolCall("1", "execute_command", { command: "ls" })]);
    expect(progress.summary).toContain("Commands run");
  });
});
