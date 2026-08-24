/**
 * A realistic session, as data.
 *
 * This is the scene the design was drawn against: inbox triage, a research step,
 * two tools in flight, a delegated lane, and an approval that will write to a
 * real calendar. It exists so the layout can be run and looked at without an API
 * key, and so tests assert against the same frame a person would see.
 *
 * Identifiers are deliberately fictional. Design fixtures end up in screenshots
 * and documentation, so they must not carry anyone's real address.
 */

import type { ApprovalOverlay, Block, SearchOverlay, ViewModel } from "./types";
import packageJson from "../../../../package.json";

let seq = 0;
const next = (): number => (seq += 1);

const BLOCKS: readonly Block[] = [
  {
    id: "b1",
    seq: next(),
    kind: "user",
    text: "what did I miss in my inbox this week? anything urgent should go on my calendar",
    at: "14:32",
  },
  {
    id: "b2",
    seq: next(),
    kind: "reasoning",
    collapsed: true,
    text: "",
    steps: 8,
    durationMs: 3_200,
    tokens: 1_100,
  },
  {
    id: "b3",
    seq: next(),
    kind: "tool",
    app: "gmail",
    summary: "4 flagged of 26",
    status: "ok",
    durationMs: 1_900,
    detail: "is:unread newer_than:7d",
  },
  {
    id: "b4",
    seq: next(),
    kind: "tool",
    app: "web",
    summary: "3 sources",
    status: "ok",
    durationMs: 2_400,
  },
  {
    id: "b5",
    seq: next(),
    kind: "tool",
    app: "slack",
    summary: "could not read",
    status: "failed",
    reason: "read-only connection",
    remedyKey: "ctrl-a reconnects",
  },
  {
    id: "b6",
    seq: next(),
    kind: "lane",
    name: "travel-scout",
    ask: "check whether the Basel dates moved",
    lane: 1,
    state: "done",
    result: "venue page says 12-13 March, unchanged",
    steps: 9,
  },
  {
    id: "b7",
    seq: next(),
    kind: "agent",
    markdown: [
      "Four things actually need you this week. Two are quick replies, one is a",
      "contract question, and one is a scheduling conflict that I can hold a slot for.",
      "",
      "| From | Subject | Action |",
      "| --- | --- | --- |",
      "| Dana Okafor | Q3 board deck | numbers by Thursday |",
      "| M. Ricci | contract redlines v4 | two open items |",
      "| City Clinic | appointment moved | confirm or rebook |",
      "",
      "- The Basel workshop dates did not move, so your flights still line up ‹1›.",
    ].join("\n"),
  },
];

const APPROVAL: ApprovalOverlay = {
  kind: "approval",
  app: "calendar",
  action: "create event",
  account: "you@example.com",
  fields: [
    { label: "title", value: "Hold: contract redlines with M. Ricci" },
    { label: "when", value: "Thu 21 Aug, 15:00–15:30 CEST" },
    { label: "attendees", value: "you@example.com, m.ricci@example.org" },
    { label: "calendar", value: "Work" },
    { label: "reminder", value: "10 minutes before" },
  ],
  consequence: "Not undoable from jazz — the invite leaves immediately.",
  alwaysLabel: "always allow calendar_create",
  armed: true,
};

const SEARCH: SearchOverlay = {
  kind: "search",
  query: "basel",
  scope: "all",
  hits: [
    {
      agentId: "agent-1",
      conversationId: "c-1",
      conversationTitle: "inbox triage",
      when: "now",
      line: "the Basel workshop dates did not move",
      matchStart: 4,
      matchLength: 5,
      current: true,
    },
    {
      agentId: "agent-1",
      conversationId: "c-2",
      conversationTitle: "plan my week",
      when: "2d ago",
      line: "book the Basel flights before prices move",
      matchStart: 9,
      matchLength: 5,
      current: false,
    },
    {
      agentId: "agent-1",
      conversationId: "c-3",
      conversationTitle: "travel budget",
      when: "1w ago",
      line: "Basel is the only trip left this quarter",
      matchStart: 0,
      matchLength: 5,
      current: false,
    },
  ],
  selected: 0,
};

/** The base frame: mid-session, two tools in flight, nothing blocking. */
export function sampleView(): ViewModel {
  return {
    header: {
      version: packageJson.version,
      cwd: "~/github/jazz",
      model: "claude-opus-5",
      connectors: [
        { name: "gmail", status: "live" },
        { name: "calendar", status: "live" },
        { name: "slack", status: "live" },
        { name: "notion", status: "renew" },
      ],
      contextUsed: 82_100,
      contextMax: 200_000,
    },
    blocks: BLOCKS,
    live: {
      tools: [
        { app: "gmail", operation: "threads.fetch", elapsedMs: 4_100, phase: 0 },
        { app: "web", operation: "research.deep", elapsedMs: 11_600, phase: 2 },
      ],
      hiddenTools: [],
      step: { index: 3, total: 7, label: "rank by urgency" },
      elapsedMs: 11_600,
      // Two tool rows plus the step line. The adapter grows this to fit and
      // only lets it fall once the run settles, so the input holds still while
      // tools churn.
      reservedRows: 3,
    },
    input: { value: "", placeholder: "Ask anything", queued: [], disabled: false },
    footer: {
      mode: "chat",
      hints: [],
      promptTokens: 20_000,
      completionTokens: 40_000,
      costUsd: 0.042,
      elapsedMs: 11_600,
    },
    focus: "input",
  };
}

/** The same session with the approval card up. */
export function sampleApprovalView(): ViewModel {
  const base = sampleView();
  return {
    ...base,
    // Nothing is running: jazz has stopped and is waiting on a person, and the
    // empty live zone is itself the signal.
    live: { tools: [], hiddenTools: [], reservedRows: 0 },
    overlay: APPROVAL,
  };
}

/** The same session with history search open across past sessions. */
export function sampleSearchView(): ViewModel {
  return { ...sampleView(), overlay: SEARCH };
}

/** An idle first-run frame: no work, no plan, nothing to interrupt. */
export function sampleIdleView(): ViewModel {
  const base = sampleView();
  return {
    ...base,
    blocks: [],
    live: { tools: [], hiddenTools: [], reservedRows: 0 },
    footer: {
      mode: base.footer.mode,
      hints: base.footer.hints,
    },
  };
}

/** Six tools running, to exercise the live zone's cap and its overflow row. */
export function sampleBusyView(): ViewModel {
  const base = sampleView();
  return {
    ...base,
    live: {
      ...base.live,
      tools: [
        { app: "gmail", operation: "threads.fetch", elapsedMs: 4_100, phase: 0 },
        { app: "web", operation: "research.deep", elapsedMs: 11_600, phase: 2 },
        { app: "calendar", operation: "freebusy", elapsedMs: 800, phase: 1 },
      ],
      hiddenTools: ["notion.query", "files.write", "shell.run"],
      // Three tool rows, the step line and the overflow row saturate the cap.
      reservedRows: 5,
    },
  };
}
