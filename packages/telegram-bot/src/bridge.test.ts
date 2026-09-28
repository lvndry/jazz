import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChoiceTokens } from "@jazz/bot-shared/choice-tokens";
import type { JazzEnvelope, JazzEvent, JazzRun, JazzRunHandlers } from "@jazz/bot-shared/jazz-run";
import type { OutgoingMessage } from "@jazz/bot-shared/surface";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Bridge,
  type BridgeConfig,
  createBridge,
  dispatchMessage,
  handleCallback,
  inboundFrom,
} from "./bridge";
import { renderRichText, type TelegramSurface } from "./surface";

/** A run the test finishes by hand. */
interface ManualRun {
  readonly prompt: string;
  readonly handlers: JazzRunHandlers;
  readonly decisions: { toolCallId: string; approved: boolean }[];
  finish(envelope?: JazzEnvelope): void;
}

const OWNER = 1001;
const GROUP_MEMBER = 1002;
const GROUP = -500;

let dataDir: string;
let runs: ManualRun[];
let sent: OutgoingMessage[];
let calls: { method: string; payload: Record<string, unknown> }[];
let bridge: Bridge;
/** The callback data each drawn button carries, keyed by `<promptId>|<choiceId>`. */
let buttonData: Map<string, string>;

function fakeSurface(): TelegramSurface {
  const tokens = createChoiceTokens();
  let nextMessageId = 1;
  return {
    name: "telegram",
    capabilities: {
      editMessages: true,
      buttons: true,
      attachments: true,
      linkButtons: true,
      typingIndicator: true,
      maxMessageChars: 3_500,
    },
    send: (_chatId, message) => {
      sent.push(message);
      for (const choice of message.choices ?? []) {
        const promptId = message.promptId ?? "";
        buttonData.set(`${promptId}|${choice.id}`, tokens.mint({ promptId, choiceId: choice.id }));
      }
      return Promise.resolve(String(nextMessageId++));
    },
    // An edit is recorded like a send: the progress bubble closing is one.
    edit: (_chatId, _ref, message) => {
      sent.push(message);
      return Promise.resolve();
    },
    setChoices: () => Promise.resolve(),
    typing: () => Promise.resolve(),
    readChoice: (callbackData) => tokens.read(callbackData),
    call: (method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve({ ok: true });
    },
  };
}

function config(): BridgeConfig {
  return {
    botToken: "123:test",
    apiBase: "http://127.0.0.1:1",
    mode: "polling",
    webhookSecret: "",
    webhookUrl: undefined,
    allowedChatIds: new Set([OWNER, GROUP]),
    operatorIds: new Set([String(OWNER)]),
    baseAgentId: "telegram",
    provider: "openai",
    model: "gpt-5.4",
    reasoning: "medium",
    approvalPolicy: "low-risk",
    autoApproveTools: [],
    runTimeoutMs: 60_000,
    jazzBinary: "jazz",
    jazzHome: dataDir,
    builtinPersonasDir: "",
    port: 0,
    dailyCostCapUsd: 0,
    geocodeUrl: "",
    dynamicCta: false,
    showReasoning: false,
    webAppBaseUrl: undefined,
  };
}

function startRun(options: { prompt: string }, handlers: JazzRunHandlers = {}): JazzRun {
  let settle: (envelope: JazzEnvelope) => void = () => {};
  const result = new Promise<JazzEnvelope>((resolve) => {
    settle = resolve;
  });
  const decisions: { toolCallId: string; approved: boolean }[] = [];
  let cancelled = false;
  runs.push({
    prompt: options.prompt,
    handlers,
    decisions,
    finish: (envelope = { ok: true, answer: `answered: ${options.prompt}`, costUSD: 0 }) =>
      settle(envelope),
  });
  return {
    result,
    cancelled: () => cancelled,
    lastSpend: () => undefined,
    approve: (batch) => {
      decisions.push(...batch);
      return Promise.resolve();
    },
    answerQuestion: () => Promise.resolve(),
    cancel: () => {
      cancelled = true;
      settle({ ok: false, error: "cancelled" });
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await Bun.sleep(1);
  if (!condition()) throw new Error("condition never became true");
}

function button(promptId: string, choiceId: string): string {
  const data = buttonData.get(`${promptId}|${choiceId}`);
  if (data === undefined) throw new Error(`no ${choiceId} button for ${promptId}`);
  return data;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "telegram-bridge-"));
  mkdirSync(join(dataDir, "agents"), { recursive: true });
  writeFileSync(
    join(dataDir, "agents", "telegram.json"),
    JSON.stringify({
      id: "telegram",
      name: "Jazz",
      config: {
        llmProvider: "openai",
        llmModel: "gpt-5.4",
        reasoning: "medium",
        persona: "default",
      },
    }),
  );
  runs = [];
  sent = [];
  calls = [];
  buttonData = new Map();
  bridge = createBridge(config(), fakeSurface(), startRun as never);
});

afterEach(async () => {
  for (const run of runs) run.finish();
  await until(() => !bridge.runner.busy(String(OWNER)) && !bridge.runner.busy(String(GROUP)));
  rmSync(dataDir, { recursive: true, force: true });
});

describe("messages", () => {
  test("parked-run commands refuse non-operators and bot senders without starting a run", async () => {
    dispatchMessage(bridge, {
      chat: { id: GROUP },
      from: { id: GROUP_MEMBER },
      text: "/approve run-test",
    });
    await until(() => sent.length > 0);
    expect(renderRichText(sent.at(-1)?.body ?? [])).toContain("operator can answer a parked run");
    const before = sent.length;
    dispatchMessage(bridge, {
      chat: { id: OWNER },
      from: { id: OWNER, is_bot: true },
      text: "/deny run-test",
    });
    await until(() => sent.length > before);
    expect(renderRichText(sent.at(-1)?.body ?? [])).toContain("unknown");
    expect(runs).toHaveLength(0);
  });

  test("status reads the shared spend ledger without starting an agent run", async () => {
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "/status" });
    await until(() => sent.length > 0);
    const rendered = renderRichText(sent.at(-1)?.body ?? []);
    expect(rendered).toContain("Today: 0 runs");
    expect(rendered).not.toContain("undefined");
    expect(runs).toHaveLength(0);
  });

  test("two quick messages in one chat run one after the other", async () => {
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "first" });
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "second" });
    await until(() => runs.length === 1);
    await Bun.sleep(10);
    expect(runs.map((run) => run.prompt)).toEqual(["first"]);

    runs[0]?.finish();
    await until(() => runs.length === 2);
    expect(runs[1]?.prompt).toBe("second");
    runs[1]?.finish();
  });

  test("a command addressed to the bot by name is still a command", () => {
    expect(
      inboundFrom({ chat: { id: OWNER }, from: { id: OWNER }, text: "/status@my_jazz_bot" }),
    ).toMatchObject({ text: "/status@my_jazz_bot", senderId: String(OWNER) });
  });

  test("the answer is rendered from Markdown, not escaped as text", async () => {
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "hi" });
    await until(() => runs.length === 1);
    runs[0]?.finish({ ok: true, answer: "**bold** and `code`", costUSD: 0 });
    await until(() => sent.some((message) => message.promptId === "followup"));
    const answer = sent.find((message) => message.promptId === "followup");
    expect(renderRichText(answer?.body ?? [])).toContain("<b>bold</b>");
    expect(renderRichText(answer?.body ?? [])).toContain("<code>code</code>");
  });
});

describe("buttons", () => {
  const approval = (toolCallId: string): JazzEvent => ({
    type: "approval_required",
    toolCallId,
    toolName: "execute_command",
    message: "Command: git status\nDescription: check",
  });

  test("only the requester's tap answers an approval, and Approve all appears past one", async () => {
    dispatchMessage(bridge, { chat: { id: GROUP }, from: { id: GROUP_MEMBER }, text: "status?" });
    await until(() => runs.length === 1);
    runs[0]?.handlers.onApprovalRequired?.(approval("call-1"));
    runs[0]?.handlers.onApprovalRequired?.(approval("call-2"));
    await until(() => sent.filter((message) => message.promptId?.startsWith("call-")).length === 2);

    const second = sent.find((message) => message.promptId === "call-2");
    expect(second?.choices?.map((choice) => choice.label)).toContain("⚡ Approve all 2");
    // Always allow is offered (an operator exists) but only an operator may use it.
    expect(second?.choices?.some((choice) => choice.label.includes("Always allow"))).toBe(true);

    await handleCallback(bridge, {
      id: "q1",
      data: button("call-2", "approve"),
      message: { message_id: 9, chat: { id: GROUP } },
      from: { id: OWNER },
    });
    expect(runs[0]?.decisions).toEqual([]);
    expect(calls.at(-1)?.payload["text"]).toBe("Only the person who asked can answer this.");

    await handleCallback(bridge, {
      id: "q2",
      data: button("call-2", "approve"),
      message: { message_id: 9, chat: { id: GROUP } },
      from: { id: GROUP_MEMBER },
    });
    expect(runs[0]?.decisions).toEqual([{ toolCallId: "call-2", approved: true }]);
    runs[0]?.finish();
  });

  test("Always allow is refused to a requester who is not an operator", async () => {
    dispatchMessage(bridge, { chat: { id: GROUP }, from: { id: GROUP_MEMBER }, text: "status?" });
    await until(() => runs.length === 1);
    runs[0]?.handlers.onApprovalRequired?.(approval("call-1"));
    await until(() => sent.some((message) => message.promptId === "call-1"));

    await handleCallback(bridge, {
      id: "q1",
      data: button("call-1", "always"),
      message: { message_id: 4, chat: { id: GROUP } },
      from: { id: GROUP_MEMBER },
    });
    expect(runs[0]?.decisions).toEqual([]);
    expect(String(calls.at(-1)?.payload["text"])).toContain("TELEGRAM_OPERATOR_IDS");
    runs[0]?.finish();
  });

  test("the cancel button stops the requester's run", async () => {
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "long job" });
    await until(() => runs.length === 1);
    await handleCallback(bridge, {
      id: "q1",
      data: button("run:cancel", "cancel"),
      message: { message_id: 1, chat: { id: OWNER } },
      from: { id: OWNER },
    });
    await until(() => sent.some((message) => renderRichText(message.body).includes("Cancelled")));
  });

  test("a keyboard from before the upgrade answers that it expired", async () => {
    await handleCallback(bridge, {
      id: "q1",
      data: "a:call-1:1",
      message: { message_id: 3, chat: { id: OWNER } },
      from: { id: OWNER },
    });
    expect(calls.at(-1)?.method).toBe("answerCallbackQuery");
    expect(String(calls.at(-1)?.payload["text"])).toContain("expired");
  });
});
