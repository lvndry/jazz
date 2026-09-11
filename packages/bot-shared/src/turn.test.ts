import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JazzEnvelope, JazzEvent, JazzRun } from "./jazz-run";
import {
  type ChatId,
  type MessageRef,
  type OutgoingMessage,
  renderPlain,
  type Surface,
} from "./surface";
import {
  APPROVE_CHOICE_ID,
  createTurnRunner,
  type PendingSummary,
  type TurnConfig,
  type TurnRunner,
} from "./turn";

/** A run the test drives by hand: nothing is spawned. */
interface FakeRun {
  readonly run: JazzRun;
  readonly decisions: { toolCallId: string; approved: boolean }[];
  readonly answers: { requestId: string; response: string }[];
  emit(event: JazzEvent): void;
  finish(envelope?: JazzEnvelope): void;
  cancelled(): boolean;
}

const DONE: JazzEnvelope = { ok: true, answer: "done", costUSD: 0 };

describe("turn runner", () => {
  let dataDir: string;
  let sent: { text: string; choiceCount: number }[];
  let pendingSeen: PendingSummary[][];
  let current: FakeRun | undefined;
  let runner: TurnRunner;

  const makeFakeRun = (): FakeRun => {
    let settle: (envelope: JazzEnvelope) => void = () => {};
    let killed = false;
    const decisions: { toolCallId: string; approved: boolean }[] = [];
    const answers: { requestId: string; response: string }[] = [];
    const result = new Promise<JazzEnvelope>((resolve) => {
      settle = resolve;
    });
    let handlers: {
      onApprovalRequired?: (e: JazzEvent) => void;
      onUserInputRequired?: (e: JazzEvent) => void;
    } = {};

    const fake: FakeRun = {
      run: {
        result,
        cancelled: () => killed,
        approve: async (batch) => {
          decisions.push(...batch);
        },
        answerQuestion: async (requestId, response) => {
          answers.push({ requestId, response });
        },
        cancel: () => {
          killed = true;
          settle({ ok: false, error: "cancelled" });
        },
      },
      decisions,
      answers,
      emit: (event) => {
        if (event.type === "approval_required") handlers.onApprovalRequired?.(event);
        if (event.type === "user_input_required") handlers.onUserInputRequired?.(event);
      },
      finish: (envelope = DONE) => settle(envelope),
      cancelled: () => killed,
    };
    (fake as { setHandlers?: unknown }).setHandlers = (h: typeof handlers) => {
      handlers = h;
    };
    return fake;
  };

  const surface: Surface = {
    name: "fake",
    capabilities: {
      editMessages: false,
      buttons: true,
      attachments: false,
      linkButtons: false,
      typingIndicator: false,
      maxMessageChars: 4000,
    },
    send: (_chatId: ChatId, message: OutgoingMessage): Promise<MessageRef | undefined> => {
      sent.push({ text: renderPlain(message.body), choiceCount: message.choices?.length ?? 0 });
      return Promise.resolve("m1");
    },
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "jazz-turn-test-"));
    mkdirSync(join(dataDir, "agents"), { recursive: true });
    writeFileSync(
      join(dataDir, "agents", "seed.json"),
      JSON.stringify({
        id: "seed",
        name: "Seed",
        config: {
          llmProvider: "openai",
          llmModel: "gpt-5.4",
          reasoningEffort: "medium",
          persona: "default",
        },
      }),
    );
    sent = [];
    pendingSeen = [];
    current = undefined;

    const config: TurnConfig = {
      surface,
      jazzBinary: "jazz",
      jazzHome: dataDir,
      baseAgentId: "seed",
      builtinPersonasDir: "",
      approvalPolicy: "low-risk",
      autoApproveTools: [],
      runTimeoutMs: 1000,
      dailyCostCapUsd: 0,
      showReasoning: false,
      files: {
        timezone: "t-tz.json",
        usage: "t-usage.json",
        sessions: "t-sessions.json",
        mode: "t-mode.json",
      },
      agentIdFor: (chatId) => `t_${chatId}`,
      onPendingChange: (_chatId, outstanding) => pendingSeen.push([...outstanding]),
      startRun: (_options, handlers) => {
        const fake = makeFakeRun();
        (fake as unknown as { setHandlers: (h: unknown) => void }).setHandlers(handlers);
        current = fake;
        return fake.run;
      },
    };
    runner = createTurnRunner(config);
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  /**
   * Start a turn and wait until the fake run is registered.
   *
   * The in-flight turn comes back wrapped in an object rather than returned
   * directly: `await` adopts a promise that resolves to another promise, so
   * handing back the turn itself would make every caller wait for the run to
   * finish — which is exactly what these tests are trying to intervene in.
   */
  const startTurn = async (prompt = "hello"): Promise<{ turn: Promise<void> }> => {
    const turn = runner.handle("c1", prompt);
    for (let attempt = 0; current === undefined && attempt < 200; attempt += 1) await Bun.sleep(1);
    if (current === undefined) throw new Error("the run never started");
    return { turn };
  };

  test("a button tap answers the approval it names", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);

    expect(await runner.deliverChoice("c1", "tc1", APPROVE_CHOICE_ID)).toBe(true);
    expect(current?.decisions).toEqual([{ toolCallId: "tc1", approved: true }]);

    current?.finish();
    await turn;
  });

  test("a second tap on a stale keyboard is refused rather than double-answered", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "read_file" });
    await Bun.sleep(5);

    await runner.deliverChoice("c1", "tc1", APPROVE_CHOICE_ID);
    expect(await runner.deliverChoice("c1", "tc1", APPROVE_CHOICE_ID)).toBe(false);
    expect(current?.decisions).toHaveLength(1);

    current?.finish();
    await turn;
  });

  test("approving all clears every outstanding approval in one write", async () => {
    const { turn } = await startTurn();
    for (const toolCallId of ["tc1", "tc2", "tc3"]) {
      current?.emit({ type: "approval_required", toolCallId, toolName: "web_search" });
    }
    await Bun.sleep(5);

    expect(await runner.deliverAllApprovals("c1", true)).toBe(3);
    expect(current?.decisions.map((decision) => decision.toolCallId)).toEqual([
      "tc1",
      "tc2",
      "tc3",
    ]);
    expect(current?.decisions.every((decision) => decision.approved)).toBe(true);

    current?.finish();
    await turn;
  });

  test("approving all leaves questions alone, which have no blanket answer", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "web_search" });
    current?.emit({
      type: "user_input_required",
      requestId: "q1",
      question: "which branch?",
      suggestions: [{ value: "main" }, { value: "dev" }],
    });
    await Bun.sleep(5);

    expect(await runner.deliverAllApprovals("c1", true)).toBe(1);
    expect(pendingSeen.at(-1)).toEqual([{ id: "q1", kind: "question" }]);

    current?.finish();
    await turn;
  });

  test("a typed number answers the newest prompt", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);

    // "2" is Reject in the two-option approval prompt.
    await runner.handle("c1", "2");
    expect(current?.decisions).toEqual([{ toolCallId: "tc1", approved: false }]);

    current?.finish();
    await turn;
  });

  test("a message that answers nothing is queued, not read as a decision", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);

    await runner.handle("c1", "actually, what's the weather?");
    expect(current?.decisions).toHaveLength(0);

    // Queued rather than consumed — letting the run finish would answer it as a
    // fresh turn, so cancelling is how this one unwinds.
    runner.cancel("c1");
    await turn;
  });

  test("a free-text question takes whatever the person says next", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "user_input_required", requestId: "q1", question: "name the file?" });
    await Bun.sleep(5);

    await runner.handle("c1", "notes.md");
    expect(current?.answers).toEqual([{ requestId: "q1", response: "notes.md" }]);

    current?.finish();
    await turn;
  });

  test("prompts left outstanding when a run ends stop eating the next message", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);
    current?.finish();
    await turn;

    expect(pendingSeen.at(-1)).toEqual([]);
  });

  test("cancelling kills the run and drops what was queued behind it", async () => {
    const { turn } = await startTurn();
    await runner.handle("c1", "and also this");

    expect(runner.cancel("c1")).toBe(true);
    expect(current?.cancelled()).toBe(true);
    await turn;

    // The queued message was dropped rather than answered against a cancelled turn.
    expect(sent.some((entry) => entry.text.includes("and also this"))).toBe(false);
  });

  test("cancelling an idle chat reports that there was nothing to stop", () => {
    expect(runner.cancel("nobody")).toBe(false);
  });
});
