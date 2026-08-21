/** @jsxImportSource @opentui/react */
/**
 * Drives the fullscreen interface from the live UI store.
 *
 * The store already carries everything the interface needs, through a
 * register-setter / read-snapshot contract that the Ink islands use too. So
 * fullscreen needs no new presentation service: the same service writes to the
 * store, and whoever registered the setters renders. This module is the only
 * place where live state becomes a `ViewModel`, which is what keeps every
 * region a pure function of data.
 *
 * The mapping is deliberately lossy in one direction. The store speaks in
 * output entries and activity phases, which are a log; the interface speaks in
 * blocks, which are a document. Turning the first into the second is what makes
 * scroll anchoring, collapse and copy-out possible at all.
 */

import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { search, type SearchHit } from "@/services/history/session-search";
import type { ActivityState } from "../activity-state";
import {
  store,
  type ActiveMenu,
  type ConnectorStatus,
  type EphemeralRegion,
  type PendingApproval,
  type RunStats,
} from "../store";
import type { OutputEntry, PromptState } from "../types";
import { App, type KeyChord } from "./App";
import type { KeyAction } from "./keymap";
import { Home } from "./screens/Home";
import {
  LIVE_ZONE_MAX_ROWS,
  type ApprovalOverlay,
  type Block,
  type LiveTool,
  type Overlay,
  type ViewModel,
} from "./types";

/** Waiting copy, house voice: idiomatic, never jokey. */
const WAITING = ["comping behind you", "turning it over", "two horns out", "digging the crates"];

/** How long the band holds its height after the last tool finishes. */
const SETTLE_MS = 800;

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
  readonly durationMs?: number;
  readonly reason?: string;
  readonly detail?: string;
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
    ...(typeof record["durationMs"] === "number" ? { durationMs: record["durationMs"] } : {}),
    ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
    ...(typeof record["detail"] === "string" ? { detail: record["detail"] } : {}),
  };
}

/** `Array.isArray` alone widens a readonly array to `any[]`. */
function isEntryList(value: OutputEntry | readonly OutputEntry[]): value is readonly OutputEntry[] {
  return Array.isArray(value);
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
 * Output entries become blocks. Consecutive stream chunks are one agent turn
 * rather than one block each: the model emits prose in pieces, and a block per
 * piece would make the transcript unscrollable and the markdown unparseable.
 */
function blocksFrom(entries: readonly OutputEntry[], streaming: string): Block[] {
  const blocks: Block[] = [];
  let seq = 0;

  for (const entry of entries) {
    const plainText = entry.meta?.["plainText"];
    const text = typeof plainText === "string" ? plainText : textOf(entry.message);
    if (text.trim().length === 0) continue;
    const id = entry.id ?? `b${String(seq)}`;

    if (entry.type === "user") {
      blocks.push({ id, seq: seq++, kind: "user", text });
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

    const receipt = receiptOf(entry);
    if (receipt !== null) {
      blocks.push({
        id,
        seq: seq++,
        kind: "tool",
        app: receipt.app,
        summary: receipt.summary,
        status: receipt.status,
        ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
        ...(receipt.durationMs === undefined ? {} : { durationMs: receipt.durationMs }),
        ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
      });
      continue;
    }

    const tone = entry.type === "error" ? "error" : entry.type === "warn" ? "warn" : "info";
    blocks.push({ id, seq: seq++, kind: "notice", text, tone });
  }

  // The turn still being written, appended live so prose streams in place.
  if (streaming.trim().length > 0) {
    blocks.push({
      id: "streaming",
      seq,
      kind: "agent",
      markdown: streaming,
      streaming: true,
    });
  }
  return blocks;
}

function liveToolsFrom(activity: ActivityState, now: number): LiveTool[] {
  if (activity.phase !== "tool-execution") return [];
  return activity.tools.map((tool, index) => ({
    app: tool.toolName,
    operation: "",
    elapsedMs: Math.max(0, now - tool.startedAt),
    phase: index,
  }));
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

function approvalFrom(pending: PendingApproval): ApprovalOverlay {
  const entries = Object.entries(pending.args).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const accountEntry = entries.find(([key]) => ACCOUNT_KEYS.includes(key));
  const app = pending.toolName.split(/[_.]/)[0] ?? pending.toolName;

  return {
    kind: "approval",
    app,
    action: pending.executeToolName.replace(/[_.]/g, " "),
    account: accountEntry === undefined ? "this machine" : String(accountEntry[1]),
    fields: entries
      .filter(([key]) => key !== accountEntry?.[0])
      .slice(0, 8)
      .map(([label, value]) => ({
        label,
        value: typeof value === "string" ? value : JSON.stringify(value),
      })),
    consequence: pending.message,
    armed: true,
  };
}

const VERSION = "0.14.2";

export function FullscreenBridge(): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const viewport = { width, height };
  const [outputs, setOutputs] = useState<readonly OutputEntry[]>([]);
  const [streaming, setStreaming] = useState("");
  const [activity, setActivity] = useState<ActivityState>({ phase: "idle" });
  const [stats, setStats] = useState<RunStats>({});
  const [queue, setQueue] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [regions, setRegions] = useState<readonly EphemeralRegion[]>([]);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [draft, setDraft] = useState("");
  // Code-point offset, not a JS string index — every splice below operates on
  // `[...text]` for exactly that reason, so a multi-byte character never gets
  // cut in half.
  const [draftCaret, setDraftCaret] = useState(0);
  const [customView, setCustomView] = useState<React.ReactNode | null>(null);
  const [connectors, setConnectors] = useState<ReadonlyMap<string, ConnectorStatus>>(new Map());
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<readonly SearchHit[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [menu, setMenu] = useState<ActiveMenu | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [tick, setTick] = useState(0);

  // `useKeyboard` registers its callback once, so a closure over state would keep
  // reading the values from the first render — where `prompt` is null, and a null
  // prompt makes the handler return before it reads a single keystroke. Refs are
  // correct regardless of the hook's registration semantics.
  const promptRef = useRef<PromptState | null>(null);
  const draftRef = useRef("");
  const draftCaretRef = useRef(0);
  const approvalRef = useRef<PendingApproval | null>(null);
  const searchQueryRef = useRef<string | null>(null);
  const searchHitsRef = useRef<readonly SearchHit[]>([]);
  const menuRef = useRef<ActiveMenu | null>(null);
  const menuIndexRef = useRef(0);

  promptRef.current = prompt;
  draftRef.current = draft;
  draftCaretRef.current = draftCaret;
  approvalRef.current = approval;
  searchQueryRef.current = searchQuery;
  searchHitsRef.current = searchHits;
  menuRef.current = menu;
  menuIndexRef.current = menuIndex;

  const interrupt = useRef<(() => void) | null>(null);
  const quitArmed = useRef(false);
  const reserved = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    store.registerPrintOutput((entry) => {
      const incoming: readonly OutputEntry[] = isEntryList(entry) ? entry : [entry];
      setOutputs((previous) => [...previous, ...incoming]);
      return "";
    });
    store.registerClearOutputs(() => {
      setOutputs([]);
      setStreaming("");
    });
    // Streaming bypasses printOutput entirely, so without this the agent's prose
    // would never appear.
    store.registerStreamingHandler({
      appendStream: (_kind, delta) => setStreaming((previous) => previous + delta),
      finalizeStream: () => {
        setStreaming((text) => {
          if (text.trim().length > 0) {
            setOutputs((previous) => [
              ...previous,
              { type: "streamContent", message: text, timestamp: new Date() },
            ]);
          }
          return "";
        });
      },
    });
    store.registerActivitySetter(setActivity);
    store.registerRunStatsSetter(setStats);
    store.registerMessageQueueSetter(setQueue);
    store.registerChatBusySetter(setBusy);
    store.registerEphemeralRegionsSetter(setRegions);
    store.registerPromptSetter(setPrompt);
    store.registerApprovalRequestSetter(setApproval);
    store.registerCustomView(setCustomView);
    store.registerConnectorsSetter(setConnectors);
    store.registerActiveMenuSetter((next) => {
      setMenu(next);
      setMenuIndex(0);
    });
    store.registerInterruptHandler((handler) => {
      interrupt.current = handler;
    });

    // Anything that happened before this mounted.
    setActivity(store.getActivitySnapshot());
    setStats(store.getRunStatsSnapshot());
    const pending = store.drainPendingOutputQueue();
    if (pending.length > 0) setOutputs((previous) => [...previous, ...pending]);

    return () => {
      store.registerStreamingHandler(null);
    };
  }, []);

  const running = activity.phase === "tool-execution" || activity.phase === "awaiting";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((value) => value + 1), 170);
    return () => clearInterval(timer);
  }, [running]);

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
      void search(query, { scope: "all", limit: 40 })
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
  }, [searchQuery]);

  const insertAtCaret = useCallback((text: string) => {
    setDraft((value) => {
      const characters = [...value];
      const at = Math.max(0, Math.min(draftCaretRef.current, characters.length));
      return [...characters.slice(0, at), text, ...characters.slice(at)].join("");
    });
    setDraftCaret((at) => at + [...text].length);
  }, []);

  /**
   * Deletes the previous word, the way option+Backspace and Ctrl+Backspace do
   * in every text field on both platforms: skip the run of whitespace
   * immediately before the caret, then delete the non-whitespace run before
   * that. Operates in code points throughout.
   */
  const deleteWordBeforeCaret = useCallback(() => {
    setDraft((value) => {
      const characters = [...value];
      const at = Math.max(0, Math.min(draftCaretRef.current, characters.length));
      const start = wordStartBefore(characters, at);
      setDraftCaret(start);
      return [...characters.slice(0, start), ...characters.slice(at)].join("");
    });
  }, []);

  const submit = useCallback(
    (text: string) => {
      const active = promptRef.current;
      if (active === null || text.trim().length === 0) return;
      setDraft("");
      setDraftCaret(0);
      active.resolve(text);
    },
    [prompt],
  );

  // The approval card owns the keyboard while it is up. Enter accepts, Esc
  // rejects, `a` is the always-allow path — and typing must not reach the
  // composer underneath.
  // First refusal on every key, handed to `App`, which owns the one keyboard
  // registration in the tree. Returning true consumes the key.
  const onKey = useCallback(
    ({ name, sequence, ctrl, meta, option, super: superKey }: KeyChord): boolean => {
      // Ctrl+C, before anything else and regardless of state — including a
      // modal that would otherwise swallow every key it does not recognise.
      //
      // The renderer is told not to exit on Ctrl+C so the agent loop can cancel
      // in-flight work instead of the process dying mid-tool-call. That makes
      // handling it here mandatory: an alternate screen you cannot leave is the
      // worst failure this interface can have, so the first press cancels if
      // there is anything to cancel and the second always quits.
      if (ctrl && name === "c") {
        if (interrupt.current !== null && quitArmed.current === false) {
          quitArmed.current = true;
          interrupt.current();
          return true;
        }
        process.kill(process.pid, "SIGINT");
        return true;
      }

      // A menu is a modal question: it owns the keyboard until it is answered.
      const openMenu = menuRef.current;
      if (openMenu !== null) {
        if (name === "up") {
          setMenuIndex((index) => Math.max(0, index - 1));
          return true;
        }
        if (name === "down") {
          setMenuIndex((index) => Math.min(openMenu.options.length - 1, index + 1));
          return true;
        }
        if (name === "return" || name === "enter") {
          const choice = openMenu.options[menuIndexRef.current];
          if (choice !== undefined) openMenu.onSelect(choice.value);
          return true;
        }
        if (name === "escape" || name === "q") {
          openMenu.onExit();
          return true;
        }
        return true;
      }
      const active = promptRef.current;

      // The approval card owns the keyboard while it is up: enter accepts, `a`
      // is the always-allow path, and typing must not reach the composer behind
      // it. Esc falls through to the ladder, which rejects.
      if (approvalRef.current !== null && active !== null) {
        if (name === "return" || name === "enter") {
          active.resolve("yes");
          return true;
        }
        if (name === "a") {
          active.resolve("always_tool");
          return true;
        }
        return name !== "escape";
      }

      // Search likewise owns the keyboard while it is open.
      if (searchQueryRef.current !== null) {
        if (name === "escape") {
          setSearchQuery(null);
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
        if ([...name].length === 1) {
          const code = name.codePointAt(0) ?? 0;
          if (code >= 0x20 && code !== 0x7f) setSearchQuery((value) => (value ?? "") + name);
        }
        return true;
      }

      if (active === null || active.type !== "chat") return false;

      // `/` on an empty composer opens history search rather than typing a
      // slash, which is what the footer advertises.
      if (name === "/" && draftRef.current.length === 0) {
        setSearchQuery("");
        return true;
      }
      if (name === "return" || name === "enter") {
        submit(draftRef.current);
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
        setDraft((value) => {
          const characters = [...value];
          const at = Math.max(0, Math.min(draftCaretRef.current, characters.length));
          if (at === 0) return value;
          return [...characters.slice(0, at - 1), ...characters.slice(at)].join("");
        });
        setDraftCaret((at) => Math.max(0, at - 1));
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
      const wordJump = meta || option || ctrl;
      if (name === "left" && superKey) {
        setDraftCaret((at) => lineStartBefore([...draftRef.current], at));
        return true;
      }
      if (name === "right" && superKey) {
        setDraftCaret((at) => lineEndAfter([...draftRef.current], at));
        return true;
      }
      if (name === "left" && wordJump) {
        setDraftCaret((at) => wordStartBefore([...draftRef.current], at));
        return true;
      }
      if (name === "right" && wordJump) {
        setDraftCaret((at) => wordEndAfter([...draftRef.current], at));
        return true;
      }
      if (name === "home" || (ctrl && name === "a")) {
        setDraftCaret((at) => lineStartBefore([...draftRef.current], at));
        return true;
      }
      if (name === "end" || (ctrl && name === "e")) {
        setDraftCaret((at) => lineEndAfter([...draftRef.current], at));
        return true;
      }
      if (name === "left") {
        setDraftCaret((at) => Math.max(0, at - 1));
        return true;
      }
      if (name === "right") {
        setDraftCaret((at) => Math.min([...draftRef.current].length, at + 1));
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
    [submit, insertAtCaret, deleteWordBeforeCaret],
  );

  const onAction = useCallback(
    (action: KeyAction) => {
      if (action.type === "interrupt") interrupt.current?.();
      if (action.type === "stash-draft") {
        setDraft("");
        setDraftCaret(0);
      }
      if (action.type === "close-overlay" && approval !== null) prompt?.resolve("no");
    },
    [approval, prompt],
  );

  const view = useMemo<ViewModel>(() => {
    const tools = liveToolsFrom(activity, Date.now());
    const extras =
      (activity.phase === "awaiting" ? 1 : 0) +
      (regions.some((region) => region.kind === "reasoning") ? 1 : 0);
    const needed = Math.min(LIVE_ZONE_MAX_ROWS, tools.length + extras);

    // High-water mark: grow to fit, fall only once the run settles, so the input
    // does not walk up and down as tools churn.
    if (needed > reserved.current) reserved.current = needed;
    if (needed === 0 && reserved.current > 0 && settle.current === null) {
      settle.current = setTimeout(() => {
        reserved.current = 0;
        settle.current = null;
        setTick((value) => value + 1);
      }, SETTLE_MS);
    } else if (needed > 0 && settle.current !== null) {
      clearTimeout(settle.current);
      settle.current = null;
    }

    // An approval outranks search: it is a decision the agent is blocked on, and
    // it arrived because the user asked for something.
    const overlay: Overlay | undefined =
      approval !== null
        ? approvalFrom(approval)
        : searchQuery !== null
          ? {
              kind: "search",
              query: searchQuery,
              scope: "all",
              // `current` means the hit is in this session; `selected` is the cursor.
              // Conflating them would show recency wrong on every row but one.
              hits: searchHits,
              selected: searchIndex,
            }
          : undefined;

    return {
      header: {
        model: stats.model ?? "no model",
        connectors: [...connectors].map(([name, status]) => ({ name, status })),
        contextUsed: stats.tokensInContext ?? 0,
        contextMax: stats.maxContextTokens ?? 0,
      },
      blocks: blocksFrom(outputs, streaming),
      live: {
        tools,
        hiddenTools: [],
        ...(activity.phase === "awaiting"
          ? { waiting: WAITING[Math.floor(tick / 24) % WAITING.length] as string }
          : {}),
        tick,
        reservedRows: reserved.current,
      },
      input: {
        value: draft,
        caret: draftCaret,
        placeholder: busy ? "working — esc esc interrupts" : "Ask anything",
        queued: queue.length,
        disabled: overlay !== undefined || prompt === null || prompt.type !== "chat",
      },
      footer: {
        mode: "chat",
        hints: [],
        ...(stats.costUSD === undefined ? {} : { costUsd: stats.costUSD }),
        personality: "house",
      },
      ...(overlay === undefined ? {} : { overlay }),
      focus: "input",
    };
  }, [
    outputs,
    streaming,
    activity,
    stats,
    queue,
    busy,
    regions,
    tick,
    draft,
    draftCaret,
    prompt,
    approval,
    connectors,
    searchQuery,
    searchHits,
    searchIndex,
  ]);

  // A menu the app is waiting on gets the real screen. The wizard publishes it
  // as data precisely so a renderer that cannot paint an Ink tree can still draw
  // it — which is what makes the flow work here at all.
  //
  // This is content passed *into* App as `overrideContent`, never returned in
  // its place. App's own `useKeyboard` call has to stay mounted for any of this
  // to receive a key at all — arrows, enter, or Ctrl+C.
  const overrideContent: React.ReactNode | undefined =
    menu !== null ? (
      <Home
        model={{
          version: VERSION,
          tagline: "One agent. Every surface. Your rules.",
          requirements: [],
          choices: menu.options.map((option) => ({ label: option.label, value: option.value })),
          selected: menuIndex,
        }}
        viewport={viewport}
      />
    ) : customView !== null ? (
      // Anything still delivered only as a pre-built Ink tree cannot be painted
      // here. Say so and name the way out rather than showing an empty frame
      // and looking hung.
      <box style={{ flexDirection: "column", padding: 1 }}>
        <text>This screen is not available in the fullscreen interface yet.</text>
        <text>Run the same command with --no-tui to use it.</text>
        <text>ctrl-c quits.</text>
      </box>
    ) : undefined;

  return (
    <App
      view={view}
      onAction={onAction}
      onKey={onKey}
      {...(overrideContent === undefined ? {} : { overrideContent })}
    />
  );
}
