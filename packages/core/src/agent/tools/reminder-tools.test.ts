import { NodeFileSystem } from "@effect/platform-node";
import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import type { ReminderService } from "@/core/interfaces/reminder-service";
import { ReminderServiceTag } from "@/core/interfaces/reminder-service";
import type { ToolExecutionContext } from "@/core/types/tools";
import {
  createAddReminderTool,
  createCancelReminderTool,
  createListRemindersTool,
} from "./reminder-tools";

const context: ToolExecutionContext = { agentId: "agent-1" };

function runWithFakeReminderService<A>(
  fakeService: ReminderService,
  eff: Effect.Effect<A, Error, ReminderService | import("@effect/platform").FileSystem.FileSystem>,
) {
  return Effect.runPromise(
    eff.pipe(
      Effect.provideService(ReminderServiceTag, fakeService),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

describe("add_reminder tool", () => {
  test("has the expected shape", () => {
    const tool = createAddReminderTool();
    expect(tool.name).toBe("add_reminder");
    expect(tool.riskLevel).toBe("low-risk");
    expect(tool.hidden).toBe(false);
  });

  test("dispatches to the service and reports success", async () => {
    let receivedArgs: unknown[] = [];
    const fakeService: Partial<ReminderService> = {
      add: (...args) => {
        receivedArgs = args;
        return Effect.succeed({
          success: true,
          reminder: { id: "abc123", fireAt: 1_800_000, text: "call the plumber", createdAt: 0 },
        });
      },
    };
    const tool = createAddReminderTool();
    const result = await runWithFakeReminderService(
      fakeService as ReminderService,
      tool.execute({ when: "30m", text: "call the plumber" }, context),
    );
    expect(result.success).toBe(true);
    expect(receivedArgs).toEqual(["agent-1", "30m", "call the plumber", "UTC"]);
  });

  test("surfaces a failed outcome (unparseable time) as a failed tool result", async () => {
    const fakeService: Partial<ReminderService> = {
      add: () =>
        Effect.succeed({
          success: false,
          message: "Could not understand the time 'whenever'.",
        }),
    };
    const tool = createAddReminderTool();
    const result = await runWithFakeReminderService(
      fakeService as ReminderService,
      tool.execute({ when: "whenever", text: "water the plants" }, context),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not understand the time");
  });

  test("reads context.timezone and falls back to UTC when absent", async () => {
    let receivedTimezone: unknown;
    const fakeService: Partial<ReminderService> = {
      add: (_agentId, _when, _text, timezone) => {
        receivedTimezone = timezone;
        return Effect.succeed({
          success: true,
          reminder: { id: "id", fireAt: 0, text: "x", createdAt: 0 },
        });
      },
    };
    const tool = createAddReminderTool();

    // No context.timezone set — should default to "UTC".
    await runWithFakeReminderService(
      fakeService as ReminderService,
      tool.execute({ when: "30m", text: "x" }, context),
    );
    expect(receivedTimezone).toBe("UTC");

    // Explicit context.timezone — should be passed through unchanged.
    const contextWithTz: ToolExecutionContext = { agentId: "agent-1", timezone: "Europe/Paris" };
    await runWithFakeReminderService(
      fakeService as ReminderService,
      tool.execute({ when: "30m", text: "x" }, contextWithTz),
    );
    expect(receivedTimezone).toBe("Europe/Paris");
  });
});

describe("list_reminders tool", () => {
  test("has the expected shape", () => {
    const tool = createListRemindersTool();
    expect(tool.name).toBe("list_reminders");
    expect(tool.riskLevel).toBe("read-only");
    expect(tool.hidden).toBe(false);
  });

  test("dispatches to the service and formats the list", async () => {
    const fakeService: Partial<ReminderService> = {
      list: () =>
        Effect.succeed([
          { id: "b", fireAt: 2_000, text: "second", createdAt: 0 },
          { id: "a", fireAt: 1_000, text: "first", createdAt: 0 },
        ]),
    };
    const tool = createListRemindersTool();
    const result = await runWithFakeReminderService(
      fakeService as ReminderService,
      tool.execute({}, context),
    );
    expect(result.success).toBe(true);
    const data = result.result as { reminders: readonly { id: string }[] };
    expect(data.reminders.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("cancel_reminder tool", () => {
  test("has the expected shape", () => {
    const tool = createCancelReminderTool();
    expect(tool.name).toBe("cancel_reminder");
    expect(tool.riskLevel).toBe("low-risk");
    expect(tool.hidden).toBe(false);
  });

  test("dispatches cancel to the service and reports success", async () => {
    let receivedArgs: unknown[] = [];
    const fakeService: Partial<ReminderService> = {
      cancel: (...args) => {
        receivedArgs = args;
        return Effect.succeed({ success: true, message: "Reminder cancelled." });
      },
    };
    const tool = createCancelReminderTool();
    const result = await runWithFakeReminderService(
      fakeService as ReminderService,
      tool.execute({ id: "abc123" }, context),
    );
    expect(result.success).toBe(true);
    expect(receivedArgs).toEqual(["agent-1", "abc123"]);
  });

  test("surfaces a failed cancellation as a failed tool result", async () => {
    const fakeService: Partial<ReminderService> = {
      cancel: () => Effect.succeed({ success: false, message: 'No reminder found with id "x".' }),
    };
    const tool = createCancelReminderTool();
    const result = await runWithFakeReminderService(
      fakeService as ReminderService,
      tool.execute({ id: "x" }, context),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("No reminder found");
  });
});
