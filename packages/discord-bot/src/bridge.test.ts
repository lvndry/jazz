/** Discord dispatch regression tests cover authorization, shared-runner delivery, and spend. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JazzEnvelope, JazzRun, JazzRunHandlers } from "@jazz/bot-shared/jazz-run";
import { renderPlain, type OutgoingMessage } from "@jazz/bot-shared/surface";
import { todayUsage } from "@jazz/bot-shared/usage-store";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type Bridge,
  type BridgeConfig,
  createBridge,
  dispatchMessage,
  slashCommandText,
} from "./bridge";
import { CHANNEL_TYPE_DM, type DiscordInteraction, type DiscordMessage } from "./discord";
import type { DiscordSurface } from "./surface";

const BOT = "900000000000000001";
const OWNER = "100000000000000001";
const DM_CHANNEL = "200000000000000001";

let dataDir: string;
let prompts: string[];
let finishers: ((envelope?: JazzEnvelope) => void)[];
let sent: OutgoingMessage[];
let bridge: Bridge;
let runHandlers: JazzRunHandlers;
let questionAnswers: { requestId: string; response: string }[];
let approvals: { toolCallId: string; approved: boolean }[];

function fakeSurface(): DiscordSurface {
  return {
    name: "discord",
    capabilities: {
      editMessages: true,
      buttons: true,
      attachments: true,
      linkButtons: true,
      typingIndicator: true,
      maxMessageChars: 1_900,
    },
    send: (_chatId, message) => {
      sent.push(message);
      return Promise.resolve(String(sent.length));
    },
    edit: () => Promise.resolve(),
    setChoices: () => Promise.resolve(),
    typing: () => Promise.resolve(),
    readChoice: () => undefined,
  };
}

function config(): BridgeConfig {
  return {
    botToken: "token",
    operatorIds: new Set([OWNER]),
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set(),
    allowedGuildIds: new Set(),
    requireMention: true,
    createThreads: true,
    baseAgentId: "discord",
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
    dynamicCta: false,
    showReasoning: false,
    publicBaseUrl: undefined,
  };
}

function startRun(options: { prompt: string }, handlers: JazzRunHandlers = {}): JazzRun {
  runHandlers = handlers;
  prompts.push(options.prompt);
  let settle: (envelope: JazzEnvelope) => void = () => {};
  const result = new Promise<JazzEnvelope>((resolve) => {
    settle = resolve;
  });
  finishers.push((envelope = { ok: true, answer: "done", costUSD: 0 }) => settle(envelope));
  return {
    result,
    cancelled: () => false,
    lastSpend: () => undefined,
    approve: (decisions) => {
      approvals.push(...decisions);
      return Promise.resolve();
    },
    answerQuestion: (requestId, response) => {
      questionAnswers.push({ requestId, response });
      return Promise.resolve();
    },
    answerSecret: () => Promise.resolve(),
    cancel: () => settle({ ok: false, error: "cancelled" }),
  };
}

function dm(content: string, extras: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: String(Date.now()),
    channel_id: DM_CHANNEL,
    content,
    author: { id: OWNER },
    ...extras,
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1) await Bun.sleep(1);
  if (!condition()) throw new Error("condition never became true");
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "discord-bridge-"));
  mkdirSync(join(dataDir, "agents"), { recursive: true });
  writeFileSync(
    join(dataDir, "agents", "discord.json"),
    JSON.stringify({
      id: "discord",
      name: "Jazz",
      config: {
        llmProvider: "openai",
        llmModel: "gpt-5.4",
        reasoning: "medium",
        persona: "default",
      },
    }),
  );
  runHandlers = {};
  questionAnswers = [];
  approvals = [];
  prompts = [];
  finishers = [];
  sent = [];
  bridge = createBridge(config(), fakeSurface(), {
    startRun: startRun as never,
    fetchChannel: () =>
      Promise.resolve({ type: CHANNEL_TYPE_DM, parentId: undefined, guildId: undefined }),
  });
});

afterEach(async () => {
  for (const finish of finishers) finish();
  await until(() => !bridge.runner.busy(DM_CHANNEL));
  rmSync(dataDir, { recursive: true, force: true });
});

const runtime = { botUserId: BOT, applicationId: BOT };

describe("guild questions", () => {
  const OTHER = "300000000000000001";
  const GUILD_CHANNEL = "200000000000000002";
  let allowedUsers: Set<string>;

  function guildMessage(content: string, extras: Partial<DiscordMessage> = {}): DiscordMessage {
    return { ...dm(content, extras), channel_id: extras.channel_id ?? GUILD_CHANNEL };
  }

  beforeEach(() => {
    allowedUsers = new Set([OWNER, OTHER]);
    bridge = createBridge(
      {
        ...config(),
        createThreads: false,
        allowedUserIds: allowedUsers,
        allowedChannelIds: new Set([GUILD_CHANNEL]),
      },
      fakeSurface(),
      {
        startRun,
        fetchChannel: () =>
          Promise.resolve({ type: 0, parentId: undefined, guildId: "400000000000000001" }),
      },
    );
  });

  async function askQuestion(): Promise<{ turn: Promise<void> }> {
    const turn = dispatchMessage(bridge, runtime, guildMessage(`<@${BOT}> create a note`));
    await until(() => prompts.length === 1);
    runHandlers.onUserInputRequired?.({
      type: "user_input_required",
      requestId: "q1",
      question: "What should the file be called?",
    });
    await until(() => bridge.runner.awaitsReplyFrom(GUILD_CHANNEL, OWNER));
    return { turn };
  }

  async function requestApproval(): Promise<{ turn: Promise<void> }> {
    const turn = dispatchMessage(bridge, runtime, guildMessage(`<@${BOT}> clean the build`));
    await until(() => prompts.length === 1);
    runHandlers.onApprovalRequired?.({
      type: "approval_required",
      toolCallId: "tc1",
      toolName: "execute_command",
    });
    await until(() => bridge.runner.awaitsReplyFrom(GUILD_CHANNEL, OWNER));
    return { turn };
  }

  test("the requester approves with a bare choice number, without another mention", async () => {
    const { turn } = await requestApproval();
    await dispatchMessage(bridge, runtime, guildMessage("1"));
    expect(approvals).toEqual([{ toolCallId: "tc1", approved: true }]);
    finishers[0]?.();
    await turn;
    expect(prompts).toEqual(["clean the build"]);
  });

  test("unaddressed chatter during an approval is dropped, not queued, and fetches nothing", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const { turn } = await requestApproval();
      await dispatchMessage(
        bridge,
        runtime,
        guildMessage("lunch anyone?", {
          attachments: [
            { id: "a1", filename: "menu.png", url: "https://cdn.example/menu.png", size: 10 },
          ],
        }),
      );
      expect(approvals).toEqual([]);
      expect(bridge.runner.awaitsReplyFrom(GUILD_CHANNEL, OWNER)).toBe(true);
      finishers[0]?.();
      await turn;
      await until(() => !bridge.runner.busy(GUILD_CHANNEL));
      expect(prompts).toEqual(["clean the build"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the requester can answer without another mention, then chatter is gated again", async () => {
    const { turn } = await askQuestion();
    await dispatchMessage(bridge, runtime, guildMessage("notes.md"));
    expect(questionAnswers).toEqual([{ requestId: "q1", response: "notes.md" }]);
    expect(bridge.runner.awaitsReplyFrom(GUILD_CHANNEL, OWNER)).toBe(false);
    finishers[0]?.();
    await turn;
    await dispatchMessage(bridge, runtime, guildMessage("unaddressed chatter"));
    expect(prompts).toEqual(["create a note"]);
  });

  test("a pending question does not bypass sender or channel authorization", async () => {
    const { turn } = await askQuestion();
    await dispatchMessage(
      bridge,
      runtime,
      guildMessage("someone else's answer", { author: { id: OTHER } }),
    );
    await dispatchMessage(
      bridge,
      runtime,
      guildMessage(`<@${BOT}> outsider answer`, { author: { id: "500000000000000001" } }),
    );
    await dispatchMessage(
      bridge,
      runtime,
      guildMessage(`<@${BOT}> wrong channel`, { channel_id: "600000000000000001" }),
    );
    allowedUsers.delete(OWNER);
    await dispatchMessage(bridge, runtime, guildMessage("revoked requester's answer"));
    expect(questionAnswers).toEqual([]);
    expect(bridge.runner.awaitsReplyFrom(GUILD_CHANNEL, OWNER)).toBe(true);
    finishers[0]?.();
    await turn;
    expect(prompts).toEqual(["create a note"]);
  });
});

describe("messages", () => {
  test("parked-run commands retain operator authorization without starting an agent", async () => {
    bridge = createBridge({ ...config(), operatorIds: new Set() }, fakeSurface(), {
      startRun: startRun as never,
      fetchChannel: () =>
        Promise.resolve({ type: CHANNEL_TYPE_DM, parentId: undefined, guildId: undefined }),
    });
    await dispatchMessage(bridge, runtime, dm("/approve run-test"));
    expect(prompts).toEqual([]);
    expect(renderPlain(sent.at(-1)?.body ?? [])).toContain("operator can answer a parked run");
    const previous = sent.length;
    await dispatchMessage(
      bridge,
      runtime,
      dm("/approve run-test", { author: { id: OWNER, bot: true } }),
    );
    expect(sent).toHaveLength(previous);
  });

  test("status reads this bridge's shared spend origin", async () => {
    await dispatchMessage(bridge, runtime, dm("/status"));
    expect(prompts).toEqual([]);
    expect(renderPlain(sent.at(-1)?.body ?? [])).toContain("Today: 0 runs");
  });
  test("two quick messages in one conversation run one after the other", async () => {
    const first = dispatchMessage(bridge, runtime, dm("first"));
    const second = dispatchMessage(bridge, runtime, dm("second"));
    await until(() => prompts.length === 1);
    await second;
    expect(prompts).toEqual(["first"]);
    finishers[0]?.();
    await until(() => prompts.length === 2);
    expect(prompts[1]).toBe("second");
    finishers[1]?.();
    await first;
  });

  test("records a failed run's spend through the shared runner", async () => {
    const done = dispatchMessage(bridge, runtime, dm("start a paid run"));
    await until(() => prompts.length === 1);
    finishers[0]?.({
      ok: false,
      error: "provider failed",
      costUSD: 0.25,
      costKnown: true,
      tokenUsage: { totalTokens: 42 },
    });
    await done;
    await until(() => !bridge.runner.busy(DM_CHANNEL));
    expect(await todayUsage(dataDir, "discord")).toMatchObject({
      costUSD: 0.25,
      tokens: 42,
      runs: 1,
    });
  });

  test("a message from someone not on the allowlist starts nothing", async () => {
    await dispatchMessage(bridge, runtime, dm("hi", { author: { id: "300000000000000001" } }));
    expect(prompts).toEqual([]);
  });

  test("an attachment is saved into the conversation's home and handed over by path", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("voice-bytes") });
    try {
      const done = dispatchMessage(
        bridge,
        runtime,
        dm("what does this say?", {
          attachments: [
            {
              id: "att1",
              filename: "note./../../escape.ogg",
              url: `http://127.0.0.1:${server.port}/note.ogg`,
              size: 11,
              content_type: "audio/ogg",
            },
          ],
        }),
      );
      await until(() => prompts.length === 1);
      const path = prompts[0]?.split("\n\n").at(-1) ?? "";
      expect(prompts[0]?.startsWith("what does this say?")).toBe(true);
      expect(path).toBe(join(dataDir, "dc-media", "att1.ogg"));
      expect(existsSync(path) && readFileSync(path, "utf8")).toBe("voice-bytes");
      finishers[0]?.();
      await done;
    } finally {
      void server.stop(true);
    }
  });
});

describe("slash commands", () => {
  const interaction = (name: string, options: { name: string; value: string }[] = []) =>
    ({
      id: "1",
      token: "t",
      type: 2,
      application_id: BOT,
      data: { name, options: options.map((option) => ({ ...option, type: 3 })) },
    }) as DiscordInteraction;

  test("become the text commands the runner understands", () => {
    expect(slashCommandText(interaction("status"))).toBe("/status");
    expect(slashCommandText(interaction("mode", [{ name: "mode", value: "yolo" }]))).toBe(
      "/mode yolo",
    );
    expect(
      slashCommandText(
        interaction("remind", [
          { name: "when", value: "30m" },
          { name: "text", value: "pizza" },
        ]),
      ),
    ).toBe("/remind 30m pizza");
  });
});
