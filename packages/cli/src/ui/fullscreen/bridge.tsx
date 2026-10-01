/** @jsxImportSource @opentui/react */
/**
 * Projects the canonical semantic document and one coherent live snapshot into
 * the fullscreen ViewModel. Content facts keep source identity; this adapter
 * chooses blocks, collapse state, and the visible reveal prefix. Composer and
 * secret drafts remain local to the interaction rather than durable content.
 * Prompt callbacks stay on their separate input port.
 */

import { search, type SearchHit } from "@jazz/adapters/history/conversation-search";
import type { Suggestion } from "@jazz/core/interfaces/presentation";
import { type ChoicePreviewLine } from "@jazz/core/interfaces/terminal";
import type { SkillMetadata } from "@jazz/core/skills/skill-service";
import { isHttpApprovalTool } from "@jazz/core/utils/http-approval";
import { isDiffReceiptTool } from "@jazz/core/utils/tool-formatter";
import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterCommandsByPrefix, slashCommandQuery } from "@jazz/cli/chat/commands";
import packageJson from "../../../../../package.json";
import type { ActivityState, TodoSnapshotItem } from "../activity-state";
import { applyAtMention, type AtMentionSpan } from "../at-mention";
import {
  type FilePickerEntry,
  resolveFilePickerPath,
  scanFilePickerEntries,
} from "../file-picker-files";
import { hostForModel } from "../local-model-hosts";
import { App, type KeyChord } from "./App";
import { flattenPaste, normalizePaste, readClipboard } from "./clipboard";
import {
  commit,
  composerFromText,
  deleteBackward,
  deleteForward,
  deleteRange,
  DOWN,
  EMPTY_COMPOSER,
  EMPTY_HISTORY,
  insertText,
  moveCaret,
  moveCaretVertical,
  redo,
  selectAll,
  typeCharacter,
  UP,
  type ComposerHistory,
  undo,
} from "./composer-edit";
import { wrapCommandIndex } from "./Input";
import {
  isBackgroundChord,
  isComposerNewline,
  isCtrlLetter,
  isInterruptChord,
  isRedoChord,
  isSelectAllChord,
  isUndoChord,
  type KeyAction,
} from "./keymap";
import { TODO_WINDOW_ROWS } from "./LiveZone";
import { subagentBlocks, subagentListItem } from "./subagent-view";
import { applyTextFieldKey, wordEndAfter, wordStartBefore } from "./text-field-edit";
import { themePickerTarget } from "./theme-picker-keys";
import { foldTurn } from "./turn-fold";
import {
  LIVE_ZONE_MAX_ROWS,
  type ApprovalChoice,
  type ApprovalOverlay,
  type Block,
  type FooterModel,
  type HeaderModel,
  type InputModel,
  type LiveModel,
  type LiveTool,
  type Overlay,
  type StepLine,
  type SubagentListModel,
  type ThemePickerModel,
  type ThemePickerRow,
  type ViewModel,
} from "./types";
import { formatTurnReceipt } from "../../presentation/turn-receipt";
import { contentFromOutput, outputFromEntry, projectDocumentEntries } from "../document";
import { agentDetailsBodyHeight, agentDetailsRows } from "../models/agent-details";
import { approvalFacts, diffLanguage } from "../models/approval";
import { approvalTitle } from "../models/approval";
import { homeIntent } from "../models/home-view";
import { interruptSummary, type InterruptSnapshot, type ReceiptFacts } from "../models/interrupt";
import { binaryAnswerIndices, MAX_QUICK_PICK } from "../models/question";
import { RETRY_BAND_ROWS, retryBand } from "../models/retry";
import { settledPlan } from "../models/todo";
import { filterAndRank, TYPED_ANSWER_DESCRIPTION, type PickerChoice } from "../prompt-core";
import { initialChoiceIndex } from "../prompt-core/picker-adapter";
import { readPromptStep } from "../prompt-core/stepper";
import { composeRecalledBuffer, isCursorOnFirstLine, isCursorOnLastLine } from "../queue-recall";
import { filterSkills, skillDetailRows } from "../skill-browser";
import { skillDetailBodyRows, skillListRows } from "../skill-browser";
import {
  store,
  usePresentationSlice,
  usePromptSlice,
  type EphemeralRegion,
  type PendingApproval,
} from "../store";
import type { SubagentRun } from "../subagent-runs";
import { mergeSuggestions } from "../suggestion-menu";
import { wrapIndex } from "../text/picker-window";
import { pathFromFileArgsPreview, sourceLanguageFromPath } from "../text/syntax-spans";
import { compactWorkingDirectory } from "../text/working-directory";
import { previewTheme } from "../theme";
import type { Choice, OutputEntry, PromptState } from "../types";
import { useFileMentions, type FileMentionItem } from "../use-file-mentions";
import type { FilePickerModel } from "./overlays/FilePicker";
import type { QuestionChoice, QuestionModel, QuestionTagTone } from "./overlays/Question";
import type { QuestionStep } from "./overlays/stepper";
import type { TextPromptModel } from "./overlays/TextPrompt";
import { AgentDetails } from "./screens/AgentDetails";
import { AgentPicker, filterAgents, listRowsFor } from "./screens/AgentPicker";
import { Home } from "./screens/Home";
import { MenuScreen } from "./screens/Menu";
import { SkillBrowser } from "./screens/SkillBrowser";

/** How long "message not sent" stays in the footer after Enter on a finished sub-agent. */
const SUBAGENT_NOTICE_MS = 2500;

/** Waiting copy, house voice: idiomatic, never jokey. */
const WAITING = ["comping behind you", "turning it over", "two horns out", "digging the crates"];

/**
 * What the waiting row says. Before the first event arrives nothing is known
 * about what the model is doing, so the house copy fills the silence. Once it
 * is reasoning, the row says so plainly.
 */
export function waitingLabel(phase: string, elapsedMs: number | undefined): string {
  if (phase === "thinking") return "thinking";
  return WAITING[Math.floor((elapsedMs ?? 0) / WAITING_ROTATE_MS) % WAITING.length] as string;
}

/** Footer and live elapsed digits update once a second, not on the indicator. */
const FOOTER_ELAPSED_MS = 1000;
const WAITING_ROTATE_MS = 4_000;

/** How long the band holds its height after it has room to shrink. */
const SETTLE_MS = 800;

/** Window in which a second idle Ctrl+C confirms the first's warning. */
const QUIT_CONFIRM_WINDOW_MS = 1500;
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
  readonly filterCaret: number;
}

interface PromptFileState {
  readonly filter: string;
  readonly filterCaret: number;
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
  filterCaret: 0,
};
const EMPTY_FILE: PromptFileState = {
  filter: "",
  filterCaret: 0,
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

function promptIsFilterable(prompt: PromptState): boolean {
  return prompt.type === "search" || prompt.type === "select";
}

/**
 * The filter text a `select` would submit as its own answer: set only when the prompt accepts typed
 * answers and something has been typed. Its row sits just past the last match.
 */
function typedAnswerFor(prompt: PromptState, filter: string): string | undefined {
  if (prompt.type !== "select" || prompt.options?.resolveTypedAnswer === undefined) {
    return undefined;
  }
  const text = filter.trim();
  return text.length > 0 ? text : undefined;
}

function matchingChoiceIndices(choices: readonly Choice[], filter: string): number[] {
  // Route through the shared core so fullscreen ranks choices identically to
  // the standard (ink) renderer — this ends the two-mode divergence.
  return filterAndRank(choices as readonly PickerChoice[], filter).map(
    (ranked) => ranked.originalIndex,
  );
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

/**
 * Whether a question offers a row for an answer in the person's own words. Every
 * question the agent asks does: its suggestions are the agent's framing, and a person
 * must always be able to step outside it.
 */
function allowsCustomAnswer(prompt: PromptState): boolean {
  return prompt.type === "questionnaire";
}

/**
 * The two answers of a yes/no question. A confirm prompt always is one; an agent's
 * question is one when the shared model says its choices are a Yes and a No.
 */
export function binaryAnswers(
  prompt: PromptState,
  choices: readonly { readonly label: string }[],
): { readonly yes: number; readonly no: number } | undefined {
  if (prompt.type === "confirm") return { yes: 0, no: 1 };
  if (prompt.type !== "questionnaire") return undefined;
  return binaryAnswerIndices(
    choices.map((choice) => choice.label),
    allowsMultipleAnswers(prompt),
  );
}

function questionPosition(
  prompt: PromptState,
): { readonly index: number; readonly total: number } | undefined {
  const position = prompt.options?.["position"];
  if (position === null || typeof position !== "object") return undefined;
  const { index, total } = position as Record<string, unknown>;
  return typeof index === "number" && typeof total === "number" ? { index, total } : undefined;
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

  if (prompt.type === "theme") {
    const current = themePickerRows(prompt).findIndex((row) => row.current);
    return {
      ...EMPTY_PROMPT_CONTROLS,
      question: { ...EMPTY_QUESTION, selected: Math.max(0, current) },
    };
  }

  const choices = promptChoices(prompt);
  const selected =
    prompt.type === "confirm"
      ? prompt.options?.["defaultValue"] === true
        ? 0
        : 1
      : initialChoiceIndex(
          choices,
          prompt.type === "select" ? prompt.options?.defaultSelected : undefined,
        );

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
    readonly tag?: string;
    readonly tagTone?: QuestionTagTone;
    readonly preview?: readonly ChoicePreviewLine[];
  }[],
  originalIndices?: readonly number[],
): QuestionChoice[] {
  return choices.map((choice, index) => ({
    label: choice.label,
    value: `choice-${String(originalIndices?.[index] ?? index)}`,
    ...(choice.description === undefined ? {} : { description: choice.description }),
    ...(choice.disabled === true ? { disabled: true } : {}),
    ...(choice.tag === undefined ? {} : { tag: choice.tag }),
    ...(choice.tagTone === undefined ? {} : { tagTone: choice.tagTone }),
    ...(choice.preview === undefined ? {} : { preview: choice.preview }),
  }));
}

/** `{ step }` when the prompt was opened as part of a multi-step flow, else nothing. */
function stepField(prompt: PromptState): { readonly step?: QuestionStep } {
  const step = promptStep(prompt);
  return step === undefined ? {} : { step };
}

/** The multi-step position a prompt was opened with, when it is well-formed. */
function promptStep(prompt: PromptState): QuestionStep | undefined {
  return readPromptStep(prompt.options?.["step"]);
}

function validatePrompt(prompt: PromptState, value: string): string | null {
  const candidate = prompt.options?.["validate"];
  if (typeof candidate !== "function") return null;
  const result = (candidate as (input: string) => boolean | string)(value);
  if (result === true) return null;
  return typeof result === "string" ? result : "Invalid input";
}

function hiddenPromptKeys(prompt: PromptState | null): readonly string[] | undefined {
  if (prompt?.type !== "hidden") return undefined;
  const keys = prompt.options?.["keys"];
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : undefined;
}

/** The picker's rows: the listings the `/theme` command opened it with. */
function themePickerRows(prompt: PromptState): readonly ThemePickerRow[] {
  const listings = prompt.options?.["themes"];
  return Array.isArray(listings) ? (listings as ThemePickerRow[]) : [];
}

function overlayFromPrompt(
  prompt: PromptState | null,
  controls: PromptControlsState,
): QuestionModel | TextPromptModel | FilePickerModel | ThemePickerModel | undefined {
  if (prompt === null || prompt.type === "chat" || hiddenPromptKeys(prompt) !== undefined) {
    return undefined;
  }
  const { editor, question, file } = controls;

  switch (prompt.type) {
    case "text":
    case "password":
      return {
        kind: "text",
        message: prompt.message,
        value: editor.value,
        caret: editor.caret,
        ...stepField(prompt),
        ...(prompt.type === "password" || prompt.options?.["secret"] === true
          ? { masked: true }
          : {}),
        ...(prompt.options?.["conceal"] === true ? { concealed: true } : {}),
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
        filterCaret: file.filterCaret,
        scanning: file.scanning,
        ...(file.error === undefined ? {} : { error: file.error }),
      };
    }
    case "theme":
      return { kind: "theme", rows: themePickerRows(prompt), selected: controls.question.selected };
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
        buttons: true,
      };
    case "select":
    case "search":
    case "checkbox": {
      const choices = promptChoices(prompt);
      const filterable = prompt.type !== "checkbox";
      const indices = filterable
        ? matchingChoiceIndices(choices, question.filter)
        : choices.map((_choice, index) => index);
      const typedAnswer = typedAnswerFor(prompt, question.filter);
      const matches = choiceModel(
        indices.map((index) => choices[index] as Choice),
        indices,
      );
      return {
        kind: "question",
        mode: prompt.type === "checkbox" ? "checkbox" : "select",
        message: prompt.message,
        choices:
          typedAnswer === undefined
            ? matches
            : [
                ...matches,
                {
                  label: typedAnswer,
                  value: "typed-answer",
                  description: TYPED_ANSWER_DESCRIPTION,
                },
              ],
        selected: question.selected,
        ...(filterable
          ? { filterable: true, filter: question.filter, filterCaret: question.filterCaret }
          : {}),
        ...(prompt.type === "checkbox"
          ? { checked: question.checked.map((index) => `choice-${String(index)}`) }
          : {}),
        ...stepField(prompt),
      };
    }
    case "questionnaire": {
      const suggestions = promptSuggestions(prompt);
      const allowMultiple = allowsMultipleAnswers(prompt);
      const allowCustom = allowsCustomAnswer(prompt);
      const choices = choicesForQuestion(prompt, suggestions);
      const position = questionPosition(prompt);
      return {
        kind: "question",
        mode: allowMultiple ? "checkbox" : "select",
        message: prompt.message,
        choices: choiceModel(choices),
        selected: question.selected,
        skippable: true,
        ...(binaryAnswers(prompt, choices) === undefined ? {} : { buttons: true }),
        ...(position === undefined ? {} : { position }),
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
 *
 * Word-boundary motion (`wordStartBefore`/`wordEndAfter`) lives in
 * `text-field-edit.ts` now, shared with every single-line overlay field.
 */

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

/** The settled tool calls after the last user message: the turn a stop summarises. */
function currentTurnReceipts(blocks: readonly Block[]): ReceiptFacts[] {
  let start = blocks.length;
  while (start > 0 && blocks[start - 1]?.kind !== "user") start -= 1;
  return blocks.slice(start).flatMap((block) =>
    block.kind === "tool"
      ? [
          {
            app: block.app,
            summary: block.summary,
            status: block.status,
            ...(block.args === undefined ? {} : { args: block.args }),
          },
        ]
      : [],
  );
}

/** Project semantic source entries into fullscreen document blocks. */
export function blocksFrom(
  entries: readonly OutputEntry[],
  streaming: string,
  regions: readonly EphemeralRegion[],
  expandedReasoningIds: ReadonlySet<string> = new Set(),
  streamingId?: string,
  liveReasoningIds: ReadonlySet<string> = new Set(),
): Block[] {
  const blocks: Block[] = [];
  let seq = 0;
  const sourceEntries = entries.map((entry, index) => ({
    id: entry.id ?? `entry:${String(index)}`,
    content: contentFromOutput(entry),
    timestamp: entry.timestamp.toISOString(),
  }));
  for (const source of projectDocumentEntries(
    { id: "projection", revision: 0, entries: sourceEntries },
    { expandedReasoningIds, liveReasoningIds },
  )) {
    const entry = outputFromEntry(source);
    const id = source.id;
    const content = contentFromOutput(entry);
    switch (content.kind) {
      case "user":
        blocks.push({ id, seq: seq++, kind: "user", text: content.text });
        break;
      case "agent":
        blocks.push({
          id,
          seq: seq++,
          kind: "agent",
          markdown: content.markdown,
          ...(id === streamingId ? { streaming: true } : {}),
        });
        break;
      case "tool":
        blocks.push({ id, seq: seq++, kind: "tool", ...content.receipt });
        break;
      case "reasoning":
        blocks.push({
          id,
          seq: seq++,
          kind: "reasoning",
          text: content.text,
          collapsed: content.durationMs !== undefined && !expandedReasoningIds.has(id),
          ...(content.durationMs === undefined ? {} : { durationMs: content.durationMs }),
          ...(content.steps === undefined ? {} : { steps: content.steps }),
          ...(content.tokens === undefined ? {} : { tokens: content.tokens }),
          ...(id === streamingId || liveReasoningIds.has(id) ? { live: true } : {}),
          ...(content.text.trim().length === 0 ? { readable: false } : {}),
        });
        break;
      case "report":
        blocks.push({ id, seq: seq++, kind: "report", report: content.report });
        break;
      case "stopped":
        blocks.push({ id, seq: seq++, kind: "stopped", ...content.summary });
        break;
      case "turn-receipt": {
        const text = formatTurnReceipt(content);
        if (text !== undefined)
          blocks.push({ id, seq: seq++, kind: "notice", text, tone: "receipt" });
        break;
      }
      case "expanded":
        blocks.push({
          id,
          seq: seq++,
          kind: "tool",
          app: "",
          summary: "",
          status: "ok",
          expanded: true,
          detail: content.text,
        });
        break;
      case "notice":
        if (content.audience !== "classic" && content.text.trim().length > 0)
          blocks.push({
            id,
            seq: seq++,
            kind: "notice",
            text: content.text,
            tone: content.tone === "warn" ? "warn" : content.tone === "error" ? "error" : "info",
          });
        break;
      case "header":
        break;
    }
  }
  if (streaming.trim().length > 0)
    blocks.push({
      id: streamingId ?? "streaming",
      seq: seq++,
      kind: "agent",
      markdown: streaming,
      streaming: true,
    });
  let lane = 0;
  for (const region of regions) {
    if (region.kind === "reasoning" && entries.some((entry) => entry.id === region.id)) continue;
    if (region.kind === "reasoning")
      blocks.push({
        id: region.id,
        seq: seq++,
        kind: "reasoning",
        text: region.tail.join("\n"),
        collapsed: false,
        live: true,
      });
    else
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
  return foldTurn(blocks);
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
        previous.tokens === current.tokens &&
        previous.live === current.live &&
        previous.readable === current.readable
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
        previous.notDone === current.notDone &&
        previous.durationMs === current.durationMs &&
        previous.detail === current.detail &&
        previous.outputPreview === current.outputPreview &&
        previous.expanded === current.expanded &&
        previous.classifiedRisk === current.classifiedRisk
      );
    case "notice":
      return (
        current.kind === "notice" &&
        previous.text === current.text &&
        previous.tone === current.tone
      );
    case "report":
      return current.kind === "report" && previous.report === current.report;
    case "divider":
      return current.kind === "divider" && previous.label === current.label;
    case "stopped":
      return (
        current.kind === "stopped" &&
        previous.elapsedMs === current.elapsedMs &&
        previous.done.join("\n") === current.done.join("\n") &&
        previous.notDone.join("\n") === current.notDone.join("\n")
      );
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
  readonly expandedReasoningIds?: ReadonlySet<string>;
  readonly streamingId?: string;
  readonly liveReasoningIds?: ReadonlySet<string>;
}

export function transcriptBlocks(
  sources: TranscriptBlockSources,
  previous: readonly Block[] = [],
): readonly Block[] {
  return shareUnchangedBlocks(
    previous,
    blocksFrom(
      sources.outputs,
      sources.streaming,
      sources.regions,
      sources.expandedReasoningIds,
      sources.streamingId,
      sources.liveReasoningIds,
    ),
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
    const language = isDiffReceiptTool(tool.toolName)
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

/**
 * A pending approval becomes the card.
 *
 * Fields come from the arguments the tool will actually be called with, because
 * the promise the card makes is that nothing is discoverable only after
 * pressing enter. The account is whichever argument names one — that is the
 * single most important string on the screen, so it is looked for explicitly
 * rather than left to land somewhere in a list.
 */
/** The choices the card offers, in the order left and right walk them. */
function approvalChoicesFor(pending: PendingApproval): readonly ApprovalChoice[] {
  return isHttpApprovalTool(pending.executeToolName)
    ? ["accept", "reject"]
    : ["accept", "always", "reject"];
}

/** The always-allow answer a prompt offers: the command when it lists one, else the tool. */
function alwaysApprovalValue(prompt: {
  readonly options?: { readonly choices?: readonly { readonly value: unknown }[] };
}): string {
  const alwaysCommand = prompt.options?.choices?.some(
    (choice) => choice.value === "always_command",
  );
  return alwaysCommand ? "always_command" : "always_tool";
}

function approvalFrom(
  pending: PendingApproval,
  armed: boolean,
  fieldOffset: number,
  expanded: boolean,
  choice: ApprovalChoice,
): ApprovalOverlay {
  const facts = approvalFacts(pending);
  const { intent } = facts;
  return {
    kind: "approval",
    app: facts.app,
    action: facts.title,
    account: facts.account,
    fields: facts.fields,
    consequence: pending.message,
    fieldOffset,
    expanded,
    alwaysLabel: facts.alwaysLabel,
    allowAlways: approvalChoicesFor(pending).includes("always"),
    choice,
    armed,
    ...(intent.headline === undefined ? {} : { headline: intent.headline }),
    acceptLabel: intent.accept,
    rejectLabel: intent.reject,
    ...(intent.impact === undefined ? {} : { impact: intent.impact }),
    ...(intent.command === undefined ? {} : { command: intent.command }),
    ...(intent.diff === undefined
      ? {}
      : { diff: intent.diff, diffLanguage: diffLanguage(pending.args) }),
    ...(facts.warning === undefined ? {} : { warning: facts.warning }),
    ...(facts.editableArg === undefined ? {} : { editableArg: facts.editableArg }),
  };
}

export function FullscreenBridge(): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const viewport = { width, height };
  const presentation = usePresentationSlice();
  const session = presentation.session;
  const promptSlice = usePromptSlice();
  const ephemeral = presentation.ephemeral;
  const outputs = useMemo(
    () =>
      projectDocumentEntries(presentation.document, {
        streamReveal: presentation.streamReveal,
      }).map(outputFromEntry),
    [presentation.document, presentation.streamReveal],
  );
  const streaming = "";
  const activity = session.activity;
  const stats = session.runStats;
  const queue = promptSlice.messageQueue;
  const busy = session.chatBusy;
  const [submitCount, setSubmitCount] = useState(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const isYolo = session.isYolo;
  const regions = ephemeral.regions;
  const subagentRuns = presentation.subagents.runs;
  const subagentRunsRef = useRef(subagentRuns);
  subagentRunsRef.current = subagentRuns;
  // Null while the composer has the keyboard; otherwise the highlighted row.
  const [agentCursor, agentCursorRef, setAgentCursor] = useSynchronizedState<number | null>(null);
  // The sub-agent whose log is standing in for the conversation, if any.
  const [inspectedId, inspectedIdRef, setInspectedId] = useSynchronizedState<string | null>(null);
  const [subagentNotice, setSubagentNotice] = useState<string | undefined>(undefined);
  const subagentNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prompt = promptSlice.prompt;
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const [promptControls, promptControlsRef, updatePromptControls] =
    useSynchronizedState<PromptControlsState>(EMPTY_PROMPT_CONTROLS);
  const promptFile = promptControls.file;
  const approval = session.approvalRequest;
  const [approvalArmed, setApprovalArmed] = useState(false);
  const [approvalFieldOffset, setApprovalFieldOffset] = useState(0);
  const [approvalExpanded, setApprovalExpanded] = useState(false);
  const [approvalChoice, setApprovalChoice] = useState<ApprovalChoice>("accept");
  const approvalChoiceRef = useRef<ApprovalChoice>("accept");
  approvalChoiceRef.current = approvalChoice;
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
  const [searchCaret, searchCaretRef, setSearchCaret] = useSynchronizedState(0);
  const [searchHits, searchHitsRef, setSearchHits] = useSynchronizedState<readonly SearchHit[]>([]);
  const [searchScope, , setSearchScope] = useSynchronizedState<"conversation" | "all">("all");
  const [searchIndex, searchIndexRef, setSearchIndex] = useSynchronizedState(0);
  const menu = session.activeMenu;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const [menuIndex, menuIndexRef, setMenuIndex] = useSynchronizedState(0);
  const [menuFilter, menuFilterRef, setMenuFilter] = useSynchronizedState({ value: "", caret: 0 });
  /** The agent home's button and composer go to; ↑↓ and the agent picker move it. */
  const [homeAgentId, homeAgentIdRef, setHomeAgentId] = useSynchronizedState<string | undefined>(
    undefined,
  );
  /** The waiting conversation ↓ selected on home; enter then opens it. */
  const [homeWaitingValue, homeWaitingValueRef, setHomeWaitingValue] = useSynchronizedState<
    string | undefined
  >(undefined);
  const [skillDetail, skillDetailRef, setSkillDetail] = useSynchronizedState<SkillMetadata | null>(
    null,
  );
  const [skillDetailOffset, skillDetailOffsetRef, setSkillDetailOffset] = useSynchronizedState(0);
  // The index reset for a replacement menu runs a frame after the menu lands;
  // a keypress in that gap must not read the old menu's selection into the new
  // one, so the index only counts for the menu it was moved on.
  const menuIndexForRef = useRef<typeof menu>(null);
  const [elapsedMs, setElapsedMs] = useState<number | undefined>();
  const [reservedRows, setReservedRows] = useState(0);
  const runStartedAt = useRef<number | null>(null);
  const lastTodoListRef = useRef<readonly TodoSnapshotItem[]>([]);
  const previousRunActiveRef = useRef(false);
  const previousConversationIdRef = useRef(currentConversation?.conversationId);
  if (currentConversation?.conversationId !== previousConversationIdRef.current) {
    lastTodoListRef.current = [];
    previousConversationIdRef.current = currentConversation?.conversationId;
  }

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
  // What the turn looks like right now, kept current every render so a stop can be
  // summarised from the moment the key was pressed rather than after the run unwinds.
  const stopContextRef = useRef<Omit<InterruptSnapshot, "elapsedMs"> | null>(null);
  const announceStop = useCallback((): void => {
    const context = stopContextRef.current;
    const startedAt = runStartedAt.current;
    if (context === null || startedAt === null) return;
    store.printOutput({
      type: "log",
      message: {
        kind: "stopped",
        summary: interruptSummary({ ...context, elapsedMs: Date.now() - startedAt }),
      },
      timestamp: new Date(),
    });
  }, []);
  const background = useRef(session.backgroundHandler);
  background.current = session.backgroundHandler;
  const quitArmed = useRef(false);
  const quitArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmQuit = useCallback(() => {
    quitArmed.current = false;
    if (quitArmTimer.current !== null) {
      clearTimeout(quitArmTimer.current);
      quitArmTimer.current = null;
    }
  }, []);

  useEffect(() => {
    updatePromptControls(initialPromptControls(prompt));
  }, [prompt, updatePromptControls]);

  useEffect(() => {
    if (approval !== null) flushPendingTerminalKeys();
    setApprovalArmedState(false);
    setApprovalFieldOffset(0);
    setApprovalExpanded(false);
    setApprovalChoice("accept");
  }, [approval, setApprovalArmedState]);

  // Home is refreshed in place once its history loads; only a new showing of it (a new
  // `shownAt`) resets the chosen agent and the composer, so a refresh never eats typing.
  const menuIdentity: unknown = menu?.kind === "home" ? `home:${String(menu.shownAt)}` : menu;
  useEffect(() => {
    const opened = menuRef.current;
    setMenuIndex(opened?.kind === "agents" ? (opened.initialIndex ?? 0) : 0);
    const draft = opened?.kind === "home" ? (opened.draft ?? "") : "";
    setMenuFilter({ value: draft, caret: [...draft].length });
    setHomeAgentId(
      opened?.kind === "home" ? (opened.targetAgentId ?? opened.agents[0]?.id) : undefined,
    );
    setHomeWaitingValue(undefined);
    setSkillDetail(null);
    setSkillDetailOffset(0);
  }, [
    menuIdentity,
    setMenuIndex,
    setMenuFilter,
    setHomeAgentId,
    setHomeWaitingValue,
    setSkillDetail,
    setSkillDetailOffset,
  ]);

  // A new turn prunes the finished runs, and with them whatever was open or highlighted.
  useEffect(() => {
    if (subagentRuns.length === 0) setAgentCursor(null);
    if (inspectedId !== null && !subagentRuns.some((run) => run.id === inspectedId)) {
      setInspectedId(null);
    }
  }, [subagentRuns, inspectedId, setAgentCursor, setInspectedId]);

  useEffect(() => {
    return () => {
      if (subagentNoticeTimer.current !== undefined) clearTimeout(subagentNoticeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!busy) disarmQuit();
  }, [busy, disarmQuit]);

  useEffect(() => {
    if (session.interruptHandler === null) disarmQuit();
  }, [session.interruptHandler, disarmQuit]);

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
  const runActive = busy || presentation.document.streamingId !== undefined || running;
  useEffect(() => {
    if (!runActive) disarmQuit();
  }, [runActive, disarmQuit]);
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

  // The checklist is worth reading once the turn has finished, not just while
  // manage_todos is the active tool — so its last known shape survives the
  // phase moving on to streaming, complete, or idle. Only a new run gets to
  // clear it: the rising edge below fires once, before this render computes
  // `todoList`, so a stale checklist never flashes ahead of the new run's own.
  if (runActive && !previousRunActiveRef.current) {
    lastTodoListRef.current = [];
  }
  previousRunActiveRef.current = runActive;

  const freshTodoList =
    activity.phase === "tool-execution" && activity.todoSnapshot !== undefined
      ? activity.todoSnapshot.filter((todo) => todo.status !== "cancelled")
      : undefined;
  if (freshTodoList !== undefined && freshTodoList.length > 0) {
    lastTodoListRef.current = freshTodoList;
  }
  const retainedTodoList = freshTodoList ?? lastTodoListRef.current;
  const todoList = useMemo(
    () => (runActive ? retainedTodoList : settledPlan(retainedTodoList)),
    [runActive, retainedTodoList],
  );
  const waitingNow = activity.phase === "awaiting" || activity.phase === "thinking";
  const retryNotice = runActive ? session.retryNotice : null;
  const neededRows = Math.min(
    LIVE_ZONE_MAX_ROWS,
    tools.length +
      (retryNotice === null ? 0 : RETRY_BAND_ROWS) +
      (waitingNow ? 1 : 0) +
      (step === undefined ? 0 : 1) +
      (todoList.length > 0 ? 1 + Math.min(todoList.length, TODO_WINDOW_ROWS) : 0),
  );

  useEffect(() => {
    if (neededRows > reservedRows) {
      setReservedRows(neededRows);
      return;
    }
    if (neededRows === reservedRows) return;
    const timer = setTimeout(() => setReservedRows(neededRows), SETTLE_MS);
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

  /**
   * Deletes from the caret to the start of the current logical line, the way
   * Cmd+Backspace does in every macOS text field and Ctrl+U does at a
   * readline prompt.
   */
  const deleteLineBeforeCaret = useCallback(() => {
    commitComposer((current) => {
      const characters = [...current.text];
      const at = Math.max(0, Math.min(current.caret, characters.length));
      return deleteRange(current, lineStartBefore(characters, at), at);
    });
  }, [commitComposer]);

  const submit = useCallback(
    (text: string) => {
      const active = promptRef.current;
      if (active === null || text.trim().length === 0) return;
      historyIndex.current = null;
      setSubmitCount((count) => count + 1);
      commitComposer(EMPTY_COMPOSER);
      active.resolve(text);
    },
    [promptRef, commitComposer],
  );

  const flashSubagentNotice = useCallback((notice: string): void => {
    if (subagentNoticeTimer.current !== undefined) clearTimeout(subagentNoticeTimer.current);
    setSubagentNotice(notice);
    subagentNoticeTimer.current = setTimeout(() => {
      setSubagentNotice(undefined);
      subagentNoticeTimer.current = undefined;
    }, SUBAGENT_NOTICE_MS);
  }, []);

  /** Switching what the transcript shows lands at its live edge, as a submit does. */
  const inspectSubagent = useCallback(
    (id: string | null): void => {
      setInspectedId(id);
      setSubmitCount((count) => count + 1);
    },
    [setInspectedId],
  );

  /**
   * Enter while a sub-agent is open addresses it, not the main conversation. The
   * draft is kept when the sub-agent has already finished, so nothing typed is lost.
   */
  const sendToInspectedSubagent = useCallback((): void => {
    const text = composerRef.current.text;
    if (text.trim().length === 0) return;
    const run = subagentRunsRef.current.find(
      (candidate) => candidate.id === inspectedIdRef.current,
    );
    if (run === undefined) return;
    if (!store.sendSubagentMessage(run.id, text)) {
      flashSubagentNotice(
        run.acceptsMessages
          ? `${run.label} has finished; message not sent`
          : `${run.label} can't take messages`,
      );
      return;
    }
    historyIndex.current = null;
    commitComposer(EMPTY_COMPOSER);
    setSubmitCount((count) => count + 1);
  }, [commitComposer, flashSubagentNotice, inspectedIdRef]);

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
      if (menuRef.current?.kind === "skills" && skillDetailRef.current === null) {
        const flat = flattenPaste(pasted);
        setMenuFilter((field) => insertTextAt(field.value, field.caret, flat));
        setMenuIndex(0);
        return true;
      }
      if (menuRef.current?.kind === "home" && menuRef.current.firstRun === undefined) {
        // A pasted first message stays one line, since enter sends it.
        const flat = flattenPaste(pasted);
        setMenuFilter((field) => insertTextAt(field.value, field.caret, flat));
        return true;
      }
      if (menuRef.current !== null || approvalRef.current !== null) return true;

      if (searchQueryRef.current !== null) {
        const flat = flattenPaste(pasted);
        const next = insertTextAt(searchQueryRef.current, searchCaretRef.current, flat);
        setSearchQuery(next.value);
        setSearchCaret(next.caret);
        return true;
      }

      const active = promptRef.current;
      if (active !== null && active.type !== "chat") {
        if (active.type === "filepicker") {
          const flat = flattenPaste(pasted);
          updatePromptFile((state) => {
            const next = insertTextAt(state.filter, state.filterCaret, flat);
            return { ...state, filter: next.value, filterCaret: next.caret, selected: 0 };
          });
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
            const nextFilter = insertTextAt(state.filter, state.filterCaret, flat);
            const choices = choicesAtIndices(
              sourceChoices,
              matchingChoiceIndices(sourceChoices, nextFilter.value),
            );
            return {
              ...state,
              filter: nextFilter.value,
              filterCaret: nextFilter.caret,
              selected: firstEnabledChoice(choices),
            };
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
        if (allowsCustomAnswer(active) && questionState.selected === visibleChoices.length) {
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
    [
      insertAtCaret,
      updatePromptEditor,
      updatePromptFile,
      updatePromptQuestion,
      setMenuFilter,
      setMenuIndex,
    ],
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
      // there is anything to cancel; otherwise it arms a warning and only the
      // second press (within the window) acts — resuming a chat conversation
      // rather than killing the whole process, since /exit already returns
      // cleanly to the wizard's main menu.
      if (isInterruptChord({ name, ctrl, shift, super: superKey, sequence })) {
        // Home has nothing to interrupt and no transcript to show a "press again" warning in,
        // so ctrl+c quits it at once, as esc on an empty composer does.
        if (menuRef.current?.kind === "home" && interrupt.current === null) {
          disarmQuit();
          store.completePrompt({ kind: "exit" });
          return true;
        }
        if (interrupt.current !== null && quitArmed.current === false) {
          quitArmed.current = true;
          announceStop();
          interrupt.current();
          return true;
        }

        if (quitArmed.current === false) {
          quitArmed.current = true;
          const inChat = promptRef.current?.type === "chat";
          store.printOutput({
            type: "warn",
            message: inChat
              ? "Press Ctrl+C again to leave this conversation and return to the main menu."
              : "Press Ctrl+C again to exit.",
            timestamp: new Date(),
          });
          quitArmTimer.current = setTimeout(() => {
            quitArmed.current = false;
            quitArmTimer.current = null;
          }, QUIT_CONFIRM_WINDOW_MS);
          return true;
        }

        disarmQuit();
        const active = promptRef.current;
        if (active?.type === "chat") {
          active.resolve("/exit");
        } else {
          process.kill(process.pid, "SIGINT");
        }
        return true;
      }

      // Ctrl+B: detach whatever tool call is currently running into the background
      // instead of killing it — a no-op (falls through) when nothing is running to
      // detach, unlike Ctrl+C which always does something.
      if (isBackgroundChord({ name, ctrl, shift, super: superKey, sequence })) {
        if (background.current !== null) {
          background.current();
          return true;
        }
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

      // A menu is a modal question: it owns the keyboard until it is answered.
      const openMenu = menuRef.current;
      if (openMenu !== null) {
        if (openMenu.kind === "skills") {
          const detail = skillDetailRef.current;
          if (detail !== null) {
            if (name === "escape" || name === "return" || name === "enter") {
              setSkillDetail(null);
              setSkillDetailOffset(0);
            } else if (
              name === "up" ||
              name === "k" ||
              name === "down" ||
              name === "j" ||
              name === "pageup" ||
              name === "pagedown"
            ) {
              const maxOffset = Math.max(
                0,
                skillDetailRows(detail, viewport.width).length - skillDetailBodyRows(viewport),
              );
              const step =
                name === "pageup" || name === "pagedown" ? skillDetailBodyRows(viewport) : 1;
              const direction = name === "up" || name === "k" || name === "pageup" ? -1 : 1;
              setSkillDetailOffset(
                Math.max(0, Math.min(maxOffset, skillDetailOffsetRef.current + direction * step)),
              );
            }
            return true;
          }
          if (name === "escape") {
            store.completePrompt({ kind: "exit" });
            return true;
          }
          const field = menuFilterRef.current;
          const matches = filterSkills(openMenu.skills, field.value);
          const selected = menuIndexForRef.current === openMenu ? menuIndexRef.current : 0;
          if (name === "up" || name === "down" || name === "pageup" || name === "pagedown") {
            const step = name === "pageup" || name === "pagedown" ? skillListRows(viewport) : 1;
            const direction = name === "up" || name === "pageup" ? -1 : 1;
            menuIndexForRef.current = openMenu;
            setMenuIndex(
              Math.max(0, Math.min(Math.max(0, matches.length - 1), selected + direction * step)),
            );
            return true;
          }
          if (name === "return" || name === "enter") {
            const skill = matches[selected];
            if (skill !== undefined) {
              setSkillDetail(skill);
              setSkillDetailOffset(0);
            }
            return true;
          }
          const nextField = applyTextFieldKey(field, {
            name,
            sequence,
            ctrl,
            meta,
            option,
            super: superKey,
          });
          if (nextField !== null) {
            setMenuFilter(nextField);
            if (nextField.value !== field.value) {
              menuIndexForRef.current = openMenu;
              setMenuIndex(0);
            }
          }
          return true;
        }
        if (openMenu.kind === "agent-details") {
          const menuSelection = menuIndexForRef.current === openMenu ? menuIndexRef.current : 0;
          const maxOffset = Math.max(
            0,
            agentDetailsRows(openMenu.fields, viewport.width).length -
              agentDetailsBodyHeight(viewport),
          );
          if (name === "up" || name === "k" || name === "down" || name === "j") {
            menuIndexForRef.current = openMenu;
            setMenuIndex(
              Math.max(
                0,
                Math.min(maxOffset, menuSelection + (name === "up" || name === "k" ? -1 : 1)),
              ),
            );
            return true;
          }
          if (name === "escape" || name === "q" || name === "return" || name === "enter") {
            store.completePrompt({ kind: "exit" });
            return true;
          }
          return true;
        }
        if (openMenu.kind === "agents") {
          // Typing filters, so letters are query text here and only the arrows,
          // enter and esc navigate. The index is into the filtered list.
          const field = menuFilterRef.current;
          const matches = filterAgents(openMenu.agents, field.value);
          const selected =
            menuIndexForRef.current === openMenu
              ? menuIndexRef.current
              : field.value === ""
                ? (openMenu.initialIndex ?? 0)
                : 0;
          if (name === "up" || name === "down" || name === "pageup" || name === "pagedown") {
            const step = name === "pageup" || name === "pagedown" ? listRowsFor(viewport) : 1;
            const direction = name === "up" || name === "pageup" ? -1 : 1;
            menuIndexForRef.current = openMenu;
            setMenuIndex(
              Math.max(0, Math.min(Math.max(0, matches.length - 1), selected + direction * step)),
            );
            return true;
          }
          if (name === "return" || name === "enter") {
            const choice = matches[selected]?.agent;
            if (choice !== undefined) store.completePrompt({ kind: "select", value: choice.id });
            return true;
          }
          if (name === "escape") {
            if (field.value !== "") {
              setMenuFilter({ value: "", caret: 0 });
              menuIndexForRef.current = openMenu;
              setMenuIndex(openMenu.initialIndex ?? 0);
              return true;
            }
            store.completePrompt({ kind: "exit" });
            return true;
          }
          const nextField = applyTextFieldKey(field, {
            name,
            sequence,
            ctrl,
            meta,
            option,
            super: superKey,
          });
          if (nextField !== null) {
            setMenuFilter(nextField);
            if (nextField.value !== field.value) {
              menuIndexForRef.current = openMenu;
              setMenuIndex(0);
            }
          }
          return true;
        }
        if (openMenu.kind === "home") {
          const draft = menuFilterRef.current;
          const intent = homeIntent(
            { ...openMenu, version: packageJson.version },
            {
              agentId: homeAgentIdRef.current,
              waitingValue: homeWaitingValueRef.current,
              draft: draft.value,
              commandIndex: menuIndexRef.current,
            },
            { name, sequence, ctrl, meta },
          );
          if (intent.kind === "quit") {
            store.completePrompt({ kind: "exit" });
            return true;
          }
          if (intent.kind === "answer") {
            store.completePrompt({
              kind: "select",
              value: intent.value,
              ...(intent.text === undefined ? {} : { text: intent.text }),
            });
            return true;
          }
          const { patch } = intent;
          if (patch.agentId !== undefined) {
            setHomeAgentId(patch.agentId);
          }
          if ("waitingValue" in patch) {
            setHomeWaitingValue(patch.waitingValue);
          }
          if (patch.commandIndex !== undefined) {
            menuIndexForRef.current = openMenu;
            setMenuIndex(patch.commandIndex);
          }
          const field =
            patch.draft === undefined
              ? draft
              : { value: patch.draft, caret: [...patch.draft].length };
          if (patch.draft !== undefined) {
            setMenuFilter(field);
          }
          if (intent.edit && openMenu.firstRun === undefined) {
            const next = applyTextFieldKey(field, {
              name,
              sequence,
              ctrl,
              meta,
              option,
              super: superKey,
            });
            if (next !== null) {
              setMenuFilter(next);
            }
          }
          return true;
        }
        const itemCount = openMenu.options.length;
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
          const choice = openMenu.options[menuSelection];
          if (choice !== undefined) {
            store.completePrompt({ kind: "select", value: choice.value });
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
        if (isCtrlLetter({ name, ctrl }, "o")) {
          setApprovalExpanded((current) => !current);
          setApprovalFieldOffset(0);
          return true;
        }
        if (name === "up" || name === "down" || name === "pageup" || name === "pagedown") {
          const delta = name === "up" ? -1 : name === "down" ? 1 : name === "pageup" ? -5 : 5;
          setApprovalFieldOffset((offset) => Math.max(0, offset + delta));
          return true;
        }
        if (approvalArmedForRef.current !== approvalRef.current) return true;
        if (active === null) return true;
        if (name === "left" || name === "right") {
          const choices = approvalChoicesFor(approvalRef.current);
          setApprovalChoice((current) => {
            const index = choices.indexOf(current) + (name === "left" ? -1 : 1);
            return choices[Math.max(0, Math.min(choices.length - 1, index))] ?? current;
          });
          return true;
        }
        if (name === "return" || name === "enter") {
          const chosen = approvalChoiceRef.current;
          active.resolve(
            chosen === "reject"
              ? "no"
              : chosen === "always" && approvalChoicesFor(approvalRef.current).includes("always")
                ? alwaysApprovalValue(active)
                : "yes",
          );
          return true;
        }
        // `e` rewrites the tool's editable argument first. Like accept, it waits for the
        // card to arm, so a keystroke typed before the card appeared cannot open it.
        if (
          name === "e" &&
          !ctrl &&
          !superKey &&
          !meta &&
          !option &&
          approvalRef.current.editableArg !== undefined
        ) {
          active.resolve("edit");
          return true;
        }
        // Unmodified `a` only. Ctrl+A and Cmd+A are "go to start of line" in
        // the composer, and the standing allowlist this writes outlives the
        // turn — a caret keystroke must never be able to grant it.
        if (
          name === "a" &&
          !ctrl &&
          !superKey &&
          !meta &&
          !option &&
          approvalChoicesFor(approvalRef.current).includes("always")
        ) {
          active.resolve(alwaysApprovalValue(active));
          return true;
        }
        return true;
      }

      // Ctrl+E with an empty composer expands the newest write/edit receipt's full
      // diff in place (repeat walks back through older receipts, the way Ctrl+R
      // walks reasoning), or the last long tool output for the approval flow.
      // With text in the composer the key falls through to end-of-line below —
      // returning early would skip the line-motion handler further down.
      if (isCtrlLetter({ name, ctrl }, "e") && composerRef.current.text.length === 0) {
        if (store.toggleLastReceiptDiff()) {
          return true;
        }
        const payload = store.getExpandableDiff();
        if (payload !== null && payload !== undefined) {
          store.printOutput({
            type: "log",
            message: { kind: "expanded", text: payload.fullDiff },
            timestamp: new Date(),
          });
        }
        return true;
      }

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
            message: { kind: "expanded", text: payload.fullDiff },
            timestamp: new Date(),
          });
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
        const activeQuery = searchQueryRef.current;
        if (activeQuery !== null) {
          const nextField = applyTextFieldKey(
            { value: activeQuery, caret: searchCaretRef.current },
            { name, sequence, ctrl, meta, option, super: superKey },
          );
          if (nextField !== null) {
            setSearchQuery(nextField.value);
            setSearchCaret(nextField.caret);
          }
        }
        return true;
      }

      // The approval mode belongs to the session, not the composer: it toggles while a slash
      // command runs or one of its prompts is open, which both leave the composer unavailable.
      // It stays behind the approval card above, so a pending decision cannot be flipped.
      if (name === "tab" && shift) {
        store.toggleMode();
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
          const keys = hiddenPromptKeys(active);
          if (keys !== undefined) {
            if (name === "up" || name === "down") return false;
            if (keys.includes(sequence)) active.resolve(sequence);
            return true;
          }
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
              updatePromptFile((state) => ({
                ...state,
                filter: entry.name,
                filterCaret: [...entry.name].length,
                selected: 0,
              }));
            }
            return true;
          }
          {
            const nextFilterField = applyTextFieldKey(
              { value: fileState.filter, caret: fileState.filterCaret },
              { name, sequence, ctrl, meta, option, super: superKey },
            );
            if (nextFilterField !== null) {
              updatePromptFile((state) => ({
                ...state,
                filter: nextFilterField.value,
                filterCaret: nextFilterField.caret,
                selected: 0,
              }));
              return true;
            }
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
          return true;
        }

        if (active.type === "theme") {
          const rows = themePickerRows(active);
          const current = promptControlsRef.current.question.selected;
          const target = themePickerTarget(rows, current, { name, sequence });
          if (target !== null) {
            updatePromptQuestion((state) => ({ ...state, selected: target }));
            const row = rows[target];
            if (row !== undefined) previewTheme(row.id);
            return true;
          }
          if (name === "return" || name === "enter") {
            const row = rows[current];
            if (row !== undefined) active.resolve(row.id);
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
          {
            const editorState = promptControlsRef.current.editor;
            const nextField = applyTextFieldKey(
              { value: editorState.value, caret: editorState.caret },
              { name, sequence, ctrl, meta, option, super: superKey },
            );
            if (nextField !== null) {
              updatePromptEditor(() => nextField);
              return true;
            }
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
        const allowCustom = allowsCustomAnswer(active);
        const allowMultiple = allowsMultipleAnswers(active);
        const typedAnswer = typedAnswerFor(active, questionState.filter);

        const binary = binaryAnswers(active, sourceChoices);
        const typingCustom = allowCustom && questionState.selected === visibleChoices.length;
        const plainKey = !ctrl && !meta && !option && !superKey;

        if (binary !== undefined && !typingCustom && plainKey && (name === "y" || name === "n")) {
          const answer = sourceChoices[name === "y" ? binary.yes : binary.no];
          if (answer !== undefined) active.resolve(answer.value);
          return true;
        }
        if (binary !== undefined && !typingCustom && (name === "left" || name === "right")) {
          updatePromptQuestion((state) => ({
            ...state,
            selected: name === "left" ? 0 : 1,
          }));
          return true;
        }

        // Number keys pick a row at once. They stay text while a filter or the
        // free-text row is taking input, where a digit is part of the answer.
        const quickPick = /^[1-9]$/.test(sequence) ? Number(sequence) - 1 : undefined;
        if (
          quickPick !== undefined &&
          plainKey &&
          binary === undefined &&
          !typingCustom &&
          !promptIsFilterable(active) &&
          quickPick < Math.min(visibleChoices.length, MAX_QUICK_PICK)
        ) {
          const originalIndex = filteredIndices[quickPick];
          const picked = visibleChoices[quickPick];
          if (originalIndex === undefined || picked === undefined || picked.disabled === true) {
            return true;
          }
          if (allowMultiple) {
            updatePromptQuestion((state) => ({
              ...state,
              selected: quickPick,
              checked: state.checked.includes(originalIndex)
                ? state.checked.filter((index) => index !== originalIndex)
                : [...state.checked, originalIndex],
            }));
            return true;
          }
          active.resolve(sourceChoices[originalIndex]?.value);
          return true;
        }

        if (name === "up" || name === "down") {
          updatePromptQuestion((state) => ({
            ...state,
            selected: moveChoice(
              visibleChoices,
              state.selected,
              name === "up" ? -1 : 1,
              allowCustom || typedAnswer !== undefined,
            ),
          }));
          return true;
        }
        if (promptIsFilterable(active)) {
          const nextFilterField = applyTextFieldKey(
            { value: questionState.filter, caret: questionState.filterCaret },
            { name, sequence, ctrl, meta, option, super: superKey },
          );
          if (nextFilterField !== null) {
            updatePromptQuestion((state) => {
              const choices = choicesAtIndices(
                sourceChoices,
                matchingChoiceIndices(sourceChoices, nextFilterField.value),
              );
              return {
                ...state,
                filter: nextFilterField.value,
                filterCaret: nextFilterField.caret,
                selected: firstEnabledChoice(choices),
              };
            });
            return true;
          }
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
          if (typedAnswer !== undefined && questionState.selected === visibleChoices.length) {
            active.options?.resolveTypedAnswer?.(typedAnswer);
            return true;
          }
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

        if (selectedCustom) {
          const nextCustomField = applyTextFieldKey(questionState.custom, {
            name,
            sequence,
            ctrl,
            meta,
            option,
            super: superKey,
          });
          if (nextCustomField !== null) {
            updatePromptQuestion((state) => ({ ...state, custom: nextCustomField }));
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

      // The sub-agent list has the keyboard: arrows move, Enter opens, Esc (or up
      // past the first row) hands it back. Any other key returns to the composer
      // and is handled there, so typing never needs a key to leave the list first.
      const runsNow = subagentRunsRef.current;
      const cursor = agentCursorRef.current;
      if (cursor !== null) {
        const lastRow = runsNow.length - 1;
        if (lastRow < 0) {
          setAgentCursor(null);
        } else {
          if (name === "up") {
            setAgentCursor(cursor <= 0 ? null : cursor - 1);
            return true;
          }
          if (name === "down") {
            setAgentCursor(Math.min(lastRow, cursor + 1));
            return true;
          }
          if (name === "return" || name === "enter") {
            const chosen = runsNow[Math.min(cursor, lastRow)];
            setAgentCursor(null);
            if (chosen !== undefined) inspectSubagent(chosen.id);
            return true;
          }
          setAgentCursor(null);
          if (name === "escape") return true;
        }
      }
      if (name === "escape" && inspectedIdRef.current !== null) {
        inspectSubagent(null);
        return true;
      }
      if (name === "down" && runsNow.length > 0 && composerRef.current.text.length === 0) {
        const firstRunning = runsNow.findIndex((run) => run.status === "running");
        setAgentCursor(firstRunning < 0 ? 0 : firstRunning);
        return true;
      }

      if (isCtrlLetter({ name, ctrl }, "f")) {
        setSearchQuery("");
        setSearchCaret(0);
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
        if (
          (name === "tab" && !shift) ||
          ((name === "return" || name === "enter") &&
            !isComposerNewline({ name, shift, option, meta }))
        ) {
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

      if (
        inspectedIdRef.current !== null &&
        (name === "return" || name === "enter") &&
        !isComposerNewline({ name, shift, option, meta })
      ) {
        sendToInspectedSubagent();
        return true;
      }

      const slashQuery =
        inspectedIdRef.current === null ? slashCommandQuery(composerRef.current.text) : null;
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
        if (
          (name === "return" || name === "enter") &&
          !isComposerNewline({ name, shift, option, meta })
        ) {
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
      if (name === "up" || name === "down") {
        const current = composerRef.current;
        const characters = [...current.text];
        const target = moveCaretVertical(characters, current.caret, name === "up" ? UP : DOWN);
        if (target !== current.caret) {
          moveComposer(target, shift);
        }
        return true;
      }

      // Cmd+Backspace on macOS and the classic readline Ctrl+U both mean
      // "delete to the start of the line" — checked before the word-delete
      // binding below since Cmd is reported via `super`, not `meta`/`option`.
      if ((name === "backspace" && superKey) || isCtrlLetter({ name, ctrl }, "u")) {
        deleteLineBeforeCaret();
        return true;
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
          historyIndex.current = null;
          commitComposer((current) => typeCharacter(current, sequence));
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
      deleteLineBeforeCaret,
      updatePromptEditor,
      updatePromptQuestion,
      updatePromptFile,
      disarmQuit,
      agentCursorRef,
      inspectedIdRef,
      setAgentCursor,
      inspectSubagent,
      sendToInspectedSubagent,
      setMenuFilter,
      setSkillDetail,
      setSkillDetailOffset,
      setMenuIndex,
    ],
  );

  const onAction = useCallback(
    (action: KeyAction) => {
      if (action.type === "interrupt") {
        announceStop();
        store.collapseAllEphemeral();
        interrupt.current?.();
      }
      if (action.type === "flush-queue") {
        // Enqueue the current draft alongside anything already queued, then ask
        // the chat loop to drain the lot into the running conversation now.
        const draft = composerRef.current.text;
        if (draft.length > 0) {
          store.appendToQueue(draft);
          commitComposer(EMPTY_COMPOSER);
        }
        store.requestFlushQueue();
        announceStop();
        store.collapseAllEphemeral();
        interrupt.current?.();
        return;
      }
      if (action.type === "stash-draft") commitComposer(EMPTY_COMPOSER);
      if (action.type === "close-overlay" && approval !== null) prompt?.resolve("no");
    },
    [approval, prompt, commitComposer],
  );

  const inspectedRun: SubagentRun | undefined =
    inspectedId === null ? undefined : subagentRuns.find((run) => run.id === inspectedId);

  const previousBlocks = useRef<readonly Block[]>([]);
  const blocks = useMemo(() => {
    const next =
      inspectedRun === undefined
        ? transcriptBlocks(
            {
              outputs,
              streaming,
              regions,
              expandedReasoningIds: presentation.expandedReasoningIds,
              liveReasoningIds: presentation.liveReasoningIds,
              ...(presentation.document.streamingId === undefined
                ? {}
                : { streamingId: presentation.document.streamingId }),
            },
            previousBlocks.current,
          )
        : shareUnchangedBlocks(previousBlocks.current, subagentBlocks(inspectedRun, Date.now()));
    previousBlocks.current = next;
    return next;
    // elapsedMs ticks the open sub-agent's heading clock.
  }, [
    outputs,
    streaming,
    regions,
    inspectedRun,
    elapsedMs,
    presentation.expandedReasoningIds,
    presentation.liveReasoningIds,
    presentation.document.streamingId,
  ]);

  stopContextRef.current = {
    receipts: currentTurnReceipts(blocks),
    runningTools: tools,
    ...(approval === null ? {} : { pendingApproval: approvalTitle(approval.executeToolName) }),
    todos: todoList,
  };

  const subagentList = useMemo<SubagentListModel | undefined>(() => {
    if (subagentRuns.length === 0) return undefined;
    const now = Date.now();
    return {
      items: subagentRuns.map((run) => subagentListItem(run, now)),
      ...(agentCursor === null ? {} : { selected: agentCursor }),
      ...(inspectedId === null ? {} : { inspecting: inspectedId }),
    };
    // elapsedMs ticks the per-row clocks.
  }, [subagentRuns, agentCursor, inspectedId, elapsedMs]);

  const header = useMemo<HeaderModel>(() => {
    const localHost = hostForModel(stats.provider, stats.model, stats.localModelHosts);
    return {
      version: packageJson.version,
      cwd: compactWorkingDirectory(workingDirectory),
      model: stats.model ?? "no model",
      ...(localHost === undefined ? {} : { localHost }),
      ...(stats.reasoning === undefined ? {} : { reasoning: stats.reasoning }),
      connectors: [...connectors].map(([name, status]) => ({ name, status })),
      contextUsed: stats.tokensInContext ?? 0,
      contextMax: stats.maxContextTokens ?? 0,
    };
  }, [
    workingDirectory,
    stats.model,
    stats.provider,
    stats.reasoning,
    stats.localModelHosts,
    stats.tokensInContext,
    stats.maxContextTokens,
    connectors,
  ]);

  const overlay = useMemo<Overlay | undefined>(() => {
    // An approval outranks search: it is a decision the agent is blocked on, and
    // it arrived because the user asked for something.
    const promptOverlay = overlayFromPrompt(prompt, promptControls);
    let next: Overlay | undefined = promptOverlay;
    if (searchQuery !== null) {
      next = {
        kind: "search",
        query: searchQuery,
        caret: searchCaret,
        scope: searchScope,
        // `current` means the hit is in this session; `selected` is the cursor.
        // Conflating them would show recency wrong on every row but one.
        hits: searchHits,
        selected: searchIndex,
      };
    }
    if (approval !== null) {
      next = approvalFrom(
        approval,
        approvalArmed,
        approvalFieldOffset,
        approvalExpanded,
        approvalChoice,
      );
    }
    return next;
  }, [
    prompt,
    promptControls,
    searchQuery,
    searchCaret,
    searchScope,
    searchHits,
    searchIndex,
    approval,
    approvalArmed,
    approvalFieldOffset,
    approvalExpanded,
    approvalChoice,
  ]);

  const inspectedRunning = inspectedRun?.status === "running";
  const inspectedSteerable = inspectedRunning && inspectedRun?.acceptsMessages === true;
  const input = useMemo<InputModel>(() => {
    const inspecting = inspectedRun !== undefined;
    const commandItems =
      commandQuery === null || inspecting ? [] : filterCommandsByPrefix(commandQuery);
    const mentionItems = mention === null ? [] : mentionEntries;
    const menu = mergeSuggestions(commandItems, mentionItems);
    const commands: InputModel["commands"] =
      menu === undefined
        ? undefined
        : {
            items: menu.items,
            selected: wrapCommandIndex(commandIndex, menu.items.length),
            prefix: menu.prefix,
            ...(menu.prefix === "/" && commandQuery !== null ? { query: commandQuery } : {}),
          };
    return {
      value: draft,
      caret: draftCaret,
      anchor: draftAnchor,
      placeholder:
        inspectedRun !== undefined
          ? inspectedSteerable
            ? `Message ${inspectedRun.label}`
            : inspectedRunning
              ? `${inspectedRun.label} can't take messages · esc to go back`
              : `${inspectedRun.label} finished · esc to go back`
          : busy
            ? "Type to queue for next turn"
            : "Ask anything",
      queued: queue,
      queueing: !inspecting && (busy || queue.length > 0),
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
    inspectedRun,
    inspectedRunning,
    inspectedSteerable,
  ]);

  const footer = useMemo<FooterModel>(
    () => ({
      mode: isYolo ? "yolo" : "safe",
      hints:
        prompt !== null && hiddenPromptKeys(prompt) !== undefined
          ? prompt.message.split(", ")
          : agentCursor !== null
            ? ["up down to choose", "enter to open", "esc to close"]
            : inspectedRun !== undefined
              ? inspectedSteerable
                ? ["enter to send", "pgup to scroll", "esc back to main"]
                : ["pgup to scroll", "esc back to main"]
              : [],
      ...(subagentNotice === undefined ? {} : { notice: subagentNotice }),
      ...(stats.promptTokens === undefined && stats.completionTokens === undefined
        ? {}
        : {
            promptTokens: stats.promptTokens ?? 0,
            completionTokens: stats.completionTokens ?? 0,
          }),
      ...(stats.costUSD === undefined ? {} : { costUsd: stats.costUSD }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    }),
    [
      isYolo,
      prompt,
      stats.promptTokens,
      stats.completionTokens,
      stats.costUSD,
      elapsedMs,
      agentCursor,
      inspectedRun,
      inspectedSteerable,
      subagentNotice,
    ],
  );

  const live = useMemo<LiveModel>(() => {
    const reasoningElapsedMs = liveReasoningElapsedMs(regions, Date.now());
    return {
      tools,
      hiddenTools: [],
      ...(step === undefined ? {} : { step }),
      ...(todoList.length === 0 ? {} : { todoList }),
      ...(waitingNow ? { waiting: waitingLabel(activity.phase, elapsedMs) } : {}),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      reservedRows,
      ...(reasoningElapsedMs === undefined ? {} : { reasoningElapsedMs }),
      // Recomputed on the once-a-second clock below, which is what moves the countdown.
      ...(retryNotice === null ? {} : { retry: retryBand(retryNotice, Date.now()) }),
    };
  }, [
    tools,
    step,
    todoList,
    waitingNow,
    activity.phase,
    elapsedMs,
    reservedRows,
    regions,
    retryNotice,
  ]);

  const view = useMemo<ViewModel>(
    () => ({
      header,
      blocks,
      documentId: `${presentation.document.id}:generation:${presentation.documentGeneration}:${inspectedRun === undefined ? "main" : `child:${inspectedRun.id}`}`,
      runActive,
      live,
      input,
      footer,
      ...(subagentList === undefined ? {} : { subagents: subagentList }),
      ...(overlay === undefined ? {} : { overlay }),
      focus: "input",
    }),
    [
      header,
      blocks,
      runActive,
      live,
      input,
      footer,
      subagentList,
      overlay,
      presentation.document.id,
      presentation.documentGeneration,
      inspectedRun,
    ],
  );

  // A menu the app is waiting on gets the real screen. The wizard publishes it
  // as data precisely so a renderer that cannot paint an Ink tree can still draw
  // it — which is what makes the flow work here at all.
  //
  // This is content passed *into* App as `overrideContent`, never returned in
  // its place. App's own `useKeyboard` call has to stay mounted for any of this
  // to receive a key at all — arrows, enter, or Ctrl+C.
  const overrideContent: React.ReactNode | undefined =
    menu?.kind === "skills" ? (
      <SkillBrowser
        skills={menu.skills}
        query={menuFilter.value}
        caret={menuFilter.caret}
        selected={menuIndex}
        detail={skillDetail}
        detailOffset={skillDetailOffset}
        viewport={viewport}
      />
    ) : menu?.kind === "agent-details" ? (
      <AgentDetails
        {...menu}
        offset={menuIndex}
        viewport={viewport}
      />
    ) : menu?.kind === "agents" ? (
      <AgentPicker
        agents={menu.agents}
        selectedIndex={menuIndex}
        viewport={viewport}
        title={menu.title}
        action={menu.action}
        query={menuFilter.value}
        caret={menuFilter.caret}
      />
    ) : menu?.kind === "home" ? (
      <Home
        model={{ ...menu, version: packageJson.version }}
        viewport={viewport}
        state={{
          agentId: homeAgentId,
          waitingValue: homeWaitingValue,
          draft: menuFilter.value,
          commandIndex: menuIndex,
        }}
        caret={menuFilter.caret}
      />
    ) : menu?.kind === "menu" ? (
      <MenuScreen
        title={menu.title ?? "menu"}
        choices={menu.options}
        selected={menuIndex}
        viewport={viewport}
      />
    ) : undefined;

  return (
    <App
      view={view}
      submitCount={submitCount}
      onAction={onAction}
      onKey={onKey}
      onPaste={applyPaste}
      onWatchingLiveEdgeChange={store.setReaderFollowing}
      {...(overrideContent === undefined ? {} : { overrideContent })}
    />
  );
}
