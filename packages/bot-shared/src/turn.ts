/**
 * @fileoverview One inbound message, from arrival to answer, on any surface.
 *
 * This is the part every bridge repeats: serialise the chat so two messages
 * cannot start two runs, check the spend cap, make sure the conversation has an
 * agent, start the run, put approvals and questions in front of the person,
 * send the answer, record what it cost. The command set lives beside it in
 * `turn-commands.ts`, and differs between bridges only in markup, which is what
 * `RichText` already abstracts away.
 *
 * What a surface can do decides the shape, not which bridge it is: with buttons
 * an approval carries Approve / Reject / Always allow and, when several are
 * outstanding, Approve all N; the progress bubble carries ⏹ Cancel; pickers
 * answer bare `/model`, `/persona`, `/mode` and `/reminders`. Without buttons
 * the same prompts are numbered text answered by typing.
 *
 * What is left for a bridge is genuinely surface-specific: how messages arrive,
 * who is allowed to send them, and how text reaches the screen.
 */

import { extractCommandApprovalKey } from "@jazz/core/utils/shell";
import { type AgentFile, ensureScopedAgentFrom, readAgentFile, writeAgentFile } from "./agent-file";
import {
  cancelledSummary,
  deliverComposition,
  doneSummary,
  failedSummary,
  FOLLOWUP_OPTIONS,
  FOLLOWUP_PROMPT_ID,
  followupChoices,
  followupPrompt,
  planCompositionDelivery,
} from "./answer";
import { approvalPolicyFor } from "./approval-mode-store";
import { type RunLimits, runLimitsFromEnv } from "./bridge-env";
import {
  addAutoApprovedCommand,
  type ChatSandbox,
  ensureChatSandbox,
  sandboxOwnership,
} from "./chat-sandbox";
import { compositionLinkPath, type CompositionLinks } from "./compositions";
import { type JazzComposition, type JazzEvent, type JazzRun, startJazzRun } from "./jazz-run";
import { createProgressReporter } from "./progress";
import { splitReasoning } from "./reasoning";
import { createRunLog } from "./run-log";
import { conversationKey, isIncognito } from "./session-store";
import {
  bold,
  type ChatId,
  type Choice,
  code,
  codeBlock,
  line,
  markdown,
  matchChoice,
  type MessageRef,
  plainLine,
  quote,
  type RichText,
  type Surface,
} from "./surface";
import { tzForChat } from "./timezone-store";
import { createCommands, operatorOnlyMessage, parseCommand } from "./turn-commands";
import { capBlockMessage, dailyCostCapBlockReason, recordUsage, todayUsage } from "./usage-store";

export { operatorOnlyMessage };

/** The per-bridge store files, so two bridges sharing a data directory do not collide. */
export interface TurnStoreFiles {
  readonly timezone: string;
  readonly usage: string;
  readonly sessions: string;
  readonly mode: string;
}

/** What `onAnswered` is told about an answer that went out. */
export interface AnsweredTurn {
  readonly chatId: ChatId;
  readonly senderId: SenderId;
  readonly question: string;
  readonly answer: string;
  /** The message carrying the answer's follow-up choices, when the surface returned one. */
  readonly messageRef: MessageRef | undefined;
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
  /**
   * How much of the reasoning log goes out ahead of an answer: characters per part, and
   * how many parts. A surface that collapses long quotes can afford more than one where
   * every part is a notification.
   */
  readonly reasoningPartChars?: number;
  readonly reasoningMaxParts?: number;
  readonly files: TurnStoreFiles;
  /** The agent id a conversation's files live under. */
  readonly agentIdFor: (chatId: ChatId) => string;
  /**
   * Senders allowed to widen a conversation's authority: `/mode yolo`, "Always allow".
   *
   * An allowlist admits people to talk to the agent; it does not make each of them the
   * owner of the operator's keys and machine. In a group anyone admitted could otherwise
   * turn approvals off for everyone and then have the agent run a shell. Empty means
   * nobody can from chat, and "Always allow" is not offered at all.
   */
  readonly operators: ReadonlySet<SenderId>;
  /** The setting that names operators, for the refusal a non-operator sees. */
  readonly operatorSettingName: string;
  /**
   * Where interactive `create_composition` results are published: the public origin the
   * bridge serves them from and the store of opaque ids its links carry.
   *
   * Undefined disables the interactive mode; the static one is an image and
   * needs no origin.
   */
  readonly compositionServer?: {
    readonly publicBaseUrl: string;
    readonly links: CompositionLinks;
  };
  /** The setting to name when an interactive web app has nowhere to be served from. */
  readonly publicUrlSettingName?: string;
  /** Extra help lines describing anything the bridge adds on top. */
  readonly extraHelp?: readonly string[];
  /** A line under `/tz` for another way this surface sets the zone (a shared location). */
  readonly extraTzHelp?: string;
  /**
   * Conversations flagged incognito run `--ephemeral`, keeping their transcript
   * in this process's memory and off disk. Unset disables the feature.
   */
  readonly incognitoFile?: string;
  /**
   * Called whenever the set of prompts waiting on a person changes, for a bridge that
   * shows them somewhere of its own.
   */
  readonly onPendingChange?: (chatId: ChatId, outstanding: readonly PendingSummary[]) => void;
  /**
   * Called after an answer went out, for a bridge that follows it up (contextual
   * suggestions under it, say). Errors are logged, never shown.
   */
  readonly onAnswered?: (turn: AnsweredTurn) => Promise<void>;
  /**
   * How a turn is actually run. Defaults to spawning `jazz run`.
   *
   * A seam, not a feature: it exists so the orchestration above can be tested
   * without a Jazz binary. Bun's `mock.module` is process-global and stubbing a
   * shared module in one test file breaks every other suite, so the substitute
   * is passed in rather than swapped underneath.
   */
  readonly startRun?: typeof startJazzRun;
  /**
   * Agent runs this runner has in flight at once across every conversation, and messages
   * a conversation may have waiting behind its run. Defaults to `runLimitsFromEnv()`.
   */
  readonly limits?: RunLimits;
}

/** Who sent a message, in the surface's own id space (a user id, a phone number, a handle). */
export type SenderId = string;

/** One message from a person, as a bridge hands it to the runner. */
export interface InboundMessage {
  readonly chatId: ChatId;
  readonly senderId: SenderId;
  readonly text: string;
  /** The message this one follows up (a tapped suggestion), to thread the reply under. */
  readonly replyTo?: MessageRef | undefined;
}

/** A tap on a choice, as a bridge resolved it from the button's payload. */
export interface ChoiceTap {
  readonly chatId: ChatId;
  readonly promptId: string;
  readonly choiceId: string;
  readonly senderId: SenderId;
  /** The message the choice was drawn under, when the surface can address it again. */
  readonly messageRef?: MessageRef | undefined;
}

/**
 * What became of an answer to a prompt.
 *
 * `not-requester` is someone else in the conversation answering: a prompt belongs to the
 * person whose message started the run, since it is their request the agent is asking about.
 * `not-operator` is a choice only an operator may make.
 */
export type ChoiceOutcome = "answered" | "expired" | "not-requester" | "not-operator";

export type CancelOutcome = "cancelled" | "idle" | "not-requester";

/** The choice ids an approval prompt uses; the numbering on a text surface follows this order. */
export const APPROVE_CHOICE_ID = "approve";
export const REJECT_CHOICE_ID = "reject";
export const ALWAYS_ALLOW_CHOICE_ID = "always";
export const APPROVE_ALL_CHOICE_ID = "approve-all";
export const REJECT_ALL_CHOICE_ID = "reject-all";

/** Told to anyone with a run in flight, or writing in, while the bridge shuts down. */
const RESTARTING_NOTICE: RichText = [
  plainLine("⚠️ The bridge is restarting, so your request was stopped. Send it again in a minute."),
];
/** How often a shutdown checks whether the runs it cancelled have wound down. */
const SHUTDOWN_POLL_MS = 100;

/** `/stop` or `/cancel`, with or without a bot name. */
function isStopCommand(text: string): boolean {
  const command = parseCommand(text)?.command;
  return command === "stop" || command === "cancel";
}

/** What the ⏹ Cancel button under the progress display answers. */
export const CANCEL_PROMPT_ID = "run:cancel";
const CANCEL_CHOICE: Choice = { id: "cancel", label: "⏹ Cancel", intent: "danger" };

/**
 * A prompt waiting on the person. Button surfaces address it by id; a typed reply is
 * offered to the newest one, and `matchChoice` returning undefined is what lets an
 * unrelated message fall through to the agent instead of being swallowed as a decision.
 */
interface PendingApproval {
  readonly kind: "approval";
  readonly toolCallId: string;
  /** Approve, Reject and, when offered, Always allow: the batch buttons are added per render. */
  readonly choices: readonly Choice[];
  /** The approval key "Always allow" persists, when this is a command that has one. */
  readonly commandKey: string | undefined;
  messageRef?: MessageRef | undefined;
  /** The outstanding count this prompt's buttons currently show. */
  shownCount: number;
}

interface PendingQuestion {
  readonly kind: "question";
  readonly requestId: string;
  readonly choices: readonly Choice[];
  messageRef?: MessageRef | undefined;
}

type PendingPrompt = PendingApproval | PendingQuestion;

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
  /** Whose message started the run in flight; only they answer its prompts. */
  requester?: SenderId | undefined;
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
  readonly queue: InboundMessage[];
}

/**
 * Transcripts for conversations currently incognito.
 *
 * Lives only in this process's memory and is never written anywhere, so a
 * restart drops the context rather than ever falling back to a file on disk —
 * which is the whole promise of the mode.
 */
const incognitoHistory = new Map<ChatId, unknown[]>();

/** How much reasoning to send ahead of an answer, when a bridge does not say. */
const REASONING_PART_CHARS = 1_500;
const REASONING_MAX_PARTS = 2;

/** An execute_command approval's message names the command between these two labels. */
const APPROVAL_COMMAND_PATTERN = /^Command: ([\s\S]*?)\nDescription: /m;
const APPROVAL_COMMAND_LINE = /^Command: (.+)$/m;

/**
 * What "Always allow" can persist for an approval.
 *
 * `key` is the approval key the executor's allowlist matches against, from the same
 * `extractCommandApprovalKey`, so what is saved is exactly what a later run compares.
 * `unallowable` is a shell command with no key (one that chains or redirects), which must
 * never be allowlisted. Undefined is an approval that is not a shell command at all.
 */
export type AlwaysAllowKey =
  { readonly kind: "key"; readonly key: string } | { readonly kind: "unallowable" };

export function commandKeyFromApproval(event: JazzEvent): AlwaysAllowKey | undefined {
  if (event.toolName !== "execute_command" || event.message === undefined) return undefined;
  const command =
    APPROVAL_COMMAND_PATTERN.exec(event.message)?.[1] ??
    APPROVAL_COMMAND_LINE.exec(event.message)?.[1];
  if (command === undefined || command.trim().length === 0) return undefined;
  // Typed wider than today's signature: the tokenizer version returns undefined for a
  // command it refuses to key.
  const key: string | undefined = extractCommandApprovalKey(command);
  return key === undefined || key.trim().length === 0
    ? { kind: "unallowable" }
    : { kind: "key", key };
}

/** Said under an approval whose command cannot be always-allowed. */
const UNALLOWABLE_COMMAND_NOTE = "This command can't be always-allowed: it chains or redirects.";

export interface TurnRunner {
  /**
   * Handle one message from a conversation.
   *
   * Safe to call concurrently: messages for the same conversation are queued
   * and answered in order, and a message arriving while the agent is blocked on
   * a prompt is offered to that prompt first when its sender is the requester.
   */
  handle(message: InboundMessage): Promise<void>;
  /**
   * Answer a tap on a choice: an approval or question the agent is parked on, the
   * batch buttons, ⏹ Cancel, a follow-up, or a picker a command drew. `expired` is what
   * a second tap on a stale keyboard looks like. A tap that starts a new turn (a
   * follow-up) resolves as soon as the turn is under way.
   */
  deliverChoice(tap: ChoiceTap): Promise<ChoiceOutcome>;
  /**
   * Answer every outstanding approval at once.
   *
   * A model that fires five tool calls in parallel asks five times, and tapping
   * through all of them is the common case. Questions are left alone: they have
   * their own answers and there is no blanket one.
   */
  deliverAllApprovals(
    chatId: ChatId,
    approved: boolean,
    senderId: SenderId,
  ): Promise<{ readonly outcome: ChoiceOutcome; readonly count: number }>;
  /**
   * Kill the in-flight run. The requester or an operator may; `senderId` undefined is the
   * bridge itself (shutting down).
   */
  cancel(chatId: ChatId, senderId: SenderId | undefined): CancelOutcome;
  /**
   * Whether `senderId` has a prompt waiting that a typed reply answers.
   *
   * A group that only admits messages addressed to the bot has to let the requester's plain
   * "1" through, or their approval waits for a timeout.
   */
  awaitsReplyFrom(chatId: ChatId, senderId: SenderId): boolean;
  /** Deliver a message the bridge originated, e.g. a reminder. */
  send(chatId: ChatId, body: RichText): Promise<void>;
  /** Whether a run is in flight, for a bridge that wants to show it. */
  busy(chatId: ChatId): boolean;
  /**
   * Stop taking messages, tell everyone with a run in flight that it was stopped, cancel
   * those runs, and resolve once they have wound down (or `graceMs` has passed). For a
   * bridge that is shutting down.
   */
  shutdown(graceMs: number): Promise<void>;
}

export function createTurnRunner(config: TurnConfig): TurnRunner {
  const { surface } = config;
  const states = new Map<ChatId, ChatState>();
  const startedAt = Date.now();
  const buttons = surface.capabilities.buttons;
  const canRedrawChoices =
    buttons && surface.capabilities.editMessages && surface.setChoices !== undefined;

  const limits = config.limits ?? runLimitsFromEnv();
  let runningCount = 0;
  const waitingForSlot: (() => void)[] = [];
  let stopping = false;

  /**
   * Take one of the process-wide run slots, telling the person once when they have to wait
   * for one. The returned function gives it back.
   */
  const acquireRunSlot = async (chatId: ChatId): Promise<() => void> => {
    if (runningCount >= limits.maxConcurrentRuns) {
      await send(chatId, [
        plainLine(
          `⏳ Busy with ${runningCount} other conversations; yours starts as soon as one finishes.`,
        ),
      ]).catch(() => undefined);
      while (runningCount >= limits.maxConcurrentRuns) {
        await new Promise<void>((resolve) => waitingForSlot.push(resolve));
      }
    }
    runningCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runningCount -= 1;
      waitingForSlot.shift()?.();
    };
  };

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

  const ensureAgent = (chatId: ChatId, sandbox: ChatSandbox): AgentFile =>
    ensureScopedAgentFrom(
      config.jazzHome,
      sandbox.home,
      config.agentIdFor(chatId),
      config.baseAgentId,
      sandboxOwnership(sandbox),
    );

  const writeAgent = (sandbox: ChatSandbox, agent: AgentFile): void => {
    writeAgentFile(sandbox.home, agent, sandboxOwnership(sandbox));
  };

  /** Publish a conversation's interactive app, when this bridge serves them. */
  const publishFor = (chatId: ChatId) => {
    const server = config.compositionServer;
    if (server === undefined) return undefined;
    return (composition: JazzComposition): string | undefined => {
      const id = server.links.publish(config.agentIdFor(chatId), composition);
      return id === undefined ? undefined : `${server.publicBaseUrl}${compositionLinkPath(id)}`;
    };
  };

  /** Replace the buttons under a sent message, where the surface can; failures are cosmetic. */
  const redrawChoices = async (
    chatId: ChatId,
    ref: MessageRef | undefined,
    choices: readonly Choice[],
    id?: string,
  ): Promise<void> => {
    if (!canRedrawChoices || ref === undefined) return;
    await surface.setChoices?.(chatId, ref, choices, id).catch((error: unknown) => {
      console.error(`Failed to update the buttons on ${surface.name}: ${String(error)}`);
    });
  };

  // --- Prompts the person answers -----------------------------------------

  const outstandingApprovals = (chatId: ChatId): PendingApproval[] =>
    [...stateFor(chatId).pending.values()].filter(
      (pending): pending is PendingApproval => pending.kind === "approval",
    );

  /** An approval's buttons for a given outstanding count: the batch pair joins past one. */
  const approvalChoices = (pending: PendingApproval, outstanding: number): readonly Choice[] =>
    buttons && outstanding > 1
      ? [
          ...pending.choices,
          { id: APPROVE_ALL_CHOICE_ID, label: `⚡ Approve all ${outstanding}`, intent: "primary" },
          { id: REJECT_ALL_CHOICE_ID, label: `🚫 Reject all ${outstanding}`, intent: "danger" },
        ]
      : pending.choices;

  /**
   * Bring every outstanding approval's batch count up to date. Approval events arrive
   * concurrently, so a prompt can be drawn with a count that is already stale; `shownCount`
   * is what tells which ones genuinely need redrawing.
   */
  const refreshApprovalChoices = async (chatId: ChatId): Promise<void> => {
    const outstanding = outstandingApprovals(chatId);
    for (const pending of outstanding) {
      if (pending.shownCount === outstanding.length || pending.messageRef === undefined) continue;
      pending.shownCount = outstanding.length;
      await redrawChoices(
        chatId,
        pending.messageRef,
        approvalChoices(pending, outstanding.length),
        pending.toolCallId,
      );
    }
  };

  const announceApproval = async (chatId: ChatId, event: JazzEvent): Promise<void> => {
    const toolCallId = event.toolCallId;
    if (toolCallId === undefined) return;

    // Offered only where somebody can use it: "Always allow" is operator-only.
    const alwaysAllow = config.operators.size > 0 ? commandKeyFromApproval(event) : undefined;
    const commandKey = alwaysAllow?.kind === "key" ? alwaysAllow.key : undefined;
    const choices: readonly Choice[] = [
      { id: APPROVE_CHOICE_ID, label: "✅ Approve", intent: "primary" },
      { id: REJECT_CHOICE_ID, label: "❌ Reject", intent: "danger" },
      ...(commandKey === undefined
        ? []
        : [{ id: ALWAYS_ALLOW_CHOICE_ID, label: `♾️ Always allow "${commandKey}"` }]),
    ];
    const body: RichText = [
      line(bold("⚠️ Approval needed")),
      line(code(event.toolName ?? "tool")),
      ...(event.message ? [plainLine(event.message)] : []),
      ...(event.previewDiff ? [codeBlock(event.previewDiff, "diff")] : []),
      ...(alwaysAllow?.kind === "unallowable" ? [plainLine(UNALLOWABLE_COMMAND_NOTE)] : []),
    ];

    const state = stateFor(chatId);
    const pending: PendingApproval = {
      kind: "approval",
      toolCallId,
      choices,
      commandKey,
      shownCount: 0,
    };
    state.pending.set(toolCallId, pending);
    // Counted after joining, so the keyboard drawn now already includes this one.
    const outstanding = outstandingApprovals(chatId).length;
    pending.shownCount = outstanding;
    pending.messageRef = await surface.send(chatId, {
      body,
      choices: approvalChoices(pending, outstanding),
      promptId: toolCallId,
    });
    await refreshApprovalChoices(chatId);
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

    const pending: PendingQuestion = { kind: "question", requestId, choices };
    stateFor(chatId).pending.set(requestId, pending);
    pending.messageRef = await surface.send(chatId, {
      body,
      // With no suggestions there is nothing to number: the person answers in
      // their own words and their next message is forwarded verbatim.
      ...(choices.length > 0 ? { choices, promptId: requestId } : {}),
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
      const approved = choiceId === APPROVE_CHOICE_ID || choiceId === ALWAYS_ALLOW_CHOICE_ID;
      await state.run?.approve([{ toolCallId: pending.toolCallId, approved }]);
      if (choiceId === ALWAYS_ALLOW_CHOICE_ID && pending.commandKey !== undefined) {
        try {
          addAutoApprovedCommand(sandboxFor(chatId), pending.commandKey);
          await send(chatId, [
            line(bold("♾️ Always allowed: "), code(pending.commandKey)),
            plainLine("This conversation runs it without asking from now on."),
          ]);
        } catch (error) {
          console.error(`Failed to persist an always-allowed command: ${String(error)}`);
        }
      }
    } else {
      await state.run?.answerQuestion(pending.requestId, choiceId);
    }
    await redrawChoices(chatId, pending.messageRef, []);
    await refreshApprovalChoices(chatId);
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
  const resolveTypedReply = async (message: InboundMessage): Promise<boolean> => {
    const { chatId, senderId, text: reply } = message;
    const state = stateFor(chatId);
    const pending = [...state.pending.values()].at(-1);
    if (pending === undefined || state.run === undefined) return false;
    // Someone else in a group saying "1" is conversation, not a decision about
    // another person's request.
    if (state.requester !== senderId) return false;

    // A free-text question has no options, so whatever they say next is it, except a
    // command, which is still a command.
    if (pending.kind === "question" && pending.choices.length === 0) {
      if (parseCommand(reply) !== undefined && commands.isCommand(reply)) return false;
      await settle(chatId, pending, reply);
      return true;
    }

    const choice = matchChoice(pending.choices, reply);
    if (choice === undefined) return false;
    if (choice.id === ALWAYS_ALLOW_CHOICE_ID && !config.operators.has(senderId)) {
      await send(
        chatId,
        operatorOnlyMessage(senderId, "Always allowing a command", config.operatorSettingName),
      );
      return true;
    }
    await settle(chatId, pending, choice.id);
    return true;
  };

  /** Drop the buttons of prompts nothing will read any more. */
  const expirePending = async (chatId: ChatId): Promise<void> => {
    const state = stateFor(chatId);
    const expired = [...state.pending.values()];
    state.pending.clear();
    for (const pending of expired) {
      await redrawChoices(chatId, pending.messageRef, []);
    }
    notifyPendingChange(chatId);
  };

  // --- The run -------------------------------------------------------------

  const answer = async (message: InboundMessage): Promise<void> => {
    const { chatId } = message;
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
    const releaseSlot = await acquireRunSlot(chatId);
    try {
      // Opened once the run can start, so the log's clock is the run's, not the wait's.
      const runLog = createRunLog(sandbox.home, conversation);
      await runAndAnswer(message, state, sandbox, conversation, incognito, runLog);
    } finally {
      releaseSlot();
    }
  };

  const runAndAnswer = async (
    message: InboundMessage,
    state: ChatState,
    sandbox: ChatSandbox,
    conversation: string,
    incognito: boolean,
    runLog: ReturnType<typeof createRunLog>,
  ): Promise<void> => {
    const { chatId, text: prompt } = message;
    const reporter = createProgressReporter({
      surface,
      chatId,
      runLog,
      ...(buttons ? { cancelChoice: CANCEL_CHOICE, cancelPromptId: CANCEL_PROMPT_ID } : {}),
      replyTo: message.replyTo,
    });
    await reporter.start();

    const run = (config.startRun ?? startJazzRun)(
      {
        jazzBinary: config.jazzBinary,
        surface: surface.name,
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
    state.requester = message.senderId;

    const envelope = await run.result;
    state.run = undefined;
    state.requester = undefined;
    // Prompts still outstanding when the run ends are ones nothing will ever
    // read, and leaving them would eat the person's next message.
    await expirePending(chatId);
    runLog.finish({
      ok: envelope.ok,
      cancelled: run.cancelled(),
      rounds: reporter.rounds(),
      toolsUsed: reporter.toolsUsed(),
      ...(envelope.ok ? {} : { error: envelope.error }),
    });

    if (!envelope.ok) {
      const failure = run.cancelled() ? cancelledSummary() : failedSummary(envelope.error);
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

    const summary = doneSummary(envelope, reporter.toolsUsed());
    const summaryShown = await reporter.finish(summary);

    if (config.showReasoning) {
      const parts = splitReasoning(reporter.reasoningLog(), {
        budget: config.reasoningPartChars ?? REASONING_PART_CHARS,
        maxParts: config.reasoningMaxParts ?? REASONING_MAX_PARTS,
      });
      for (const [index, part] of parts.entries()) {
        const counter = parts.length > 1 ? ` (${index + 1}/${parts.length})` : "";
        await send(chatId, [
          line(bold(`💭 Reasoning${counter}`)),
          // Collapsed where the surface can collapse it, an ordinary quote
          // where it cannot.
          quote(part, true),
        ]);
      }
    }

    const answerRef = await surface.send(chatId, {
      body: [
        markdown(envelope.answer),
        // Where the progress display could not show it — an append-only surface
        // has no bubble to close — the summary rides under the answer rather
        // than costing its own notification.
        ...(summaryShown ? [] : [plainLine(""), ...summary]),
      ],
      // Offered, never required: a surface without buttons drops these rather
      // than appending a numbered menu to every answer.
      choices: followupChoices(),
      choiceKind: "suggestion",
      promptId: FOLLOWUP_PROMPT_ID,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    });

    if (config.onAnswered !== undefined) {
      void config
        .onAnswered({
          chatId,
          senderId: message.senderId,
          question: prompt,
          answer: envelope.answer,
          messageRef: answerRef,
        })
        .catch((error: unknown) =>
          console.error(`Following up an answer on ${surface.name} failed: ${String(error)}`),
        );
    }

    if (envelope.composition !== undefined) {
      await deliverComposition(
        surface,
        chatId,
        planCompositionDelivery(envelope.composition, {
          home: sandbox.home,
          publish: publishFor(chatId),
          publicUrlSettingName: config.publicUrlSettingName ?? "the public URL setting",
        }),
      );
    }
  };

  const commands = createCommands({
    config,
    startedAt,
    sandboxFor,
    ensureAgent,
    writeAgent,
    forgetIncognitoHistory: (chatId) => {
      incognitoHistory.delete(chatId);
    },
    runTurn: (message) => answer(message),
    send: async (chatId, body, choices) => {
      await surface.send(
        chatId,
        choices === undefined
          ? { body }
          : { body, choices: choices.choices, promptId: choices.promptId },
      );
    },
  });

  const cancel = (chatId: ChatId, senderId: SenderId | undefined): CancelOutcome => {
    const state = stateFor(chatId);
    if (state.run === undefined) return "idle";
    if (senderId !== undefined && state.requester !== senderId && !config.operators.has(senderId)) {
      return "not-requester";
    }
    state.run.cancel();
    // The queue goes too: those messages were sent expecting the answer this
    // run was about to give, and replaying them against a cancelled turn is
    // not what anyone asking to stop meant.
    state.queue.length = 0;
    return "cancelled";
  };

  const deliverAllApprovals = async (
    chatId: ChatId,
    approved: boolean,
    senderId: SenderId,
  ): Promise<{ readonly outcome: ChoiceOutcome; readonly count: number }> => {
    const state = stateFor(chatId);
    const approvals = outstandingApprovals(chatId);
    if (approvals.length === 0 || state.run === undefined) {
      return { outcome: "expired", count: 0 };
    }
    if (state.requester !== senderId) return { outcome: "not-requester", count: 0 };

    for (const pending of approvals) state.pending.delete(pending.toolCallId);
    await state.run.approve(
      approvals.map((pending) => ({ toolCallId: pending.toolCallId, approved })),
    );
    for (const pending of approvals) {
      await redrawChoices(chatId, pending.messageRef, []);
    }
    notifyPendingChange(chatId);
    return { outcome: "answered", count: approvals.length };
  };

  /**
   * Run one message's handling so that a failure answers that message and leaves the rest
   * of the conversation's queue to run. Without it one throw stranded every message queued
   * behind it, unanswered, until something else arrived.
   */
  const handleSafely = async (
    message: InboundMessage,
    work: () => Promise<void>,
  ): Promise<void> => {
    try {
      await work();
    } catch (error) {
      console.error(`Handling a message in ${message.chatId} failed: ${String(error)}`);
      await send(message.chatId, [
        plainLine("⚠️ Something went wrong handling your message. Try again in a moment."),
      ]).catch((notifyError: unknown) =>
        console.error(`Could not tell ${message.chatId} it failed: ${String(notifyError)}`),
      );
    }
  };

  /** `/stop` and `/cancel` stop the run; any other immediate command is an ordinary one. */
  const handleImmediate = async (message: InboundMessage): Promise<void> => {
    if (!isStopCommand(message.text)) {
      await commands.handle(message);
      return;
    }
    const outcome = cancel(message.chatId, message.senderId);
    await send(message.chatId, [
      plainLine(
        outcome === "cancelled"
          ? "⏹ Stopping the current run."
          : outcome === "idle"
            ? "Nothing is running."
            : "Only the person who started this run, or an operator, can stop it.",
      ),
    ]);
  };

  const runner: TurnRunner = {
    busy: (chatId) => stateFor(chatId).busy,
    send,
    cancel,
    deliverAllApprovals,

    async deliverChoice(tap: ChoiceTap): Promise<ChoiceOutcome> {
      const { chatId, choiceId, senderId } = tap;

      // A follow-up is not something the agent is waiting on: it is a new turn
      // whose prompt happens to have been chosen by tapping rather than typed.
      if (tap.promptId === FOLLOWUP_PROMPT_ID) {
        const prompt = followupPrompt(choiceId);
        const label = FOLLOWUP_OPTIONS[choiceId]?.label;
        if (prompt === undefined || label === undefined) return "expired";
        await redrawChoices(chatId, tap.messageRef, []);
        await surface.send(chatId, {
          body: [plainLine(label)],
          ...(tap.messageRef === undefined ? {} : { replyTo: tap.messageRef }),
        });
        void runner
          .handle({ chatId, senderId, text: prompt, replyTo: tap.messageRef })
          .catch((error: unknown) =>
            console.error(`A follow-up on ${surface.name} failed: ${String(error)}`),
          );
        return "answered";
      }

      if (tap.promptId === CANCEL_PROMPT_ID) {
        const outcome = cancel(chatId, senderId);
        return outcome === "cancelled" ? "answered" : outcome === "idle" ? "expired" : outcome;
      }

      if (commands.owns(tap.promptId)) return commands.handleChoice(tap);

      const state = stateFor(chatId);
      const pending = state.pending.get(tap.promptId);
      if (pending === undefined || state.run === undefined) return "expired";
      if (state.requester !== senderId) return "not-requester";

      if (
        pending.kind === "approval" &&
        (choiceId === APPROVE_ALL_CHOICE_ID || choiceId === REJECT_ALL_CHOICE_ID)
      ) {
        return (await deliverAllApprovals(chatId, choiceId === APPROVE_ALL_CHOICE_ID, senderId))
          .outcome;
      }
      if (choiceId === ALWAYS_ALLOW_CHOICE_ID && !config.operators.has(senderId)) {
        return "not-operator";
      }
      await settle(chatId, pending, choiceId);
      return "answered";
    },

    awaitsReplyFrom(chatId: ChatId, senderId: SenderId): boolean {
      const state = stateFor(chatId);
      return state.run !== undefined && state.pending.size > 0 && state.requester === senderId;
    },

    async handle(message: InboundMessage): Promise<void> {
      const state = stateFor(message.chatId);

      if (stopping) {
        await send(message.chatId, RESTARTING_NOTICE).catch(() => undefined);
        return;
      }

      if (state.busy) {
        // A command about the conversation itself is answered now, not after the run.
        if (commands.answersImmediately(message.text)) {
          await handleSafely(message, () => handleImmediate(message));
          return;
        }
        if (await resolveTypedReply(message)) return;
        if (state.queue.length >= limits.maxQueuedMessages) {
          await send(message.chatId, [
            plainLine(
              `⚠️ ${state.queue.length} messages are already waiting behind the current answer, so this one was dropped. Send it again once that answer arrives, or /stop it.`,
            ),
          ]).catch(() => undefined);
          return;
        }
        state.queue.push(message);
        return;
      }

      state.busy = true;
      try {
        let next: InboundMessage | undefined = message;
        while (next !== undefined) {
          const current = next;
          await handleSafely(current, async () => {
            if (isStopCommand(current.text)) {
              await handleImmediate(current);
              return;
            }
            if (!(await commands.handle(current))) await answer(current);
          });
          next = state.queue.shift();
        }
      } finally {
        state.busy = false;
      }
    },

    async shutdown(graceMs: number): Promise<void> {
      stopping = true;
      const inFlight = [...states.entries()].filter(([, state]) => state.run !== undefined);
      for (const [chatId, state] of inFlight) {
        state.queue.length = 0;
        await send(chatId, RESTARTING_NOTICE).catch(() => undefined);
        state.run?.cancel();
      }
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && [...states.values()].some((state) => state.busy)) {
        await Bun.sleep(SHUTDOWN_POLL_MS);
      }
    },
  };
  return runner;
}

export { readAgentFile };
