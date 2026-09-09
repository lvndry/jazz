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
  type MessageRef,
  plainLine,
  type RichText,
  type Surface,
  text,
} from "./surface";

/** How often the edited bubble may be rewritten. Telegram rate-limits edits. */
const EDIT_MIN_INTERVAL_MS = 2_000;

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
  /**
   * How often the bubble may be rewritten. Surfaces rate-limit edits at
   * different rates, and a test needs a cadence it can reach without sleeping.
   */
  readonly editIntervalMs?: number;
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
}

const WORKING_HEADER = "🤔 Working…";

export function createProgressReporter(options: ProgressReporterOptions): ProgressReporter {
  const { surface, chatId, runLog } = options;
  const editable = surface.capabilities.editMessages && surface.edit !== undefined;
  const editIntervalMs = options.editIntervalMs ?? EDIT_MIN_INTERVAL_MS;

  const tools: string[] = [];
  const subagents: string[] = [];
  const declined: string[] = [];
  let reasoning = "";
  let writing = false;
  let rounds = 0;

  let messageRef: MessageRef | undefined;
  let lastRendered = "";
  let lastSentAt = 0;
  let sending = false;
  let quietUpdates = 0;
  const startedAt = Date.now();

  const render = (): RichText => {
    const body: RichText[number][] = [line(bold(WORKING_HEADER))];
    const thought = reasoningSnippet(reasoning);
    if (thought) body.push(line(text(`💭 ${thought}`)));
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
    if (rounds > 1) body.push(plainLine(`↻ round ${rounds}`));
    if (writing) body.push(plainLine("✍️ writing the answer…"));
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

  const choices = options.cancelChoice ? [options.cancelChoice] : undefined;

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
    if (!editable || messageRef === undefined) return;
    if (sending && !force) return;
    const rendered = JSON.stringify(body);
    if (rendered === lastRendered && !force) return;
    sending = true;
    lastRendered = rendered;
    lastSentAt = Date.now();
    try {
      await surface.edit?.(chatId, messageRef, {
        body,
        ...(withChoices ? { choices: withChoices } : {}),
      });
    } catch (error) {
      console.error(`Failed to update progress on ${surface.name}: ${String(error)}`);
    } finally {
      sending = false;
    }
  };

  const quietTick = async () => {
    if (sending) return;
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
      messageRef = await surface.send(chatId, {
        body: [line(bold(WORKING_HEADER))],
        ...(editable && choices ? { choices } : {}),
      });
      lastRendered = JSON.stringify([line(bold(WORKING_HEADER))]);
      lastSentAt = Date.now();
    },

    onEvent(event: JazzEvent): void {
      runLog.event(event);
      switch (event.type) {
        case "tools_detected":
          // One per model response that asked for tools, so one per loop round.
          rounds += 1;
          break;
        case "thinking_chunk":
          // Accumulate raw so a lone-space chunk isn't trimmed away (which
          // would glue the surrounding words); normalisation is at render time.
          if (typeof event.content === "string") reasoning += event.content;
          break;
        case "tool_execution_start":
          if (typeof event.toolName === "string") tools.push(event.toolName);
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
        case "text_chunk":
          writing = true;
          break;
      }

      if (editable) {
        if (Date.now() - lastSentAt >= editIntervalMs) void update(render(), choices);
        return;
      }

      const due = quietUpdates === 0 ? QUIET_FIRST_UPDATE_MS : QUIET_UPDATE_INTERVAL_MS;
      if (Date.now() - lastSentAt >= due) void quietTick();
    },

    async finish(summary: RichText): Promise<boolean> {
      if (!editable || messageRef === undefined) return false;
      // An empty choice list is what drops the Cancel button from the closed bubble.
      await update(summary, [], true);
      return true;
    },

    toolsUsed: () => [...new Set(tools)],
    rounds: () => rounds,
    reasoningLog: () => reasoning,
  };
}
