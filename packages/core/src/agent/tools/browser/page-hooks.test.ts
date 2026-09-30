import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Page } from "puppeteer-core";
import { testConfigLayer } from "@/core/agent/test-config";
import type { Tool } from "@/core/interfaces/tool-registry";
import {
  MAX_PAGE_ELEMENTS,
  MAX_PAGE_LABEL_CHARS,
  type ClassifyPageInput,
  type ClassifyPageOutcome,
  type PageFlagId,
  type PageStructuralSignals,
  type RouteSnapshotInput,
  type RouteSnapshotOutcome,
} from "@/core/types/plugin";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { createBrowserActTools, createBrowserSnapshotTool } from "./browser-tools";
import {
  ROUTE_SNAPSHOT_MAX_LEAD,
  ROUTE_SNAPSHOT_MIN_PROBABILITY,
  advisePage,
  renderSnapshot,
  type PageAdvice,
} from "./page-hooks";
import {
  PAGE_FLAG_MIN_PROBABILITY,
  combineFlags,
  describeFlags,
  flagsFromClassification,
  readPageSignals,
  summarizeElements,
} from "./page-signals";
import { type BrowserSession, BrowserSessions } from "./session";
import type { PageSnapshot } from "./snapshot";

const NO_SIGNALS: PageStructuralSignals = { passwordField: false, paymentField: false };
const PASSWORD_SIGNALS: PageStructuralSignals = { passwordField: true, paymentField: false };

const SNAPSHOT_LINES = [
  '- page "Checkout"',
  '  - textbox "Card number" [ref=e1]',
  '  - link "Terms" [ref=e2]',
  '  - button "Pay now" [ref=e3]',
];

const SNAPSHOT: PageSnapshot = {
  lines: SNAPSHOT_LINES,
  text: SNAPSHOT_LINES.join("\n"),
  refs: new Map([
    ["e1", { backendNodeId: 1, label: 'textbox "Card number"' }],
    ["e2", { backendNodeId: 2, label: 'link "Terms"' }],
    ["e3", { backendNodeId: 3, label: 'button "Pay now"' }],
  ]),
  truncated: false,
};

const PAGE = {
  url: "https://shop.example/cart/checkout?session=secret-token#step2",
  title: "Checkout",
  snapshot: SNAPSHOT,
};

function answeredFlags(...flags: readonly [PageFlagId, number][]): ClassifyPageOutcome {
  return {
    status: "answered",
    flags: flags.map(([flag, probability]) => ({ flag, probability })),
  };
}

function answeredRoute(...elements: readonly (readonly [string, number])[]): RouteSnapshotOutcome {
  const total = elements.reduce((sum, [, probability]) => sum + probability, 0);
  return {
    status: "answered",
    distribution: {
      elements: elements.map(([ref, probability]) => ({ ref, probability })),
      noElementProbability: 1 - total,
    },
  };
}

describe("page flags", () => {
  test("come from the page's structure with no plugin at all", () => {
    expect(combineFlags(NO_SIGNALS, [])).toEqual([]);
    expect(combineFlags(PASSWORD_SIGNALS, [])).toEqual(["credential-entry"]);
    expect(combineFlags({ passwordField: true, paymentField: true }, [])).toEqual([
      "credential-entry",
      "payment",
    ]);
  });

  test("add a plugin's flags in a fixed order without repeating one", () => {
    expect(combineFlags(PASSWORD_SIGNALS, ["captcha", "credential-entry", "payment"])).toEqual([
      "credential-entry",
      "payment",
      "captcha",
    ]);
  });

  test("count a classification flag only at or above the threshold", () => {
    expect(
      flagsFromClassification(
        answeredFlags(
          ["payment", PAGE_FLAG_MIN_PROBABILITY],
          ["captcha", PAGE_FLAG_MIN_PROBABILITY - 0.01],
        ),
      ),
    ).toEqual(["payment"]);
    expect(flagsFromClassification({ status: "abstained", reason: "no answer" })).toEqual([]);
    expect(flagsFromClassification(undefined)).toEqual([]);
  });

  test("are worded by Jazz from the flag names alone", () => {
    expect(describeFlags([])).toBeUndefined();
    const notice = describeFlags(["credential-entry", "agent-directed-instructions"]);
    expect(notice).toContain("password field");
    expect(notice).toContain("addressed to an AI agent");
    expect(notice?.startsWith("Warning:")).toBe(true);
  });
});

describe("readPageSignals", () => {
  test("reports what the page evaluation returns", async () => {
    const page = {
      evaluate: async () => ({ passwordField: true, paymentField: false }),
    } as unknown as Page;
    expect(await readPageSignals(page)).toEqual(PASSWORD_SIGNALS);
  });

  test("reads a page that cannot be evaluated as having neither field", async () => {
    const page = {
      evaluate: async () => {
        throw new Error("no execution context");
      },
    } as unknown as Page;
    expect(await readPageSignals(page)).toEqual(NO_SIGNALS);
  });
});

describe("summarizeElements", () => {
  test("splits a role from its quoted name, in page order", () => {
    expect(summarizeElements(SNAPSHOT.refs)).toEqual([
      { ref: "e1", role: "textbox", label: "Card number" },
      { ref: "e2", role: "link", label: "Terms" },
      { ref: "e3", role: "button", label: "Pay now" },
    ]);
  });

  test("reads a role with no name and a name with an escaped quote", () => {
    const refs = new Map([
      ["e1", { backendNodeId: 1, label: "textbox" }],
      ["e2", { backendNodeId: 2, label: 'button "Say \\"hi\\""' }],
    ]);
    expect(summarizeElements(refs)).toEqual([
      { ref: "e1", role: "textbox", label: "" },
      { ref: "e2", role: "button", label: 'Say "hi"' },
    ]);
  });

  test("bounds the count and each label", () => {
    const refs = new Map(
      Array.from({ length: MAX_PAGE_ELEMENTS + 50 }, (_, index) => [
        `e${String(index)}`,
        { backendNodeId: index, label: `button "${"x".repeat(MAX_PAGE_LABEL_CHARS * 2)}"` },
      ]),
    );
    const summaries = summarizeElements(refs);
    expect(summaries).toHaveLength(MAX_PAGE_ELEMENTS);
    expect(summaries.every(({ label }) => label.length <= MAX_PAGE_LABEL_CHARS)).toBe(true);
  });
});

describe("advisePage", () => {
  test("uses only the page's structure when no plugin answers", async () => {
    const advice = await Effect.runPromise(
      advisePage({ agentId: "a" }, { page: PAGE, signals: PASSWORD_SIGNALS, firstWindow: true }),
    );
    expect(advice).toEqual({ flags: ["credential-entry"], leadRefs: [] });
  });

  test("sends a classification the origin, title, element labels and signals, and nothing else", async () => {
    const inputs: ClassifyPageInput[] = [];
    const context: ToolExecutionContext = {
      agentId: "a",
      classifyPage: (input) => {
        inputs.push(input);
        return Effect.succeed({ status: "abstained", reason: "test" } as const);
      },
    };
    await Effect.runPromise(
      advisePage(context, { page: PAGE, signals: NO_SIGNALS, firstWindow: true }),
    );
    expect(inputs).toHaveLength(1);
    const sent = JSON.stringify(inputs[0]);
    expect(inputs[0]?.origin).toBe("https://shop.example");
    expect(inputs[0]?.title).toBe("Checkout");
    expect(sent).not.toContain("secret-token");
    expect(sent).not.toContain("/cart/checkout");
    expect(sent).not.toContain("step2");
    expect(inputs[0]?.elements.map(({ label }) => label)).toEqual([
      "Card number",
      "Terms",
      "Pay now",
    ]);
  });

  test("raises a classification's flags and leads with the routed refs, best first", async () => {
    const context: ToolExecutionContext = {
      agentId: "a",
      conversationMessages: [{ role: "user", content: "pay the invoice" }],
      classifyPage: () => Effect.succeed(answeredFlags(["payment", 0.9])),
      routeSnapshot: () => Effect.succeed(answeredRoute(["e1", 0.2], ["e3", 0.6], ["e2", 0.05])),
    };
    const advice = await Effect.runPromise(
      advisePage(context, { page: PAGE, signals: NO_SIGNALS, firstWindow: true }),
    );
    expect(advice.flags).toEqual(["payment"]);
    expect(advice.leadRefs).toEqual(["e3", "e1"]);
  });

  test("hands routing the latest user message, bounded", async () => {
    const requests: string[] = [];
    const context: ToolExecutionContext = {
      agentId: "a",
      conversationMessages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: `pay ${"x".repeat(10_000)}` },
      ],
      routeSnapshot: (input: RouteSnapshotInput) => {
        requests.push(input.requestText);
        return Effect.succeed({ status: "abstained", reason: "test" } as const);
      },
    };
    await Effect.runPromise(
      advisePage(context, { page: PAGE, signals: NO_SIGNALS, firstWindow: true }),
    );
    expect(requests[0]?.startsWith("pay ")).toBe(true);
    expect(requests[0]?.length).toBeLessThanOrEqual(2_000);
  });

  test("routes only the first window of a snapshot, and never an empty page", async () => {
    let routed = 0;
    const context: ToolExecutionContext = {
      agentId: "a",
      routeSnapshot: () => {
        routed += 1;
        return Effect.succeed({ status: "abstained", reason: "test" } as const);
      },
    };
    await Effect.runPromise(
      advisePage(context, { page: PAGE, signals: NO_SIGNALS, firstWindow: false }),
    );
    await Effect.runPromise(
      advisePage(context, {
        page: { ...PAGE, snapshot: { ...SNAPSHOT, refs: new Map() } },
        signals: NO_SIGNALS,
        firstWindow: true,
      }),
    );
    expect(routed).toBe(0);
  });

  test("keeps at most the lead limit", async () => {
    const evenSplit = Math.round(1 / ROUTE_SNAPSHOT_MIN_PROBABILITY);
    expect(evenSplit).toBeGreaterThan(ROUTE_SNAPSHOT_MAX_LEAD);
    const refs = Array.from({ length: evenSplit }, (_, index) => `e${index + 1}`);
    const page = {
      ...PAGE,
      snapshot: {
        ...SNAPSHOT,
        refs: new Map(refs.map((ref, index) => [ref, { backendNodeId: index, label: "button" }])),
      },
    };
    const share = ROUTE_SNAPSHOT_MIN_PROBABILITY;
    const context: ToolExecutionContext = {
      agentId: "a",
      routeSnapshot: () =>
        Effect.succeed(answeredRoute(...refs.map((ref) => [ref, share] as const))),
    };
    const advice = await Effect.runPromise(
      advisePage(context, { page, signals: NO_SIGNALS, firstWindow: true }),
    );
    expect(advice.leadRefs).toHaveLength(ROUTE_SNAPSHOT_MAX_LEAD);
  });

  test("cannot lower a flag the page's structure raised", async () => {
    const context: ToolExecutionContext = {
      agentId: "a",
      classifyPage: () => Effect.succeed(answeredFlags(["credential-entry", 0], ["payment", 0])),
    };
    const advice = await Effect.runPromise(
      advisePage(context, { page: PAGE, signals: PASSWORD_SIGNALS, firstWindow: true }),
    );
    expect(advice.flags).toEqual(["credential-entry"]);
  });
});

describe("renderSnapshot", () => {
  const plain: PageAdvice = { flags: [], leadRefs: [] };

  test("shows the outline unchanged when nothing was advised", () => {
    expect(renderSnapshot(SNAPSHOT, plain, undefined)).toBe(SNAPSHOT_LINES.join("\n"));
  });

  test("leads with the routed lines and still shows every line of the outline", () => {
    const text = renderSnapshot(SNAPSHOT, { flags: [], leadRefs: ["e3"] }, undefined);
    expect(text.startsWith("Likely relevant to your request:")).toBe(true);
    for (const line of SNAPSHOT_LINES) {
      expect(text).toContain(line);
    }
    expect(text.indexOf("Pay now")).toBeLessThan(text.indexOf('- page "Checkout"'));
  });

  test("ignores a routed ref the page does not have", () => {
    const text = renderSnapshot(SNAPSHOT, { flags: [], leadRefs: ["e99"] }, undefined);
    expect(text).toBe(SNAPSHOT_LINES.join("\n"));
  });

  test("puts the warning before everything else", () => {
    const text = renderSnapshot(SNAPSHOT, { flags: ["payment"], leadRefs: ["e1"] }, undefined);
    expect(text.startsWith("Warning:")).toBe(true);
  });
});

function fakeSession(signals: PageStructuralSignals, recorded: { flags: PageFlagId[] }) {
  return {
    exclusive: async (_policy: unknown, operation: () => Promise<unknown>) => operation(),
    state: async () => ({ url: "https://shop.example/pay", title: "Pay" }),
    snapshot: async () => ({ url: "https://shop.example/pay", title: "Pay", snapshot: SNAPSHOT }),
    pageSignals: async () => signals,
    recordFlags: (_url: string, flags: readonly PageFlagId[]) => {
      recorded.flags = [...flags];
    },
    flagsFor: () => recorded.flags,
    describeRef: () => 'button "Pay now"',
  } as unknown as BrowserSession;
}

async function contextFor(
  signals: PageStructuralSignals,
  recorded: { flags: PageFlagId[] },
  hooks: Partial<ToolExecutionContext> = {},
) {
  const sessions = new BrowserSessions();
  await sessions.obtain(async () => fakeSession(signals, recorded));
  const context: ToolExecutionContext = {
    agentId: "a",
    conversationId: "c",
    browserSessions: sessions,
    ...hooks,
  };
  return context;
}

function run(tool: Tool<never>, args: Record<string, unknown>, context: ToolExecutionContext) {
  return Effect.runPromise(
    (tool.execute(args, context) as Effect.Effect<ToolExecutionResult, never, never>).pipe(
      Effect.provide(testConfigLayer()),
    ),
  );
}

describe("browser tools on a flagged page", () => {
  const snapshotTool = createBrowserSnapshotTool() as unknown as Tool<never>;
  const act = createBrowserActTools();
  const actProposal = act.approval as unknown as Tool<never>;

  test("browser_snapshot warns and stays untrusted external content", async () => {
    const recorded = { flags: [] as PageFlagId[] };
    const context = await contextFor(PASSWORD_SIGNALS, recorded);
    const result = await run(snapshotTool, {}, context);
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain("Warning: this page has a password field");
    expect(result.untrusted).toEqual({
      kind: "external",
      source: "browser_snapshot https://shop.example/pay",
    });
    expect(recorded.flags).toEqual(["credential-entry"]);
  });

  test("a clean page with no plugin asks as it did before", async () => {
    const context = await contextFor(NO_SIGNALS, { flags: [] });
    const result = await run(actProposal, { action: "click", ref: "e3" }, context);
    const proposal = result.result as { message: string; alwaysAsk?: boolean };
    expect(proposal.alwaysAsk).toBeUndefined();
    expect(proposal.message).toBe('Click button "Pay now"\non https://shop.example/pay');
  });

  test("a password field makes browser_act always ask and puts the warning in the approval", async () => {
    const context = await contextFor(PASSWORD_SIGNALS, { flags: [] });
    const result = await run(actProposal, { action: "click", ref: "e3" }, context);
    const proposal = result.result as { message: string; alwaysAsk?: boolean };
    expect(proposal.alwaysAsk).toBe(true);
    expect(proposal.message).toContain("Warning: this page has a password field");
  });

  test("a plugin's flag from the last snapshot tightens the next action", async () => {
    const recorded = { flags: [] as PageFlagId[] };
    const context = await contextFor(NO_SIGNALS, recorded, {
      classifyPage: () => Effect.succeed(answeredFlags(["agent-directed-instructions", 0.95])),
    });
    await run(snapshotTool, {}, context);
    const result = await run(actProposal, { action: "click", ref: "e3" }, context);
    const proposal = result.result as { message: string; alwaysAsk?: boolean };
    expect(proposal.alwaysAsk).toBe(true);
    expect(proposal.message).toContain("addressed to an AI agent");
  });

  test("a plugin that answers clean or abstains changes nothing on a clean page", async () => {
    for (const classification of [
      answeredFlags(["payment", 0.1]),
      { status: "abstained", reason: "no" } as const,
    ]) {
      const recorded = { flags: [] as PageFlagId[] };
      const context = await contextFor(NO_SIGNALS, recorded, {
        classifyPage: () => Effect.succeed(classification),
      });
      await run(snapshotTool, {}, context);
      const result = await run(actProposal, { action: "click", ref: "e3" }, context);
      expect((result.result as { alwaysAsk?: boolean }).alwaysAsk).toBeUndefined();
    }
  });

  test("a plugin cannot lower the flags the page's own structure raised", async () => {
    const recorded = { flags: [] as PageFlagId[] };
    const context = await contextFor(PASSWORD_SIGNALS, recorded, {
      classifyPage: () => Effect.succeed(answeredFlags(["credential-entry", 0])),
    });
    await run(snapshotTool, {}, context);
    const result = await run(actProposal, { action: "click", ref: "e3" }, context);
    expect((result.result as { alwaysAsk?: boolean }).alwaysAsk).toBe(true);
    expect(actProposal.riskLevel).toBe("high-risk");
  });

  test("routing reorders the snapshot and every outline line stays", async () => {
    const context = await contextFor(
      NO_SIGNALS,
      { flags: [] },
      {
        routeSnapshot: () => Effect.succeed(answeredRoute(["e3", 0.8])),
      },
    );
    const result = await run(snapshotTool, {}, context);
    const text = String(result.result);
    expect(text).toContain("Likely relevant to your request:");
    for (const line of SNAPSHOT_LINES) {
      expect(text).toContain(line);
    }
    expect(result.untrusted).toEqual({
      kind: "external",
      source: "browser_snapshot https://shop.example/pay",
    });
  });
});
