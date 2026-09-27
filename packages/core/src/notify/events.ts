/**
 * @fileoverview What the notify channel tells you, and how each event reads as a message.
 *
 * An event is data; {@link renderNotification} turns it into the title and body every channel
 * sends (a chat message is the two joined, a desktop toast shows them apart, a webhook gets
 * the event itself plus the rendered text).
 */

import { z } from "zod";
import { SPEND_SOURCE_LABELS, SPEND_SOURCES, type SpendSource } from "@/core/spend/sources";

export type ParkedInputKind = "tool-approval" | "question" | "file-picker";

export type NotifyEvent =
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
      readonly kind: "approval-needed";
      readonly runId: string;
      readonly agentId: string;
      readonly source: SpendSource;
      readonly name?: string;
      /** A tool approval can be answered with approve or deny; a question needs words. */
      readonly pending: ParkedInputKind;
      /** What the run is waiting for, in the words its request used. */
      readonly request: string;
      /** ISO time after which the parked run is abandoned. */
      readonly expiresAt: string;
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
      readonly kind: "spend-ceiling";
      readonly source: SpendSource;
      readonly agentId: string;
      readonly name?: string;
      readonly message: string;
    };

const sourceSchema = z.enum(SPEND_SOURCES);

export const NotifyEventSchema: z.ZodType<NotifyEvent> = z.discriminatedUnion("kind", [
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
    kind: z.literal("approval-needed"),
    runId: z.string(),
    agentId: z.string(),
    source: sourceSchema,
    name: z.string().exactOptional(),
    pending: z.enum(["tool-approval", "question", "file-picker"]),
    request: z.string(),
    expiresAt: z.string(),
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
    kind: z.literal("spend-ceiling"),
    source: sourceSchema,
    agentId: z.string(),
    name: z.string().exactOptional(),
    message: z.string(),
  }),
]);

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
}

export interface RenderOptions {
  /** The channel is a chat a Jazz bridge serves, so `/approve <runId>` works there. */
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
    case "workflow-result":
      return { title: `Jazz: ${event.workflow}`, body: event.answer };
    case "reminder":
      return { title: "Jazz reminder", body: event.text };
    case "approval-needed": {
      const how =
        event.pending !== "tool-approval"
          ? `Answer with \`jazz runs answer ${event.runId} --response "..."\`.`
          : options.approveFromChat === true
            ? `Reply /approve ${event.runId} or /deny ${event.runId}.`
            : `Run \`jazz runs approve ${event.runId}\` or \`jazz runs reject ${event.runId}\`.`;
      return {
        title: `Jazz ${event.pending === "tool-approval" ? "needs your approval" : "has a question"} (${named(event.source, event.name)})`,
        body: `${event.request}\n\nRun ${event.runId}, agent ${event.agentId}. It waits until ${event.expiresAt}. ${how}`,
      };
    }
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
    case "spend-ceiling":
      return {
        title: `Jazz stopped a ${named(event.source, event.name)}: spend ceiling`,
        body: event.message,
      };
  }
}
