import { describe, expect, test } from "bun:test";
import { createProgressReporter, type ProgressReporterOptions } from "./progress";
import { nullRunLog } from "./run-log";
import {
  type ChatId,
  type DraftOutcome,
  type MessageRef,
  type OutgoingMessage,
  plainLine,
  renderPlain,
  type Surface,
  type SurfaceCapabilities,
} from "./surface";

interface Recorded {
  readonly kind: "send" | "edit";
  readonly text: string;
  readonly choiceCount: number;
}

function fakeSurface(capabilities: Partial<SurfaceCapabilities> = {}): {
  surface: Surface;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  const full: SurfaceCapabilities = {
    editMessages: true,
    buttons: true,
    attachments: false,
    linkButtons: false,
    typingIndicator: false,
    maxMessageChars: 4000,
    ...capabilities,
  };
  const record = (kind: "send" | "edit", message: OutgoingMessage) => {
    recorded.push({
      kind,
      text: renderPlain(message.body),
      choiceCount: message.choices?.length ?? 0,
    });
  };
  const surface: Surface = {
    name: "fake",
    capabilities: full,
    send: (_chatId: ChatId, message: OutgoingMessage): Promise<MessageRef | undefined> => {
      record("send", message);
      return Promise.resolve("m1");
    },
    ...(full.editMessages
      ? {
          edit: (_chatId: ChatId, _ref: MessageRef, message: OutgoingMessage): Promise<void> => {
            record("edit", message);
            return Promise.resolve();
          },
        }
      : {}),
  };
  return { surface, recorded };
}

describe("editable surfaces", () => {
  test("open one bubble and rewrite it rather than sending again", async () => {
    const { surface, recorded } = fakeSurface();
    const reporter = createProgressReporter({
      surface,
      chatId: "c1",
      runLog: nullRunLog(),
      cancelChoice: { id: "cancel", label: "⏹ Cancel" },
    });

    await reporter.start();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.kind).toBe("send");
    expect(recorded[0]?.choiceCount).toBe(1);

    reporter.onEvent({ type: "tool_execution_start", toolName: "web_search" });
    await reporter.finish([plainLine("✅ Done")]);

    expect(recorded.filter((entry) => entry.kind === "send")).toHaveLength(1);
    expect(recorded.at(-1)?.text).toBe("✅ Done");
    // The closing frame drops the Cancel button.
    expect(recorded.at(-1)?.choiceCount).toBe(0);
  });

  test("report the summary as displayed, so the caller does not repeat it", async () => {
    const { surface } = fakeSurface();
    const reporter = createProgressReporter({ surface, chatId: "c1", runLog: nullRunLog() });
    await reporter.start();
    expect(await reporter.finish([plainLine("✅ Done")])).toBe(true);
  });

  test("the closing summary lands even while an edit is still in flight", async () => {
    const recorded: Recorded[] = [];
    let releaseEdit: (() => void) | undefined;
    const surface: Surface = {
      name: "slow",
      capabilities: {
        editMessages: true,
        buttons: true,
        attachments: false,
        linkButtons: false,
        typingIndicator: false,
        maxMessageChars: 4000,
      },
      send: (_chatId, message) => {
        recorded.push({ kind: "send", text: renderPlain(message.body), choiceCount: 0 });
        return Promise.resolve("m1");
      },
      edit: (_chatId, _ref, message) => {
        recorded.push({ kind: "edit", text: renderPlain(message.body), choiceCount: 0 });
        // The first edit hangs until released, so `sending` is genuinely true
        // when the summary is written — the case that used to drop it.
        return releaseEdit === undefined
          ? new Promise<void>((resolve) => {
              releaseEdit = resolve;
            })
          : Promise.resolve();
      },
    };

    const reporter = createProgressReporter({
      surface,
      chatId: "c1",
      runLog: nullRunLog(),
      editIntervalMs: 0,
    });
    await reporter.start();
    reporter.onEvent({ type: "tool_execution_start", toolName: "read_file" });
    await Bun.sleep(0);
    expect(recorded.some((entry) => entry.kind === "edit")).toBe(true);

    await reporter.finish([plainLine("✅ Done")]);
    expect(recorded.at(-1)?.text).toBe("✅ Done");
    releaseEdit?.();
  });
});

describe("append-only surfaces", () => {
  test("acknowledge once and stay quiet through a normal run", async () => {
    const { surface, recorded } = fakeSurface({ editMessages: false, buttons: false });
    const reporter = createProgressReporter({ surface, chatId: "c1", runLog: nullRunLog() });

    await reporter.start();
    for (const toolName of ["web_search", "read_file", "execute_command"]) {
      reporter.onEvent({ type: "tool_execution_start", toolName });
    }
    reporter.onEvent({ type: "text_start" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.text).toContain("Working");
  });

  test("offer no cancel choice, which would swallow the next real message", async () => {
    const { surface, recorded } = fakeSurface({ editMessages: false, buttons: false });
    const reporter = createProgressReporter({
      surface,
      chatId: "c1",
      runLog: nullRunLog(),
      cancelChoice: { id: "cancel", label: "⏹ Cancel" },
    });
    await reporter.start();
    expect(recorded[0]?.choiceCount).toBe(0);
  });

  test("leave the summary to the caller, since there is no bubble to close", async () => {
    const { surface, recorded } = fakeSurface({ editMessages: false });
    const reporter = createProgressReporter({ surface, chatId: "c1", runLog: nullRunLog() });
    await reporter.start();
    expect(await reporter.finish([plainLine("✅ Done")])).toBe(false);
    expect(recorded).toHaveLength(1);
  });
});

describe("accumulated run state", () => {
  test("deduplicates tools and counts rounds", async () => {
    const { surface } = fakeSurface();
    const reporter = createProgressReporter({ surface, chatId: "c1", runLog: nullRunLog() });
    await reporter.start();

    reporter.onEvent({ type: "tools_detected" });
    reporter.onEvent({ type: "tool_execution_start", toolName: "web_search" });
    reporter.onEvent({ type: "tool_execution_start", toolName: "web_search" });
    reporter.onEvent({ type: "tools_detected" });

    expect(reporter.toolsUsed()).toEqual(["web_search"]);
    expect(reporter.rounds()).toBe(2);
  });

  test("keeps raw thinking so a lone-space chunk does not glue two words", async () => {
    const { surface } = fakeSurface();
    const reporter = createProgressReporter({ surface, chatId: "c1", runLog: nullRunLog() });
    await reporter.start();

    for (const content of ["Let me", " ", "check that"]) {
      reporter.onEvent({ type: "thinking_chunk", content });
    }
    expect(reporter.reasoningLog()).toBe("Let me check that");
  });
});

describe("between events", () => {
  test("the last event inside the throttle window is still drawn", async () => {
    const { surface, recorded } = fakeSurface();
    const reporter = createProgressReporter({
      surface,
      chatId: "c1",
      runLog: nullRunLog(),
      editIntervalMs: 30,
      tickMs: 60_000,
    });
    await reporter.start();
    reporter.onEvent({ type: "tool_execution_start", toolName: "web_search" });
    // Arrives inside the window: without a trailing redraw this never reaches the screen.
    reporter.onEvent({ type: "tool_execution_start", toolName: "read_file" });
    await Bun.sleep(80);
    expect(recorded.at(-1)?.text).toContain("read_file");
    await reporter.finish([plainLine("done")]);
  });

  test("an append-only surface hears it is still working with no events at all", async () => {
    const { surface, recorded } = fakeSurface({ editMessages: false });
    const reporter = createProgressReporter({
      surface,
      chatId: "c1",
      runLog: nullRunLog(),
      tickMs: 10,
    });
    const realNow = Date.now;
    await reporter.start();
    try {
      // Pretend the first quiet interval has passed.
      Date.now = () => realNow() + 46_000;
      await Bun.sleep(40);
      expect(recorded.some((entry) => entry.text.includes("Still working"))).toBe(true);
    } finally {
      Date.now = realNow;
      await reporter.finish([plainLine("done")]);
    }
  });
});

describe("drafts", () => {
  /** A surface with drafts whose outcome for each frame the test decides. */
  function draftingSurface(outcomes: (frame: number) => DraftOutcome | Promise<DraftOutcome>) {
    const { surface, recorded } = fakeSurface();
    const frames: string[] = [];
    const drafted: Surface = {
      ...surface,
      streamDraft: (_chatId, draft) => {
        frames.push(renderPlain(draft.body));
        return Promise.resolve(outcomes(frames.length));
      },
    };
    return { surface: drafted, recorded, frames };
  }

  const reporterFor = (surface: Surface, overrides: Partial<ProgressReporterOptions> = {}) =>
    createProgressReporter({
      surface,
      chatId: "c1",
      runLog: nullRunLog(),
      draft: { id: 7, stoppable: true },
      editIntervalMs: 0,
      tickMs: 10,
      ...overrides,
    });

  test("an unchanged draft is sent again before it would expire", async () => {
    const { surface, frames } = draftingSurface(() => "shown");
    const reporter = reporterFor(surface, { draftKeepaliveMs: 30 });
    await reporter.start();
    await Bun.sleep(120);
    await reporter.finish([plainLine("done")]);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(new Set(frames)).toEqual(new Set([""]));
  });

  test("a first frame that did not get through is retried on the next tick, not left blank", async () => {
    const { surface, frames, recorded } = draftingSurface((frame) =>
      frame === 1 ? "skipped" : "shown",
    );
    const reporter = reporterFor(surface);
    await reporter.start();
    await Bun.sleep(40);
    await reporter.finish([plainLine("done")]);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(recorded).toHaveLength(0);
  });

  test("a bubble still being opened when the run finishes is closed with the summary", async () => {
    const { surface: drafted, recorded } = draftingSurface((frame) =>
      frame === 1 ? "shown" : "refused",
    );
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const surface: Surface = {
      ...drafted,
      send: async (chatId, message) => {
        await sendGate;
        return drafted.send(chatId, message);
      },
    };
    const reporter = reporterFor(surface, { tickMs: 60_000 });
    await reporter.start();
    reporter.onEvent({ type: "text_chunk", accumulated: "partial" });
    await Bun.sleep(10);

    const finishing = reporter.finish([plainLine("✅ Done")]);
    releaseSend();
    expect(await finishing).toBe(true);
    expect(recorded.map((entry) => entry.kind)).toEqual(["send", "edit"]);
    expect(recorded.at(-1)?.text).toBe("✅ Done");
  });

  test("a refusal that lands after the run finished opens no bubble under the answer", async () => {
    let refuseLate: (outcome: DraftOutcome) => void = () => {};
    const { surface, recorded } = draftingSurface((frame) =>
      frame === 1
        ? "shown"
        : new Promise<DraftOutcome>((resolve) => {
            refuseLate = resolve;
          }),
    );
    const reporter = reporterFor(surface, { tickMs: 60_000 });
    await reporter.start();
    reporter.onEvent({ type: "text_chunk", accumulated: "partial" });
    await Bun.sleep(10);
    expect(await reporter.finish([plainLine("done")])).toBe(false);
    refuseLate("refused");
    await Bun.sleep(10);
    expect(recorded).toHaveLength(0);
  });

  test("the answer already shown in a draft is kept when drafting later falls back", async () => {
    const { surface } = draftingSurface((frame) => (frame <= 2 ? "shown" : "refused"));
    const reporter = reporterFor(surface, { tickMs: 60_000 });
    await reporter.start();
    reporter.onEvent({ type: "text_chunk", accumulated: "Half an answer" });
    await Bun.sleep(10);
    reporter.onEvent({ type: "text_chunk", accumulated: "Half an answer, then more" });
    await Bun.sleep(10);
    await reporter.finish([plainLine("stopped")]);
    expect(reporter.streamedAnswer()).toBe("Half an answer");
  });
});
