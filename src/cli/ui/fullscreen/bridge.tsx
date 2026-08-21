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

import { useKeyboard } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityState } from "../activity-state";
import {
  store,
  type ConnectorStatus,
  type EphemeralRegion,
  type PendingApproval,
  type RunStats,
} from "../store";
import type { OutputEntry, PromptState } from "../types";
import { App } from "./App";
import type { KeyAction } from "./keymap";
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

function textOf(message: unknown): string {
  if (typeof message === "string") return message;
  if (message !== null && typeof message === "object" && "text" in message) {
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return String(message);
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
    const text = textOf(entry.message);
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

export function FullscreenBridge(): React.ReactNode {
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
  const [customView, setCustomView] = useState<React.ReactNode | null>(null);
  const [connectors, setConnectors] = useState<ReadonlyMap<string, ConnectorStatus>>(new Map());
  const [tick, setTick] = useState(0);

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

  const submit = useCallback(
    (text: string) => {
      const active = prompt;
      if (active === null || text.trim().length === 0) return;
      setDraft("");
      active.resolve(text);
    },
    [prompt],
  );

  // The approval card owns the keyboard while it is up. Enter accepts, Esc
  // rejects, `a` is the always-allow path — and typing must not reach the
  // composer underneath.
  useKeyboard((key) => {
    const name = typeof key === "string" ? key : (key.name ?? "");
    const ctrl = typeof key === "string" ? false : key.ctrl === true;
    const active = prompt;

    // Ctrl+C, before anything else and regardless of state.
    //
    // The renderer is told not to exit on Ctrl+C so the agent loop can cancel
    // in-flight work instead of the process dying mid-tool-call. That makes
    // handling it here mandatory rather than optional: an alternate screen you
    // cannot leave is the worst failure this interface can have, so the first
    // press cancels if there is anything to cancel and the second always quits.
    if (ctrl && (name === "c" || name === "\u0003")) {
      if (interrupt.current !== null && quitArmed.current === false) {
        quitArmed.current = true;
        interrupt.current();
        return;
      }
      process.kill(process.pid, "SIGINT");
      return;
    }

    if (approval !== null && active !== null) {
      if (name === "return" || name === "enter") active.resolve("yes");
      else if (name === "a") active.resolve("always_tool");
      return;
    }
    if (active === null || active.type !== "chat") return;

    if (name === "return" || name === "enter") {
      submit(draft);
      return;
    }
    if (name === "backspace") {
      setDraft((value) => [...value].slice(0, -1).join(""));
      return;
    }
    if ([...name].length === 1) {
      const code = name.codePointAt(0) ?? 0;
      if (code >= 0x20 && code !== 0x7f) setDraft((value) => value + name);
    }
  });

  const onAction = useCallback(
    (action: KeyAction) => {
      if (action.type === "interrupt") interrupt.current?.();
      if (action.type === "stash-draft") setDraft("");
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

    const overlay: Overlay | undefined = approval === null ? undefined : approvalFrom(approval);

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
    prompt,
    approval,
    connectors,
  ]);

  // Custom views — the wizard, the config wizard, the workflow picker — are Ink
  // element trees built by their callers and handed to whichever renderer is
  // mounted. OpenTUI cannot paint an Ink tree, so rather than showing an empty
  // frame and looking hung, say so and name the way out. Porting those screens
  // is what closes the gap; until then this is the honest failure.
  if (customView !== null) {
    return (
      <box style={{ flexDirection: "column", padding: 1 }}>
        <text>This screen is not available in the fullscreen interface yet.</text>
        <text>Run the same command without --fullscreen to use it.</text>
        <text>ctrl-c quits.</text>
      </box>
    );
  }

  return (
    <App
      view={view}
      onAction={onAction}
    />
  );
}
