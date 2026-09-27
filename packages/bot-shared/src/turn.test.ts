import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCommandApprovalKey } from "@jazz/core/utils/shell";
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
  ALWAYS_ALLOW_CHOICE_ID,
  APPROVE_ALL_CHOICE_ID,
  APPROVE_CHOICE_ID,
  commandKeyFromApproval,
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
const REQUESTER = "u1";
const OTHER_MEMBER = "u2";
const OPERATOR = "op";

function message(text: string, senderId: string = REQUESTER, chatId = "c1") {
  return { chatId, senderId, text };
}

function tap(promptId: string, choiceId: string, senderId: string = REQUESTER) {
  return { chatId: "c1", promptId, choiceId, senderId };
}

describe("turn runner", () => {
  let dataDir: string;
  let sent: {
    text: string;
    choiceCount: number;
    promptId?: string | undefined;
    choiceIds: string[];
  }[];
  let runsStarted: string[];
  let pendingSeen: PendingSummary[][];
  let current: FakeRun | undefined;
  let runner: TurnRunner;
  let baseConfig: TurnConfig;

  const makeFakeRun = (): FakeRun => {
    let settle: (envelope: JazzEnvelope) => void = () => {};
    let killed = false;
    const decisions: { toolCallId: string; approved: boolean }[] = [];
    const answers: { requestId: string; response: string }[] = [];
    const result = new Promise<JazzEnvelope>((resolve) => {
      settle = resolve;
    });
    let handlers: {
      onEvent?: (e: JazzEvent) => void;
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
        handlers.onEvent?.(event);
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
      sent.push({
        text: renderPlain(message.body),
        choiceCount: message.choices?.length ?? 0,
        promptId: message.promptId,
        choiceIds: (message.choices ?? []).map((choice) => choice.id),
      });
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
          reasoning: "medium",
          persona: "default",
        },
      }),
    );
    sent = [];
    runsStarted = [];
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
      operators: new Set([OPERATOR]),
      operatorSettingName: "TEST_OPERATOR_IDS",
      onPendingChange: (_chatId, outstanding) => pendingSeen.push([...outstanding]),
      startRun: (options, handlers) => {
        runsStarted.push(options.prompt);
        const fake = makeFakeRun();
        (fake as unknown as { setHandlers: (h: unknown) => void }).setHandlers(handlers);
        current = fake;
        return fake.run;
      },
    };
    baseConfig = config;
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
    const turn = runner.handle(message(prompt));
    for (let attempt = 0; current === undefined && attempt < 200; attempt += 1) await Bun.sleep(1);
    if (current === undefined) throw new Error("the run never started");
    return { turn };
  };

  test("reasoning arrives before the answer, not after it", async () => {
    // It is the work that produced the answer, so it reads before it - and on
    // an append-only surface a reader should not have to scroll back past the
    // answer to find out how the agent got there.
    runner = createTurnRunner({ ...baseConfig, showReasoning: true });
    const { turn } = await startTurn();
    current?.emit({ type: "thinking_chunk", content: "weighing the options" });
    await Bun.sleep(5);

    current?.finish();
    await turn;

    const reasoningAt = sent.findIndex((message) => message.text.includes("Reasoning"));
    const answerAt = sent.findIndex((message) => message.text.includes("done"));
    expect(reasoningAt).toBeGreaterThanOrEqual(0);
    expect(answerAt).toBeGreaterThanOrEqual(0);
    expect(reasoningAt).toBeLessThan(answerAt);
  });

  test("a button tap answers the approval it names", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);

    expect(await runner.deliverChoice(tap("tc1", APPROVE_CHOICE_ID, REQUESTER))).toBe("answered");
    expect(current?.decisions).toEqual([{ toolCallId: "tc1", approved: true }]);

    current?.finish();
    await turn;
  });

  test("a second tap on a stale keyboard is refused rather than double-answered", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "read_file" });
    await Bun.sleep(5);

    await runner.deliverChoice(tap("tc1", APPROVE_CHOICE_ID, REQUESTER));
    expect(await runner.deliverChoice(tap("tc1", APPROVE_CHOICE_ID, REQUESTER))).toBe("expired");
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

    expect(await runner.deliverAllApprovals("c1", true, REQUESTER)).toEqual({
      outcome: "answered",
      count: 3,
    });
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

    expect((await runner.deliverAllApprovals("c1", true, REQUESTER)).count).toBe(1);
    expect(pendingSeen.at(-1)).toEqual([{ id: "q1", kind: "question" }]);

    current?.finish();
    await turn;
  });

  test("a typed number answers the newest prompt", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);

    // "2" is Reject in the two-option approval prompt.
    await runner.handle(message("2"));
    expect(current?.decisions).toEqual([{ toolCallId: "tc1", approved: false }]);

    current?.finish();
    await turn;
  });

  test("a message that answers nothing is queued, not read as a decision", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);

    await runner.handle(message("actually, what's the weather?"));
    expect(current?.decisions).toHaveLength(0);

    // Queued rather than consumed — letting the run finish would answer it as a
    // fresh turn, so cancelling is how this one unwinds.
    runner.cancel("c1", undefined);
    await turn;
  });

  test("a free-text question takes whatever the person says next", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "user_input_required", requestId: "q1", question: "name the file?" });
    await Bun.sleep(5);

    await runner.handle(message("notes.md"));
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
    await runner.handle(message("and also this"));

    expect(runner.cancel("c1", REQUESTER)).toBe("cancelled");
    expect(current?.cancelled()).toBe(true);
    await turn;

    // The queued message was dropped rather than answered against a cancelled turn.
    expect(sent.some((entry) => entry.text.includes("and also this"))).toBe(false);
  });

  test("cancelling an idle chat reports that there was nothing to stop", () => {
    expect(runner.cancel("nobody", REQUESTER)).toBe("idle");
  });

  test("only the requester answers the approval their message led to", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);

    expect(await runner.deliverChoice(tap("tc1", APPROVE_CHOICE_ID, OTHER_MEMBER))).toBe(
      "not-requester",
    );
    expect(await runner.deliverAllApprovals("c1", true, OTHER_MEMBER)).toEqual({
      outcome: "not-requester",
      count: 0,
    });
    expect(current?.decisions).toEqual([]);

    expect(await runner.deliverChoice(tap("tc1", APPROVE_CHOICE_ID, REQUESTER))).toBe("answered");
    current?.finish();
    await turn;
  });

  test("another member's typed number is conversation, not a decision", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "execute_command" });
    await Bun.sleep(5);

    expect(runner.awaitsReplyFrom("c1", OTHER_MEMBER)).toBe(false);
    expect(runner.awaitsReplyFrom("c1", REQUESTER)).toBe(true);
    await runner.handle(message("1", OTHER_MEMBER));
    expect(current?.decisions).toEqual([]);

    runner.cancel("c1", undefined);
    await turn;
  });

  test("another member cannot cancel someone else's run, an operator can", async () => {
    const { turn } = await startTurn();
    expect(runner.cancel("c1", OTHER_MEMBER)).toBe("not-requester");
    expect(current?.cancelled()).toBe(false);
    expect(runner.cancel("c1", OPERATOR)).toBe("cancelled");
    await turn;
  });

  test("two quick messages run one after the other", async () => {
    const first = runner.handle(message("first"));
    const second = runner.handle(message("second"));
    for (let attempt = 0; runsStarted.length === 0 && attempt < 200; attempt += 1)
      await Bun.sleep(1);
    await Bun.sleep(10);
    expect(runsStarted).toEqual(["first"]);

    // The second message was queued behind the first, so the first handle call is the one
    // that answers it: finishing both is what lets it return.
    await second;
    const firstRun = current;
    current = undefined;
    firstRun?.finish();
    const running = (): FakeRun | undefined => current;
    for (let attempt = 0; running() === undefined && attempt < 200; attempt += 1)
      await Bun.sleep(1);
    expect(runsStarted).toEqual(["first", "second"]);
    running()?.finish();
    await first;
  });

  test("approve all is offered past one approval and clears every one", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "approval_required", toolCallId: "tc1", toolName: "web_search" });
    current?.emit({ type: "approval_required", toolCallId: "tc2", toolName: "web_search" });
    await Bun.sleep(5);

    expect(sent.find((entry) => entry.promptId === "tc2")?.choiceIds).toContain(
      APPROVE_ALL_CHOICE_ID,
    );
    expect(sent.find((entry) => entry.promptId === "tc1")?.choiceIds).not.toContain(
      APPROVE_ALL_CHOICE_ID,
    );
    expect(await runner.deliverChoice(tap("tc2", APPROVE_ALL_CHOICE_ID))).toBe("answered");
    expect(current?.decisions).toEqual([
      { toolCallId: "tc1", approved: true },
      { toolCallId: "tc2", approved: true },
    ]);
    current?.finish();
    await turn;
  });

  test("always allow persists the command for an operator and is refused otherwise", async () => {
    // Wrapped, like `startTurn`: returning the turn itself would await the whole run.
    const turnAs = async (senderId: string): Promise<{ turn: Promise<void> }> => {
      const turn = runner.handle(message("list files", senderId));
      for (let attempt = 0; current === undefined && attempt < 200; attempt += 1)
        await Bun.sleep(1);
      return { turn };
    };
    const event = {
      type: "approval_required",
      toolCallId: "tc1",
      toolName: "execute_command",
      message: "Command: ls -la\nDescription: list",
    };

    const { turn: memberTurn } = await turnAs(OTHER_MEMBER);
    current?.emit(event);
    await Bun.sleep(5);
    expect(sent.find((entry) => entry.promptId === "tc1")?.choiceIds).toContain(
      ALWAYS_ALLOW_CHOICE_ID,
    );
    expect(await runner.deliverChoice(tap("tc1", ALWAYS_ALLOW_CHOICE_ID, OTHER_MEMBER))).toBe(
      "not-operator",
    );
    expect(current?.decisions).toEqual([]);
    current?.finish();
    await memberTurn;

    current = undefined;
    // Read through a function: after the reset above the compiler narrows `current` to
    // undefined, though the next run assigns it.
    const running = (): FakeRun | undefined => current;
    const { turn: operatorTurn } = await turnAs(OPERATOR);
    running()?.emit(event);
    await Bun.sleep(5);
    expect(await runner.deliverChoice(tap("tc1", ALWAYS_ALLOW_CHOICE_ID, OPERATOR))).toBe(
      "answered",
    );
    expect(running()?.decisions).toEqual([{ toolCallId: "tc1", approved: true }]);
    const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
      autoApprovedCommands?: string[];
    };
    expect(saved.autoApprovedCommands).toEqual([extractCommandApprovalKey("ls -la")]);
    running()?.finish();
    await operatorTurn;
  });

  test("a follow-up tap starts a new turn with that prompt", async () => {
    expect(await runner.deliverChoice(tap("followup", "shorter"))).toBe("answered");
    for (let attempt = 0; current === undefined && attempt < 200; attempt += 1) await Bun.sleep(1);
    expect(runsStarted[0]).toContain("shorter version");
    current?.finish();
  });

  test("the cancel button is the requester's or an operator's", async () => {
    const { turn } = await startTurn();
    expect(await runner.deliverChoice(tap("run:cancel", "cancel", OTHER_MEMBER))).toBe(
      "not-requester",
    );
    expect(await runner.deliverChoice(tap("run:cancel", "cancel"))).toBe("answered");
    await turn;
    expect(current?.cancelled()).toBe(true);
  });

  test("the mode picker refuses yolo to anyone but an operator", async () => {
    expect(await runner.deliverChoice(tap("command:mode", "yolo", OTHER_MEMBER))).toBe(
      "not-operator",
    );
    expect(await runner.deliverChoice(tap("command:mode", "yolo", OPERATOR))).toBe("answered");
    expect(sent.at(-1)?.text).toContain("Mode →");
  });

  test("a bare /mode on a button surface draws the picker", async () => {
    await runner.handle(message("/mode@jazz_bot"));
    expect(sent.at(-1)?.promptId).toBe("command:mode");
    expect(sent.at(-1)?.choiceIds).toEqual(["safe", "yolo"]);
  });

  test("/remind runs a turn that asks the agent to add the reminder", async () => {
    const turn = runner.handle(message("/remind 30m take pizza out"));
    for (let attempt = 0; current === undefined && attempt < 200; attempt += 1) await Bun.sleep(1);
    expect(runsStarted).toEqual(["Add a reminder: 30m take pizza out"]);
    current?.finish();
    await turn;
  });

  test("a failure answers that message and the queue behind it still runs", async () => {
    // The shape of the stranded-queue repro: sending the progress message throws.
    let failWorking = true;
    const flakySurface: Surface = {
      ...surface,
      send: (chatId, outgoing) => {
        if (failWorking && renderPlain(outgoing.body).includes("Working")) {
          return Promise.reject(new Error("socket down"));
        }
        return surface.send(chatId, outgoing);
      },
    };
    runner = createTurnRunner({ ...baseConfig, surface: flakySurface });
    const first = runner.handle(message("first"));
    const second = runner.handle(message("second"));
    await first;
    await second;
    expect(sent.filter((entry) => entry.text.includes("Something went wrong"))).toHaveLength(2);
    failWorking = false;
    const { turn } = await startTurn("third");
    expect(runsStarted).toEqual(["third"]);
    current?.finish();
    await turn;
  });

  test("/status is answered at once while a run is in flight, and /stop stops it", async () => {
    const { turn } = await startTurn();
    await runner.handle(message("/status"));
    expect(sent.at(-1)?.text).toContain("Status");
    await runner.handle(message("/stop"));
    expect(sent.some((entry) => entry.text.includes("Stopping"))).toBe(true);
    await turn;
    expect(current?.cancelled()).toBe(true);
  });

  test("a free-text question does not swallow a command", async () => {
    const { turn } = await startTurn();
    current?.emit({ type: "user_input_required", requestId: "q1", question: "which file?" });
    await Bun.sleep(5);
    await runner.handle(message("/status"));
    expect(current?.answers).toEqual([]);
    await runner.handle(message("notes.md"));
    expect(current?.answers).toEqual([{ requestId: "q1", response: "notes.md" }]);
    current?.finish();
    await turn;
  });

  test("messages past the queue bound are dropped with a reply", async () => {
    runner = createTurnRunner({
      ...baseConfig,
      limits: { maxConcurrentRuns: 4, maxQueuedMessages: 1 },
    });
    const { turn } = await startTurn();
    await runner.handle(message("queued"));
    await runner.handle(message("one too many"));
    expect(sent.at(-1)?.text).toContain("was dropped");
    runner.cancel("c1", undefined);
    await turn;
  });

  test("the process-wide cap makes a second conversation wait for a slot", async () => {
    runner = createTurnRunner({
      ...baseConfig,
      limits: { maxConcurrentRuns: 1, maxQueuedMessages: 5 },
    });
    const { turn } = await startTurn();
    const firstRun = current;
    current = undefined;
    const other = runner.handle(message("other chat", REQUESTER, "c2"));
    await Bun.sleep(20);
    expect(runsStarted).toEqual(["hello"]);
    expect(sent.some((entry) => entry.text.includes("Busy with 1"))).toBe(true);
    firstRun?.finish();
    await turn;
    const running = (): FakeRun | undefined => current;
    for (let attempt = 0; running() === undefined && attempt < 200; attempt += 1)
      await Bun.sleep(1);
    expect(runsStarted).toEqual(["hello", "other chat"]);
    running()?.finish();
    await other;
  });

  test("shutdown tells whoever is waiting, cancels, and refuses new messages", async () => {
    const { turn } = await startTurn();
    await runner.shutdown(1_000);
    await turn;
    expect(current?.cancelled()).toBe(true);
    expect(sent.some((entry) => entry.text.includes("restarting"))).toBe(true);
    const before = runsStarted.length;
    await runner.handle(message("anyone there?"));
    expect(runsStarted).toHaveLength(before);
  });

  test("/mode yolo is refused for anyone but an operator", async () => {
    await runner.handle(message("/mode yolo", OTHER_MEMBER));
    expect(sent.at(-1)?.text).toContain("Operator only");
    expect(sent.at(-1)?.text).toContain(OTHER_MEMBER);
    expect(sent.at(-1)?.text).toContain("TEST_OPERATOR_IDS");

    await runner.handle(message("/mode yolo", OPERATOR));
    expect(sent.at(-1)?.text).toContain("Mode →");

    // Tightening back to safe is anyone's call.
    await runner.handle(message("/mode safe", OTHER_MEMBER));
    expect(sent.at(-1)?.text).toContain("Mode →");
  });
});

describe("commandKeyFromApproval", () => {
  const approval = (command: string) => ({
    type: "approval_required",
    toolName: "execute_command",
    message: `Command: ${command}\nDescription: run it`,
  });

  test("uses the executor's own approval key, not just the binary", () => {
    const command = "git status --short";
    expect(commandKeyFromApproval(approval(command))).toEqual({
      kind: "key",
      key: extractCommandApprovalKey(command),
    });
    expect(extractCommandApprovalKey(command)).toContain("git status");
  });

  test("a command with no key is unallowable, and anything else is not a command", () => {
    expect(commandKeyFromApproval(approval("   "))).toBeUndefined();
    expect(
      commandKeyFromApproval({ type: "approval_required", toolName: "web_search", message: "x" }),
    ).toBeUndefined();
  });
});
