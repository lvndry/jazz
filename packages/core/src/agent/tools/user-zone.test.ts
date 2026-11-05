import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { ReminderService } from "@/core/interfaces/reminder-service";
import { ReminderServiceTag } from "@/core/interfaces/reminder-service";
import {
  WakeTriggerServiceTag,
  type WakeTriggerService,
} from "@/core/interfaces/wake-trigger-service";
import { partialFake } from "@/core/test-support/fakes";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { createGetTimeTool } from "./context";
import { createAddReminderTool } from "./reminder";
import { createRegisterTriggerTool } from "./wake-trigger";

interface Recorded {
  zone?: string;
}

function runReminder(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  recorded: Recorded,
): Promise<ToolExecutionResult> {
  const fakeService: Partial<ReminderService> = {
    add: (_agentId, _when, text, timezone) => {
      recorded.zone = timezone;
      return Effect.succeed({
        success: true,
        reminder: { id: "r1", fireAt: 1_800_000, text, createdAt: 0 },
      });
    },
  };
  return Effect.runPromise(
    createAddReminderTool()
      .execute(args, context)
      .pipe(
        Effect.provideService(ReminderServiceTag, fakeService as ReminderService),
        Effect.provide(NodeFileSystem.layer),
      ) as Effect.Effect<ToolExecutionResult, never, never>,
  );
}

function runGetTime(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    createGetTimeTool().execute(args, context) as Effect.Effect<ToolExecutionResult, never, never>,
  );
}

const botContext: ToolExecutionContext = { agentId: "bot", zoneSettingCommand: "/tz" };

describe("add_reminder on a surface that does not know the user's zone", () => {
  test("refuses a clock time and tells the model to ask, offering the surface's command", async () => {
    const recorded: Recorded = {};
    const outcome = await runReminder({ when: "09:00", text: "stand up" }, botContext, recorded);
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("not known");
    expect(outcome.error).toContain("/tz");
    expect(recorded.zone).toBeUndefined();
  });

  test("still schedules a relative duration, which is the same instant everywhere", async () => {
    const recorded: Recorded = {};
    const outcome = await runReminder({ when: "30m", text: "stand up" }, botContext, recorded);
    expect(outcome.success).toBe(true);
    expect(recorded.zone).toBe("UTC");
  });

  test("a zone named in the message is used and the result offers to remember it", async () => {
    const recorded: Recorded = {};
    const outcome = await runReminder(
      { when: "09:00", text: "stand up", timeZone: "Asia/Tokyo" },
      botContext,
      recorded,
    );
    expect(outcome.success).toBe(true);
    expect(recorded.zone).toBe("Asia/Tokyo");
    expect(outcome.result).toMatchObject({
      timeZone: "Asia/Tokyo",
      timeZoneSource: "explicit-in-message",
    });
  });

  test("an invalid zone is rejected with a clear error", async () => {
    const recorded: Recorded = {};
    const outcome = await runReminder(
      { when: "09:00", text: "stand up", timeZone: "Narnia/Cair_Paravel" },
      botContext,
      recorded,
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("Narnia/Cair_Paravel");
    expect(recorded.zone).toBeUndefined();
  });
});

describe("add_reminder zone precedence", () => {
  test("the zone in the message wins over the chat setting", async () => {
    const recorded: Recorded = {};
    await runReminder(
      { when: "09:00", text: "stand up", timeZone: "Asia/Tokyo" },
      { ...botContext, timezone: "Europe/Paris", timezoneSource: "chat-setting" },
      recorded,
    );
    expect(recorded.zone).toBe("Asia/Tokyo");
  });

  test("the chat setting is used when the message names none", async () => {
    const recorded: Recorded = {};
    const outcome = await runReminder(
      { when: "09:00", text: "stand up" },
      { ...botContext, timezone: "Europe/Paris", timezoneSource: "chat-setting" },
      recorded,
    );
    expect(recorded.zone).toBe("Europe/Paris");
    expect(outcome.result).toMatchObject({ timeZoneSource: "chat-setting" });
  });

  test("the interactive host's zone is the user's on their own device", async () => {
    const recorded: Recorded = {};
    const outcome = await runReminder(
      { when: "09:00", text: "stand up" },
      { agentId: "chat", hostIsUserDevice: true },
      recorded,
    );
    expect(outcome.success).toBe(true);
    expect(outcome.result).toMatchObject({ timeZoneSource: "interactive-host" });
    expect(recorded.zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("get_time", () => {
  test("reports an unknown zone with an instruction and no local clock", async () => {
    const outcome = await runGetTime({}, botContext);
    expect(outcome.success).toBe(true);
    const result = outcome.result as Record<string, unknown>;
    expect(result["iso"]).toBeString();
    expect(result["localTime"]).toBeUndefined();
    expect(result["timeZone"]).toMatchObject({ status: "unknown" });
  });

  test("reports the zone and its source when known", async () => {
    const outcome = await runGetTime(
      {},
      { agentId: "bot", timezone: "Europe/Paris", timezoneSource: "chat-setting" },
    );
    expect(outcome.result).toMatchObject({
      timeZone: { status: "known", zone: "Europe/Paris", source: "chat-setting" },
    });
  });

  test("names the host as the source on the user's own device", async () => {
    const outcome = await runGetTime({}, { agentId: "chat", hostIsUserDevice: true });
    expect(outcome.result).toMatchObject({
      timeZone: { status: "known", source: "interactive-host" },
    });
  });

  test("rejects an invalid zone", async () => {
    const outcome = await runGetTime({ timeZone: "nope" }, botContext);
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("nope");
  });
});

describe("register_trigger with an unknown user zone", () => {
  for (const when of ["09:00", "30m"]) {
    test(`handles ${when} without assuming the server zone`, async () => {
      const zones: string[] = [];
      const service = partialFake<WakeTriggerService>({
        add: (_agent, conversationId, _when, prompt, reason, timezone) => {
          zones.push(timezone);
          return Effect.succeed({
            success: true,
            trigger: { id: "t1", fireAt: 1_800_000, conversationId, prompt, reason, createdAt: 0 },
          });
        },
      });
      const result = await Effect.runPromise(
        createRegisterTriggerTool()
          .execute(
            { when, prompt: "check", reason: "monitor" },
            { ...botContext, conversationId: "trigger-chat" },
          )
          .pipe(
            Effect.provideService(WakeTriggerServiceTag, service),
            Effect.provide(NodeFileSystem.layer),
          ),
      );
      expect(result.success).toBe(when === "30m");
      expect(zones).toEqual(when === "30m" ? ["UTC"] : []);
      if (when === "09:00") {
        expect(result.error).toContain("not known");
      }
    });
  }

  test("attributes a bridge default to its operator", async () => {
    const result = await runGetTime(
      {},
      { ...botContext, timezone: "Europe/Paris", timezoneSource: "operator-default" },
    );
    expect(result.result).toMatchObject({
      timeZone: { source: "operator-default", zone: "Europe/Paris" },
    });
  });
});
