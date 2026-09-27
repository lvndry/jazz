/**
 * @fileoverview The chat commands every bridge answers, and the pickers some of them draw.
 *
 * `/new`, `/incognito`, `/model`, `/persona`, `/mode`, `/tz`, `/remind`, `/reminders`,
 * `/status` and `/help` differ between bridges only in markup, which `RichText` already
 * abstracts. A surface with buttons also gets pickers: bare `/model`, `/persona`, `/mode`
 * and `/reminders` put the options under the reply, and a tap on one comes back through
 * `handleChoice`. A surface without buttons gets the same information as text, since a
 * numbered menu there would swallow the person's next real message.
 *
 * Split from `turn.ts`, which owns the conversation state and the run; this owns what a
 * command says and changes, and reaches the rest through `CommandContext`.
 */

import { AVAILABLE_PROVIDERS, type ProviderName } from "@jazz/core/constants/models";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { parseProviderModel } from "@jazz/core/utils/provider-model";
import type { AgentFile } from "./agent-file";
import { formatTokenCount } from "./answer";
import {
  APPROVAL_MODE_LABELS,
  type ApprovalMode,
  approvalModeFor,
  describeApprovalMode,
  setApprovalMode,
} from "./approval-mode-store";
import { type ChatSandbox, sandboxOwnership } from "./chat-sandbox";
import { listPersonaNames } from "./personas";
import { listModelsForProvider } from "./provider-models";
import { cancelReminder, readReminders } from "./reminder-store";
import { isIncognito, setIncognito, startNewConversation } from "./session-store";
import {
  bold,
  type ChatId,
  type Choice,
  code,
  line,
  plainLine,
  type RichText,
  text,
} from "./surface";
import { formatWhen, hasChatTz, isValidTimeZone, setTzForChat, tzForChat } from "./timezone-store";
import type { ChoiceOutcome, ChoiceTap, InboundMessage, SenderId, TurnConfig } from "./turn";
import { todayUsage } from "./usage-store";

/** What a tap on a picker answers. Namespaced so no agent-minted prompt id can equal one. */
export const MODEL_PROMPT_ID = "command:model";
export const PERSONA_PROMPT_ID = "command:persona";
export const MODE_PROMPT_ID = "command:mode";
export const REMINDERS_PROMPT_ID = "command:reminders";

/** Every command name this module answers, `/stop` included (the runner handles that one). */
const COMMAND_NAMES: ReadonlySet<string> = new Set([
  "help",
  "start",
  "new",
  "reset",
  "incognito",
  "status",
  "model",
  "persona",
  "mode",
  "tz",
  "timezone",
  "remind",
  "reminders",
  "stop",
  "cancel",
]);

/** Commands that answer at once, even mid-run. `/remind` starts a run, so it waits. */
const IMMEDIATE_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "help",
  "start",
  "status",
  "new",
  "reset",
  "stop",
  "cancel",
]);

const COMMAND_PROMPT_IDS: ReadonlySet<string> = new Set([
  MODEL_PROMPT_ID,
  PERSONA_PROMPT_ID,
  MODE_PROMPT_ID,
  REMINDERS_PROMPT_ID,
]);

/**
 * Most options a picker shows. Discord's select menu and a phone-width keyboard both stop
 * being usable past this; a provider with more models is still reachable by name.
 */
const MAX_PICKER_CHOICES = 25;

/** Characters of a reminder's text on its cancel button, so the time stays readable. */
const REMINDER_LABEL_TEXT_CHARS = 24;

/** The reasoning effort a reasoning-capable model is switched to, and the one for any other. */
const REASONING_MODEL_EFFORT = "medium";
const NON_REASONING_EFFORT = "disable";

const REMIND_USAGE: RichText = [
  line(text("Usage: "), code("/remind <when> <text>")),
  line(
    text("e.g. "),
    code("/remind 30m take pizza out"),
    text(", "),
    code("/remind tomorrow 09:00 gym"),
    text(", "),
    code("/remind 2026-08-25 20:00 pack shoes"),
  ),
  plainLine("…or just say it: “remind me to call the dentist in 2 hours”."),
];

export interface CommandContext {
  readonly config: TurnConfig;
  send(chatId: ChatId, body: RichText, choices?: CommandChoices): Promise<void>;
  sandboxFor(chatId: ChatId): ChatSandbox;
  ensureAgent(chatId: ChatId, sandbox: ChatSandbox): AgentFile;
  writeAgent(sandbox: ChatSandbox, agent: AgentFile): void;
  /** Run a turn as if the person had typed `message`. */
  runTurn(message: InboundMessage): Promise<void>;
  forgetIncognitoHistory(chatId: ChatId): void;
  /** When this runner started, for `/status`. */
  readonly startedAt: number;
}

/** A picker to draw under a command's reply. */
export interface CommandChoices {
  readonly choices: readonly Choice[];
  readonly promptId: string;
}

export interface Commands {
  /** Returns whether the text was a command and has been dealt with. */
  handle(message: InboundMessage): Promise<boolean>;
  /** Whether the text is one of the commands this runner answers. */
  isCommand(text: string): boolean;
  /**
   * Whether the text is a command answered even while a run is in flight: it is about the
   * conversation, not a request for the agent, so it should not wait for the answer.
   */
  answersImmediately(text: string): boolean;
  /** Whether a tapped prompt id belongs to a picker. */
  owns(promptId: string): boolean;
  /** A tap on a picker drawn by one of the commands above. */
  handleChoice(tap: ChoiceTap): Promise<ChoiceOutcome>;
}

/** `/model@my_bot args` → `{ command: "model", args: "args" }`, or undefined for prose. */
export function parseCommand(body: string): { command: string; args: string } | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(body.trim());
  const command = match?.[1];
  if (command === undefined) return undefined;
  return { command: command.toLowerCase(), args: (match?.[2] ?? "").trim() };
}

export function formatUptime(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

/** The refusal for something only an operator may do, naming the sender's id. */
export function operatorOnlyMessage(
  senderId: SenderId,
  what: string,
  operatorSettingName: string,
): RichText {
  return [
    line(bold("🔒 Operator only")),
    plainLine(`${what} is only for this bot's operator.`),
    line(
      text("To allow it, the operator adds your id "),
      code(senderId),
      text(" to "),
      code(operatorSettingName),
      text("."),
    ),
  ];
}

export function createCommands(context: CommandContext): Commands {
  const { config } = context;
  const { surface } = config;
  const buttons = surface.capabilities.buttons;
  const markup = { bold: (value: string) => value, code: (value: string) => value };

  const reasoningFor = (isReasoningModel: boolean): string =>
    isReasoningModel ? REASONING_MODEL_EFFORT : NON_REASONING_EFFORT;

  /** Drop a picker's buttons once it has been answered, where the surface can. */
  const closePicker = async (tap: ChoiceTap): Promise<void> => {
    if (tap.messageRef === undefined || surface.setChoices === undefined) return;
    await surface.setChoices(tap.chatId, tap.messageRef, []).catch(() => undefined);
  };

  const help = (): RichText => [
    line(bold("Jazz")),
    plainLine("Just write normally — every message runs the agent."),
    plainLine(""),
    plainLine("/new — fresh conversation (keeps model and persona)"),
    plainLine(
      buttons
        ? "/model — pick a model, or /model provider/model for any provider"
        : "/model provider/model — switch this chat's model",
    ),
    plainLine(buttons ? "/persona — pick a persona" : "/persona name — switch this chat's persona"),
    plainLine("/mode safe|yolo — whether risky tools stop to ask (yolo is operator-only)"),
    plainLine("/remind <when> <text> — e.g. /remind 30m take pizza out"),
    plainLine("/reminders — list your reminders"),
    plainLine("/tz Europe/Paris — timezone reminders resolve in"),
    plainLine("/status — model, mode, timezone, today's usage"),
    plainLine("/stop — stop the answer in progress"),
    ...(config.incognitoFile === undefined
      ? []
      : [plainLine("/incognito — keep this conversation in memory only, until /new")]),
    plainLine("/help — this message"),
    ...(config.extraHelp ?? []).map((extra) => plainLine(extra)),
    ...(buttons
      ? []
      : [
          plainLine(""),
          plainLine("When the agent asks something, reply with the option's number."),
        ]),
  ];

  const handleStatus = async (chatId: ChatId): Promise<void> => {
    const sandbox = context.sandboxFor(chatId);
    const agent = context.ensureAgent(chatId, sandbox);
    const usage = todayUsage(config.jazzHome, config.files.usage);
    const mode = approvalModeFor(config.jazzHome, config.files.mode, chatId);
    const timezone = tzForChat(config.jazzHome, config.files.timezone, chatId);
    const incognito =
      config.incognitoFile !== undefined &&
      isIncognito(config.jazzHome, config.incognitoFile, chatId);
    const unpriced = usage.unpricedRuns ?? 0;

    await context.send(chatId, [
      line(bold("📊 Status")),
      ...(incognito ? [plainLine("🕶️ Incognito — nothing being saved right now")] : []),
      line(
        text("Model: "),
        code(`${agent.config.llmProvider}/${agent.config.llmModel}`),
        text(` (reasoning: ${agent.config.reasoning})`),
      ),
      plainLine(`Persona: ${agent.config.persona}`),
      plainLine(`Mode: ${APPROVAL_MODE_LABELS[mode]}`),
      line(
        text("Timezone: "),
        code(timezone),
        text(hasChatTz(config.jazzHome, config.files.timezone, chatId) ? "" : " (default)"),
      ),
      plainLine(
        `Today: ${usage.runs} run${usage.runs === 1 ? "" : "s"} · ` +
          `${formatTokenCount(usage.tokens)} tokens · $${usage.costUSD.toFixed(4)}` +
          (unpriced > 0 ? ` · ${unpriced} unpriced` : ""),
      ),
      plainLine(
        `Daily cap: ${config.dailyCostCapUsd > 0 ? `$${config.dailyCostCapUsd.toFixed(2)}` : "none"}`,
      ),
      plainLine(`Uptime: ${formatUptime(Date.now() - context.startedAt)}`),
    ]);
  };

  const providerModels = async (provider: string) =>
    (AVAILABLE_PROVIDERS as readonly string[]).includes(provider)
      ? listModelsForProvider(provider as ProviderName)
      : [];

  const handleModel = async (chatId: ChatId, args: string): Promise<void> => {
    const sandbox = context.sandboxFor(chatId);
    const agent = context.ensureAgent(chatId, sandbox);

    if (args.length > 0) {
      const parsed = parseProviderModel(args);
      if (parsed === null) {
        await context.send(chatId, [
          line(
            text(`Could not read "${args}" as provider/model. Try `),
            code("/model openai/gpt-5.2"),
          ),
          plainLine(`Providers: ${AVAILABLE_PROVIDERS.join(", ")}`),
        ]);
        return;
      }
      const metadata = await getModelsDevMetadata(parsed.model, parsed.provider);
      agent.config.llmProvider = parsed.provider;
      agent.config.llmModel = parsed.model;
      if (metadata !== undefined) {
        agent.config.reasoning = reasoningFor(metadata.isReasoningModel === true);
      }
      context.writeAgent(sandbox, agent);
      await context.send(chatId, [
        plainLine(`✅ Model → ${parsed.provider}/${parsed.model}`),
        plainLine(
          metadata !== undefined
            ? `Reasoning: ${agent.config.reasoning}`
            : "⚠️ Unknown model in the catalog — reasoning setting left unchanged.",
        ),
      ]);
      return;
    }

    const current: RichText = [
      line(text("Current model: "), code(`${agent.config.llmProvider}/${agent.config.llmModel}`)),
    ];
    if (!buttons) {
      await context.send(chatId, [
        ...current,
        line(
          text("Switch with "),
          code("/model provider/model"),
          text(", e.g. "),
          code("/model anthropic/claude-sonnet-5"),
        ),
      ]);
      return;
    }

    const models = await providerModels(agent.config.llmProvider);
    if (models.length === 0) {
      await context.send(chatId, [
        ...current,
        plainLine(
          `No models are listed for ${agent.config.llmProvider} right now — check its API key is set.`,
        ),
        line(text("Switch provider directly with "), code("/model provider/model"), text(".")),
      ]);
      return;
    }
    const shown = models.slice(0, MAX_PICKER_CHOICES);
    await context.send(
      chatId,
      [
        ...current,
        plainLine(
          `Pick a ${agent.config.llmProvider} model, or send /model provider/model to switch provider.` +
            (models.length > shown.length
              ? ` (${models.length - shown.length} more not shown.)`
              : ""),
        ),
      ],
      {
        promptId: MODEL_PROMPT_ID,
        choices: shown.map((model) => ({
          id: model.id,
          label: `${model.id === agent.config.llmModel ? "✅ " : ""}${model.id}`,
        })),
      },
    );
  };

  const handlePersona = async (chatId: ChatId, args: string): Promise<void> => {
    const sandbox = context.sandboxFor(chatId);
    const agent = context.ensureAgent(chatId, sandbox);
    const available = await listPersonaNames(sandbox.home, config.builtinPersonasDir);

    if (args.length === 0) {
      await context.send(
        chatId,
        [
          plainLine(`Current persona: ${agent.config.persona}`),
          plainLine(buttons ? "Pick a persona:" : `Available: ${available.join(", ")}`),
        ],
        buttons
          ? {
              promptId: PERSONA_PROMPT_ID,
              choices: available.slice(0, MAX_PICKER_CHOICES).map((persona) => ({
                id: persona,
                label: `${persona === agent.config.persona ? "✅ " : ""}${persona}`,
              })),
            }
          : undefined,
      );
      return;
    }
    if (!available.includes(args)) {
      await context.send(chatId, [
        plainLine(`No persona called "${args}".`),
        plainLine(`Available: ${available.join(", ")}`),
      ]);
      return;
    }
    agent.config.persona = args;
    context.writeAgent(sandbox, agent);
    await context.send(chatId, [plainLine(`✅ Persona → ${args}`)]);
  };

  /** Set a mode, refusing yolo to anyone but an operator. Returns whether it was set. */
  const setMode = async (
    chatId: ChatId,
    senderId: SenderId,
    mode: ApprovalMode,
  ): Promise<boolean> => {
    if (mode === "yolo" && !config.operators.has(senderId)) {
      await context.send(
        chatId,
        operatorOnlyMessage(senderId, "Turning approvals off", config.operatorSettingName),
      );
      return false;
    }
    setApprovalMode(config.jazzHome, config.files.mode, chatId, mode);
    await context.send(chatId, [
      plainLine(`✅ Mode → ${APPROVAL_MODE_LABELS[mode]}`),
      plainLine(describeApprovalMode(mode, config.approvalPolicy, markup)),
      ...(mode === "yolo" ? [plainLine("Send /mode safe to turn approvals back on.")] : []),
    ]);
    return true;
  };

  const handleMode = async (message: InboundMessage, args: string): Promise<void> => {
    const { chatId } = message;
    const requested = args.toLowerCase();
    if (requested === "safe" || requested === "yolo") {
      await setMode(chatId, message.senderId, requested);
      return;
    }
    const current = approvalModeFor(config.jazzHome, config.files.mode, chatId);
    await context.send(
      chatId,
      [
        line(text("Mode: "), bold(APPROVAL_MODE_LABELS[current])),
        plainLine(describeApprovalMode("safe", config.approvalPolicy, markup)),
        plainLine(describeApprovalMode("yolo", config.approvalPolicy, markup)),
        ...(buttons ? [] : [plainLine("Set it with /mode safe or /mode yolo.")]),
      ],
      buttons
        ? {
            promptId: MODE_PROMPT_ID,
            choices: (["safe", "yolo"] as const).map((mode) => ({
              id: mode,
              label: `${mode === current ? "✅ " : ""}${APPROVAL_MODE_LABELS[mode]}`,
              intent: mode === "yolo" ? "danger" : "primary",
            })),
          }
        : undefined,
    );
  };

  const handleTz = async (chatId: ChatId, args: string): Promise<void> => {
    if (args.length === 0) {
      const current = tzForChat(config.jazzHome, config.files.timezone, chatId);
      const isDefault = !hasChatTz(config.jazzHome, config.files.timezone, chatId);
      await context.send(chatId, [
        line(
          text("🌍 Timezone: "),
          code(current),
          text(isDefault ? " (default — not set yet)" : ""),
        ),
        plainLine(`Local time now: ${formatWhen(Date.now(), current)}`),
        line(text("Change it with "), code("/tz Europe/Paris"), text(" (an IANA name).")),
        ...(config.extraTzHelp === undefined ? [] : [plainLine(config.extraTzHelp)]),
      ]);
      return;
    }
    if (!isValidTimeZone(args)) {
      await context.send(chatId, [
        line(text(`"${args}" is not an IANA timezone. Try `), code("/tz Europe/Paris"), text(".")),
      ]);
      return;
    }
    setTzForChat(config.jazzHome, config.files.timezone, chatId, args);
    await context.send(chatId, [
      line(text("✅ Timezone → "), code(args)),
      plainLine(`Local time now: ${formatWhen(Date.now(), args)}. Reminders use it from now on.`),
    ]);
  };

  const handleReminders = async (chatId: ChatId): Promise<void> => {
    const sandbox = context.sandboxFor(chatId);
    const timezone = tzForChat(config.jazzHome, config.files.timezone, chatId);
    const mine = [...readReminders(sandbox.home, config.agentIdFor(chatId))].sort(
      (left, right) => left.fireAt - right.fireAt,
    );
    if (mine.length === 0) {
      await context.send(chatId, [
        line(text("No reminders set. Use "), code("/remind <when> <text>"), text(".")),
      ]);
      return;
    }
    if (!buttons) {
      await context.send(chatId, [
        line(bold("⏰ Reminders"), text(` (times in ${timezone})`)),
        ...mine.map((reminder) =>
          plainLine(`• ${formatWhen(reminder.fireAt, timezone)} — ${reminder.text}`),
        ),
        plainLine("To cancel one, ask me, e.g. “cancel the dentist reminder”."),
      ]);
      return;
    }
    await context.send(
      chatId,
      [plainLine(`Pending reminders (tap to cancel · times in ${timezone}):`)],
      {
        promptId: REMINDERS_PROMPT_ID,
        choices: mine.slice(0, MAX_PICKER_CHOICES).map((reminder) => ({
          id: reminder.id,
          label: `❌ ${formatWhen(reminder.fireAt, timezone)} — ${reminder.text.slice(0, REMINDER_LABEL_TEXT_CHARS)}`,
          intent: "danger",
        })),
      },
    );
  };

  const handleNew = async (chatId: ChatId): Promise<void> => {
    const wasIncognito =
      config.incognitoFile !== undefined &&
      isIncognito(config.jazzHome, config.incognitoFile, chatId);
    startNewConversation(config.jazzHome, config.files.sessions, chatId);
    // Also leaves incognito: "start fresh" reads as returning to normal, and a
    // mode that silently outlived a reset would be one nobody remembers turning on.
    if (config.incognitoFile !== undefined) {
      setIncognito(config.jazzHome, config.incognitoFile, chatId, false);
      context.forgetIncognitoHistory(chatId);
    }
    await context.send(chatId, [
      plainLine(
        wasIncognito
          ? "🆕 Incognito conversation ended and discarded. Model and persona are unchanged."
          : "🆕 Fresh conversation. Model and persona are unchanged.",
      ),
    ]);
  };

  const handleIncognito = async (chatId: ChatId): Promise<void> => {
    if (config.incognitoFile === undefined) {
      await context.send(chatId, [plainLine("Incognito is not available on this bridge.")]);
      return;
    }
    const next = !isIncognito(config.jazzHome, config.incognitoFile, chatId);
    setIncognito(config.jazzHome, config.incognitoFile, chatId, next);
    context.forgetIncognitoHistory(chatId);
    await context.send(
      chatId,
      next
        ? [
            line(bold("🕶️ Incognito on")),
            plainLine(
              "Nothing from this conversation is saved to history or memory, and it is gone when the bridge restarts. Send /new or /incognito to end it.",
            ),
          ]
        : [plainLine("✅ Incognito off. This conversation is saved again.")],
    );
  };

  return {
    owns: (promptId) => COMMAND_PROMPT_IDS.has(promptId),
    isCommand: (text) => COMMAND_NAMES.has(parseCommand(text)?.command ?? ""),
    answersImmediately: (text) => IMMEDIATE_COMMAND_NAMES.has(parseCommand(text)?.command ?? ""),

    async handle(message: InboundMessage): Promise<boolean> {
      const parsed = parseCommand(message.text);
      if (parsed === undefined) return false;
      const { chatId } = message;
      const { command, args } = parsed;

      switch (command) {
        case "help":
        case "start":
          await context.send(chatId, help());
          return true;
        case "new":
        case "reset":
          await handleNew(chatId);
          return true;
        case "incognito":
          await handleIncognito(chatId);
          return true;
        case "status":
          await handleStatus(chatId);
          return true;
        case "model":
          await handleModel(chatId, args);
          return true;
        case "persona":
          await handlePersona(chatId, args);
          return true;
        case "mode":
          await handleMode(message, args);
          return true;
        case "tz":
        case "timezone":
          await handleTz(chatId, args);
          return true;
        case "remind":
          if (args.length === 0) {
            await context.send(chatId, REMIND_USAGE);
            return true;
          }
          // A normal turn: the add_reminder tool does the time parsing, so there is one
          // code path that creates reminders however the request arrived.
          await context.runTurn({ ...message, text: `Add a reminder: ${args}` });
          return true;
        case "reminders":
          await handleReminders(chatId);
          return true;
        default:
          // Not one of ours: let it through as an ordinary message. A person can
          // legitimately begin a sentence with a slash and should get an answer
          // rather than a lecture about commands.
          return false;
      }
    },

    async handleChoice(tap: ChoiceTap): Promise<ChoiceOutcome> {
      const { chatId, choiceId } = tap;
      switch (tap.promptId) {
        case MODEL_PROMPT_ID: {
          const sandbox = context.sandboxFor(chatId);
          const agent = context.ensureAgent(chatId, sandbox);
          const chosen = (await providerModels(agent.config.llmProvider)).find(
            (model) => model.id === choiceId,
          );
          if (chosen === undefined) return "expired";
          agent.config.llmModel = chosen.id;
          agent.config.reasoning = reasoningFor(chosen.isReasoningModel);
          context.writeAgent(sandbox, agent);
          await closePicker(tap);
          await context.send(chatId, [
            plainLine(`✅ Model → ${agent.config.llmProvider}/${chosen.id}`),
            plainLine(`Reasoning: ${agent.config.reasoning}`),
          ]);
          return "answered";
        }
        case PERSONA_PROMPT_ID: {
          const sandbox = context.sandboxFor(chatId);
          const available = await listPersonaNames(sandbox.home, config.builtinPersonasDir);
          if (!available.includes(choiceId)) return "expired";
          const agent = context.ensureAgent(chatId, sandbox);
          agent.config.persona = choiceId;
          context.writeAgent(sandbox, agent);
          await closePicker(tap);
          await context.send(chatId, [plainLine(`✅ Persona → ${choiceId}`)]);
          return "answered";
        }
        case MODE_PROMPT_ID: {
          if (choiceId !== "safe" && choiceId !== "yolo") return "expired";
          if (choiceId === "yolo" && !config.operators.has(tap.senderId)) return "not-operator";
          await closePicker(tap);
          await setMode(chatId, tap.senderId, choiceId);
          return "answered";
        }
        case REMINDERS_PROMPT_ID: {
          const sandbox = context.sandboxFor(chatId);
          const cancelled = await cancelReminder(
            sandbox.home,
            config.agentIdFor(chatId),
            choiceId,
            sandboxOwnership(sandbox),
          );
          if (!cancelled) return "expired";
          await closePicker(tap);
          await context.send(chatId, [plainLine("✅ Reminder cancelled.")]);
          return "answered";
        }
        default:
          return "expired";
      }
    },
  };
}
