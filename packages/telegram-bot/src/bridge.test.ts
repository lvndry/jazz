import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChoiceTokens } from "@jazz/bot-shared/choice-tokens";
import type { JazzEnvelope, JazzEvent, JazzRun, JazzRunHandlers } from "@jazz/bot-shared/jazz-run";
import type { OutgoingMessage } from "@jazz/bot-shared/surface";
import { waitUntil } from "@jazz/bot-shared/wait-until";
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
  /** The agent the run was started for, which is also whose sandbox it runs in. */
  readonly agentId: string;
  /** The persistent conversation's key, or undefined for an incognito run. */
  readonly conversationKey: string | undefined;
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
/** Where each entry of `sent` went, index for index. */
let sentTo: string[];
let calls: { method: string; payload: Record<string, unknown> }[];
/** How many more times the fake Bot API refuses each method before it accepts it. */
let refusedCalls: Map<string, number>;
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
    send: (chatId, message) => {
      sent.push(message);
      sentTo.push(chatId);
      for (const choice of message.choices ?? []) {
        const promptId = message.promptId ?? "";
        buttonData.set(`${promptId}|${choice.id}`, tokens.mint({ promptId, choiceId: choice.id }));
      }
      return Promise.resolve(String(nextMessageId++));
    },
    // An edit is recorded like a send: the progress bubble closing is one.
    edit: (chatId, _ref, message) => {
      sent.push(message);
      sentTo.push(chatId);
      return Promise.resolve();
    },
    setChoices: () => Promise.resolve(),
    typing: () => Promise.resolve(),
    readChoice: (callbackData) => tokens.read(callbackData),
    call: (method, payload) => {
      calls.push({ method, payload });
      const refusals = refusedCalls.get(method) ?? 0;
      if (refusals > 0) {
        refusedCalls.set(method, refusals - 1);
        return Promise.resolve({ ok: false, error_code: 400 });
      }
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

function startRun(
  options: {
    prompt: string;
    agentId: string;
    conversation: { kind: "persistent"; key: string } | { kind: "ephemeral" };
  },
  handlers: JazzRunHandlers = {},
): JazzRun {
  let settle: (envelope: JazzEnvelope) => void = () => {};
  const result = new Promise<JazzEnvelope>((resolve) => {
    settle = resolve;
  });
  const decisions: { toolCallId: string; approved: boolean }[] = [];
  let cancelled = false;
  runs.push({
    prompt: options.prompt,
    agentId: options.agentId,
    conversationKey:
      options.conversation.kind === "persistent" ? options.conversation.key : undefined,
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
    answerSecret: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(),
    delivered: () => false,
    cancel: () => {
      cancelled = true;
      settle({ ok: false, error: "cancelled" });
    },
  };
}

function button(promptId: string, choiceId: string): string {
  const data = buttonData.get(`${promptId}|${choiceId}`);
  if (data === undefined) {
    throw new Error(`no ${choiceId} button for ${promptId}`);
  }
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
        llm: { provider: "openai", model: "gpt-5.4", reasoning: "medium" },
        persona: "default",
      },
    }),
  );
  runs = [];
  sent = [];
  sentTo = [];
  calls = [];
  refusedCalls = new Map();
  buttonData = new Map();
  bridge = createBridge(config(), fakeSurface(), startRun as never);
});

afterEach(async () => {
  for (const run of runs) {
    run.finish();
  }
  await waitUntil(() => !bridge.runner.busy(String(OWNER)) && !bridge.runner.busy(String(GROUP)));
  rmSync(dataDir, { recursive: true, force: true });
});

describe("messages", () => {
  test("parked-run commands refuse non-operators and bot senders without starting a run", async () => {
    dispatchMessage(bridge, {
      chat: { id: GROUP },
      from: { id: GROUP_MEMBER },
      text: "/approve run-test",
    });
    await waitUntil(() => sent.length > 0);
    expect(renderRichText(sent.at(-1)?.body ?? [])).toContain("operator can answer a parked run");
    const before = sent.length;
    dispatchMessage(bridge, {
      chat: { id: OWNER },
      from: { id: OWNER, is_bot: true },
      text: "/deny run-test",
    });
    await waitUntil(() => sent.length > before);
    expect(renderRichText(sent.at(-1)?.body ?? [])).toContain("unknown");
    expect(runs).toHaveLength(0);
  });

  test("status reads the shared spend ledger without starting an agent run", async () => {
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "/status" });
    await waitUntil(() => sent.length > 0);
    const rendered = renderRichText(sent.at(-1)?.body ?? []);
    expect(rendered).toContain("Today: 0 runs");
    expect(rendered).not.toContain("undefined");
    expect(runs).toHaveLength(0);
  });

  test("two quick messages in one chat run one after the other", async () => {
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "first" });
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "second" });
    await waitUntil(() => runs.length === 1);
    await Bun.sleep(10);
    expect(runs.map((run) => run.prompt)).toEqual(["first"]);

    runs[0]?.finish();
    await waitUntil(() => runs.length === 2);
    expect(runs[1]?.prompt).toBe("second");
    runs[1]?.finish();
  });

  test("a command addressed to the bot by name is still a command", () => {
    expect(
      inboundFrom({ chat: { id: OWNER }, from: { id: OWNER }, text: "/status@my_jazz_bot" }),
    ).toMatchObject({ text: "/status@my_jazz_bot", senderId: String(OWNER) });
  });

  test("a message says whether its chat is private, and carries its own id and words", () => {
    expect(
      inboundFrom({
        message_id: 77,
        chat: { id: OWNER, type: "private" },
        from: { id: OWNER },
        text: "s3cret",
        reply_to_message: { text: "The agent needs a secret" },
      }),
    ).toMatchObject({ privateChat: true, ref: "77", ownText: "s3cret" });
    expect(
      inboundFrom({ chat: { id: -100, type: "supergroup" }, from: { id: OWNER }, text: "hi" }),
    ).toMatchObject({ privateChat: false });
  });

  test("the answer is rendered from Markdown, not escaped as text", async () => {
    dispatchMessage(bridge, { chat: { id: OWNER }, from: { id: OWNER }, text: "hi" });
    await waitUntil(() => runs.length === 1);
    runs[0]?.finish({ ok: true, answer: "**bold** and `code`", costUSD: 0 });
    await waitUntil(() => sent.some((message) => message.promptId === "followup"));
    const answer = sent.find((message) => message.promptId === "followup");
    expect(renderRichText(answer?.body ?? [])).toContain("<b>bold</b>");
    expect(renderRichText(answer?.body ?? [])).toContain("<code>code</code>");
  });
});

describe("topics", () => {
  const inTopic = (topicId: number, text: string) => ({
    chat: { id: OWNER, type: "private" },
    from: { id: OWNER },
    message_thread_id: topicId,
    is_topic_message: true,
    text,
  });
  const topicAddress = (topicId: number): string => `${OWNER}_${topicId}`;

  /** Finish every run, including one a queued message starts once the run ahead of it ends. */
  const settle = async (...topicIds: number[]): Promise<void> => {
    await waitUntil(() => {
      for (const run of runs) {
        run.finish();
      }
      return topicIds.every((topicId) => !bridge.runner.busy(topicAddress(topicId)));
    });
  };

  test("two topics of one chat are two conversations that run at once in one sandbox", async () => {
    dispatchMessage(bridge, inTopic(7, "plan the trip"));
    dispatchMessage(bridge, inTopic(9, "do my taxes"));
    await waitUntil(() => runs.length === 2);

    expect(runs.map((run) => run.conversationKey).sort()).toEqual([
      topicAddress(7),
      topicAddress(9),
    ]);
    expect(new Set(runs.map((run) => run.agentId))).toEqual(new Set([`tg_${OWNER}`]));
    await settle(7, 9);
  });

  test("everything a topic's run says goes back into that topic", async () => {
    dispatchMessage(bridge, inTopic(7, "plan the trip"));
    await waitUntil(() => runs.length === 1);
    runs[0]?.finish();
    await waitUntil(() => sent.some((message) => message.promptId === "followup"));

    expect(new Set(sentTo)).toEqual(new Set([topicAddress(7)]));
    await settle(7);
  });

  test("a reply chain in a group without topics stays in the group's one conversation", async () => {
    dispatchMessage(bridge, {
      chat: { id: GROUP, type: "supergroup" },
      from: { id: OWNER },
      message_thread_id: 55,
      text: "hello",
    });
    await waitUntil(() => runs.length === 1);
    expect(runs[0]?.conversationKey).toBe(String(GROUP));
  });

  test("/new in one topic leaves the other topic's conversation alone", async () => {
    dispatchMessage(bridge, inTopic(7, "/new"));
    await waitUntil(() => sentTo.includes(topicAddress(7)));
    dispatchMessage(bridge, inTopic(7, "fresh start"));
    dispatchMessage(bridge, inTopic(9, "carry on"));
    await waitUntil(() => runs.length === 2);

    const keyFor = (prompt: string) => runs.find((run) => run.prompt === prompt)?.conversationKey;
    expect(keyFor("fresh start")).toBe(`${topicAddress(7)}-1`);
    expect(keyFor("carry on")).toBe(topicAddress(9));
    await settle(7, 9);
  });

  test("a timezone set in one topic holds in the chat's other topics", async () => {
    dispatchMessage(bridge, inTopic(7, "/tz Europe/Paris"));
    await waitUntil(() => sentTo.includes(topicAddress(7)));
    dispatchMessage(bridge, inTopic(9, "/tz"));
    await waitUntil(() => sentTo.includes(topicAddress(9)));

    const reply = sent[sentTo.indexOf(topicAddress(9))];
    expect(renderRichText(reply?.body ?? [])).toContain("Europe/Paris");
  });

  test("a tapped button answers the prompt of the topic it was drawn in", async () => {
    dispatchMessage(bridge, inTopic(7, "delete it"));
    await waitUntil(() => runs.length === 1);
    runs[0]?.handlers.onApprovalRequired?.({
      type: "approval_required",
      toolCallId: "call-1",
      toolName: "execute_command",
      message: "Command: rm -rf build\nDescription: clean",
    });
    await waitUntil(() => sent.some((message) => message.promptId === "call-1"));

    await handleCallback(bridge, {
      id: "cb-1",
      data: button("call-1", "approve"),
      message: {
        message_id: 5,
        chat: { id: OWNER },
        message_thread_id: 7,
        is_topic_message: true,
      },
      from: { id: OWNER },
    });
    expect(runs[0]?.decisions).toEqual([{ toolCallId: "call-1", approved: true }]);
    await settle(7);
  });

  test("a topic opened without a name is named from its first message", async () => {
    dispatchMessage(bridge, {
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER },
      message_thread_id: 21,
      is_topic_message: true,
      forum_topic_created: { is_name_implicit: true },
    });
    dispatchMessage(bridge, inTopic(21, "/status"));
    await waitUntil(() => sentTo.includes(topicAddress(21)));
    expect(calls.some((call) => call.method === "editForumTopic")).toBe(false);

    dispatchMessage(bridge, inTopic(21, "Plan the Lisbon trip"));
    await waitUntil(() => calls.some((call) => call.method === "editForumTopic"));
    expect(calls.find((call) => call.method === "editForumTopic")?.payload).toEqual({
      chat_id: OWNER,
      message_thread_id: 21,
      name: "Plan the Lisbon trip",
    });

    dispatchMessage(bridge, inTopic(21, "and book the flights"));
    await waitUntil(() => runs.length === 1);
    expect(calls.filter((call) => call.method === "editForumTopic")).toHaveLength(1);
    await settle(21);
  });

  const openUnnamed = (topicId: number): void => {
    dispatchMessage(bridge, {
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER },
      message_thread_id: topicId,
      is_topic_message: true,
      forum_topic_created: { is_name_implicit: true },
    });
  };
  const renames = () => calls.filter((call) => call.method === "editForumTopic");

  test("a rename Telegram refuses is tried again with the next message", async () => {
    refusedCalls.set("editForumTopic", 1);
    openUnnamed(23);
    dispatchMessage(bridge, inTopic(23, "Plan the Lisbon trip"));
    await waitUntil(() => renames().length === 1);
    await Bun.sleep(10);

    dispatchMessage(bridge, inTopic(23, "and book the flights"));
    await waitUntil(() => renames().length === 2);
    expect(renames()[1]?.payload["name"]).toBe("and book the flights");

    dispatchMessage(bridge, inTopic(23, "thanks"));
    await Bun.sleep(10);
    expect(renames()).toHaveLength(2);
    await settle(23);
  });

  test("a photo's caption names the topic it opens", async () => {
    openUnnamed(24);
    dispatchMessage(bridge, {
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER },
      message_thread_id: 24,
      is_topic_message: true,
      photo: [{ file_id: "photo-1" }],
      caption: "What plant is this?",
    });
    await waitUntil(() => renames().length === 1);
    expect(renames()[0]?.payload["name"]).toBe("What plant is this?");
  });

  test("a topic the person named themselves keeps its name", async () => {
    dispatchMessage(bridge, {
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER },
      message_thread_id: 22,
      is_topic_message: true,
      forum_topic_created: {},
    });
    dispatchMessage(bridge, inTopic(22, "hello"));
    await waitUntil(() => runs.length === 1);
    expect(calls.some((call) => call.method === "editForumTopic")).toBe(false);
    await settle(22);
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
    await waitUntil(() => runs.length === 1);
    runs[0]?.handlers.onApprovalRequired?.(approval("call-1"));
    runs[0]?.handlers.onApprovalRequired?.(approval("call-2"));
    await waitUntil(
      () => sent.filter((message) => message.promptId?.startsWith("call-")).length === 2,
    );

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
    await waitUntil(() => runs.length === 1);
    runs[0]?.handlers.onApprovalRequired?.(approval("call-1"));
    await waitUntil(() => sent.some((message) => message.promptId === "call-1"));

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
    await waitUntil(() => runs.length === 1);
    await handleCallback(bridge, {
      id: "q1",
      data: button("run:cancel", "cancel"),
      message: { message_id: 1, chat: { id: OWNER } },
      from: { id: OWNER },
    });
    await waitUntil(() =>
      sent.some((message) => renderRichText(message.body).includes("Cancelled")),
    );
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
