/**
 * The chat-facing tools. Each turns a list of items into Jev requests with one question per item,
 * so judging 50 emails or 30 receipts costs a few calls at most:
 *
 * - `classify` puts every item into one of the given labels, or "none of these" (a Jev choice
 *   question per item).
 * - `rank` places every item on an ordered scale and returns them best first (a Jev score
 *   question per item).
 *
 * An item is text, a text file, an image path (PNG or JPEG), or text plus an image; `files` adds
 * one item per matched path, so the agent never has to copy file contents into the call. Each
 * item travels inside its own question, so Jev reads one item at a time against a small shared
 * state holding only the caller's context. Items are split across requests that fit Jev's input
 * limits, sent in parallel.
 */

import { randomUUID } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
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
  JEV_MAX_INPUT_TOKENS,
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
/** Added to every label set, so an item that fits no label is not forced into the closest one. */
export const NONE_LABEL = "none of these";
const NONE_LABEL_DESCRIPTION = "The item fits none of the other labels.";
/** Below this, Jev rates the label it chose as more likely wrong than right. */
export const UNCERTAIN_BELOW_PROBABILITY = 0.5;
/**
 * The most items one call takes. At the per-file cap, 200 items split into about 10 parallel
 * requests, which still finish inside the host's 30s tool deadline; a broader glob is a mistake.
 */
export const MAX_ITEMS = 200;
/**
 * Text read from one file, about 2,000 tokens: enough to judge an email or a listing from its
 * opening, and small enough that about 20 items share one request.
 */
export const MAX_ITEM_FILE_CHARS = 8_000;
/** The usual English rate; TypeSafe does not publish Jev's tokenizer, so batches leave headroom. */
const CHARS_PER_TOKEN_ESTIMATE = 4;
/** Share of Jev's per-request input limit a batch may use, covering error in the estimate above. */
const REQUEST_TOKEN_BUDGET = Math.floor(JEV_MAX_INPUT_TOKENS * 0.75);
/** TypeSafe's limit on all images in one request. */
const MAX_REQUEST_IMAGE_BYTES = 32 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

interface ToolContext {
  readonly signal: AbortSignal;
  readonly cwd: string;
}

interface ItemSpec {
  /** What results call the item: the caller's id, the file path, or the 1-based position. */
  readonly id: string | number;
  readonly text?: string;
  readonly textFile?: string;
  readonly imagePath?: string;
}

interface Item {
  readonly id: string | number;
  readonly text?: string;
  readonly truncated: boolean;
  readonly image?: ItemImage;
}

interface ItemImage {
  readonly part: Experimental_DecisionStatePart;
  readonly bytes: number;
  /** The token a question names to have TypeSafe send this image with it. */
  readonly reference: string;
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

function parseItemEntries(raw: unknown): ItemSpec[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ToolInputError("items must be an array");
  }
  return raw.map((entry, index) => {
    const position = index + 1;
    if (typeof entry === "string") {
      if (!nonEmptyString(entry)) {
        throw new ToolInputError(`items[${index}] is empty`);
      }
      return { id: position, text: entry };
    }
    if (!isRecord(entry)) {
      throw new ToolInputError(`items[${index}] must be text or an object`);
    }
    const { id, text, file, image } = entry;
    if (id !== undefined && !nonEmptyString(id)) {
      throw new ToolInputError(`items[${index}].id must be non-empty text`);
    }
    if (nonEmptyString(text) && nonEmptyString(file)) {
      throw new ToolInputError(`items[${index}] has both text and file; give one`);
    }
    if (!nonEmptyString(text) && !nonEmptyString(file) && !nonEmptyString(image)) {
      throw new ToolInputError(
        `items[${index}] needs text, a file, an image, or text and an image`,
      );
    }
    return {
      id: id ?? (nonEmptyString(file) ? file : position),
      ...(nonEmptyString(text) ? { text } : {}),
      ...(nonEmptyString(file) ? { textFile: file } : {}),
      ...(nonEmptyString(image) ? { imagePath: image } : {}),
    };
  });
}

/** One item per file matched by `files`, in sorted order, each named by its path. */
async function expandFiles(raw: unknown, cwd: string): Promise<ItemSpec[]> {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || !raw.every(nonEmptyString)) {
    throw new ToolInputError("files must be a list of paths or glob patterns");
  }
  const matched = new Set<string>();
  for (const pattern of raw) {
    let matchedPattern = false;
    for await (const path of glob(pattern, { cwd })) {
      matchedPattern = true;
      matched.add(path);
      if (matched.size > MAX_ITEMS) {
        throw new ToolInputError(
          `files matches more than ${MAX_ITEMS} files; narrow the patterns or split the call`,
        );
      }
    }
    if (!matchedPattern) {
      throw new ToolInputError(`files pattern ${pattern} matches no file`);
    }
  }
  return [...matched]
    .sort()
    .map((path) =>
      imageExtension(path) ? { id: path, imagePath: path } : { id: path, textFile: path },
    );
}

function imageExtension(path: string): boolean {
  return /\.(png|jpe?g)$/i.test(path);
}

async function parseItems(args: Record<string, unknown>, cwd: string): Promise<ItemSpec[]> {
  const specs = [...parseItemEntries(args["items"]), ...(await expandFiles(args["files"], cwd))];
  if (specs.length === 0) {
    throw new ToolInputError("give items, files, or both");
  }
  if (specs.length > MAX_ITEMS) {
    throw new ToolInputError(
      `${specs.length} items given; split the call into ${MAX_ITEMS} or fewer`,
    );
  }
  const seen = new Set<string | number>();
  for (const spec of specs) {
    if (seen.has(spec.id)) {
      throw new ToolInputError(`item id ${spec.id} appears twice`);
    }
    seen.add(spec.id);
  }
  return specs;
}

async function readTextFile(
  path: string,
  cwd: string,
): Promise<{ text: string; truncated: boolean }> {
  let content: string;
  try {
    content = await readFile(resolve(cwd, path), "utf8");
  } catch (error) {
    throw new ToolInputError(
      `could not read file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (content.includes("\u0000")) {
    throw new ToolInputError(`file ${path} is not a text file`);
  }
  if (content.trim().length === 0) {
    throw new ToolInputError(`file ${path} is empty`);
  }
  return content.length > MAX_ITEM_FILE_CHARS
    ? { text: content.slice(0, MAX_ITEM_FILE_CHARS), truncated: true }
    : { text: content, truncated: false };
}

async function readImage(path: string, cwd: string): Promise<ItemImage> {
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
  // A random reference never collides with item text; with insertReference off, TypeSafe sends
  // the image only with the question that names it.
  const reference = `[image-${randomUUID()}]`;
  return {
    part: {
      type: "file",
      data: bytes,
      mediaType,
      providerOptions: { typesafe: { reference, insertReference: false } },
    } as Experimental_DecisionStatePart,
    bytes: bytes.byteLength,
    reference,
  };
}

async function loadItems(specs: readonly ItemSpec[], cwd: string): Promise<Item[]> {
  return Promise.all(
    specs.map(async (spec) => {
      const file = spec.textFile === undefined ? undefined : await readTextFile(spec.textFile, cwd);
      const text = file?.text ?? spec.text;
      return {
        id: spec.id,
        ...(text === undefined ? {} : { text }),
        truncated: file?.truncated ?? false,
        ...(spec.imagePath === undefined ? {} : { image: await readImage(spec.imagePath, cwd) }),
      };
    }),
  );
}

/** What one question shows Jev about its item: the text, the image reference, or both. */
function itemForQuestion(item: Item): Record<string, string> {
  return {
    ...(item.text === undefined ? {} : { text: item.text }),
    ...(item.image === undefined ? {} : { image: item.image.reference }),
  };
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Split items into requests that fit Jev's limits. Every question is sent with the shared state,
 * so the state counts once per request and each question adds its own size.
 */
function batchItems(
  items: readonly Item[],
  stateTokens: number,
  questionTokens: (item: Item) => number,
): Item[][] {
  const batches: Item[][] = [];
  let current: Item[] = [];
  let tokens = stateTokens;
  let imageBytes = 0;
  for (const item of items) {
    const itemTokens = questionTokens(item);
    const itemImageBytes = item.image?.bytes ?? 0;
    if (
      current.length > 0 &&
      (tokens + itemTokens > REQUEST_TOKEN_BUDGET ||
        imageBytes + itemImageBytes > MAX_REQUEST_IMAGE_BYTES)
    ) {
      batches.push(current);
      current = [];
      tokens = stateTokens;
      imageBytes = 0;
    }
    current.push(item);
    tokens += itemTokens;
    imageBytes += itemImageBytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function sharedState(context: string | undefined, task: string): Record<string, string> {
  return { task, ...(context === undefined ? {} : { context }) };
}

function requestState(
  state: Record<string, string>,
  items: readonly Item[],
): Experimental_DecisionState {
  const images = items.flatMap((item) => (item.image === undefined ? [] : [item.image.part]));
  return images.length === 0 ? state : [{ type: "json", value: state }, ...images];
}

function questionKey(index: number): string {
  return `item_${index + 1}`;
}

/** Ask Jev each batch's questions in parallel and merge the answers, keyed by item index. */
async function askInBatches(
  api: PluginHostApi,
  items: readonly Item[],
  state: Record<string, string>,
  question: (item: Item) => JevQuestion,
  signal: AbortSignal,
): Promise<{
  model: string;
  answers: Map<Item, JevDecision["answers"][string]>;
  confidence: Map<Item, number>;
  usage: { inputTokens: number; costUSD: number; requests: number };
}> {
  const apiKey = await api.secrets.get("apiKey");
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ToolInputError(
      "TypeSafe API key is missing. Ask the user to run: jazz plugin secret set com.jazz.plugins.jev apiKey",
    );
  }
  const stateTokens = estimateTokens(state);
  const batches = batchItems(items, stateTokens, (item) => estimateTokens(question(item)));
  const decisions = await Promise.all(
    batches.map((batch) =>
      decideWithJev({
        apiKey,
        state: requestState(state, batch),
        questions: Object.fromEntries(
          batch.map((item, index) => [questionKey(index), question(item)]),
        ),
        signal,
        maxRetries: TOOL_MAX_RETRIES,
      }).then((decision) => ({ batch, decision })),
    ),
  );
  const answers = new Map<Item, JevDecision["answers"][string]>();
  const confidence = new Map<Item, number>();
  for (const { batch, decision } of decisions) {
    batch.forEach((item, index) => {
      const answer = decision.answers[questionKey(index)];
      if (answer !== undefined) {
        answers.set(item, answer);
      }
      const itemConfidence = decision.confidence[questionKey(index)];
      if (itemConfidence !== undefined) {
        confidence.set(item, itemConfidence);
      }
    });
  }
  return {
    model: decisions[0]?.decision.model ?? "",
    answers,
    confidence,
    usage: {
      inputTokens: decisions.reduce((total, { decision }) => total + decision.inputTokens, 0),
      costUSD: decisions.reduce((total, { decision }) => total + decision.costUSD, 0),
      requests: decisions.length,
    },
  };
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

function parseLabels(raw: unknown): Record<string, string | null> {
  if (!Array.isArray(raw) || raw.length < MIN_LABELS) {
    throw new ToolInputError(`labels must list at least ${MIN_LABELS} labels`);
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
  if (!(NONE_LABEL in criteria)) {
    criteria[NONE_LABEL] = NONE_LABEL_DESCRIPTION;
  }
  if (Object.keys(criteria).length > JEV_MAX_CHOICE_OPTIONS) {
    throw new ToolInputError(
      `labels has ${raw.length} entries; Jev accepts at most ${JEV_MAX_CHOICE_OPTIONS - 1} plus "${NONE_LABEL}"`,
    );
  }
  return criteria;
}

function parseKeep(raw: unknown, criteria: Record<string, string | null>): Set<string> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(nonEmptyString)) {
    throw new ToolInputError("keep must list label names");
  }
  for (const label of raw) {
    if (!(label in criteria)) {
      throw new ToolInputError(`keep names "${label}", which is not one of the labels`);
    }
  }
  return new Set(raw);
}

function parseTop(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new ToolInputError("top must be a whole number of 1 or more");
  }
  return raw;
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

function truncationNote(item: Item): Record<string, boolean> {
  return item.truncated ? { truncated: true } : {};
}

async function classify(
  api: PluginHostApi,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PluginToolResult> {
  const criteria = parseLabels(args["labels"]);
  const keep = parseKeep(args["keep"], criteria);
  const instructions = optionalText(args["instructions"], "instructions");
  const items = await loadItems(await parseItems(args, context.cwd), context.cwd);
  const task = `Classify the item in each question.${instructions === undefined ? "" : ` ${instructions}`}`;
  const decision = await askInBatches(
    api,
    items,
    sharedState(optionalText(args["context"], "context"), task),
    (item) => ({ type: "choice", instructions: { item: itemForQuestion(item) }, criteria }),
    context.signal,
  );
  const results = items.map((item) => {
    const answer = decision.answers.get(item);
    if (answer?.type !== "choice") {
      return { id: item.id, error: "Jev returned no label for this item" };
    }
    const chosenProbability = answer.probabilities?.[answer.choice];
    const confidence = decision.confidence.get(item);
    return {
      id: item.id,
      label: answer.choice,
      ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(chosenProbability !== undefined && chosenProbability < UNCERTAIN_BELOW_PROBABILITY
        ? { uncertain: true }
        : {}),
      ...truncationNote(item),
    };
  });
  const kept =
    keep === undefined
      ? results
      : results.filter((result) => !("label" in result) || keep.has(result.label));
  const omitted: Record<string, number> = {};
  for (const result of results) {
    if ("label" in result && !kept.includes(result)) {
      omitted[result.label] = (omitted[result.label] ?? 0) + 1;
    }
  }
  return {
    content: JSON.stringify({
      model: decision.model,
      results: kept,
      ...(keep === undefined ? {} : { omitted }),
      usage: decision.usage,
    }),
  };
}

async function rank(
  api: PluginHostApi,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PluginToolResult> {
  const criterion = args["criterion"];
  if (!nonEmptyString(criterion)) {
    throw new ToolInputError("criterion must describe what makes an item better");
  }
  const levels = parseLevels(args["levels"]);
  const top = parseTop(args["top"]);
  const items = await loadItems(await parseItems(args, context.cwd), context.cwd);
  const decision = await askInBatches(
    api,
    items,
    sharedState(
      optionalText(args["context"], "context"),
      `Rate the item in each question against this criterion: ${criterion}`,
    ),
    (item) => ({ type: "score", instructions: { item: itemForQuestion(item) }, criteria: levels }),
    context.signal,
  );
  const topLevel = levels.length - 1;
  const scored = items.map((item) => {
    const answer = decision.answers.get(item);
    const confidence = decision.confidence.get(item);
    if (answer?.type !== "score") {
      return { id: item.id, error: "Jev returned no score for this item" };
    }
    return {
      id: item.id,
      score: answer.score / topLevel,
      level: levels[Math.min(topLevel, Math.max(0, Math.round(answer.score)))],
      ...(confidence === undefined ? {} : { confidence }),
      ...truncationNote(item),
    };
  });
  // Jev's score is the probability-weighted mean of the levels, so equal scores are rare; among
  // them the item Jev is more confident about goes first, then the earlier one.
  const ranking = [...scored].sort((left, right) => {
    const byScore =
      ("score" in right ? right.score : Number.NEGATIVE_INFINITY) -
      ("score" in left ? left.score : Number.NEGATIVE_INFINITY);
    if (byScore !== 0) {
      return byScore;
    }
    return (
      ("confidence" in right ? (right.confidence ?? 0) : 0) -
      ("confidence" in left ? (left.confidence ?? 0) : 0)
    );
  });
  const shown = top === undefined ? ranking : ranking.slice(0, top);
  return {
    content: JSON.stringify({
      model: decision.model,
      levels,
      ranking: shown,
      ...(shown.length < ranking.length ? { omitted: ranking.length - shown.length } : {}),
      usage: decision.usage,
    }),
  };
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
