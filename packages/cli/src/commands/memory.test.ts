/**
 * Exercise lesson acceptance through the person-facing CLI with the real memory store.
 * Agent-started commands must leave proposals pending; a person can still accept them.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { MemoryServiceImpl } from "@jazz/adapters/memory-service";
import { MemoryServiceTag } from "@jazz/core/interfaces/memory-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { AGENT_PROCESS_ENV } from "@jazz/core/utils/env";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { acceptSuggestionCommand } from "./memory";

let directory: string;
const previousAgentProcess = process.env[AGENT_PROCESS_ENV];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-memory-command-test-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  if (previousAgentProcess === undefined) {
    delete process.env[AGENT_PROCESS_ENV];
  } else {
    process.env[AGENT_PROCESS_ENV] = previousAgentProcess;
  }
});

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));
}

async function pendingLesson(service: MemoryServiceImpl): Promise<string> {
  const result = await run(
    service.proposeLesson({
      scope: "personal",
      subject: "check prior art",
      topic: "always",
      rule: "Check for existing tools before proposing a build.",
      mistake: "Proposed building a tool that already existed.",
      proposedBy: "agent-1",
    }),
  );
  if (!result.success) throw new Error(result.message);
  return result.suggestion.id;
}

describe("jazz memory accept", () => {
  test.each([true, false])("agent-started: %s", async (agentStarted) => {
    const service = new MemoryServiceImpl({
      baseMemoryDirectory: directory,
      receiptsDirectory: path.join(directory, ".receipts"),
    });
    const id = await pendingLesson(service);
    const before = await run(service.pendingSuggestions());
    if (agentStarted) {
      process.env[AGENT_PROCESS_ENV] = "1";
    } else {
      delete process.env[AGENT_PROCESS_ENV];
    }
    const successes: string[] = [];
    const result = await run(
      acceptSuggestionCommand(id).pipe(
        Effect.provideService(MemoryServiceTag, service),
        Effect.provide(
          Layer.mock(TerminalServiceTag, {
            isInteractive: false,
            success: (message) =>
              Effect.sync(() => {
                successes.push(message);
              }),
          }),
        ),
        Effect.either,
      ),
    );
    const entry = await run(service.view("personal/always/check-prior-art.md"));
    if (agentStarted) {
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toContain("started by a Jazz agent");
      }
      expect(entry.kind).toBe("not_found");
      expect(await run(service.pendingSuggestions())).toEqual(before);
      expect(successes).toEqual([]);
    } else {
      expect(result._tag).toBe("Right");
      expect(entry.kind).toBe("file");
      expect(await run(service.pendingSuggestions())).toEqual([]);
      expect(successes).toEqual(["Saved to personal/always/check-prior-art.md."]);
    }
  });
});
