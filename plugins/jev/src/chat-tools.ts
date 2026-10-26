/**
 * The chat-facing tools. Each takes a list of items and turns them into one Jev request with one
 * question per item, so judging 50 emails or 30 receipts costs a single call:
 *
 * - `classify` puts every item into one of the given labels (a Jev choice question per item).
 * - `rank` places every item on an ordered scale and returns them best first (a Jev score
 *   question per item).
 *
 * Items are text, an image path (PNG or JPEG), or both.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PluginHostApi, PluginToolResult } from "@jazz/plugin-sdk";
import {
  Experimental_DecisionRefusalError,
  type Experimental_DecisionState,
  type Experimental_DecisionStatePart,
} from "ai";
import {
  decideWithJev,
  JEV_MAX_CHOICE_OPTIONS,
  JEV_MAX_SCORE_LEVELS,
  type JevDecision,
  type JevQuestion,
} from "./jev-client";

export const CLASSIFY_TOOL_NAME = "classify";
export const RANK_TOOL_NAME = "rank";

/** The AI SDK default; two backoff waits (2s, then 4s) fit inside the host's 30s tool deadline. */
const TOOL_MAX_RETRIES = 2;
/** A label set needs at least two labels for a choice to carry information. */
const MIN_LABELS = 2;
/** A scale needs at least two ordered levels to place an item between them. */
const MIN_SCORE_LEVELS = 2;
/** The scale `rank` uses when the caller does not supply one, worst to best. */
export const DEFAULT_RANK_LEVELS = [
  "poor fit",
  "weak fit",
  "partial fit",
  "good fit",
  "excellent fit",
] as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

interface ToolContext {
  readonly signal: AbortSignal;
  readonly cwd: string;
}

interface Item {
  readonly id: string;
  readonly text?: string;
  readonly imagePath?: string;
}

/** Thrown for caller mistakes, so the model gets an actionable message instead of a stack. */
class ToolInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function imageMediaType(bytes: Uint8Array): "image/png" | "image/jpeg" | undefined {
  const startsWith = (signature: readonly number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (startsWith(JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  return undefined;
}

function parseItems(raw: unknown): readonly Item[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolInputError("items must be a non-empty array");
  }
  return raw.map((entry, index) => {
    const id = `item_${index + 1}`;
    if (typeof entry === "string") {
      if (!nonEmptyString(entry)) {
        throw new ToolInputError(`items[${index}] is empty`);
      }
      return { id, text: entry };
    }
    if (!isRecord(entry)) {
      throw new ToolInputError(`items[${index}] must be text or an object with text and/or image`);
    }
    const text = entry["text"];
    const image = entry["image"];
    if (!nonEmptyString(text) && !nonEmptyString(image)) {
      throw new ToolInputError(`items[${index}] needs text, an image path, or both`);
    }
    return {
      id,
      ...(nonEmptyString(text) ? { text } : {}),
      ...(nonEmptyString(image) ? { imagePath: image } : {}),
    };
  });
}

function optionalText(raw: unknown, name: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new ToolInputError(`${name} must be text`);
  }
  return nonEmptyString(raw) ? raw : undefined;
}

async function readImage(path: string, cwd: string): Promise<Experimental_DecisionStatePart> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(resolve(cwd, path)));
  } catch (error) {
    throw new ToolInputError(
      `could not read image ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const mediaType = imageMediaType(bytes);
  if (mediaType === undefined) {
    throw new ToolInputError(`image ${path} is not a PNG or JPEG file`);
  }
  return { type: "file", data: bytes, mediaType };
}

/**
 * The shared state Jev reads: the caller's context plus every item under its id. An item's image
 * is placed where its random reference token appears in the item list, so each image is sent once
 * and sits next to the item it belongs to.
 */
async function buildState(
  items: readonly Item[],
  context: string | undefined,
  cwd: string,
): Promise<Experimental_DecisionState> {
  const images: Experimental_DecisionStatePart[] = [];
  const listedItems = await Promise.all(
    items.map(async (item) => {
      if (item.imagePath === undefined) {
        return { id: item.id, text: item.text };
      }
      const reference = `image-${randomUUID()}`;
      const image = await readImage(item.imagePath, cwd);
      images.push({
        ...image,
        providerOptions: { typesafe: { reference, insertReference: false } },
      } as Experimental_DecisionStatePart);
      return {
        id: item.id,
        ...(item.text === undefined ? {} : { text: item.text }),
        image: reference,
      };
    }),
  );
  const state = { ...(context === undefined ? {} : { context }), items: listedItems };
  return images.length === 0 ? state : [{ type: "json", value: state }, ...images];
}

function parseLabels(raw: unknown): Record<string, string | null> {
  if (!Array.isArray(raw) || raw.length < MIN_LABELS) {
    throw new ToolInputError(`labels must list at least ${MIN_LABELS} labels`);
  }
  if (raw.length > JEV_MAX_CHOICE_OPTIONS) {
    throw new ToolInputError(
      `labels has ${raw.length} entries; Jev accepts at most ${JEV_MAX_CHOICE_OPTIONS}`,
    );
  }
  const criteria: Record<string, string | null> = {};
  for (const [index, entry] of raw.entries()) {
    const name = typeof entry === "string" ? entry : isRecord(entry) ? entry["name"] : undefined;
    if (!nonEmptyString(name)) {
      throw new ToolInputError(`labels[${index}] needs a name`);
    }
    if (name in criteria) {
      throw new ToolInputError(`labels repeats "${name}"`);
    }
    const description = isRecord(entry) ? entry["description"] : undefined;
    criteria[name] = nonEmptyString(description) ? description : null;
  }
  return criteria;
}

function parseLevels(raw: unknown): readonly string[] {
  if (raw === undefined) {
    return DEFAULT_RANK_LEVELS;
  }
  if (!Array.isArray(raw) || !raw.every(nonEmptyString)) {
    throw new ToolInputError("levels must be a list of level names, worst first");
  }
  if (raw.length < MIN_SCORE_LEVELS || raw.length > JEV_MAX_SCORE_LEVELS) {
    throw new ToolInputError(
      `levels has ${raw.length} entries; Jev accepts ${MIN_SCORE_LEVELS} to ${JEV_MAX_SCORE_LEVELS}`,
    );
  }
  return raw;
}

function usageOf(decision: JevDecision): Record<string, number> {
  return { inputTokens: decision.inputTokens, costUSD: decision.costUSD };
}

async function classify(
  api: PluginHostApi,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PluginToolResult> {
  const items = parseItems(args["items"]);
  const criteria = parseLabels(args["labels"]);
  const instructions = optionalText(args["instructions"], "instructions");
  const state = await buildState(items, optionalText(args["context"], "context"), context.cwd);
  const questions: Record<string, JevQuestion> = Object.fromEntries(
    items.map((item) => [
      item.id,
      {
        type: "choice",
        instructions: `Classify ${item.id}.${instructions === undefined ? "" : ` ${instructions}`}`,
        criteria,
      },
    ]),
  );
  const decision = await askJev(api, state, questions, context.signal);
  const results = items.map((item, index) => {
    const answer = decision.answers[item.id];
    if (answer?.type !== "choice") {
      return { item: index + 1, error: "Jev returned no label for this item" };
    }
    return {
      item: index + 1,
      label: answer.choice,
      ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
      ...(decision.confidence[item.id] === undefined
        ? {}
        : { confidence: decision.confidence[item.id] }),
    };
  });
  return { content: JSON.stringify({ model: decision.model, results, usage: usageOf(decision) }) };
}

async function rank(
  api: PluginHostApi,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PluginToolResult> {
  const items = parseItems(args["items"]);
  const criterion = args["criterion"];
  if (!nonEmptyString(criterion)) {
    throw new ToolInputError("criterion must describe what makes an item better");
  }
  const levels = parseLevels(args["levels"]);
  const state = await buildState(items, optionalText(args["context"], "context"), context.cwd);
  const questions: Record<string, JevQuestion> = Object.fromEntries(
    items.map((item) => [
      item.id,
      {
        type: "score",
        instructions: `Rate ${item.id} against this criterion: ${criterion}`,
        criteria: levels,
      },
    ]),
  );
  const decision = await askJev(api, state, questions, context.signal);
  const topLevel = levels.length - 1;
  const scored = items.map((item, index) => {
    const answer = decision.answers[item.id];
    if (answer?.type !== "score") {
      return { item: index + 1, score: undefined, error: "Jev returned no score for this item" };
    }
    return {
      item: index + 1,
      score: answer.score / topLevel,
      level: levels[Math.min(topLevel, Math.max(0, Math.round(answer.score)))],
      ...(decision.confidence[item.id] === undefined
        ? {}
        : { confidence: decision.confidence[item.id] }),
    };
  });
  const ranking = [...scored].sort(
    (left, right) =>
      (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY),
  );
  return {
    content: JSON.stringify({ model: decision.model, levels, ranking, usage: usageOf(decision) }),
  };
}

async function askJev(
  api: PluginHostApi,
  state: Experimental_DecisionState,
  questions: Readonly<Record<string, JevQuestion>>,
  signal: AbortSignal,
): Promise<JevDecision> {
  const apiKey = await api.secrets.get("apiKey");
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ToolInputError(
      "TypeSafe API key is missing. Ask the user to run: jazz plugin secret set com.jazz.plugins.jev apiKey",
    );
  }
  return decideWithJev({ apiKey, state, questions, signal, maxRetries: TOOL_MAX_RETRIES });
}

/** Turns caller mistakes, refusals, and API failures into a tool error the model can act on. */
function asToolResult(
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<PluginToolResult>,
): (args: Record<string, unknown>, context: ToolContext) => Promise<PluginToolResult> {
  return async (args, context) => {
    try {
      return await run(args, context);
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      if (error instanceof ToolInputError) {
        return { isError: true, content: error.message };
      }
      if (Experimental_DecisionRefusalError.isInstance(error)) {
        return {
          isError: true,
          content: `Jev declined to judge some items: ${error.message}. Judge those items yourself.`,
        };
      }
      return {
        isError: true,
        content: `Jev request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export function registerChatTools(api: PluginHostApi): void {
  api.tools.register({
    name: CLASSIFY_TOOL_NAME,
    handler: asToolResult((args, context) => classify(api, args, context)),
  });
  api.tools.register({
    name: RANK_TOOL_NAME,
    handler: asToolResult((args, context) => rank(api, args, context)),
  });
}
