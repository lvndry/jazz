/**
 * Validates persisted conversation presentation at the storage boundary. Only
 * renderer-independent facts are accepted: strict objects reject callbacks,
 * prompt drafts, geometry, and unknown fields instead of silently saving them.
 * Live producers use the TypeScript contract; readers and writers use these
 * schemas before trusting JSON or external history.
 */
import { z } from "zod";
import type { PresentationContent, PresentationEntry } from "./presentation-content";

const nonnegative = z.number().finite().nonnegative();
type Defined<T> = T extends readonly (infer Item)[]
  ? readonly Defined<Item>[]
  : T extends object
    ? { [Key in keyof T as undefined extends T[Key] ? never : Key]: Defined<T[Key]> } & {
        [Key in keyof T as undefined extends T[Key] ? Key : never]?: Defined<
          Exclude<T[Key], undefined>
        >;
      }
    : T;

/** Zod optional properties allow explicit undefined; durable facts omit those keys. */
function defined<T>(value: T): Defined<T> {
  if (Array.isArray(value)) return value.map((item: unknown) => defined(item)) as Defined<T>;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, defined(item)]),
    ) as Defined<T>;
  }
  return value as Defined<T>;
}
const tone = z.enum(["text", "muted", "accent", "success", "warning", "error"]);
const reportRow = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("field"),
    key: z.string(),
    value: z.string(),
    tone: tone.optional(),
    detail: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("item"),
    name: z.string(),
    detail: z.string().optional(),
    marker: z.enum(["current", "active", "inactive", "attention", "disabled"]).optional(),
    tone: tone.optional(),
  }),
  z.strictObject({
    kind: z.literal("meter"),
    used: nonnegative,
    total: nonnegative,
    caption: z.string(),
  }),
  z.strictObject({ kind: z.literal("text"), text: z.string(), tone: tone.optional() }),
  z.strictObject({ kind: z.literal("group"), label: z.string(), count: z.string().optional() }),
  z.strictObject({ kind: z.literal("gap") }),
]);

export const presentationContentSchema: z.ZodType<PresentationContent> = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), text: z.string() }),
    z.strictObject({ kind: z.literal("agent"), markdown: z.string() }),
    z.strictObject({
      kind: z.literal("reasoning"),
      text: z.string(),
      label: z.string(),
      durationMs: nonnegative.optional(),
      steps: nonnegative.int().optional(),
      tokens: nonnegative.int().optional(),
    }),
    z.strictObject({
      kind: z.literal("tool"),
      receipt: z.strictObject({
        app: z.string(),
        summary: z.string(),
        status: z.enum(["ok", "failed", "denied"]),
        args: z.string().optional(),
        durationMs: nonnegative.optional(),
        reason: z.string().optional(),
        notDone: z.string().optional(),
        remedyKey: z.string().optional(),
        detail: z.string().optional(),
        outputPreview: z.string().optional(),
        classifiedRisk: z.string().optional(),
        diffPreview: z
          .strictObject({ lines: z.array(z.string()), hiddenLines: nonnegative.int() })
          .optional(),
        diffText: z.string().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal("notice"),
      text: z.string(),
      tone: z.enum(["info", "success", "warn", "error", "debug", "log"]),
      audience: z.literal("classic").optional(),
    }),
    z.strictObject({
      kind: z.literal("report"),
      report: z.strictObject({
        _tag: z.literal("report"),
        label: z.string(),
        rows: z.array(reportRow),
        note: z.string().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal("header"),
      name: z.string(),
      provider: z.string().optional(),
      model: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal("turn-receipt"),
      steps: z.array(
        z.strictObject({
          durationMs: nonnegative,
          generationDurationMs: nonnegative.optional(),
          promptTokens: nonnegative.int().optional(),
          completionTokens: nonnegative.int().optional(),
          totalTokens: nonnegative.int().optional(),
          cacheReadTokens: nonnegative.int().optional(),
          costUSD: nonnegative.optional(),
          tokensPerSecond: nonnegative.optional(),
        }),
      ),
    }),
    z.strictObject({
      kind: z.literal("stopped"),
      summary: z.strictObject({
        elapsedMs: nonnegative,
        done: z.array(z.string()),
        notDone: z.array(z.string()),
      }),
    }),
    z.strictObject({ kind: z.literal("expanded"), text: z.string() }),
  ])
  .transform(defined);

export const presentationEntrySchema: z.ZodType<PresentationEntry> = z.strictObject({
  id: z.string().min(1),
  content: presentationContentSchema,
  timestamp: z.iso.datetime({ offset: true }),
});
