/** @jsxImportSource @opentui/react */
/**
 * Drives the fullscreen interface from the live UI store.
 *
 * The store is a process singleton write port. Both this tree and the Ink
 * islands subscribe to the same Object.is-stable slices via
 * useSyncExternalStore. This module is the only place where live state becomes
 * a `ViewModel`, which is what keeps every region a pure function of data.
 *
 * The mapping is deliberately lossy in one direction. The store speaks in
 * output entries and activity phases, which are a log; the interface speaks in
 * blocks, which are a document. Turning the first into the second is what makes
 * scroll anchoring, collapse and copy-out possible at all.
 */

import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stripAnsiCodes } from "@/cli/utils/string-utils";
import type { Suggestion } from "@/core/interfaces/presentation";
import { extractCommandApprovalKey } from "@/core/utils/shell";
import { isFileMutationTool } from "@/core/utils/tool-formatter";
import { filterCommandsByPrefix, slashCommandQuery } from "@/services/chat/commands";
import { search, type SearchHit } from "@/services/history/conversation-search";
import packageJson from "../../../../package.json";
import type { ActivityState } from "../activity-state";
import { applyAtMention, type AtMentionSpan } from "../at-mention";
import {
  type FilePickerEntry,
  resolveFilePickerPath,
  scanFilePickerEntries,
} from "../file-picker-files";
import { pickerItemMatches, wrapIndex } from "../picker-window";
import { composeRecalledBuffer, isCursorOnFirstLine, isCursorOnLastLine } from "../queue-recall";
import {
  store,
  useEphemeralSlice,
  useOutputSlice,
  usePromptSlice,
  useSessionSlice,
  type EphemeralRegion,
  type PendingApproval,
} from "../store";
import { mergeSuggestions } from "../suggestion-menu";
import type { Choice, OutputEntry, PromptState } from "../types";
import { useFileMentions, type FileMentionItem } from "../use-file-mentions";
import { App, type KeyChord } from "./App";
import { flattenPaste, normalizePaste, readClipboard } from "./clipboard";
import {
  commit,
  composerFromText,
  deleteBackward,
  deleteForward,
  deleteRange,
  EMPTY_COMPOSER,
  EMPTY_HISTORY,
  insertText,
  moveCaret,
  redo,
  selectAll,
  type ComposerHistory,
  undo,
} from "./composer-edit";
import { wrapCommandIndex } from "./Input";
import {
  isComposerNewline,
  isCtrlLetter,
  isInterruptChord,
  isPrintableSequence,
  isRedoChord,
  isSelectAllChord,
  isUndoChord,
  type KeyAction,
} from "./keymap";
import type { FilePickerModel } from "./overlays/FilePicker";
import type { QuestionChoice, QuestionModel } from "./overlays/Question";
import type { TextPromptModel } from "./overlays/TextPrompt";
import { AgentPicker } from "./screens/AgentPicker";
import { Home } from "./screens/Home";
import { pathFromFileArgsPreview, sourceLanguageFromPath } from "./syntax-spans";
import {
  LIVE_ZONE_MAX_ROWS,
  type ApprovalOverlay,
  type Block,
  type FooterModel,
  type HeaderModel,
  type InputModel,
  type LiveModel,
  type LiveTool,
  type Overlay,
  type StepLine,
  type ViewModel,
} from "./types";

/** Waiting copy, house voice: idiomatic, never jokey. */
const WAITING = ["comping behind you", "turning it over", "two horns out", "digging the crates"];

/** Footer and live elapsed digits update once a second, not on the indicator. */
const FOOTER_ELAPSED_MS = 1000;
const WAITING_ROTATE_MS = 4_000;

/** How long the band holds its height after the last tool finishes. */
const SETTLE_MS = 800;
export const APPROVAL_ARM_MS = 250;

/** Discard keystrokes already sitting on stdin before the card can see them. */
export function flushPendingTerminalKeys(stdin: NodeJS.ReadStream = process.stdin): void {
  if (stdin.readable !== true || typeof stdin.read !== "function") return;
  while (stdin.read() !== null) {
    // Buffered Enter / always-allow must not land on a card that just appeared.
  }
}

interface PromptEditorState {
  readonly value: string;
  readonly caret: number;
  readonly error?: string;
}

interface PromptQuestionState {
  readonly selected: number;
  readonly checked: readonly number[];
  readonly custom: PromptEditorState;
  readonly filter: string;
}

interface PromptFileState {
  readonly filter: string;
  readonly selected: number;
  readonly entries: readonly FilePickerEntry[];
  readonly scanning: boolean;
  readonly error?: string;
}

interface PromptControlsState {
  readonly editor: PromptEditorState;
  readonly question: PromptQuestionState;
  readonly file: PromptFileState;
}

const EMPTY_EDITOR: PromptEditorState = { value: "", caret: 0 };
const EMPTY_QUESTION: PromptQuestionState = {
  selected: 0,
  checked: [],
  custom: EMPTY_EDITOR,
  filter: "",
};
const EMPTY_FILE: PromptFileState = {
  filter: "",
  selected: 0,
  entries: [],
  scanning: false,
};

const EMPTY_PROMPT_CONTROLS: PromptControlsState = {
  editor: EMPTY_EDITOR,
  question: EMPTY_QUESTION,
  file: EMPTY_FILE,
};

function useSynchronizedState<State>(
  initialState: State,
): readonly [State, React.MutableRefObject<State>, (update: React.SetStateAction<State>) => void] {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(initialState);
  const updateState = useCallback((update: React.SetStateAction<State>): void => {
    const nextState =
      typeof update === "function"
        ? (update as (current: State) => State)(stateRef.current)
        : update;
    stateRef.current = nextState;
    setState(nextState);
  }, []);
  return [state, stateRef, updateState];
}

function promptChoices(prompt: PromptState): readonly Choice[] {
  return prompt.options?.choices ?? [];
}

function firstEnabledChoice(choices: readonly { readonly disabled?: boolean }[]): number {
  const index = choices.findIndex((choice) => choice.disabled !== true);
  return index < 0 ? 0 : index;
}

function choiceMatchesFilter(choice: Choice, filter: string): boolean {
  return pickerItemMatches(choice, filter);
}

function promptIsFilterable(prompt: PromptState): boolean {
  return prompt.type === "search" || prompt.type === "select";
}

function matchingChoiceIndices(choices: readonly Choice[], filter: string): number[] {
  return choices.flatMap((choice, index) => (choiceMatchesFilter(choice, filter) ? [index] : []));
}

function choicesAtIndices(choices: readonly Choice[], indices: readonly number[]): Choice[] {
  return indices.flatMap((index) => {
    const choice = choices[index];
    return choice === undefined ? [] : [choice];
  });
}

function isSuggestion(value: unknown): value is Suggestion {
  if (value === null || typeof value !== "object") return false;
  const suggestion = value as Record<string, unknown>;
  return (
    typeof suggestion["value"] === "string" &&
    (suggestion["label"] === undefined || typeof suggestion["label"] === "string") &&
    (suggestion["description"] === undefined || typeof suggestion["description"] === "string")
  );
}

function promptSuggestions(prompt: PromptState): readonly Suggestion[] {
  if (prompt.type !== "questionnaire") return [];
  const suggestions = prompt.options?.["suggestions"];
  if (!Array.isArray(suggestions)) return [];
  const candidates: readonly unknown[] = suggestions;
  return candidates.filter(isSuggestion);
}

function choicesForQuestion(
  prompt: PromptState,
  suggestions: readonly Suggestion[],
): readonly Choice[] {
  if (prompt.type === "confirm") {
    return [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ];
  }
  if (prompt.type === "questionnaire") {
    return suggestions.map((suggestion) => ({
      label: suggestion.label ?? suggestion.value,
      value: suggestion.value,
      ...(suggestion.description === undefined ? {} : { description: suggestion.description }),
    }));
  }
  return promptChoices(prompt);
}

function allowsCustomAnswer(prompt: PromptState, suggestions: readonly Suggestion[]): boolean {
  return (
    prompt.type === "questionnaire" &&
    (prompt.options?.["allowCustom"] !== false || suggestions.length === 0)
  );
}

function allowsMultipleAnswers(prompt: PromptState): boolean {
  return (
    prompt.type === "checkbox" ||
    (prompt.type === "questionnaire" && prompt.options?.["allowMultiple"] === true)
  );
}

function insertTextAt(
  value: string,
  caret: number,
  text: string,
): { readonly value: string; readonly caret: number } {
  const characters = [...value];
  const at = Math.max(0, Math.min(caret, characters.length));
  return {
    value: [...characters.slice(0, at), text, ...characters.slice(at)].join(""),
    caret: at + [...text].length,
  };
}

function filePickerBasePath(prompt: PromptState): string {
  const basePath = prompt.options?.["basePath"];
  return typeof basePath === "string" ? basePath : process.cwd();
}

function filePickerExtensions(prompt: PromptState): readonly string[] | undefined {
  const extensions = prompt.options?.["extensions"];
  if (!Array.isArray(extensions)) return undefined;
  return extensions.filter((value): value is string => typeof value === "string");
}

function initialPromptControls(prompt: PromptState | null): PromptControlsState {
  if (prompt === null || prompt.type === "chat" || prompt.type === "hidden") {
    return EMPTY_PROMPT_CONTROLS;
  }
  if (prompt.type === "text" || prompt.type === "password") {
    const defaultValue = prompt.options?.["defaultValue"];
    const value = prompt.type === "text" && typeof defaultValue === "string" ? defaultValue : "";
    return {
      ...EMPTY_PROMPT_CONTROLS,
      editor: { value, caret: [...value].length },
    };
  }
  if (prompt.type === "filepicker") {
    return {
      ...EMPTY_PROMPT_CONTROLS,
      file: { ...EMPTY_FILE, scanning: true },
    };
  }

  const choices = promptChoices(prompt);
  let selected = firstEnabledChoice(choices);
  if (prompt.type === "confirm") {
    selected = prompt.options?.["defaultValue"] === true ? 0 : 1;
  } else if (prompt.type === "select" && prompt.options?.defaultSelected !== undefined) {
    const defaultIndex = choices.findIndex(
      (choice) =>
        Object.is(choice.value, prompt.options?.defaultSelected) && choice.disabled !== true,
    );
    if (defaultIndex >= 0) selected = defaultIndex;
  }

  const defaults = Array.isArray(prompt.options?.defaultSelected)
    ? prompt.options.defaultSelected
    : [];
  const checked = choices.flatMap((choice, index) =>
    defaults.some((value) => Object.is(value, choice.value)) && choice.disabled !== true
      ? [index]
      : [],
  );
  return {
    ...EMPTY_PROMPT_CONTROLS,
    question: { ...EMPTY_QUESTION, selected, checked },
  };
}

function editorCaretForKey(state: PromptEditorState, name: string): number {
  switch (name) {
    case "home":
      return 0;
    case "end":
      return [...state.value].length;
    case "left":
      return Math.max(0, state.caret - 1);
    default:
      return Math.min([...state.value].length, state.caret + 1);
  }
}

function selectedAnswerIndices(
  checked: readonly number[],
  selectedIndex: number | undefined,
): number[] {
  if (checked.length > 0) return [...checked].sort((left, right) => left - right);
  return selectedIndex === undefined ? [] : [selectedIndex];
}

function moveChoice(
  choices: readonly { readonly disabled?: boolean }[],
  selected: number,
  delta: -1 | 1,
  allowCustom: boolean,
): number {
  const total = choices.length + (allowCustom ? 1 : 0);
  if (total <= 0) return 0;
  let next = selected;
  for (let step = 0; step < total; step += 1) {
    next = wrapIndex(next + delta, total);
    if (next === choices.length || choices[next]?.disabled !== true) return next;
  }
  return selected;
}

function choiceModel(
  choices: readonly {
    readonly label: string;
    readonly description?: string;
    readonly disabled?: boolean;
  }[],
  originalIndices?: readonly number[],
): QuestionChoice[] {
  return choices.map((choice, index) => ({
    label: choice.label,
    value: `choice-${String(originalIndices?.[index] ?? index)}`,
    ...(choice.description === undefined ? {} : { description: choice.description }),
    ...(choice.disabled === true ? { disabled: true } : {}),
  }));
}

function validatePrompt(prompt: PromptState, value: string): string | null {
  const candidate = prompt.options?.["validate"];
  if (typeof candidate !== "function") return null;
  const result = (candidate as (input: string) => boolean | string)(value);
  if (result === true) return null;
  return typeof result === "string" ? result : "Invalid input";
}

function overlayFromPrompt(
  prompt: PromptState | null,
  controls: PromptControlsState,
): QuestionModel | TextPromptModel | FilePickerModel | undefined {
  if (prompt === null || prompt.type === "chat") return undefined;
  const { editor, question, file } = controls;

  switch (prompt.type) {
    case "text":
    case "password":
      return {
        kind: "text",
        message: prompt.message,
        value: editor.value,
        caret: editor.caret,
        ...(prompt.type === "password" || prompt.options?.["secret"] === true
          ? { masked: true }
          : {}),
        ...(typeof prompt.options?.["placeholder"] === "string"
          ? { placeholder: prompt.options["placeholder"] }
          : {}),
        ...(editor.error === undefined ? {} : { error: editor.error }),
      };
    case "hidden":
      return {
        kind: "text",
        message: prompt.message,
        value: "",
        caret: 0,
        placeholder: "Press Enter to continue",
      };
    case "filepicker": {
      return {
        kind: "filepicker",
        message: prompt.message,
        basePath: filePickerBasePath(prompt),
        entries: file.entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory,
        })),
        selected: file.selected,
        filter: file.filter,
        scanning: file.scanning,
        ...(file.error === undefined ? {} : { error: file.error }),
      };
    }
    case "confirm":
      return {
        kind: "question",
        mode: "select",
        message: prompt.message,
        choices: [
          { label: "Yes", value: "choice-0" },
          { label: "No", value: "choice-1" },
        ],
        selected: question.selected,
      };
    case "select":
    case "search":
    case "checkbox": {
      const choices = promptChoices(prompt);
      const filterable = prompt.type !== "checkbox";
      const indices = filterable
        ? matchingChoiceIndices(choices, question.filter)
        : choices.map((_choice, index) => index);
      return {
        kind: "question",
        mode: prompt.type === "checkbox" ? "checkbox" : "select",
        message: prompt.message,
        choices: choiceModel(
          indices.map((index) => choices[index] as Choice),
          indices,
        ),
        selected: question.selected,
        ...(filterable ? { filterable: true, filter: question.filter } : {}),
        ...(prompt.type === "checkbox"
          ? { checked: question.checked.map((index) => `choice-${String(index)}`) }
          : {}),
      };
    }
    case "questionnaire": {
      const suggestions = promptSuggestions(prompt);
      const allowMultiple = allowsMultipleAnswers(prompt);
      const allowCustom = allowsCustomAnswer(prompt, suggestions);
      return {
        kind: "question",
        mode: allowMultiple ? "checkbox" : "select",
        message: prompt.message,
        choices: choiceModel(choicesForQuestion(prompt, suggestions)),
        selected: question.selected,
        ...(allowMultiple
          ? { checked: question.checked.map((index) => `choice-${String(index)}`) }
          : {}),
        ...(allowCustom
          ? {
              allowCustom: true,
              customValue: question.custom.value,
              customCaret: question.custom.caret,
            }
          : {}),
      };
    }
  }
}

/**
 * Caret motion, as pure functions over code points.
 *
 * All four take and return a code-point offset, never a JS string index, so a
 * multi-byte character is a single step rather than a surrogate half.
 */

/** Start of the word before `at`: skip whitespace, then the run before it. */
function wordStartBefore(characters: readonly string[], at: number): number {
  let index = Math.max(0, Math.min(at, characters.length));
  while (index > 0 && /\s/.test(characters[index - 1] as string)) index -= 1;
  while (index > 0 && !/\s/.test(characters[index - 1] as string)) index -= 1;
  return index;
}

/** End of the word after `at`: skip whitespace, then the run after it. */
function wordEndAfter(characters: readonly string[], at: number): number {
  const limit = characters.length;
  let index = Math.max(0, Math.min(at, limit));
  while (index < limit && /\s/.test(characters[index] as string)) index += 1;
  while (index < limit && !/\s/.test(characters[index] as string)) index += 1;
  return index;
}

/**
 * Start of the current logical line — just past the previous newline.
 *
 * "Logical" and not "visual": the composer wraps by cell, so a visual row is an
 * artefact of the current width. Jumping to the start of a wrapped fragment
 * would move the caret somewhere that changes when the window is resized, which
 * is not what Cmd+Left means anywhere else.
 */
function lineStartBefore(characters: readonly string[], at: number): number {
  let index = Math.max(0, Math.min(at, characters.length));
  while (index > 0 && characters[index - 1] !== "\n") index -= 1;
  return index;
}

/** End of the current logical line — just before the next newline. */
function lineEndAfter(characters: readonly string[], at: number): number {
  const limit = characters.length;
  let index = Math.max(0, Math.min(at, limit));
  while (index < limit && characters[index] !== "\n") index += 1;
  return index;
}

/**
 * A completed tool call, as the activity reducer recorded it.
 *
 * The reducer also pushes a rendered ANSI string for the Ink tree. Reading the
 * structured form instead is what turns a tool call into a receipt — the app and
 * what came back, dim, with the invocation and timing behind a key — rather than
 * a generic notice carrying somebody else's layout.
 */
interface ToolReceiptMeta {
  readonly app: string;
  readonly summary: string;
  readonly status: "ok" | "failed";
  readonly args?: string;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly detail?: string;
  readonly classifiedRisk?: string;
}

function receiptOf(entry: OutputEntry): ToolReceiptMeta | null {
  const candidate = entry.meta?.["toolReceipt"];
  if (candidate === null || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record["app"] !== "string" || typeof record["summary"] !== "string") return null;
  const status = record["status"] === "failed" ? "failed" : "ok";
  return {
    app: record["app"],
    summary: record["summary"],
    status,
    ...(typeof record["args"] === "string" ? { args: record["args"] } : {}),
    ...(typeof record["durationMs"] === "number" ? { durationMs: record["durationMs"] } : {}),
    ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
    ...(typeof record["detail"] === "string" ? { detail: record["detail"] } : {}),
    ...(typeof record["classifiedRisk"] === "string"
      ? { classifiedRisk: record["classifiedRisk"] }
      : {}),
  };
}

/**
 * `OutputEntry.message` is typed `string | TerminalInkNode` — the second half
 * is an opaque wrapper (`{ _tag: "ink", node: <a React element> }`) that only
 * an Ink-based terminal knows how to render. It reaches here whenever a
 * response completes without ever streaming a chunk — a short, fast reply is
 * the common case — so it is not an edge case to shrug off.
 *
 * `String()` on that object is where "[object Object]" came from: a plain
 * object's default stringification, applied to a React element. The real fix
 * is at the source, which now attaches the same text as `meta.plainText`
 * (checked in `blocksFrom` before this function ever runs). This is the
 * defensive floor for anything that does not: never stringify an object,
 * because there is no object shape in this codebase whose default
 * `toString()` is meaningful to a reader.
 */
function textOf(message: unknown): string {
  if (typeof message === "string") return message;
  if (message !== null && typeof message === "object" && "text" in message) {
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Strips the styling another renderer already applied.
 *
 * The presentation service styles its strings with chalk before they reach the
 * store — the reasoning summary is `chalk.dim(chalk.italic(...))`, tool results
 * arrive pre-rendered, markdown comes back with colour already baked in. Those
 * escapes are instructions to a terminal, not characters, so rendering them
 * into a composited frame puts `\u001b[2m` on screen as cells and lets the
 * terminal eat the ones that follow — which is what turned "Reasoning" into
 * "easoning".
 *
 * Stripping rather than parsing is the right call here, and not just the easy
 * one: this interface decides colour from its own semantic tokens, six of them,
 * each answering one question. Inheriting another renderer's palette would
 * defeat that by construction.
 *
 * Worth knowing why this was invisible for so long: `chalk.level` is 0 under
 * `bun test`, so chalk emits no escapes and every one of these strings arrives
 * clean in a test while arriving styled in production. `bridge.test.tsx` now
 * forces truecolor for exactly that reason.
 */
function plainOf(message: unknown): string {
  return stripAnsiCodes(textOf(message));
}

/**
 * Output entries become blocks. Consecutive stream chunks are one agent turn
 * rather than one block each: the model emits prose in pieces, and a block per
 * piece would make the transcript unscrollable and the markdown unparseable.
 */
export function blocksFrom(
  entries: readonly OutputEntry[],
  streaming: string,
  regions: readonly EphemeralRegion[],
): Block[] {
  const blocks: Block[] = [];
  let seq = 0;

  for (const entry of entries) {
    const id = entry.id ?? `b${String(seq)}`;

    // A receipt is read before anything looks at the entry's text, because a
    // receipt has no text: the activity reducer puts the structured form in
    // `meta.toolReceipt` and leaves `message` as the Ink node it built for the
    // other renderer. Behind the empty-text guard below, every settled tool
    // call was therefore skipped in silence, and the transcript showed nothing
    // at all between the question and the answer.
    const receipt = receiptOf(entry);
    if (receipt !== null) {
      blocks.push({
        id,
        seq: seq++,
        kind: "tool",
        app: receipt.app,
        summary: receipt.summary,
        status: receipt.status,
        ...(receipt.args === undefined ? {} : { args: receipt.args }),
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
        ...(receipt.durationMs === undefined ? {} : { durationMs: receipt.durationMs }),
        ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
        ...(receipt.classifiedRisk === undefined ? {} : { classifiedRisk: receipt.classifiedRisk }),
      });
      continue;
    }

    if (entry.meta?.["toolStart"] === true) continue;

    if (entry.meta?.["expandedOutput"] === true) {
      const expanded = stripAnsiCodes(
        typeof entry.meta["plainText"] === "string"
          ? entry.meta["plainText"]
          : plainOf(entry.message),
      );
      if (expanded.trim().length > 0) {
        blocks.push({
          id,
          seq: seq++,
          kind: "tool",
          app: "",
          summary: "",
          status: "ok",
          expanded: true,
          detail: expanded,
        });
      }
      continue;
    }

    const plainText = entry.meta?.["plainText"];
    const text = stripAnsiCodes(typeof plainText === "string" ? plainText : plainOf(entry.message));
    if (text.trim().length === 0) continue;

    if (entry.type === "user") {
      blocks.push({ id, seq: seq++, kind: "user", text });
      continue;
    }

    // Reasoning re-emitted by Ctrl+R arrives as `streamContent` so the Ink tree
    // can stream it in. Merging it into the preceding agent block the way
    // ordinary prose is merged would graft the model's private thinking onto
    // the end of its answer with no seam between them, so `meta.kind` decides
    // which of the two this is.
    if (entry.type === "streamContent" && entry.meta?.["kind"] === "reasoning") {
      const collapsed = entry.meta["collapsed"] === true;
      const fullText = entry.meta["fullText"];
      const durationMs = entry.meta["durationMs"];
      blocks.push({
        id,
        seq: seq++,
        kind: "reasoning",
        text: collapsed
          ? ""
          : typeof fullText === "string" && fullText.length > 0
            ? fullText
            : text,
        collapsed,
        ...(typeof durationMs === "number" ? { durationMs } : {}),
      });
      continue;
    }
    if (entry.type === "streamContent") {
      const last = blocks.at(-1);
      if (last?.kind === "agent") {
        blocks[blocks.length - 1] = { ...last, markdown: `${last.markdown}${text}` };
        continue;
      }
      blocks.push({ id, seq: seq++, kind: "agent", markdown: text });
      continue;
    }

    const tone = entry.type === "error" ? "error" : entry.type === "warn" ? "warn" : "info";
    blocks.push({ id, seq: seq++, kind: "notice", text, tone });
  }

  // The turn still being written, appended live so prose streams in place.
  if (streaming.trim().length > 0) {
    blocks.push({
      id: "streaming",
      seq: seq++,
      kind: "agent",
      markdown: streaming,
      streaming: true,
    });
  }

  // Open regions last, because they are the work happening now and everything
  // above them has already settled.
  //
  // These were subscribed and then dropped: `regions` reached this component
  // and appeared only in a dependency array, so extended thinking and every
  // delegated subagent showed a spinner and nothing else for their whole
  // duration. The blocks that render them were already built.
  let lane = 0;
  for (const region of regions) {
    if (region.kind === "reasoning") {
      blocks.push({
        id: region.id,
        seq: seq++,
        kind: "reasoning",
        text: region.tail.join("\n"),
        collapsed: false,
      });
      continue;
    }
    // A lane's header is who it is and what it is doing right now, which is the
    // region's newest line. `result` stays unset while it runs: that field
    // draws the lane-closing glyph, and a lane that is still open has not
    // closed.
    blocks.push({
      id: region.id,
      seq: seq++,
      kind: "lane",
      name: region.label,
      ask: region.tail.at(-1) ?? "",
      lane: lane++,
      state: "running",
    });
  }
  return blocks;
}

// `previous` is undefined on the first block or a missing cache slot; still
// compare so sharing can no-op without a null check at every call site.
function sameBlock(previous: Block | undefined, current: Block): previous is Block {
  if (previous === undefined || previous.kind !== current.kind) return false;
  if (previous.id !== current.id || previous.seq !== current.seq) return false;
  switch (previous.kind) {
    case "user":
      return (
        current.kind === "user" && previous.text === current.text && previous.at === current.at
      );
    case "agent":
      return (
        current.kind === "agent" &&
        previous.markdown === current.markdown &&
        previous.streaming === current.streaming
      );
    case "reasoning":
      return (
        current.kind === "reasoning" &&
        previous.text === current.text &&
        previous.collapsed === current.collapsed &&
        previous.steps === current.steps &&
        previous.durationMs === current.durationMs &&
        previous.tokens === current.tokens
      );
    case "tool":
      return (
        current.kind === "tool" &&
        previous.app === current.app &&
        previous.summary === current.summary &&
        previous.args === current.args &&
        previous.status === current.status &&
        previous.reason === current.reason &&
        previous.remedyKey === current.remedyKey &&
        previous.durationMs === current.durationMs &&
        previous.detail === current.detail &&
        previous.expanded === current.expanded &&
        previous.classifiedRisk === current.classifiedRisk
      );
    case "notice":
      return (
        current.kind === "notice" &&
        previous.text === current.text &&
        previous.tone === current.tone
      );
    case "divider":
      return current.kind === "divider" && previous.label === current.label;
    case "lane":
      return (
        current.kind === "lane" &&
        previous.name === current.name &&
        previous.ask === current.ask &&
        previous.lane === current.lane &&
        previous.state === current.state &&
        previous.result === current.result &&
        previous.steps === current.steps
      );
  }
}

export function shareUnchangedBlocks(
  previous: readonly Block[],
  next: readonly Block[],
): readonly Block[] {
  if (previous.length === 0) return next;
  let changed = previous.length !== next.length;
  const shared = next.map((current, index) => {
    const cached = previous[index];
    if (sameBlock(cached, current)) return cached;
    changed = true;
    return current;
  });
  return changed ? shared : previous;
}

export interface TranscriptBlockSources {
  readonly outputs: readonly OutputEntry[];
  readonly streaming: string;
  readonly regions: readonly EphemeralRegion[];
}

export function transcriptBlocks(
  sources: TranscriptBlockSources,
  previous: readonly Block[] = [],
): readonly Block[] {
  return shareUnchangedBlocks(
    previous,
    blocksFrom(sources.outputs, sources.streaming, sources.regions),
  );
}

function liveReasoningElapsedMs(
  regions: readonly EphemeralRegion[],
  now: number,
): number | undefined {
  let startedAt: number | undefined;
  for (const region of regions) {
    if (region.kind === "reasoning") startedAt = region.startedAt;
  }
  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

function liveToolsFrom(activity: ActivityState, now: number): LiveTool[] {
  if (activity.phase !== "tool-execution") return [];
  return activity.tools.map((tool, index) => {
    const parts = tool.toolName.split(/[_.-]+/).filter((part) => part.length > 0);
    const nameRest = parts.length > 1 ? parts.slice(1).join(" ") : "";
    const args = tool.argsPreview?.trim();
    let operation = nameRest.length > 0 ? nameRest : tool.toolName;
    if (tool.classifying === true) {
      operation =
        args !== undefined && args.length > 0 ? `classifying ${args}` : "classifying risk";
    } else if (args !== undefined && args.length > 0) {
      operation = nameRest.length > 0 ? `${nameRest} ${args}` : args;
    }
    const language = isFileMutationTool(tool.toolName)
      ? (sourceLanguageFromPath(pathFromFileArgsPreview(args ?? "") ?? "") ?? "code")
      : args === undefined
        ? undefined
        : sourceLanguageFromPath(pathFromFileArgsPreview(args) ?? "");
    return {
      app: parts[0] ?? tool.toolName,
      operation,
      elapsedMs: Math.max(0, now - tool.startedAt),
      phase: index,
      ...(language === undefined ? {} : { language }),
    };
  });
}

function stepFrom(activity: ActivityState): StepLine | undefined {
  if (activity.phase !== "tool-execution" || activity.todoSnapshot === undefined) {
    return undefined;
  }
  const todos = activity.todoSnapshot.filter((todo) => todo.status !== "cancelled");
  if (todos.length === 0) return undefined;
  const activeIndex = todos.findIndex((todo) => todo.status === "in_progress");
  const pendingIndex = todos.findIndex((todo) => todo.status === "pending");
  let index = activeIndex;
  if (index < 0) index = pendingIndex;
  if (index < 0) index = todos.length - 1;
  const todo = todos[index];
  if (todo === undefined) return undefined;
  return { index: index + 1, total: todos.length, label: todo.content };
}

function compactWorkingDirectory(workingDirectory: string | null): string {
  const cwd = workingDirectory ?? process.cwd();
  const home = process.env["HOME"];
  if (home !== undefined && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/**
 * A pending approval becomes the card.
 *
 * Fields come from the arguments the tool will actually be called with, because
 * the promise the card makes is that nothing is discoverable only after
 * pressing enter. The account is whichever argument names one — that is the
 * single most important string on the screen, so it is looked for explicitly
 * rather than left to land somewhere in a list.
 */
const ACCOUNT_KEYS = ["account", "calendar", "calendarId", "from", "sender", "mailbox", "channel"];

function approvalFrom(
  pending: PendingApproval,
  armed: boolean,
  fieldOffset: number,
): ApprovalOverlay {
  const entries = Object.entries(pending.args).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const accountEntry = entries.find(([key]) => ACCOUNT_KEYS.includes(key));
  const app = pending.toolName.split(/[_.]/)[0] ?? pending.toolName;
  const command = pending.toolName === "execute_command" ? pending.args["command"] : undefined;
  const alwaysLabel =
    typeof command === "string"
      ? `always allow ${extractCommandApprovalKey(command)}`
      : `always allow ${pending.toolName}`;

  return {
    kind: "approval",
    app,
    action: pending.executeToolName.replace(/[_.]/g, " "),
    account: accountEntry === undefined ? "this machine" : String(accountEntry[1]),
    fields: entries
      .filter(([key]) => key !== accountEntry?.[0])
      .map(([label, value]) => ({
        label,
        value: typeof value === "string" ? value : JSON.stringify(value),
      })),
    consequence: pending.message,
    fieldOffset,
    alwaysLabel,
    armed,
  };
}

export function FullscreenBridge(): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const viewport = { width, height };
  const output = useOutputSlice();
  const session = useSessionSlice();
  const promptSlice = usePromptSlice();
  const ephemeral = useEphemeralSlice();
  const outputs = output.entries;
  const streaming = stripAnsiCodes(output.streaming);
  const activity = session.activity;
  const stats = session.runStats;
  const queue = promptSlice.messageQueue;
  const busy = session.chatBusy;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const isYolo = session.isYolo;
  const regions = ephemeral.regions;
  const prompt = promptSlice.prompt;
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const [promptControls, promptControlsRef, updatePromptControls] =
    useSynchronizedState<PromptControlsState>(EMPTY_PROMPT_CONTROLS);
  const promptFile = promptControls.file;
  const approval = session.approvalRequest;
  const [approvalArmed, setApprovalArmed] = useState(false);
  const [approvalFieldOffset, setApprovalFieldOffset] = useState(0);
  /**
   * The composer's text and caret as one value, updated only through pure
   * updaters.
   *
   * They were two `useState`s with the caret also mirrored into a ref, and the
   * ref only refreshes on render — so two keypresses landing before a repaint
   * both read the same stale offset and the second insert overwrote the first.
   * Fast typing dropped characters. Text and caret are a single fact and have
   * to move together.
   *
   * The caret is a code-point offset, never a JS string index, which is why
   * every splice below works on `[...text]`.
   */
  const [history, , updateHistory] = useSynchronizedState<ComposerHistory>(EMPTY_HISTORY);
  const composer = history.present;
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const draft = composer.text;
  const draftCaret = composer.caret;
  const draftAnchor = composer.anchor;

  const commitComposer = useCallback(
    (
      next: Parameters<typeof commit>[1] | ((current: typeof composer) => typeof composer),
    ): void => {
      updateHistory((current) =>
        commit(current, typeof next === "function" ? next(current.present) : next),
      );
    },
    [updateHistory],
  );

  const moveComposer = useCallback(
    (caret: number, extend = false): void => {
      updateHistory((current) => commit(current, moveCaret(current.present, caret, extend)));
    },
    [updateHistory],
  );
  const [commandIndex, commandIndexRef, setCommandIndex] = useSynchronizedState(0);
  const connectors = session.connectors;
  const currentConversation = session.currentConversation;
  const workingDirectory = session.workingDirectory;
  const [searchQuery, searchQueryRef, setSearchQuery] = useSynchronizedState<string | null>(null);
  const [searchHits, searchHitsRef, setSearchHits] = useSynchronizedState<readonly SearchHit[]>([]);
  const [searchScope, , setSearchScope] = useSynchronizedState<"conversation" | "all">("all");
  const [searchIndex, searchIndexRef, setSearchIndex] = useSynchronizedState(0);
  const menu = session.activeMenu;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const [menuIndex, menuIndexRef, setMenuIndex] = useSynchronizedState(0);
  // The index reset for a replacement menu runs a frame after the menu lands;
  // a keypress in that gap must not read the old menu's selection into the new
  // one, so the index only counts for the menu it was moved on.
  const menuIndexForRef = useRef<typeof menu>(null);
  const [elapsedMs, setElapsedMs] = useState<number | undefined>();
  const [reservedRows, setReservedRows] = useState(0);
  const runStartedAt = useRef<number | null>(null);

  // `useKeyboard` registers its callback once, so a closure over state would keep
  // reading the values from the first render — where `prompt` is null, and a null
  // prompt makes the handler return before it reads a single keystroke. Refs are
  // correct regardless of the hook's registration semantics.
  const approvalRef = useRef<PendingApproval | null>(null);
  // Armed-ness is pinned to the approval it was armed for: the disarm effect
  // for a replacement card runs a frame after the card lands, and a key-repeat
  // Enter in that gap must not inherit the old card's armed state.
  const approvalArmedForRef = useRef<PendingApproval | null>(null);

  const updatePromptEditor = useCallback(
    (update: (state: PromptEditorState) => PromptEditorState): void => {
      updatePromptControls((controls) => ({ ...controls, editor: update(controls.editor) }));
    },
    [updatePromptControls],
  );
  const updatePromptQuestion = useCallback(
    (update: (state: PromptQuestionState) => PromptQuestionState): void => {
      updatePromptControls((controls) => ({ ...controls, question: update(controls.question) }));
    },
    [updatePromptControls],
  );
  const updatePromptFile = useCallback(
    (update: (state: PromptFileState) => PromptFileState): void => {
      updatePromptControls((controls) => ({ ...controls, file: update(controls.file) }));
    },
    [updatePromptControls],
  );

  const setApprovalArmedState = useCallback((armed: boolean): void => {
    approvalArmedForRef.current = armed ? approvalRef.current : null;
    setApprovalArmed(armed);
  }, []);

  approvalRef.current = approval;

  const interrupt = useRef(session.interruptHandler);
  interrupt.current = session.interruptHandler;
  const quitArmed = useRef(false);

  useEffect(() => {
    updatePromptControls(initialPromptControls(prompt));
  }, [prompt, updatePromptControls]);

  useEffect(() => {
    if (approval !== null) flushPendingTerminalKeys();
    setApprovalArmedState(false);
    setApprovalFieldOffset(0);
  }, [approval, setApprovalArmedState]);

  useEffect(() => {
    setMenuIndex(0);
  }, [menu, setMenuIndex]);

  useEffect(() => {
    if (!busy) quitArmed.current = false;
  }, [busy]);

  useEffect(() => {
    if (session.interruptHandler === null) quitArmed.current = false;
  }, [session.interruptHandler]);

  useEffect(() => {
    if (approval === null) return;
    const timer = setTimeout(() => {
      setApprovalArmedState(true);
    }, APPROVAL_ARM_MS);
    return () => clearTimeout(timer);
  }, [approval, setApprovalArmedState]);

  useEffect(() => {
    if (prompt?.type !== "filepicker") return;
    const basePath = filePickerBasePath(prompt);
    const extensions = filePickerExtensions(prompt);
    const includeDirectories = prompt.options?.["includeDirectories"] === true;
    let cancelled = false;
    updatePromptFile((state) => {
      const { error: _error, ...rest } = state;
      return { ...rest, scanning: true };
    });
    void scanFilePickerEntries({
      basePath,
      query: promptFile.filter,
      ...(extensions === undefined ? {} : { extensions }),
      includeDirectories,
    }).then((entries) => {
      if (cancelled) return;
      updatePromptFile((state) => {
        const { error: _error, ...rest } = state;
        return { ...rest, entries, selected: 0, scanning: false };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [prompt, promptFile.filter, updatePromptFile]);

  // Reasoning is the model working with nothing yet to show, which is exactly
  // when an indicator earns its place — it was excluded here, so the loader
  // vanished the moment thinking began and only came back if a tool ran.
  const running =
    activity.phase === "tool-execution" ||
    activity.phase === "awaiting" ||
    activity.phase === "thinking";
  const runActive = busy || streaming.length > 0 || running;
  useEffect(() => {
    if (!runActive) quitArmed.current = false;
  }, [runActive]);
  useEffect(() => {
    if (!runActive) {
      runStartedAt.current = null;
      setElapsedMs(undefined);
      return;
    }
    if (runStartedAt.current === null) runStartedAt.current = Date.now();
    const update = (): void => {
      setElapsedMs(Math.max(0, Date.now() - (runStartedAt.current ?? Date.now())));
    };
    update();
    const timer = setInterval(update, FOOTER_ELAPSED_MS);
    return () => clearInterval(timer);
  }, [runActive]);

  const tools = useMemo(() => liveToolsFrom(activity, Date.now()), [activity, elapsedMs]);
  const step = useMemo(() => stepFrom(activity), [activity]);
  const waitingNow = activity.phase === "awaiting" || activity.phase === "thinking";
  const neededRows = Math.min(
    LIVE_ZONE_MAX_ROWS,
    tools.length + (waitingNow ? 1 : 0) + (step === undefined ? 0 : 1),
  );

  useEffect(() => {
    if (neededRows > 0) {
      setReservedRows((current) => Math.max(current, neededRows));
      return;
    }
    if (reservedRows === 0) return;
    const timer = setTimeout(() => setReservedRows(0), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [neededRows, reservedRows]);

  // Searching runs on every keystroke, and the backend reads files, so let the
  // typing settle first. A stale result must never overwrite a newer one, hence
  // the cancellation flag rather than just awaiting.
  useEffect(() => {
    const query = searchQuery;
    if (query === null || query.trim().length === 0) {
      setSearchHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void search(query, {
        scope: searchScope,
        limit: 40,
        ...(currentConversation === null ? {} : { current: currentConversation }),
      })
        .then((hits) => {
          if (!cancelled) {
            setSearchHits(hits);
            setSearchIndex(0);
          }
        })
        .catch(() => {
          if (!cancelled) setSearchHits([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, searchScope]);

  const commandQuery = slashCommandQuery(draft);
  useEffect(() => {
    setCommandIndex(0);
  }, [commandQuery, setCommandIndex]);

  // `@path` completions. Unlike slash commands, the candidates come off disk,
  // so they are fetched rather than filtered — the menu itself is shared.
  const { span: mention, items: mentionEntries } = useFileMentions(draft, draftCaret);
  const mentionRef = useRef<AtMentionSpan | null>(mention);
  mentionRef.current = mention;
  const mentionEntriesRef = useRef<readonly FileMentionItem[]>(mentionEntries);
  mentionEntriesRef.current = mentionEntries;

  useEffect(() => {
    setCommandIndex(0);
  }, [mention?.query, setCommandIndex]);

  const historyIndex = useRef<number | null>(null);

  const insertAtCaret = useCallback(
    (text: string) => {
      historyIndex.current = null;
      commitComposer((current) => insertText(current, text));
    },
    [commitComposer],
  );

  /**
   * Deletes the previous word, the way option+Backspace and Ctrl+Backspace do
   * in every text field on both platforms: skip the run of whitespace
   * immediately before the caret, then delete the non-whitespace run before
   * that. Operates in code points throughout.
   */
  const deleteWordBeforeCaret = useCallback(() => {
    commitComposer((current) => {
      const characters = [...current.text];
      const at = Math.max(0, Math.min(current.caret, characters.length));
      return deleteRange(current, wordStartBefore(characters, at), at);
    });
  }, [commitComposer]);

  const submit = useCallback(
    (text: string) => {
      const active = promptRef.current;
      if (active === null || text.trim().length === 0) return;
      historyIndex.current = null;
      commitComposer(EMPTY_COMPOSER);
      active.resolve(text);
    },
    [promptRef, commitComposer],
  );

  /**
   * Inserts pasted text into whichever field currently owns typing.
   *
   * Always consumes the paste so a newline inside it cannot submit, and so
   * an approval card or menu does not leak the bytes into the composer.
   */
  const applyPaste = useCallback(
    (raw: string): boolean => {
      const pasted = normalizePaste(raw);
      if (pasted.length === 0) return true;
      if (menuRef.current !== null || approvalRef.current !== null) return true;

      if (searchQueryRef.current !== null) {
        const flat = flattenPaste(pasted);
        setSearchQuery((value) => (value === null ? null : value + flat));
        return true;
      }

      const active = promptRef.current;
      if (active !== null && active.type !== "chat") {
        if (active.type === "filepicker") {
          const flat = flattenPaste(pasted);
          updatePromptFile((state) => ({
            ...state,
            filter: state.filter + flat,
            selected: 0,
          }));
          return true;
        }
        if (active.type === "text" || active.type === "password") {
          const flat = flattenPaste(pasted);
          updatePromptEditor((state) => ({
            ...state,
            ...insertTextAt(state.value, state.caret, flat),
          }));
          return true;
        }
        if (promptIsFilterable(active)) {
          const flat = flattenPaste(pasted);
          const suggestions = promptSuggestions(active);
          const sourceChoices = choicesForQuestion(active, suggestions);
          updatePromptQuestion((state) => {
            const filter = state.filter + flat;
            const choices = sourceChoices.filter((choice) => choiceMatchesFilter(choice, filter));
            return { ...state, filter, selected: firstEnabledChoice(choices) };
          });
          return true;
        }
        const suggestions = promptSuggestions(active);
        const sourceChoices = choicesForQuestion(active, suggestions);
        const visibleChoices = choicesAtIndices(
          sourceChoices,
          sourceChoices.map((_choice, index) => index),
        );
        const questionState = promptControlsRef.current.question;
        if (
          allowsCustomAnswer(active, suggestions) &&
          questionState.selected === visibleChoices.length
        ) {
          updatePromptQuestion((state) => ({
            ...state,
            custom: insertTextAt(state.custom.value, state.custom.caret, flattenPaste(pasted)),
          }));
        }
        return true;
      }

      const composerAvailable = active?.type === "chat" || (active === null && busyRef.current);
      if (composerAvailable) insertAtCaret(pasted);
      return true;
    },
    [insertAtCaret, updatePromptEditor, updatePromptFile, updatePromptQuestion],
  );

  // The approval card owns the keyboard while it is up. Enter accepts, Esc
  // rejects, `a` is the always-allow path — and typing must not reach the
  // composer underneath.
  // First refusal on every key, handed to `App`, which owns the one keyboard
  // registration in the tree. Returning true consumes the key.
  const onKey = useCallback(
    ({ name, sequence, ctrl, shift, meta, option, super: superKey, focus }: KeyChord): boolean => {
      // Ctrl+C, before anything else and regardless of state — including a
      // modal that would otherwise swallow every key it does not recognise.
      // Cmd+C and Ctrl+Shift+C are copy and must not take this path.
      //
      // The renderer is told not to exit on Ctrl+C so the agent loop can cancel
      // in-flight work instead of the process dying mid-tool-call. That makes
      // handling it here mandatory: an alternate screen you cannot leave is the
      // worst failure this interface can have, so the first press cancels if
      // there is anything to cancel and the second always quits.
      if (isInterruptChord({ name, ctrl, shift, super: superKey, sequence })) {
        if (interrupt.current !== null && quitArmed.current === false) {
          quitArmed.current = true;
          interrupt.current();
          return true;
        }
        process.kill(process.pid, "SIGINT");
        return true;
      }

      // Ctrl+V reads the host clipboard. Cmd+V / Shift+Insert arrive as a
      // bracketed paste instead and go through `onPaste` — same inserter.
      if (isCtrlLetter({ name, ctrl }, "v")) {
        void readClipboard().then((text) => {
          if (text.length > 0) applyPaste(text);
        });
        return true;
      }

      // Ctrl+R expands the most recently collapsed reasoning in the place it
      // was thought. While a panel is still streaming, pin it so collapse
      // writes the full text there instead of a one-line stub.
      if (isCtrlLetter({ name, ctrl }, "r")) {
        if (store.expandLastReasoning()) return true;
        store.printOutput({
          type: "warn",
          message: "No collapsed reasoning to expand.",
          timestamp: new Date(),
        });
        return true;
      }

      // Ctrl+O expands the last truncated tool output, which is the other half
      // of the promise the footer makes.
      if (isCtrlLetter({ name, ctrl }, "o")) {
        const payload = store.getExpandableDiff();
        if (payload === null || payload === undefined) {
          store.printOutput({
            type: "warn",
            message: "No truncated output available to expand.",
            timestamp: new Date(),
          });
        } else {
          store.printOutput({
            type: "log",
            message: payload.fullDiff,
            timestamp: new Date(),
            meta: { expandedOutput: true },
          });
        }
        return true;
      }

      // A menu is a modal question: it owns the keyboard until it is answered.
      const openMenu = menuRef.current;
      if (openMenu !== null) {
        const itemCount =
          openMenu.kind === "agents" ? openMenu.agents.length : openMenu.options.length;
        const menuSelection = menuIndexForRef.current === openMenu ? menuIndexRef.current : 0;
        if (name === "up" || name === "k") {
          menuIndexForRef.current = openMenu;
          setMenuIndex(Math.max(0, menuSelection - 1));
          return true;
        }
        if (name === "down" || name === "j") {
          menuIndexForRef.current = openMenu;
          setMenuIndex(Math.min(Math.max(0, itemCount - 1), menuSelection + 1));
          return true;
        }
        if (name === "return" || name === "enter") {
          if (openMenu.kind === "agents") {
            if (openMenu.browse === true) {
              store.completePrompt({ kind: "exit" });
            } else {
              const choice = openMenu.agents[menuSelection];
              if (choice !== undefined) store.completePrompt({ kind: "select", value: choice.id });
            }
          } else {
            const choice = openMenu.options[menuSelection];
            if (choice !== undefined) {
              store.completePrompt({ kind: "select", value: choice.value });
            }
          }
          return true;
        }
        if (name === "escape" || name === "q") {
          store.completePrompt({ kind: "exit" });
          return true;
        }
        return true;
      }
      const active = promptRef.current;

      // The approval card owns the keyboard while it is up: enter accepts, `a`
      // is the always-allow path, and typing must not reach the composer behind
      // it. Esc falls through to the ladder, which rejects.
      if (approvalRef.current !== null) {
        if (name === "escape") return false;
        if (name === "up" || name === "down" || name === "pageup" || name === "pagedown") {
          const delta = name === "up" ? -1 : name === "down" ? 1 : name === "pageup" ? -5 : 5;
          setApprovalFieldOffset((offset) => Math.max(0, offset + delta));
          return true;
        }
        if (approvalArmedForRef.current !== approvalRef.current) return true;
        if (active === null) return true;
        if (name === "return" || name === "enter") {
          active.resolve("yes");
          return true;
        }
        // Unmodified `a` only. Ctrl+A and Cmd+A are "go to start of line" in
        // the composer, and the standing allowlist this writes outlives the
        // turn — a caret keystroke must never be able to grant it.
        if (name === "a" && !ctrl && !superKey && !meta && !option) {
          const alwaysCommand = active.options?.choices?.some(
            (choice) => choice.value === "always_command",
          );
          active.resolve(alwaysCommand ? "always_command" : "always_tool");
          return true;
        }
        return true;
      }

      // Search likewise owns the keyboard while it is open.
      if (searchQueryRef.current !== null) {
        if (name === "escape") {
          setSearchQuery(null);
          return true;
        }
        if (name === "tab") {
          setSearchScope((scope) => (scope === "all" ? "conversation" : "all"));
          return true;
        }
        if (name === "return" || name === "enter") {
          const hit = searchHitsRef.current[searchIndexRef.current];
          if (hit !== undefined) {
            setSearchQuery(null);
            insertAtCaret(hit.line);
          }
          return true;
        }
        if (name === "down") {
          setSearchIndex((index) =>
            Math.min(index + 1, Math.max(0, searchHitsRef.current.length - 1)),
          );
          return true;
        }
        if (name === "up") {
          setSearchIndex((index) => Math.max(0, index - 1));
          return true;
        }
        if (name === "backspace") {
          setSearchQuery((value) => (value === null ? null : [...value].slice(0, -1).join("")));
          return true;
        }
        if (isPrintableSequence(sequence, ctrl, superKey)) {
          setSearchQuery((value) => (value ?? "") + sequence);
        }
        return true;
      }

      if (active !== null && active.type !== "chat") {
        if (name === "pageup" || name === "pagedown") return false;
        if (name === "escape") {
          if (active.reject !== undefined) {
            active.reject();
          } else if (active.type === "hidden") {
            active.resolve("");
          }
          return true;
        }

        if (active.type === "hidden") {
          if (name === "return" || name === "enter") active.resolve("");
          return true;
        }

        if (active.type === "filepicker") {
          const fileState = promptControlsRef.current.file;
          if (name === "up") {
            updatePromptFile((state) => ({
              ...state,
              selected: Math.max(0, state.selected - 1),
            }));
            return true;
          }
          if (name === "down") {
            updatePromptFile((state) => ({
              ...state,
              selected: Math.min(Math.max(0, state.entries.length - 1), state.selected + 1),
            }));
            return true;
          }
          if (name === "tab") {
            const entry = fileState.entries[fileState.selected];
            if (entry !== undefined) {
              updatePromptFile((state) => ({ ...state, filter: entry.name, selected: 0 }));
            }
            return true;
          }
          if (name === "backspace") {
            updatePromptFile((state) => ({
              ...state,
              filter: [...state.filter].slice(0, -1).join(""),
              selected: 0,
            }));
            return true;
          }
          if (name === "return" || name === "enter") {
            const selected = fileState.entries[fileState.selected];
            if (selected !== undefined) {
              active.resolve(selected.path);
              return true;
            }
            const basePath = filePickerBasePath(active);
            const submittedFilter = fileState.filter;
            void resolveFilePickerPath(basePath, submittedFilter).then((resolvedPath) => {
              if (promptRef.current !== active) return;
              if (resolvedPath !== null) {
                active.resolve(resolvedPath);
              } else {
                updatePromptFile((state) => ({
                  ...state,
                  error:
                    submittedFilter.length > 0
                      ? `No file found: ${submittedFilter}`
                      : "No file selected",
                }));
              }
            });
            return true;
          }
          if (isPrintableSequence(sequence, ctrl, superKey)) {
            updatePromptFile((state) => ({
              ...state,
              filter: state.filter + sequence,
              selected: 0,
            }));
          }
          return true;
        }

        if (active.type === "text" || active.type === "password") {
          if (name === "return" || name === "enter") {
            const value = promptControlsRef.current.editor.value;
            const error = validatePrompt(active, value);
            if (error === null) active.resolve(value);
            else updatePromptEditor((state) => ({ ...state, error }));
            return true;
          }
          if (name === "backspace") {
            updatePromptEditor((state) => {
              const characters = [...state.value];
              const at = Math.max(0, Math.min(state.caret, characters.length));
              if (at === 0) return state;
              return {
                value: [...characters.slice(0, at - 1), ...characters.slice(at)].join(""),
                caret: at - 1,
              };
            });
            return true;
          }
          if (name === "left" || name === "right" || name === "home" || name === "end") {
            updatePromptEditor((state) => ({
              value: state.value,
              caret: editorCaretForKey(state, name),
            }));
            return true;
          }
          if (isPrintableSequence(sequence, ctrl, superKey)) {
            updatePromptEditor((state) => {
              const characters = [...state.value];
              const at = Math.max(0, Math.min(state.caret, characters.length));
              return {
                value: [...characters.slice(0, at), sequence, ...characters.slice(at)].join(""),
                caret: at + [...sequence].length,
              };
            });
          }
          return true;
        }

        const questionState = promptControlsRef.current.question;
        const suggestions = promptSuggestions(active);
        const sourceChoices = choicesForQuestion(active, suggestions);
        const filteredIndices = promptIsFilterable(active)
          ? matchingChoiceIndices(sourceChoices, questionState.filter)
          : sourceChoices.map((_choice, index) => index);
        const visibleChoices = choicesAtIndices(sourceChoices, filteredIndices);
        const allowCustom = allowsCustomAnswer(active, suggestions);
        const allowMultiple = allowsMultipleAnswers(active);

        if (name === "up" || name === "down") {
          updatePromptQuestion((state) => ({
            ...state,
            selected: moveChoice(
              visibleChoices,
              state.selected,
              name === "up" ? -1 : 1,
              allowCustom,
            ),
          }));
          return true;
        }
        if (promptIsFilterable(active) && name === "backspace") {
          updatePromptQuestion((state) => {
            const filter = [...state.filter].slice(0, -1).join("");
            const choices = sourceChoices.filter((choice) => choiceMatchesFilter(choice, filter));
            return { ...state, filter, selected: firstEnabledChoice(choices) };
          });
          return true;
        }

        const selectedVisibleChoice = visibleChoices[questionState.selected];
        const selectedOriginalIndex = filteredIndices[questionState.selected];
        const selectedCustom = allowCustom && questionState.selected === visibleChoices.length;

        if (
          allowMultiple &&
          (name === "space" || sequence === " ") &&
          selectedOriginalIndex !== undefined &&
          selectedVisibleChoice?.disabled !== true
        ) {
          updatePromptQuestion((state) => ({
            ...state,
            checked: state.checked.includes(selectedOriginalIndex)
              ? state.checked.filter((index) => index !== selectedOriginalIndex)
              : [...state.checked, selectedOriginalIndex],
          }));
          return true;
        }

        if (name === "return" || name === "enter") {
          if (selectedCustom) {
            const value = questionState.custom.value.trim();
            if (value.length > 0) active.resolve(value);
            return true;
          }
          if (allowMultiple) {
            const selectedIndices = selectedAnswerIndices(
              questionState.checked,
              active.type === "questionnaire" ? selectedOriginalIndex : undefined,
            );
            const values = selectedIndices.flatMap((index) => {
              const choice = sourceChoices[index];
              return choice === undefined || choice.disabled === true ? [] : [choice.value];
            });
            active.resolve(
              active.type === "questionnaire" ? values.map(String).join(", ") : values,
            );
            return true;
          }
          if (selectedOriginalIndex !== undefined && selectedVisibleChoice?.disabled !== true) {
            active.resolve(sourceChoices[selectedOriginalIndex]?.value);
          }
          return true;
        }

        if (promptIsFilterable(active) && isPrintableSequence(sequence, ctrl, superKey)) {
          updatePromptQuestion((state) => {
            const filter = state.filter + sequence;
            const choices = sourceChoices.filter((choice) => choiceMatchesFilter(choice, filter));
            return { ...state, filter, selected: firstEnabledChoice(choices) };
          });
          return true;
        }
        if (selectedCustom) {
          if (name === "backspace") {
            updatePromptQuestion((state) => ({
              ...state,
              custom: {
                value: [...state.custom.value].slice(0, -1).join(""),
                caret: Math.max(0, state.custom.caret - 1),
              },
            }));
            return true;
          }
          if (isPrintableSequence(sequence, ctrl, superKey)) {
            updatePromptQuestion((state) => ({
              ...state,
              custom: {
                value: state.custom.value + sequence,
                caret: state.custom.caret + [...sequence].length,
              },
            }));
            return true;
          }
        }
        return true;
      }

      const composerAvailable = active?.type === "chat" || (active === null && busyRef.current);
      if (!composerAvailable) return false;
      if (
        focus === "transcript" &&
        (name === "up" ||
          name === "down" ||
          name === "pageup" ||
          name === "pagedown" ||
          name === "home" ||
          name === "end")
      ) {
        return false;
      }

      if (name === "tab" && shift) {
        store.toggleMode();
        return true;
      }
      if (isCtrlLetter({ name, ctrl }, "f")) {
        setSearchQuery("");
        return true;
      }

      const mentionSpan = mentionRef.current;
      const mentionItems = mentionEntriesRef.current;
      if (mentionSpan !== null && mentionItems.length > 0) {
        const selected = wrapCommandIndex(commandIndexRef.current, mentionItems.length);
        if (name === "up") {
          setCommandIndex(wrapCommandIndex(selected - 1, mentionItems.length));
          return true;
        }
        if (name === "down") {
          setCommandIndex(wrapCommandIndex(selected + 1, mentionItems.length));
          return true;
        }
        // Tab and Enter both accept here. A path is not a command, so there is
        // nothing to submit — accepting only edits the composer, which leaves
        // Enter free to mean "insert" while the menu is open.
        if ((name === "tab" && !shift) || name === "return" || name === "enter") {
          const entry = mentionItems[selected];
          if (entry !== undefined) {
            const applied = applyAtMention(composerRef.current.text, mentionSpan, entry.name);
            historyIndex.current = null;
            commitComposer({
              text: applied.text,
              caret: applied.caret,
              anchor: applied.caret,
            });
          }
          return true;
        }
      }

      const slashQuery = slashCommandQuery(composerRef.current.text);
      const slashCommands = slashQuery === null ? [] : filterCommandsByPrefix(slashQuery);
      if (slashCommands.length > 0) {
        const selected = wrapCommandIndex(commandIndexRef.current, slashCommands.length);
        if (name === "up") {
          setCommandIndex(wrapCommandIndex(selected - 1, slashCommands.length));
          return true;
        }
        if (name === "down") {
          setCommandIndex(wrapCommandIndex(selected + 1, slashCommands.length));
          return true;
        }
        if (name === "tab" && !shift) {
          const command = slashCommands[selected];
          if (command !== undefined) {
            const next = `/${command.name} `;
            historyIndex.current = null;
            commitComposer(composerFromText(next));
          }
          return true;
        }
        if (name === "return" || name === "enter") {
          const command = slashCommands[selected];
          if (command === undefined) return true;
          const text = `/${command.name}`;
          if (busyRef.current) {
            store.appendToQueue(text);
            commitComposer(EMPTY_COMPOSER);
            return true;
          }
          submit(text);
          return true;
        }
      }

      if (isUndoChord({ name, ctrl, shift, super: superKey })) {
        updateHistory((current) => undo(current));
        return true;
      }
      if (isRedoChord({ name, ctrl, shift, super: superKey })) {
        updateHistory((current) => redo(current));
        return true;
      }
      if (isSelectAllChord({ name, ctrl, shift, super: superKey })) {
        updateHistory((current) => commit(current, selectAll(current.present)));
        return true;
      }

      if (isComposerNewline({ name, shift, option, meta })) {
        insertAtCaret("\n");
        return true;
      }
      if (name === "return" || name === "enter") {
        if (busyRef.current) {
          const queuedDraft = composerRef.current.text;
          if (queuedDraft.length > 0) {
            store.appendToQueue(queuedDraft);
            commitComposer(EMPTY_COMPOSER);
          }
          return true;
        }
        submit(composerRef.current.text);
        return true;
      }
      if (
        busyRef.current &&
        name === "up" &&
        store.getMessageQueueSnapshot().length > 0 &&
        isCursorOnFirstLine(composerRef.current.text, composerRef.current.caret)
      ) {
        const recalled = composeRecalledBuffer(store.takeQueue(), composerRef.current.text);
        commitComposer(composerFromText(recalled.value));
        return true;
      }
      if (
        busyRef.current &&
        isCtrlLetter({ name, ctrl }, "x") &&
        composerRef.current.text.length === 0
      ) {
        store.clearQueue();
        return true;
      }
      if (!busyRef.current && (name === "up" || name === "down")) {
        const recalledHistory = store.getInputHistory();
        if (recalledHistory.length > 0) {
          const current = composerRef.current;
          const index = historyIndex.current;
          const navigating = index !== null && current.text === recalledHistory[index];
          if (name === "up" && isCursorOnFirstLine(current.text, current.caret)) {
            if (navigating || current.text.length === 0) {
              const nextIndex = navigating ? Math.max(0, index - 1) : recalledHistory.length - 1;
              const recalled = recalledHistory[nextIndex] ?? "";
              historyIndex.current = nextIndex;
              commitComposer(composerFromText(recalled));
              return true;
            }
          }
          if (name === "down" && navigating && isCursorOnLastLine(current.text, current.caret)) {
            if (index >= recalledHistory.length - 1) {
              historyIndex.current = null;
              commitComposer(EMPTY_COMPOSER);
              return true;
            }
            const nextIndex = index + 1;
            const recalled = recalledHistory[nextIndex] ?? "";
            historyIndex.current = nextIndex;
            commitComposer(composerFromText(recalled));
            return true;
          }
        }
      }

      // Option+Backspace on macOS and Ctrl+Backspace elsewhere both mean
      // "delete the previous word" — this keyboard library reports the first
      // as `meta`, not `option`, which is easy to miss without checking the
      // actual event rather than assuming a name.
      if (name === "backspace" && (meta || option || ctrl)) {
        deleteWordBeforeCaret();
        return true;
      }
      if (name === "backspace") {
        commitComposer((current) => deleteBackward(current));
        return true;
      }
      if (name === "delete") {
        commitComposer((current) => deleteForward(current));
        return true;
      }
      // Caret motion, from widest jump to narrowest so a chord is never
      // shadowed by the plainer key it contains.
      //
      // macOS convention, and the reason `super` and `option` are carried
      // separately: Cmd jumps to the edge of the line, Option moves by word.
      // Ctrl+arrow is the Linux/Windows word-jump, and Home/End plus Ctrl+A /
      // Ctrl+E are the bindings that work in every terminal regardless of
      // whether it forwards Cmd at all — which many do not.
      // Shift keeps the anchor so the same keys grow a selection.
      const wordJump = meta || option || ctrl;
      const extend = shift;
      const current = composerRef.current;
      const characters = [...current.text];
      if (name === "left" && superKey) {
        moveComposer(lineStartBefore(characters, current.caret), extend);
        return true;
      }
      if (name === "right" && superKey) {
        moveComposer(lineEndAfter(characters, current.caret), extend);
        return true;
      }
      if (name === "left" && wordJump) {
        moveComposer(wordStartBefore(characters, current.caret), extend);
        return true;
      }
      if (name === "right" && wordJump) {
        moveComposer(wordEndAfter(characters, current.caret), extend);
        return true;
      }
      if (name === "home" || isCtrlLetter({ name, ctrl }, "a")) {
        moveComposer(lineStartBefore(characters, current.caret), extend);
        return true;
      }
      if (name === "end" || isCtrlLetter({ name, ctrl }, "e")) {
        moveComposer(lineEndAfter(characters, current.caret), extend);
        return true;
      }
      if (name === "left") {
        moveComposer(current.caret - 1, extend);
        return true;
      }
      if (name === "right") {
        moveComposer(current.caret + 1, extend);
        return true;
      }

      // Typing, from the sequence the terminal actually sent rather than from
      // `name`. `name` is lowercased for capitals and is the word "space" for
      // a space, so composing from it types in lower case and drops spaces.
      //
      // One printable code point is the whole test: a control key's sequence is
      // either a control code (Enter is "\r", Ctrl+A is "\u0001") or a
      // multi-character escape sequence (every arrow and function key), so both
      // are excluded without maintaining a list of names. Ctrl and Cmd are
      // rejected outright — a chord that reached here unhandled is a binding
      // this does not implement, not text to insert.
      if (!ctrl && !superKey && [...sequence].length === 1) {
        const code = sequence.codePointAt(0) ?? 0;
        if (code >= 0x20 && code !== 0x7f) {
          insertAtCaret(sequence);
          return true;
        }
      }
      return false;
    },
    [
      submit,
      applyPaste,
      insertAtCaret,
      setCommandIndex,
      commitComposer,
      moveComposer,
      updateHistory,
      deleteWordBeforeCaret,
      updatePromptEditor,
      updatePromptQuestion,
      updatePromptFile,
    ],
  );

  const onAction = useCallback(
    (action: KeyAction) => {
      if (action.type === "interrupt") interrupt.current?.();
      if (action.type === "stash-draft") commitComposer(EMPTY_COMPOSER);
      if (action.type === "close-overlay" && approval !== null) prompt?.resolve("no");
    },
    [approval, prompt, commitComposer],
  );

  const previousBlocks = useRef<readonly Block[]>([]);
  const blocks = useMemo(() => {
    const next = transcriptBlocks({ outputs, streaming, regions }, previousBlocks.current);
    previousBlocks.current = next;
    return next;
  }, [outputs, streaming, regions]);

  const header = useMemo<HeaderModel>(
    () => ({
      version: packageJson.version,
      cwd: compactWorkingDirectory(workingDirectory),
      model: stats.model ?? "no model",
      connectors: [...connectors].map(([name, status]) => ({ name, status })),
      contextUsed: stats.tokensInContext ?? 0,
      contextMax: stats.maxContextTokens ?? 0,
    }),
    [workingDirectory, stats.model, stats.tokensInContext, stats.maxContextTokens, connectors],
  );

  const overlay = useMemo<Overlay | undefined>(() => {
    // An approval outranks search: it is a decision the agent is blocked on, and
    // it arrived because the user asked for something.
    const promptOverlay = overlayFromPrompt(prompt, promptControls);
    let next: Overlay | undefined = promptOverlay;
    if (searchQuery !== null) {
      next = {
        kind: "search",
        query: searchQuery,
        scope: searchScope,
        // `current` means the hit is in this session; `selected` is the cursor.
        // Conflating them would show recency wrong on every row but one.
        hits: searchHits,
        selected: searchIndex,
      };
    }
    if (approval !== null) {
      next = approvalFrom(approval, approvalArmed, approvalFieldOffset);
    }
    return next;
  }, [
    prompt,
    promptControls,
    searchQuery,
    searchScope,
    searchHits,
    searchIndex,
    approval,
    approvalArmed,
    approvalFieldOffset,
  ]);

  const input = useMemo<InputModel>(() => {
    const commandItems = commandQuery === null ? [] : filterCommandsByPrefix(commandQuery);
    const mentionItems = mention === null ? [] : mentionEntries;
    const menu = mergeSuggestions(commandItems, mentionItems);
    const commands: InputModel["commands"] =
      menu === undefined
        ? undefined
        : {
            items: menu.items,
            selected: wrapCommandIndex(commandIndex, menu.items.length),
            prefix: menu.prefix,
          };
    return {
      value: draft,
      caret: draftCaret,
      anchor: draftAnchor,
      placeholder: busy ? "Type to queue for next turn" : "Ask anything",
      queued: queue,
      queueing: busy || queue.length > 0,
      disabled: overlay !== undefined || (!busy && queue.length === 0 && prompt?.type !== "chat"),
      ...(commands === undefined ? {} : { commands }),
    };
  }, [
    draft,
    draftCaret,
    draftAnchor,
    busy,
    queue,
    overlay,
    prompt,
    commandQuery,
    commandIndex,
    mention,
    mentionEntries,
  ]);

  const footer = useMemo<FooterModel>(
    () => ({
      mode: isYolo ? "yolo" : "safe",
      hints: [],
      ...(stats.costUSD === undefined ? {} : { costUsd: stats.costUSD }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    }),
    [isYolo, stats.costUSD, elapsedMs],
  );

  const live = useMemo<LiveModel>(() => {
    const reasoningElapsedMs = liveReasoningElapsedMs(regions, Date.now());
    return {
      tools,
      hiddenTools: [],
      ...(step === undefined ? {} : { step }),
      ...(waitingNow
        ? {
            waiting: WAITING[
              Math.floor((elapsedMs ?? 0) / WAITING_ROTATE_MS) % WAITING.length
            ] as string,
          }
        : {}),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      reservedRows,
      ...(reasoningElapsedMs === undefined ? {} : { reasoningElapsedMs }),
    };
  }, [tools, step, waitingNow, elapsedMs, reservedRows, regions]);

  const view = useMemo<ViewModel>(
    () => ({
      header,
      blocks,
      runActive,
      live,
      input,
      footer,
      ...(overlay === undefined ? {} : { overlay }),
      focus: "input",
    }),
    [header, blocks, runActive, live, input, footer, overlay],
  );

  // A menu the app is waiting on gets the real screen. The wizard publishes it
  // as data precisely so a renderer that cannot paint an Ink tree can still draw
  // it — which is what makes the flow work here at all.
  //
  // This is content passed *into* App as `overrideContent`, never returned in
  // its place. App's own `useKeyboard` call has to stay mounted for any of this
  // to receive a key at all — arrows, enter, or Ctrl+C.
  const overrideContent: React.ReactNode | undefined =
    menu?.kind === "agents" ? (
      <AgentPicker
        agents={menu.agents}
        selectedIndex={menuIndex}
        viewport={viewport}
        title={menu.title}
        action={menu.action}
      />
    ) : menu?.kind === "menu" ? (
      <Home
        model={{
          version: packageJson.version,
          tagline: "One agent. Every surface. Your rules.",
          requirements: menu.requirements ?? [],
          choices: menu.options.map((option) => ({ label: option.label, value: option.value })),
          selected: menuIndex,
          ...(menu.tip === undefined ? {} : { tip: menu.tip }),
        }}
        viewport={viewport}
      />
    ) : undefined;

  return (
    <App
      view={view}
      onAction={onAction}
      onKey={onKey}
      onPaste={applyPaste}
      {...(overrideContent === undefined ? {} : { overrideContent })}
    />
  );
}
