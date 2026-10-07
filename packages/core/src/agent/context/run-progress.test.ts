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

function toolResult(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
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
      toolResult("1", "1|hello"),
      toolCall("2", "grep", { path: "/repo/ansible", pattern: "docker" }),
      toolResult("2", "found"),
      // Re-read of the same file is not repeated.
      toolCall("3", "read_file", { path: "/ksyl/patches/a.sh.patch" }),
      toolResult("3", "1|hello"),
      toolCall("4", "read_file", { path: "/ksyl/patches/b.sh.patch" }),
      toolResult("4", "1|world"),
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
    const messages: ChatMessage[] = [
      ...Array.from({ length: 20 }, (_, i): ChatMessage =>
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

  it("tracks a tool call with no recorded result as covered", () => {
    // The result is outside the kept window (the split dropped it); the call is
    // still evidence the file was handled.
    const progress = extractRunProgress([
      toolCall("1", "read_file", { path: "/x.txt" }),
      toolCall("2", "execute_command", { command: "git status" }),
      userMessage("thanks"),
    ]);
    expect(progress.filesRead).toEqual(["/x.txt"]);
    expect(progress.summary).toContain("git status");
    expect(progress.lastAction).toContain("execute_command");
  });

  it("does not count a failed call as covered", () => {
    const progress = extractRunProgress([
      toolCall("1", "read_file", { path: "/missing.txt" }),
      toolResult("1", "error: File not found"),
      toolCall("2", "read_file", { path: "/ok.txt" }),
      toolResult("2", "1|fine"),
    ]);
    expect(progress.filesRead).toEqual(["/ok.txt"]);
  });

  it("tracks plugin tools whose arguments use the *Path naming convention", () => {
    // No tool-name list to maintain: any path-shaped argument is tracked.
    const progress = extractRunProgress([
      toolCall("1", "myplugin__read_log", { log_path: "/var/log/app.log" }),
      toolResult("1", "log lines"),
      toolCall("2", "myplugin__list", { filter: "app" }),
      toolResult("2", "entries"),
    ]);
    expect(progress.filesRead).toEqual(["/var/log/app.log"]);
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
      toolResult("2", "1|y"),
    ];
    const progress = extractRunProgress(messages);
    expect(progress.filesRead).toEqual(["/y.txt"]);
  });
});
