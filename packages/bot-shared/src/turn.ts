/**
 * @fileoverview One inbound message, from arrival to answer, on any surface.
 *
 * This is the part every bridge repeats: serialise the chat so two messages
 * cannot start two runs, check the spend cap, make sure the conversation has an
 * agent, start the run, put approvals and questions in front of the person,
 * send the answer, record what it cost. Plus the command set — `/new`,
 * `/model`, `/persona`, `/mode`, `/tz`, `/status`, `/help` — which differs
 * between bridges only in markup, and markup is what `RichText` already
 * abstracts away.
 *
 * What is left for a bridge is genuinely surface-specific: how messages arrive,
 * who is allowed to send them, and how text reaches the screen.
 */

import { parseProviderModel } from "@jazz/core/utils/provider-model";
import {
  type AgentFile,
  agentPath,
  ensureScopedAgentFrom,
  readAgentFile,
  writeAgentFile,
} from "./agent-file";
import {
  APPROVAL_MODE_LABELS,
  type ApprovalMode,
  approvalModeFor,
  approvalPolicyFor,
  describeApprovalMode,
  setApprovalMode,
} from "./approval-mode-store";
import { type ChatSandbox, ensureChatSandbox } from "./chat-sandbox";
import { adoptIntoSandbox } from "./chat-sandbox";
import { type JazzEnvelope, type JazzEvent, type JazzRun, startJazzRun } from "./jazz-run";
import { listPersonaNames } from "./personas";
import { createProgressReporter } from "./progress";
import { splitReasoning } from "./reasoning";
import { createRunLog } from "./run-log";
import { conversationKey, startNewConversation } from "./session-store";
import {
  bold,
  type ChatId,
  type Choice,
  code,
  line,
  matchChoice,
  plainLine,
  type RichText,
  type Surface,
} from "./surface";
import { isValidTimeZone, setTzForChat, tzForChat } from "./timezone-store";
import { capBlockMessage, dailyCostCapBlockReason, recordUsage, todayUsage } from "./usage-store";

/** The per-bridge store files, so two bridges sharing a data directory do not collide. */
export interface TurnStoreFiles {
  readonly timezone: string;
  readonly usage: string;
  readonly sessions: string;
  readonly mode: string;
}

export interface TurnConfig {
  readonly surface: Surface;
  readonly jazzBinary: string;
  readonly jazzHome: string;
  /** Seed agent each conversation's own agent is cloned from. */
  readonly baseAgentId: string;
  readonly builtinPersonasDir: string;
  readonly approvalPolicy: string;
  readonly autoApproveTools: readonly string[];
  readonly runTimeoutMs: number;
  /** Spend ceiling in USD per day across all conversations; 0 disables it. */
  readonly dailyCostCapUsd: number;
  readonly showReasoning: boolean;
  readonly files: TurnStoreFiles;
  /** The agent id a conversation's files live under. */
  readonly agentIdFor: (chatId: ChatId) => string;
  /** Extra help lines describing anything the bridge adds on top. */
  readonly extraHelp?: readonly string[];
}

/**
 * A prompt the person is expected to answer next on a surface with no buttons.
 *
 * Their reply is offered to this before it is treated as a new question, and
 * `matchChoice` returning undefined is what lets an unrelated message fall
 * through to the agent instead of being swallowed as a mis-read decision.
 */
type PendingPrompt =
  | { readonly kind: "approval"; readonly toolCallId: string; readonly choices: readonly Choice[] }
  | { readonly kind: "question"; readonly requestId: string; readonly choices: readonly Choice[] };

interface ChatState {
  /**
   * Whether this conversation is mid-turn. Set before the first await of
   * handling: every inbound message is handled concurrently, and keying this on
   * the run instead would leave a window where a second message arrives before
   * the first has spawned anything and starts a run of its own.
   */
  busy: boolean;
  run?: JazzRun | undefined;
  pending?: PendingPrompt | undefined;
  /** Messages that arrived mid-turn, answered in order once it finishes. */
  readonly queue: string[];
}

/** How much reasoning to attach under an answer, when a bridge asks for it. */
const REASONING_PART_CHARS = 1_500;
const REASONING_MAX_PARTS = 2;

export interface TurnRunner {
  /**
   * Handle one message from a conversation.
   *
   * Safe to call concurrently: messages for the same conversation are queued
   * and answered in order, and a message arriving while the agent is blocked on
   * a prompt is offered to that prompt first.
   */
  handle(chatId: ChatId, prompt: string): Promise<void>;
  /** Deliver a message the bridge originated, e.g. a reminder. */
  send(chatId: ChatId, body: RichText): Promise<void>;
  /** Whether a run is in flight, for a bridge that wants to show it. */
  busy(chatId: ChatId): boolean;
}

export function createTurnRunner(config: TurnConfig): TurnRunner {
  const { surface } = config;
  const states = new Map<ChatId, ChatState>();

  const stateFor = (chatId: ChatId): ChatState => {
    const existing = states.get(chatId);
    if (existing !== undefined) return existing;
    const created: ChatState = { busy: false, queue: [] };
    states.set(chatId, created);
    return created;
  };

  const send = async (chatId: ChatId, body: RichText): Promise<void> => {
    await surface.send(chatId, { body });
  };

  const sandboxFor = (chatId: ChatId): ChatSandbox =>
    ensureChatSandbox(config.jazzHome, config.agentIdFor(chatId));

  const ensureAgent = (chatId: ChatId, sandbox: ChatSandbox): AgentFile => {
    const agent = ensureScopedAgentFrom(
      config.jazzHome,
      sandbox.home,
      config.agentIdFor(chatId),
      config.baseAgentId,
    );
    adoptIntoSandbox(sandbox, agentPath(sandbox.home, agent.id));
    return agent;
  };

  const writeAgent = (sandbox: ChatSandbox, agent: AgentFile): void => {
    writeAgentFile(sandbox.home, agent);
    adoptIntoSandbox(sandbox, agentPath(sandbox.home, agent.id));
  };

  // --- Prompts the person answers -----------------------------------------

  const announceApproval = async (chatId: ChatId, event: JazzEvent): Promise<void> => {
    const toolCallId = event.toolCallId;
    if (toolCallId === undefined) return;

    const choices: readonly Choice[] = [
      { id: "approve", label: "Approve", intent: "primary" },
      { id: "reject", label: "Reject", intent: "danger" },
    ];
    const body: RichText = [
      line(bold("⚠️ Approval needed")),
      line(code(event.toolName ?? "tool")),
      ...(event.message ? [plainLine(event.message)] : []),
      ...(event.previewDiff ? [plainLine(event.previewDiff)] : []),
    ];

    stateFor(chatId).pending = { kind: "approval", toolCallId, choices };
    await surface.send(chatId, { body, choices });
  };

  const announceQuestion = async (chatId: ChatId, event: JazzEvent): Promise<void> => {
    const requestId = event.requestId;
    const question = event.question?.trim();
    if (requestId === undefined || !question) return;

    const suggestions = event.suggestions ?? [];
    const choices: readonly Choice[] = suggestions.map((suggestion) => ({
      id: suggestion.value,
      label: suggestion.label ?? suggestion.value,
    }));
    const body: RichText = [
      line(bold("❓ The agent needs an answer")),
      plainLine(question),
      ...suggestions
        .filter((suggestion) => suggestion.description !== undefined)
        .map((suggestion) =>
          plainLine(`• ${suggestion.label ?? suggestion.value} — ${suggestion.description ?? ""}`),
        ),
    ];

    stateFor(chatId).pending = { kind: "question", requestId, choices };
    await surface.send(chatId, {
      body,
      // With no suggestions there is nothing to number: the person answers in
      // their own words and their next message is forwarded verbatim.
      ...(choices.length > 0 ? { choices } : {}),
    });
  };

  const resolvePending = async (chatId: ChatId, reply: string): Promise<boolean> => {
    const state = stateFor(chatId);
    const { pending, run } = state;
    if (pending === undefined || run === undefined) return false;

    if (pending.kind === "question" && pending.choices.length === 0) {
      state.pending = undefined;
      await run.answerQuestion(pending.requestId, reply);
      return true;
    }

    const choice = matchChoice(pending.choices, reply);
    if (choice === undefined) return false;
    state.pending = undefined;

    if (pending.kind === "approval") {
      await run.approve([{ toolCallId: pending.toolCallId, approved: choice.id === "approve" }]);
    } else {
      await run.answerQuestion(pending.requestId, choice.id);
    }
    return true;
  };

  // --- The run -------------------------------------------------------------

  const formatTokenCount = (tokens: number): string =>
    tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

  const runSummary = (envelope: JazzEnvelope, toolCount: number): string => {
    if (!envelope.ok) return "";
    const bits = [`✅ ${toolCount} tool${toolCount === 1 ? "" : "s"}`];
    const totalTokens = envelope.tokenUsage?.totalTokens ?? 0;
    if (totalTokens > 0) bits.push(`${formatTokenCount(totalTokens)} tokens`);
    if (envelope.costKnown !== false && envelope.costUSD > 0) {
      bits.push(`$${envelope.costUSD.toFixed(4)}`);
    }
    return bits.join(" · ");
  };

  const answer = async (chatId: ChatId, prompt: string): Promise<void> => {
    const capBlock = dailyCostCapBlockReason(
      todayUsage(config.jazzHome, config.files.usage),
      config.dailyCostCapUsd,
    );
    if (capBlock !== undefined) {
      await send(chatId, [plainLine(capBlockMessage(capBlock, config.dailyCostCapUsd))]);
      return;
    }

    const state = stateFor(chatId);
    const sandbox = sandboxFor(chatId);
    ensureAgent(chatId, sandbox);

    if (surface.capabilities.typingIndicator && surface.typing !== undefined) {
      await surface.typing(chatId).catch(() => undefined);
    }

    const conversation = conversationKey(config.jazzHome, config.files.sessions, chatId);
    const runLog = createRunLog(sandbox.home, conversation);
    const reporter = createProgressReporter({ surface, chatId, runLog });
    await reporter.start();

    const run = startJazzRun(
      {
        jazzBinary: config.jazzBinary,
        agentId: config.agentIdFor(chatId),
        sandbox,
        approvalPolicy: approvalPolicyFor(
          config.jazzHome,
          config.files.mode,
          chatId,
          config.approvalPolicy,
        ),
        autoApproveTools: config.autoApproveTools,
        timezone: tzForChat(config.jazzHome, config.files.timezone, chatId),
        runTimeoutMs: config.runTimeoutMs,
        conversation: { kind: "persistent", key: conversation },
        prompt,
      },
      {
        onEvent: (event) => reporter.onEvent(event),
        onApprovalRequired: (event) => {
          void announceApproval(chatId, event).catch((error) =>
            console.error(`Failed to send an approval request to ${chatId}: ${String(error)}`),
          );
        },
        onUserInputRequired: (event) => {
          void announceQuestion(chatId, event).catch((error) =>
            console.error(`Failed to send a question to ${chatId}: ${String(error)}`),
          );
        },
      },
    );
    state.run = run;

    const envelope = await run.result;
    state.run = undefined;
    // A prompt still outstanding when the run ends is one nothing will ever
    // read, and leaving it set would eat the person's next message.
    state.pending = undefined;
    runLog.finish(envelope);

    if (!envelope.ok) {
      const failure: RichText = [plainLine(`⚠️ ${envelope.error}`)];
      if (!(await reporter.finish(failure))) await send(chatId, failure);
      return;
    }

    recordUsage(
      config.jazzHome,
      config.files.usage,
      envelope.costUSD,
      envelope.tokenUsage?.totalTokens ?? 0,
      envelope.costKnown !== false,
    );

    const summary = runSummary(envelope, reporter.toolsUsed().length);
    const summaryShown = await reporter.finish([plainLine(summary)]);
    await surface.send(chatId, {
      body: [
        plainLine(envelope.answer),
        // Where the progress display could not show it — an append-only
        // surface has no bubble to close — the summary rides under the answer
        // rather than costing its own notification.
        ...(summaryShown || summary.length === 0 ? [] : [plainLine(""), plainLine(summary)]),
      ],
    });

    if (config.showReasoning) {
      const parts = splitReasoning(reporter.reasoningLog(), {
        budget: REASONING_PART_CHARS,
        maxParts: REASONING_MAX_PARTS,
      });
      for (const part of parts) {
        await send(chatId, [line(bold("💭 Reasoning")), plainLine(part)]);
      }
    }

    // A static `create_web_app` result is an image, which every surface here
    // can show; the interactive mode needs a public URL to open it at, which a
    // bridge with no origin of its own cannot offer.
    const imagePath = envelope.webApp?.imagePath;
    if (imagePath !== undefined && surface.sendFile !== undefined) {
      await surface
        .sendFile(chatId, imagePath, envelope.webApp?.title)
        .catch((error) => console.error(`Failed to send the web app image: ${String(error)}`));
    }
  };

  // --- Commands ------------------------------------------------------------

  /**
   * Surfaces without markup render the mode wording with its marks dropped
   * rather than showing literal asterisks or backticks.
   */
  const markup = { bold: (value: string) => value, code: (value: string) => value };

  const help = (): RichText => [
    line(bold("Jazz")),
    plainLine("Just write normally — every message runs the agent."),
    plainLine(""),
    plainLine("/new — fresh conversation (keeps model and persona)"),
    plainLine("/model provider/model — switch this chat's model"),
    plainLine("/persona name — switch this chat's persona"),
    plainLine("/mode safe|yolo — whether risky tools stop to ask"),
    plainLine("/tz Europe/Paris — timezone reminders resolve in"),
    plainLine("/status — model, mode, timezone, today's usage"),
    plainLine("/help — this message"),
    ...(config.extraHelp ?? []).map((extra) => plainLine(extra)),
    plainLine(""),
    ...(surface.capabilities.buttons
      ? []
      : [plainLine("When the agent asks something, reply with the option's number.")]),
  ];

  const handleStatus = async (chatId: ChatId): Promise<void> => {
    const sandbox = sandboxFor(chatId);
    const agent = ensureAgent(chatId, sandbox);
    const usage = todayUsage(config.jazzHome, config.files.usage);
    const mode = approvalModeFor(config.jazzHome, config.files.mode, chatId);

    await send(chatId, [
      line(bold("Status")),
      plainLine(`Model: ${agent.config.llmProvider}/${agent.config.llmModel}`),
      plainLine(`Persona: ${agent.config.persona}`),
      plainLine(`Mode: ${APPROVAL_MODE_LABELS[mode]}`),
      plainLine(`Timezone: ${tzForChat(config.jazzHome, config.files.timezone, chatId)}`),
      plainLine(
        `Today: ${usage.runs} run${usage.runs === 1 ? "" : "s"} · ` +
          `${formatTokenCount(usage.tokens)} tokens · $${usage.costUSD.toFixed(4)}` +
          (config.dailyCostCapUsd > 0 ? ` of $${config.dailyCostCapUsd.toFixed(2)}` : ""),
      ),
    ]);
  };

  const handleModel = async (chatId: ChatId, args: string): Promise<void> => {
    const sandbox = sandboxFor(chatId);
    const agent = ensureAgent(chatId, sandbox);

    if (args.length === 0) {
      await send(chatId, [
        plainLine(`Current model: ${agent.config.llmProvider}/${agent.config.llmModel}`),
        plainLine("Switch with /model provider/model, e.g. /model anthropic/claude-sonnet-5"),
      ]);
      return;
    }

    const parsed = parseProviderModel(args);
    if (parsed === null) {
      await send(chatId, [
        plainLine(`Could not read "${args}" as provider/model.`),
        plainLine("Try /model anthropic/claude-sonnet-5"),
      ]);
      return;
    }

    agent.config.llmProvider = parsed.provider;
    agent.config.llmModel = parsed.model;
    writeAgent(sandbox, agent);
    await send(chatId, [plainLine(`✅ Model → ${parsed.provider}/${parsed.model}`)]);
  };

  const handlePersona = async (chatId: ChatId, args: string): Promise<void> => {
    const sandbox = sandboxFor(chatId);
    const agent = ensureAgent(chatId, sandbox);
    const available = await listPersonaNames(sandbox.home, config.builtinPersonasDir);

    if (args.length === 0) {
      await send(chatId, [
        plainLine(`Current persona: ${agent.config.persona}`),
        plainLine(`Available: ${available.join(", ")}`),
      ]);
      return;
    }
    if (!available.includes(args)) {
      await send(chatId, [
        plainLine(`No persona called "${args}".`),
        plainLine(`Available: ${available.join(", ")}`),
      ]);
      return;
    }

    agent.config.persona = args;
    writeAgent(sandbox, agent);
    await send(chatId, [plainLine(`✅ Persona → ${args}`)]);
  };

  const handleMode = async (chatId: ChatId, args: string): Promise<void> => {
    const requested = args.toLowerCase();
    if (requested !== "safe" && requested !== "yolo") {
      const current = approvalModeFor(config.jazzHome, config.files.mode, chatId);
      await send(chatId, [
        plainLine(`Mode: ${APPROVAL_MODE_LABELS[current]}`),
        plainLine(describeApprovalMode(current, config.approvalPolicy, markup)),
        plainLine("Set it with /mode safe or /mode yolo."),
      ]);
      return;
    }

    const mode: ApprovalMode = requested;
    setApprovalMode(config.jazzHome, config.files.mode, chatId, mode);
    await send(chatId, [
      plainLine(`✅ Mode → ${APPROVAL_MODE_LABELS[mode]}`),
      plainLine(describeApprovalMode(mode, config.approvalPolicy, markup)),
    ]);
  };

  const handleTz = async (chatId: ChatId, args: string): Promise<void> => {
    if (args.length === 0) {
      await send(chatId, [
        plainLine(`Timezone: ${tzForChat(config.jazzHome, config.files.timezone, chatId)}`),
        plainLine("Set it with /tz Europe/Paris"),
      ]);
      return;
    }
    if (!isValidTimeZone(args)) {
      await send(chatId, [plainLine(`"${args}" is not an IANA timezone. Try /tz Europe/Paris`)]);
      return;
    }
    setTzForChat(config.jazzHome, config.files.timezone, chatId, args);
    await send(chatId, [plainLine(`✅ Timezone → ${args}`)]);
  };

  /** Returns whether the text was a command and has been dealt with. */
  const handleCommand = async (chatId: ChatId, body: string): Promise<boolean> => {
    if (!body.startsWith("/")) return false;
    const [rawCommand, ...rest] = body.slice(1).split(/\s+/);
    const command = (rawCommand ?? "").toLowerCase();
    const args = rest.join(" ").trim();

    switch (command) {
      case "help":
        await send(chatId, help());
        return true;
      case "new":
      case "reset":
        startNewConversation(config.jazzHome, config.files.sessions, chatId);
        await send(chatId, [plainLine("🆕 Fresh conversation. Model and persona are unchanged.")]);
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
        await handleMode(chatId, args);
        return true;
      case "tz":
        await handleTz(chatId, args);
        return true;
      default:
        // Not one of ours: let it through as an ordinary message. A person can
        // legitimately begin a sentence with a slash and should get an answer
        // rather than a lecture about commands.
        return false;
    }
  };

  return {
    busy: (chatId) => stateFor(chatId).busy,
    send,

    async handle(chatId: ChatId, prompt: string): Promise<void> {
      const state = stateFor(chatId);

      if (state.busy) {
        if (await resolvePending(chatId, prompt)) return;
        state.queue.push(prompt);
        return;
      }

      state.busy = true;
      try {
        let next: string | undefined = prompt;
        while (next !== undefined) {
          if (!(await handleCommand(chatId, next))) await answer(chatId, next);
          next = state.queue.shift();
        }
      } finally {
        state.busy = false;
      }
    },
  };
}

export { readAgentFile };
