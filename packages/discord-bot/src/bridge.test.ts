import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JazzEnvelope, JazzRun } from "@jazz/bot-shared/jazz-run";
import type { OutgoingMessage } from "@jazz/bot-shared/surface";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

function startRun(options: { prompt: string }): JazzRun {
  prompts.push(options.prompt);
  let settle: (envelope: JazzEnvelope) => void = () => {};
  const result = new Promise<JazzEnvelope>((resolve) => {
    settle = resolve;
  });
  finishers.push((envelope = { ok: true, answer: "done", costUSD: 0 }) => settle(envelope));
  return {
    result,
    cancelled: () => false,
    approve: () => Promise.resolve(),
    answerQuestion: () => Promise.resolve(),
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
  prompts = [];
  finishers = [];
  sent = [];
  bridge = createBridge(config(), fakeSurface(), {
    startRun: startRun as never,
    fetchChannel: () =>
      Promise.resolve({ type: CHANNEL_TYPE_DM, parentId: undefined, guildId: undefined }),
  });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const runtime = { botUserId: BOT, applicationId: BOT };

describe("messages", () => {
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
