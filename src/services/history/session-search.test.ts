import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import { formatRelativeWhen, search } from "./session-search";
import {
  getSessionLogPath,
  recordSessionTranscript,
  resetSessionAppendCache,
} from "./session-store";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-session-search-test-"));
  resetSessionAppendCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetSessionAppendCache();
});

function runEffect<A>(eff: Effect.Effect<A, unknown, NodeFileSystem.NodeFileSystem["Type"]>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

async function writeSession(
  conversationId: string,
  lines: readonly string[],
  options: { readonly title?: string; readonly modifiedAtMs?: number } = {},
): Promise<string> {
  const messages: ChatMessage[] = lines.map((content, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content,
  }));
  const sessionId = await runEffect(
    recordSessionTranscript(
      {
        agentId: "agent-1",
        conversationId,
        title: options.title ?? "",
        startedAt: "2026-08-01T10:00:00.000Z",
        endedAt: null,
        messages,
      },
      tmpDir,
    ),
  );
  if (options.modifiedAtMs !== undefined) {
    const seconds = options.modifiedAtMs / 1000;
    fs.utimesSync(getSessionLogPath(sessionId, tmpDir), seconds, seconds);
  }
  return sessionId;
}

/** What the renderer does before it indexes the line, so hits must already be in this form. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function markedText(line: string, matchStart: number, matchLength: number): string {
  return [...line].slice(matchStart, matchStart + matchLength).join("");
}

describe("search", () => {
  test("returns nothing for a blank query", async () => {
    await writeSession("conv-1", ["the Basel workshop dates did not move"]);
    expect(await search("   ", { scope: "all", dir: tmpDir })).toEqual([]);
  });

  test("matches case-insensitively", async () => {
    await writeSession("conv-1", ["the Basel workshop dates did not move"]);
    const hits = await search("basel", { scope: "all", dir: tmpDir });
    expect(hits).toHaveLength(1);
    expect(
      markedText(hits[0]?.line ?? "", hits[0]?.matchStart ?? 0, hits[0]?.matchLength ?? 0),
    ).toBe("Basel");
  });

  test("marks exactly the matched span", async () => {
    await writeSession("conv-1", ["book the Basel flights before prices move"]);
    const [hit] = await search("Basel", { scope: "all", dir: tmpDir });
    expect(hit?.line).toBe("book the Basel flights before prices move");
    expect(hit?.matchStart).toBe(9);
    expect(hit?.matchLength).toBe(5);
  });

  test("indices are code points, so astral characters do not shift the mark", async () => {
    await writeSession("conv-1", ["🎷🎺 the Basel workshop"]);
    const [hit] = await search("basel", { scope: "all", dir: tmpDir });
    expect(markedText(hit?.line ?? "", hit?.matchStart ?? 0, hit?.matchLength ?? 0)).toBe("Basel");
  });

  test("returns lines already whitespace-collapsed, matching how they are rendered", async () => {
    await writeSession("conv-1", ["  the   Basel\tworkshop  "]);
    const [hit] = await search("basel", { scope: "all", dir: tmpDir });
    expect(hit?.line).toBe(oneLine(hit?.line ?? ""));
    expect(markedText(hit?.line ?? "", hit?.matchStart ?? 0, hit?.matchLength ?? 0)).toBe("Basel");
  });

  test("slides the window on a long line and keeps the indices aligned", async () => {
    const longLine = `${"filler words ".repeat(60)}Basel${" trailing words".repeat(60)}`;
    await writeSession("conv-1", [longLine]);
    const [hit] = await search("Basel", { scope: "all", dir: tmpDir });
    expect([...(hit?.line ?? "")].length).toBeLessThanOrEqual(200);
    expect(markedText(hit?.line ?? "", hit?.matchStart ?? 0, hit?.matchLength ?? 0)).toBe("Basel");
  });

  test("finds every matching line of a multi-line message", async () => {
    await writeSession("conv-1", ["Basel first\nnothing here\nBasel again"]);
    const hits = await search("basel", { scope: "all", dir: tmpDir });
    expect(hits.map((hit) => hit.line)).toEqual(["Basel first", "Basel again"]);
  });

  test("puts current-session hits before older sessions", async () => {
    await writeSession("conv-old", ["Basel is the only trip left this quarter"], {
      modifiedAtMs: Date.now(),
    });
    const currentSessionId = await writeSession("conv-current", ["the Basel workshop dates"], {
      modifiedAtMs: Date.now() - 60 * 60 * 1000,
    });

    const hits = await search("basel", { scope: "all", currentSessionId, dir: tmpDir });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.sessionId).toBe(currentSessionId);
    expect(hits[0]?.current).toBe(true);
    expect(hits[1]?.current).toBe(false);
  });

  test("orders the remaining sessions by how recently they were written", async () => {
    const now = Date.now();
    await writeSession("conv-older", ["Basel older"], { modifiedAtMs: now - 3 * 86_400_000 });
    await writeSession("conv-newer", ["Basel newer"], { modifiedAtMs: now - 86_400_000 });
    const hits = await search("basel", { scope: "all", dir: tmpDir });
    expect(hits.map((hit) => hit.line)).toEqual(["Basel newer", "Basel older"]);
  });

  test("session scope looks only at the current session", async () => {
    await writeSession("conv-other", ["Basel elsewhere"]);
    const currentSessionId = await writeSession("conv-current", ["Basel here"]);

    const hits = await search("basel", { scope: "session", currentSessionId, dir: tmpDir });
    expect(hits.map((hit) => hit.line)).toEqual(["Basel here"]);
  });

  test("session scope with no current session finds nothing", async () => {
    await writeSession("conv-1", ["Basel somewhere"]);
    expect(await search("basel", { scope: "session", dir: tmpDir })).toEqual([]);
  });

  test("honours the limit", async () => {
    await writeSession("conv-1", ["Basel one\nBasel two\nBasel three"]);
    const hits = await search("basel", { scope: "all", dir: tmpDir, limit: 2 });
    expect(hits).toHaveLength(2);
  });

  test("uses the session title, and derives one when none was set", async () => {
    await writeSession("conv-titled", ["Basel one"], { title: "travel budget" });
    const [titled] = await search("basel", { scope: "all", dir: tmpDir });
    expect(titled?.sessionTitle).toBe("travel budget");

    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-session-search-test-"));
    resetSessionAppendCache();

    await writeSession("conv-untitled", ["plan the Basel trip"]);
    const [untitled] = await search("basel", { scope: "all", dir: tmpDir });
    expect(untitled?.sessionTitle).toBe("plan the Basel trip");
  });

  test("labels each hit with a short relative time", async () => {
    const now = Date.parse("2026-08-21T12:00:00.000Z");
    await writeSession("conv-1", ["Basel one"], { modifiedAtMs: now - 2 * 86_400_000 });
    const [hit] = await search("basel", { scope: "all", dir: tmpDir, now });
    expect(hit?.when).toBe("2d ago");
  });

  test("survives a history directory that does not exist", async () => {
    expect(await search("basel", { scope: "all", dir: path.join(tmpDir, "missing") })).toEqual([]);
  });

  test("ignores a log line a crash left half-written", async () => {
    const sessionId = await writeSession("conv-1", ["Basel one"]);
    fs.appendFileSync(
      getSessionLogPath(sessionId, tmpDir),
      '{"type":"message","at":"2026","message":{"role":"user","content":"Basel tr',
    );
    const hits = await search("basel", { scope: "all", dir: tmpDir });
    expect(hits.map((hit) => hit.line)).toEqual(["Basel one"]);
  });
});

describe("formatRelativeWhen", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");

  test("reads short at every scale", () => {
    expect(formatRelativeWhen(now, now)).toBe("now");
    expect(formatRelativeWhen(now - 30_000, now)).toBe("now");
    expect(formatRelativeWhen(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeWhen(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeWhen(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatRelativeWhen(now - 8 * 86_400_000, now)).toBe("1w ago");
    expect(formatRelativeWhen(now - 60 * 86_400_000, now)).toBe("2mo ago");
    expect(formatRelativeWhen(now - 400 * 86_400_000, now)).toBe("1y ago");
  });

  test("never reads as the future", () => {
    expect(formatRelativeWhen(now + 86_400_000, now)).toBe("now");
  });
});
