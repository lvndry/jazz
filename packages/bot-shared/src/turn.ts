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
import { conversationKey, isIncognito, setIncognito, startNewConversation } from "./session-store";
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
  /**
   * Conversations flagged incognito run `--ephemeral`, keeping their transcript
   * in this process's memory and off disk. Unset disables the feature.
   */
  readonly incognitoFile?: string;
  /**
   * Called whenever the set of prompts waiting on a person changes.
   *
   * A surface with buttons shows a batch control ("Approve all 3") whose count
   * has to track reality as requests arrive and are answered, and only the
   * bridge knows which messages it drew.
   */
  readonly onPendingChange?: (chatId: ChatId, outstanding: readonly PendingSummary[]) => void;
  /**
   * How a turn is actually run. Defaults to spawning `jazz run`.
   *
   * A seam, not a feature: it exists so the orchestration above can be tested
   * without a Jazz binary. Bun's `mock.module` is process-global and stubbing a
   * shared module in one test file breaks every other suite, so the substitute
   * is passed in rather than swapped underneath.
   */
  readonly startRun?: typeof startJazzRun;
}

/** The choice id an approval prompt uses for "yes"; the bridge routes on it too. */
export const APPROVE_CHOICE_ID = "approve";
export const REJECT_CHOICE_ID = "reject";

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

/** What a bridge needs to re-render its outstanding prompts. */
export interface PendingSummary {
  /** `toolCallId` for an approval, `requestId` for a question. */
  readonly id: string;
  readonly kind: "approval" | "question";
}

function promptId(pending: PendingPrompt): string {
  return pending.kind === "approval" ? pending.toolCallId : pending.requestId;
}

interface ChatState {
  /**
   * Whether this conversation is mid-turn. Set before the first await of
   * handling: every inbound message is handled concurrently, and keying this on
   * the run instead would leave a window where a second message arrives before
   * the first has spawned anything and starts a run of its own.
   */
  busy: boolean;
  run?: JazzRun | undefined;
  /**
   * Prompts waiting on the person, keyed by the id the agent minted.
   *
   * A map rather than one slot because a model can fire several tool calls at
   * once and each asks separately: a surface with buttons shows them all and
   * can be answered in any order. Insertion order is preserved, which is what
   * lets a typed reply be matched against the most recent one.
   */
  readonly pending: Map<string, PendingPrompt>;
  /** Messages that arrived mid-turn, answered in order once it finishes. */
  readonly queue: string[];
}

/**
 * Transcripts for conversations currently incognito.
 *
 * Lives only in this process's memory and is never written anywhere, so a
 * restart drops the context rather than ever falling back to a file on disk —
 * which is the whole promise of the mode.
 */
const incognitoHistory = new Map<ChatId, unknown[]>();

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
  /**
   * Answer one outstanding prompt by id — a button tap rather than a typed
   * reply. Returns false when that prompt is gone, which is what a second tap
   * on a stale keyboard looks like.
   */
  deliverChoice(chatId: ChatId, promptId: string, choiceId: string): Promise<boolean>;
  /**
   * Answer every outstanding approval at once.
   *
   * A model that fires five tool calls in parallel asks five times, and tapping
   * through all of them is the common case. Questions are left alone: they have
   * their own answers and there is no blanket one.
   */
  deliverAllApprovals(chatId: ChatId, approved: boolean): Promise<number>;
  /** Kill the in-flight run. Returns false when there was nothing running. */
  cancel(chatId: ChatId): boolean;
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
    const created: ChatState = { busy: false, pending: new Map(), queue: [] };
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
      { id: APPROVE_CHOICE_ID, label: "Approve", intent: "primary" },
      { id: REJECT_CHOICE_ID, label: "Reject", intent: "danger" },
    ];
    const body: RichText = [
      line(bold("⚠️ Approval needed")),
      line(code(event.toolName ?? "tool")),
      ...(event.message ? [plainLine(event.message)] : []),
      ...(event.previewDiff ? [plainLine(event.previewDiff)] : []),
    ];

    const state = stateFor(chatId);
    state.pending.set(toolCallId, { kind: "approval", toolCallId, choices });
    await surface.send(chatId, { body, choices });
    notifyPendingChange(chatId);
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

    stateFor(chatId).pending.set(requestId, { kind: "question", requestId, choices });
    await surface.send(chatId, {
      body,
      // With no suggestions there is nothing to number: the person answers in
      // their own words and their next message is forwarded verbatim.
      ...(choices.length > 0 ? { choices } : {}),
    });
    notifyPendingChange(chatId);
  };

  const notifyPendingChange = (chatId: ChatId): void => {
    if (config.onPendingChange === undefined) return;
    const outstanding = [...stateFor(chatId).pending.values()].map((pending) => ({
      id: promptId(pending),
      kind: pending.kind,
    }));
    config.onPendingChange(chatId, outstanding);
  };

  const settle = async (
    chatId: ChatId,
    pending: PendingPrompt,
    choiceId: string,
  ): Promise<void> => {
    const state = stateFor(chatId);
    state.pending.delete(promptId(pending));
    if (pending.kind === "approval") {
      await state.run?.approve([
        { toolCallId: pending.toolCallId, approved: choiceId === APPROVE_CHOICE_ID },
      ]);
    } else {
      await state.run?.answerQuestion(pending.requestId, choiceId);
    }
    notifyPendingChange(chatId);
  };

  /**
   * Answer an outstanding prompt with something the person typed.
   *
   * Only the most recent one is considered. With several outstanding there is
   * nothing in a bare "1" saying which it answers, and guessing would silently
   * approve the wrong tool — so the rest wait for a surface that can address
   * them explicitly, or for their turn.
   */
  const resolveTypedReply = async (chatId: ChatId, reply: string): Promise<boolean> => {
    const state = stateFor(chatId);
    const pending = [...state.pending.values()].at(-1);
    if (pending === undefined || state.run === undefined) return false;

    // A free-text question has no options, so whatever they say next is it.
    if (pending.kind === "question" && pending.choices.length === 0) {
      await settle(chatId, pending, reply);
      return true;
    }

    const choice = matchChoice(pending.choices, reply);
    if (choice === undefined) return false;
    await settle(chatId, pending, choice.id);
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
    const incognito =
      config.incognitoFile !== undefined &&
      isIncognito(config.jazzHome, config.incognitoFile, chatId);
    const runLog = createRunLog(sandbox.home, conversation);
    const reporter = createProgressReporter({ surface, chatId, runLog });
    await reporter.start();

    const run = (config.startRun ?? startJazzRun)(
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
        conversation: incognito
          ? { kind: "ephemeral", history: incognitoHistory.get(chatId) ?? [] }
          : { kind: "persistent", key: conversation },
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
    // Prompts still outstanding when the run ends are ones nothing will ever
    // read, and leaving them would eat the person's next message.
    state.pending.clear();
    notifyPendingChange(chatId);
    runLog.finish(envelope);

    if (!envelope.ok) {
      const failure: RichText = [plainLine(`⚠️ ${envelope.error}`)];
      if (!(await reporter.finish(failure))) await send(chatId, failure);
      return;
    }

    // Carried forward in memory for this conversation's next turn; it never
    // touches disk, so a run that errored just means the next turn starts
    // context-free rather than resurrecting a stale transcript.
    if (incognito) incognitoHistory.set(chatId, envelope.messages ?? []);

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
    ...(config.incognitoFile === undefined
      ? []
      : [plainLine("/incognito — keep this conversation in memory only")]),
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

  const handleIncognito = async (chatId: ChatId): Promise<void> => {
    if (config.incognitoFile === undefined) {
      await send(chatId, [plainLine("Incognito is not available on this bridge.")]);
      return;
    }
    const next = !isIncognito(config.jazzHome, config.incognitoFile, chatId);
    setIncognito(config.jazzHome, config.incognitoFile, chatId, next);
    incognitoHistory.delete(chatId);
    await send(
      chatId,
      next
        ? [
            line(bold("🕶️ Incognito on")),
            plainLine(
              "This conversation is kept in memory only and is gone when the bridge restarts.",
            ),
          ]
        : [plainLine("✅ Incognito off. This conversation is saved again.")],
    );
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
        // Also leaves incognito: "start fresh" reads as returning to normal,
        // and a mode that silently outlived a reset would be one nobody
        // remembers turning on.
        if (config.incognitoFile !== undefined) {
          setIncognito(config.jazzHome, config.incognitoFile, chatId, false);
          incognitoHistory.delete(chatId);
        }
        await send(chatId, [plainLine("🆕 Fresh conversation. Model and persona are unchanged.")]);
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

    async deliverChoice(chatId: ChatId, id: string, choiceId: string): Promise<boolean> {
      const state = stateFor(chatId);
      const pending = state.pending.get(id);
      if (pending === undefined || state.run === undefined) return false;
      await settle(chatId, pending, choiceId);
      return true;
    },

    async deliverAllApprovals(chatId: ChatId, approved: boolean): Promise<number> {
      const state = stateFor(chatId);
      const approvals = [...state.pending.values()].filter(
        (pending) => pending.kind === "approval",
      );
      if (approvals.length === 0 || state.run === undefined) return 0;

      for (const pending of approvals) state.pending.delete(promptId(pending));
      await state.run.approve(
        approvals.map((pending) => ({
          toolCallId: (pending as { toolCallId: string }).toolCallId,
          approved,
        })),
      );
      notifyPendingChange(chatId);
      return approvals.length;
    },

    cancel(chatId: ChatId): boolean {
      const state = stateFor(chatId);
      if (state.run === undefined) return false;
      state.run.cancel();
      // The queue goes too: those messages were sent expecting the answer this
      // run was about to give, and replaying them against a cancelled turn is
      // not what anyone asking to stop meant.
      state.queue.length = 0;
      return true;
    },

    async handle(chatId: ChatId, prompt: string): Promise<void> {
      const state = stateFor(chatId);

      if (state.busy) {
        if (await resolveTypedReply(chatId, prompt)) return;
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
