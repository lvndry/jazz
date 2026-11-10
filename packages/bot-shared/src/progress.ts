/**
 * @fileoverview Narrate a running Jazz turn on whatever surface is listening.
 *
 * The Telegram and Discord bridges each grew the same reporter: accumulate
 * thinking, tool calls, sub-agents and declined tools out of the event stream,
 * and rewrite one "Working…" message every couple of seconds. That shape needs
 * a surface that can edit a sent message, and two of the four cannot — iMessage
 * and WhatsApp would turn every tick into a push notification.
 *
 * So there are two modes here, chosen from the surface's capabilities rather
 * than by the caller:
 *
 *   - editable: one bubble, rewritten on a short interval, closed with the
 *     run's summary. What Telegram and Discord already do.
 *   - append-only: one acknowledgement up front, then silence unless the run
 *     runs long, at which point a single short update goes out on a much slower
 *     cadence. A person who texted their assistant does not want eight
 *     notifications about tool calls, but does want to know it is still alive.
 *
 * A one-to-one conversation on a surface with native drafts gets a third: the
 * progress, then the answer as the model writes it, shown as a draft that is never
 * saved to the chat. The answer message replaces it. A refused draft switches the
 * run to the edited bubble.
 */

import type { JazzEvent } from "./jazz-run";
import { reasoningSnippet } from "./reasoning";
import type { RunLog } from "./run-log";
import {
  bold,
  type ChatId,
  type Choice,
  code,
  line,
  markdown,
  type MessageRef,
  plainLine,
  type DraftOutcome,
  type RichText,
  type Surface,
  text,
} from "./surface";

/** How often the edited bubble may be rewritten. Telegram rate-limits edits. */
const EDIT_MIN_INTERVAL_MS = 2_000;

/**
 * A draft that is not redrawn disappears: Telegram shows one for 30 seconds
 * (`sendMessageDraft`). A run waiting on a tool or an approval changes nothing for longer
 * than that, so the same frame is sent again with this much of the 30 seconds to spare.
 */
const DRAFT_KEEPALIVE_MS = 20_000;

/**
 * How long an append-only surface stays quiet before saying it is still
 * working, and the cadence of those updates after that.
 *
 * Most turns finish inside this, so the common case is exactly two messages:
 * the acknowledgement and the answer. Long enough that a normal question never
 * triggers one; short enough that a person does not conclude it broke.
 */
const QUIET_FIRST_UPDATE_MS = 45_000;
const QUIET_UPDATE_INTERVAL_MS = 60_000;

/**
 * How often the display is looked at without an event. A slow model loading into memory
 * sends nothing for minutes, and the display must still move: the elapsed time on an edited
 * bubble, the "still working" line on an append-only surface.
 */
const PROGRESS_TICK_MS = 5_000;

/** The bubble shows how long the run has taken once it is past this. */
const ELAPSED_SHOWN_AFTER_MS = QUIET_FIRST_UPDATE_MS;

/** Tools and sub-agents past this are dropped from the display, oldest first. */
const MAX_TOOLS_SHOWN = 8;

export interface ProgressReporterOptions {
  readonly surface: Surface;
  readonly chatId: ChatId;
  readonly runLog: RunLog;
  /**
   * Offered while the run is in flight, on surfaces with buttons. Left out on
   * an append-only surface: a choice there is a numbered reply, and a standing
   * "reply 1 to cancel" would swallow the person's next real message.
   */
  readonly cancelChoice?: Choice;
  /** What a tap on `cancelChoice` answers, so the bridge can route it back. */
  readonly cancelPromptId?: string;
  /** The message this run answers, so the progress display is threaded under it. */
  readonly replyTo?: MessageRef | undefined;
  /**
   * How often the bubble may be rewritten. Surfaces rate-limit edits at
   * different rates, and a test needs a cadence it can reach without sleeping.
   */
  readonly editIntervalMs?: number;
  /** How often the display is looked at without an event; a test shortens it. */
  readonly tickMs?: number;
  /** How long an unchanged draft may stand before it is sent again; a test shortens it. */
  readonly draftKeepaliveMs?: number;
  /**
   * Show the run as a native draft. Set by the caller for a one-to-one conversation;
   * ignored on a surface without `streamDraft`.
   */
  readonly draft?: { readonly id: number; readonly stoppable: boolean };
}

export interface ProgressReporter {
  /** Put the first message on screen. Call once, before the run starts. */
  start(): Promise<void>;
  onEvent(event: JazzEvent): void;
  /**
   * Close the progress display with the run's summary.
   *
   * Returns whether the summary actually reached the person: false on an
   * append-only surface, where there is no bubble to close and sending it
   * alone would be a second notification carrying no answer. The caller
   * attaches it to the answer instead.
   */
  finish(summary: RichText): Promise<boolean>;
  toolsUsed(): readonly string[];
  rounds(): number;
  /**
   * Everything the model thought, for the expandable log under the answer. The
   * live display only ever shows a rolling tail of it.
   */
  reasoningLog(): string;
  /**
   * The answer as far as the person saw it in the draft, for a run stopped before it was
   * sent. Empty when the run was not drafted or nothing was written yet.
   */
  streamedAnswer(): string;
}

const WORKING_HEADER = "🤔 Working…";

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function createProgressReporter(options: ProgressReporterOptions): ProgressReporter {
  const { surface, chatId, runLog } = options;
  const editable = surface.capabilities.editMessages && surface.edit !== undefined;
  const editIntervalMs = options.editIntervalMs ?? EDIT_MIN_INTERVAL_MS;
  const draft = surface.streamDraft === undefined ? undefined : options.draft;
  /** Cleared for good when the surface refuses a draft; the run then gets the bubble. */
  let drafting = draft !== undefined;

  const tools: string[] = [];
  const subagents: string[] = [];
  const declined: string[] = [];
  let reasoning = "";
  let writing = false;
  let rounds = 0;
  /** The model's text in its current response, which the draft shows once there is some. */
  let answerText = "";
  /**
   * The answer as of the last draft frame that reached the screen. Kept when drafting later
   * stops, since the person already read it.
   */
  let shownAnswer = "";

  let messageRef: MessageRef | undefined;
  /** The progress bubble being sent, so finishing waits for it and closes it. */
  let bubbleOpening: Promise<void> | undefined;
  let lastRendered = "";
  let lastSentAt = 0;
  let sending = false;
  let quietUpdates = 0;
  const startedAt = Date.now();

  const render = (): RichText => {
    const body: RichText[number][] = [line(bold(WORKING_HEADER))];
    const thought = reasoningSnippet(reasoning);
    if (thought) {
      body.push(line(text(`💭 ${thought}`)));
    }
    for (const tool of tools.slice(-MAX_TOOLS_SHOWN)) {
      body.push(line(text("🔧 "), code(tool)));
    }
    for (const task of subagents.slice(-MAX_TOOLS_SHOWN)) {
      body.push(plainLine(`🤖 ${task}`));
    }
    for (const tool of declined) {
      body.push(line(text("⛔ "), code(tool), text(" declined (needs approval)")));
    }
    // A run going round and round looks identical to a slow one from outside;
    // the count is what makes a loop visible without reading logs.
    if (rounds > 1) {
      body.push(plainLine(`↻ round ${rounds}`));
    }
    if (writing) {
      body.push(plainLine("✍️ writing the answer…"));
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= ELAPSED_SHOWN_AFTER_MS) {
      body.push(plainLine(`⏱ ${formatElapsed(elapsedMs)}`));
    }
    return body;
  };

  /**
   * A one-line "still going" for append-only surfaces.
   *
   * Deliberately not the full display: on a surface where this arrives as its
   * own notification, the useful content is that it is alive and roughly where
   * it is, not a transcript of every tool call.
   */
  const renderQuietUpdate = (): RichText => {
    const elapsedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
    const latest = tools.at(-1);
    const detail = writing ? "writing the answer" : (latest ?? "thinking");
    return [plainLine(`⏳ Still working (${elapsedMinutes}m) — ${detail}`)];
  };

  /**
   * What the draft shows: the answer once the model is writing one, otherwise the progress.
   * Progress with nothing in it yet stays empty, which keeps the platform's own "thinking"
   * placeholder up instead of a bare header.
   */
  const renderDraft = (): RichText => {
    if (answerText.trim().length > 0) {
      return [markdown(answerText)];
    }
    const progress = render();
    return progress.length > 1 ? progress : [];
  };

  const frame = (): RichText => (drafting ? renderDraft() : render());

  const choices = options.cancelChoice ? [options.cancelChoice] : undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  /**
   * Redraw now if the throttle allows, and otherwise once it does: an event that arrives
   * inside the edit interval would otherwise never be shown when it is the last one. A draft
   * nothing has changed is still redrawn before it expires.
   */
  const refresh = (): void => {
    if (finished) {
      return;
    }
    const sinceLastMs = Date.now() - lastSentAt;
    if (drafting && sinceLastMs >= (options.draftKeepaliveMs ?? DRAFT_KEEPALIVE_MS)) {
      void update(frame(), choices, true);
      return;
    }
    const waitMs = editIntervalMs - sinceLastMs;
    if (waitMs <= 0) {
      void update(frame(), choices);
      return;
    }
    trailing ??= setTimeout(() => {
      trailing = undefined;
      if (!finished) {
        void update(frame(), choices);
      }
    }, waitMs);
  };

  const maybeQuietTick = (): void => {
    const due = quietUpdates === 0 ? QUIET_FIRST_UPDATE_MS : QUIET_UPDATE_INTERVAL_MS;
    if (Date.now() - lastSentAt >= due) {
      void quietTick();
    }
  };

  const stopTimers = (): void => {
    finished = true;
    if (ticker !== undefined) {
      clearInterval(ticker);
    }
    if (trailing !== undefined) {
      clearTimeout(trailing);
    }
    ticker = undefined;
    trailing = undefined;
  };

  /**
   * Rewrite the bubble, skipping a no-op edit.
   *
   * `sending` drops ticks that arrive while one is in flight rather than
   * queueing them: the next event is a couple of seconds away and will render
   * fresher state, so a queue would only ever deliver stale frames late. The
   * closing summary passes `force`, since it is the one frame that has to land
   * however the throttle happens to fall.
   */
  const update = async (
    body: RichText,
    withChoices: readonly Choice[] | undefined,
    force = false,
  ) => {
    if (drafting) {
      // A refusal that lands after the run finished must not open a bubble under the answer.
      if ((await pushDraft(body, force)) === "refused" && !finished) {
        await openBubble();
      }
      return;
    }
    if (!editable || messageRef === undefined) {
      return;
    }
    if (sending && !force) {
      return;
    }
    const rendered = JSON.stringify(body);
    if (rendered === lastRendered && !force) {
      return;
    }
    sending = true;
    lastRendered = rendered;
    lastSentAt = Date.now();
    try {
      await surface.edit?.(chatId, messageRef, {
        body,
        ...(withChoices ? { choices: withChoices } : {}),
        ...(options.cancelPromptId === undefined ? {} : { promptId: options.cancelPromptId }),
      });
    } catch (error) {
      console.error(`Failed to update progress on ${surface.name}: ${String(error)}`);
    } finally {
      sending = false;
    }
  };

  /**
   * Draw one draft frame. A frame dropped here (one already in flight, or nothing changed)
   * counts as shown. A `refused` one ends drafting for the run; a `skipped` one is forgotten,
   * so the next tick sends it again instead of waiting for the content to change.
   */
  const pushDraft = async (body: RichText, force: boolean): Promise<DraftOutcome> => {
    if (draft === undefined || surface.streamDraft === undefined) {
      return "refused";
    }
    if (sending && !force) {
      return "shown";
    }
    const rendered = JSON.stringify(body);
    if (rendered === lastRendered && !force) {
      return "shown";
    }
    const answerInFrame = answerText.trim().length > 0 ? answerText : undefined;
    sending = true;
    lastRendered = rendered;
    lastSentAt = Date.now();
    let outcome: DraftOutcome;
    try {
      outcome = await surface.streamDraft(chatId, {
        id: draft.id,
        body,
        stoppable: draft.stoppable,
      });
    } catch (error) {
      console.error(`Draft failed on ${surface.name}: ${String(error)}`);
      outcome = "skipped";
    } finally {
      sending = false;
    }
    if (outcome === "shown" && answerInFrame !== undefined) {
      shownAnswer = answerInFrame;
    }
    if (outcome === "skipped") {
      lastRendered = "";
      lastSentAt = 0;
      console.log(`[progress] ${chatId}: draft frame did not get through, retrying next tick`);
    }
    if (outcome === "refused" && drafting) {
      drafting = false;
      console.warn(
        `[progress] ${chatId}: draft refused on ${surface.name}, using an edited bubble`,
      );
    }
    return outcome;
  };

  /** Put the progress bubble on screen: at the start, or when a draft was refused mid-run. */
  const openBubble = (): Promise<void> => {
    if (messageRef !== undefined) {
      return Promise.resolve();
    }
    bubbleOpening ??= (async () => {
      const opening = [line(bold(WORKING_HEADER))];
      messageRef = await surface.send(chatId, {
        body: opening,
        ...(editable && choices ? { choices } : {}),
        ...(options.cancelPromptId === undefined ? {} : { promptId: options.cancelPromptId }),
        ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
      });
      lastRendered = JSON.stringify(opening);
      lastSentAt = Date.now();
    })();
    return bubbleOpening;
  };

  const quietTick = async () => {
    if (sending) {
      return;
    }
    sending = true;
    quietUpdates += 1;
    lastSentAt = Date.now();
    try {
      await surface.send(chatId, { body: renderQuietUpdate() });
    } catch (error) {
      console.error(`Failed to send a progress update on ${surface.name}: ${String(error)}`);
    } finally {
      sending = false;
    }
  };

  return {
    async start(): Promise<void> {
      // A first frame that was only skipped keeps the run drafted: the next tick retries it.
      const drafted = drafting && (await pushDraft([], true)) !== "refused";
      console.log(`[progress] ${chatId}: ${drafted ? "drafting" : "progress bubble"}`);
      if (!drafted) {
        await openBubble();
      }
      ticker = setInterval(
        () => (drafting || editable ? refresh() : maybeQuietTick()),
        options.tickMs ?? PROGRESS_TICK_MS,
      );
      ticker.unref?.();
    },

    onEvent(event: JazzEvent): void {
      runLog.event(event);
      switch (event.type) {
        case "tools_detected":
          // One per model response that asked for tools, so one per loop round.
          rounds += 1;
          // What it wrote before calling tools ("let me check") is not the answer.
          answerText = "";
          break;
        case "thinking_chunk":
          // Accumulate raw so a lone-space chunk isn't trimmed away (which
          // would glue the surrounding words); normalisation is at render time.
          if (typeof event.content === "string") {
            reasoning += event.content;
          }
          break;
        case "tool_execution_start":
          if (typeof event.toolName === "string") {
            tools.push(event.toolName);
          }
          break;
        case "subagent_start":
          subagents.push(event.task?.trim() || "sub-agent");
          break;
        case "approval_resolved":
          if (event.approved === false && typeof event.toolName === "string") {
            declined.push(event.toolName);
          }
          break;
        case "text_start":
          writing = true;
          answerText = "";
          break;
        case "text_chunk":
          writing = true;
          if (typeof event.accumulated === "string") {
            answerText = event.accumulated;
          }
          break;
      }

      if (drafting || editable) {
        refresh();
        return;
      }
      maybeQuietTick();
    },

    async finish(summary: RichText): Promise<boolean> {
      stopTimers();
      // A bubble a refused draft started opening just before the run ended is closed too,
      // rather than left on screen saying it is still working.
      await bubbleOpening?.catch(() => undefined);
      // A draft is not a message: the summary goes out with the answer, which replaces it.
      if (drafting || !editable || messageRef === undefined) {
        return false;
      }
      // An empty choice list is what drops the Cancel button from the closed bubble.
      await update(summary, [], true);
      return true;
    },

    toolsUsed: () => [...new Set(tools)],
    rounds: () => rounds,
    reasoningLog: () => reasoning,
    streamedAnswer: () => shownAnswer,
  };
}
