import { describe, expect, test } from "bun:test";
import { createProgressReporter } from "./progress";
import { nullRunLog } from "./run-log";
import {
  type ChatId,
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
