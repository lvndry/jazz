/**
 * @fileoverview What Jazz tells you through the `notify` targets, and how each event reads.
 *
 * An event is data; {@link renderNotification} turns it into the title and body every target
 * sends (a chat message is the two joined, a desktop toast and an ntfy push show them apart, a
 * webhook gets the event itself plus the rendered text).
 *
 * - `waiting`: something needs you: a parked run's approval, question or file, a goal stopped
 *   for review or at its cycle cap, a loop that stopped (see `daemon/attention.ts`).
 * - `paused`: the daemon stopped starting work of its own, at a daily cap.
 * - `reminder`: a reminder a desktop could not show.
 * - `unattended-failed`: work nobody was watching failed.
 * - `spend-cap`: a spend cap refused an unattended run.
 * - `workflow-result`: a workflow's answer, for the targets its `deliver:` names.
 */

import { z } from "zod";
import {
  answerHint,
  type DaemonPause,
  DaemonPauseSchema,
  type WaitingItem,
  WaitingItemSchema,
} from "@/core/daemon/attention";
import { SPEND_SOURCE_LABELS, SPEND_SOURCES, type SpendSource } from "@/core/spend/sources";
import { isRecord } from "@/core/utils/is-record";

export type NotifyEvent =
  | { readonly kind: "waiting"; readonly item: WaitingItem }
  | { readonly kind: "paused"; readonly pause: DaemonPause; readonly reason: string }
  | {
      readonly kind: "workflow-result";
      readonly workflow: string;
      readonly agentId: string;
      readonly answer: string;
    }
  | {
      readonly kind: "reminder";
      readonly agentId: string;
      readonly text: string;
      /** Epoch ms the reminder was set for. */
      readonly fireAt: number;
    }
  | {
      readonly kind: "unattended-failed";
      readonly source: SpendSource;
      readonly name?: string;
      readonly agentId?: string;
      readonly runId?: string;
      readonly error: string;
    }
  | {
      readonly kind: "spend-cap";
      readonly source: SpendSource;
      readonly agentId: string;
      readonly name?: string;
      readonly message: string;
    };

const sourceSchema = z.enum(SPEND_SOURCES);

export const NotifyEventSchema: z.ZodType<NotifyEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting"), item: WaitingItemSchema }),
  z.object({ kind: z.literal("paused"), pause: DaemonPauseSchema, reason: z.string() }),
  z.object({
    kind: z.literal("workflow-result"),
    workflow: z.string(),
    agentId: z.string(),
    answer: z.string(),
  }),
  z.object({
    kind: z.literal("reminder"),
    agentId: z.string(),
    text: z.string(),
    fireAt: z.number(),
  }),
  z.object({
    kind: z.literal("unattended-failed"),
    source: sourceSchema,
    name: z.string().exactOptional(),
    agentId: z.string().exactOptional(),
    runId: z.string().exactOptional(),
    error: z.string(),
  }),
  z.object({
    kind: z.literal("spend-cap"),
    source: sourceSchema,
    agentId: z.string(),
    name: z.string().exactOptional(),
    message: z.string(),
  }),
]);

const LEGACY_PENDING_TO_WAITING_KIND: Readonly<Record<string, WaitingItem["kind"]>> = {
  "tool-approval": "approval",
  question: "question",
  "file-picker": "file",
};

const LEGACY_PENDING_TITLE: Readonly<Record<WaitingItem["kind"], string>> = {
  approval: "needs your approval",
  question: "has a question",
  secret: "needs a secret you type",
  file: "needs a file",
  "goal-review": "needs a review",
  "goal-limit": "stopped at its cycle cap",
  "loop-stopped": "stopped",
};

/**
 * An event queued by a Jazz whose outbox held `approval-needed` and `spend-ceiling`, in the
 * shape this build reads: `spend-ceiling` is `spend-cap` with the same fields, and
 * `approval-needed` is a `waiting` item for its run. Any other value is returned unchanged.
 * `queuedAt` (epoch ms) stands in for when the item started waiting.
 */
export function upgradeStoredNotifyEvent(stored: unknown, queuedAt: number): unknown {
  if (!isRecord(stored)) {
    return stored;
  }
  if (stored["kind"] === "spend-ceiling") {
    return { ...stored, kind: "spend-cap" };
  }
  if (stored["kind"] !== "approval-needed") {
    return stored;
  }
  const runId = typeof stored["runId"] === "string" ? stored["runId"] : "unknown";
  const pending = typeof stored["pending"] === "string" ? stored["pending"] : "tool-approval";
  const waitingKind = LEGACY_PENDING_TO_WAITING_KIND[pending] ?? "approval";
  const request = typeof stored["request"] === "string" ? stored["request"] : "";
  const expiresAt = typeof stored["expiresAt"] === "string" ? stored["expiresAt"] : undefined;
  const agentId = typeof stored["agentId"] === "string" ? stored["agentId"] : undefined;
  const item: WaitingItem = {
    key: `run:${runId}:${pending}`,
    kind: waitingKind,
    title: `Jazz run ${runId} ${LEGACY_PENDING_TITLE[waitingKind]}`,
    detail: expiresAt === undefined ? request : `${request}\n\nIt waits until ${expiresAt}.`,
    since: new Date(queuedAt).toISOString(),
    runId,
    ...(agentId !== undefined ? { agentId } : {}),
  };
  return { kind: "waiting", item };
}

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
}

export interface RenderOptions {
  /** The target is a chat a Jazz bridge serves, so `/approve <runId>` works there. */
  readonly approveFromChat?: boolean;
}

function singular(source: SpendSource): string {
  switch (source) {
    case "workflow":
      return "workflow";
    case "goal":
      return "goal cycle";
    case "loop":
      return "loop run";
    case "wake-trigger":
      return "wake-up turn";
    case "job":
      return "job batch";
    case "webhook":
      return "webhook run";
    case "peer":
      return "peer request";
    default:
      return SPEND_SOURCE_LABELS[source];
  }
}

function named(source: SpendSource, name: string | undefined): string {
  return name === undefined ? singular(source) : `${singular(source)} "${name}"`;
}

/** The title and body a person reads for `event`. */
export function renderNotification(
  event: NotifyEvent,
  options: RenderOptions = {},
): RenderedNotification {
  switch (event.kind) {
    case "waiting":
      return {
        title: event.item.title,
        body: `${event.item.detail}\n${answerHint(event.item, {
          ...(options.approveFromChat !== undefined ? { fromChat: options.approveFromChat } : {}),
        })}`,
      };
    case "paused":
      return { title: "Jazz paused its background work", body: event.reason };
    case "workflow-result":
      return { title: `Jazz: ${event.workflow}`, body: event.answer };
    case "reminder":
      return { title: "Jazz reminder", body: event.text };
    case "unattended-failed":
      return {
        title: `Jazz ${named(event.source, event.name)} failed`,
        body: [
          event.error,
          event.agentId === undefined ? undefined : `Agent ${event.agentId}.`,
          event.runId === undefined
            ? undefined
            : `Run ${event.runId} (jazz runs show ${event.runId}).`,
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n"),
      };
    case "spend-cap":
      return {
        title: `Jazz stopped a ${named(event.source, event.name)}: spend cap`,
        body: event.message,
      };
  }
}
