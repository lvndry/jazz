import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { testConfigLayer } from "@/core/agent/test-config";
import type { Tool } from "@/core/interfaces/tool-registry";
import { UserSecretStore } from "@/core/secrets/user-secrets";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { hasExternalUntrustedFrame } from "@/core/utils/untrusted-content";
import {
  createBrowserActTools,
  createBrowserBackTool,
  createBrowserCloseTool,
  createBrowserNavigateTool,
  createBrowserScreenshotTool,
  createBrowserSnapshotTool,
} from "./browser-tools";
import { type BrowserSession, BrowserSessions } from "./session";

interface FakePage {
  url: string;
  title: string;
}

function fakeBrowser(page: FakePage, refs: Readonly<Record<string, string>> = {}) {
  const calls: string[] = [];
  let closes = 0;
  const session = {
    exclusive: async (_policy: unknown, operation: () => Promise<unknown>) => operation(),
    state: async () => ({ ...page }),
    navigate: async (url: string) => {
      calls.push(`navigate ${url}`);
      page.url = url;
      return { ...page };
    },
    back: async () => {
      calls.push("back");
      return { ...page };
    },
    snapshot: async () => ({
      ...page,
      snapshot: {
        lines: ['- page "Home"', '  - link "Docs" [ref=e1]'],
        text: '- page "Home"\n  - link "Docs" [ref=e1]',
        refs: new Map([["e1", { backendNodeId: 1, label: 'link "Docs"' }]]),
        truncated: false,
      },
    }),
    screenshot: async (filePath: string) => {
      calls.push(`screenshot ${filePath}`);
      return { ...page };
    },
    act: async (action: unknown) => {
      calls.push(`act ${JSON.stringify(action)}`);
      return { ...page };
    },
    describeRef: (ref: string) => refs[ref],
    pageSignals: async () => ({ passwordField: false, paymentField: false }),
    recordFlags: () => undefined,
    flagsFor: () => [],
    close: async () => {
      closes += 1;
    },
  } as unknown as BrowserSession;
  return { session, calls, closes: () => closes };
}

async function contextWithBrowser(
  page: FakePage,
  refs?: Readonly<Record<string, string>>,
  userSecrets?: UserSecretStore,
) {
  const browser = fakeBrowser(page, refs);
  const sessions = new BrowserSessions();
  await sessions.obtain(async () => browser.session);
  const context: ToolExecutionContext = {
    agentId: "agent-1",
    conversationId: "conversation-1",
    browserSessions: sessions,
    ...(userSecrets === undefined ? {} : { userSecrets }),
  };
  return { browser, sessions, context };
}

function run(tool: Tool<never>, args: Record<string, unknown>, context: ToolExecutionContext) {
  return Effect.runPromise(
    (tool.execute(args, context) as Effect.Effect<ToolExecutionResult, never, never>).pipe(
      Effect.provide(testConfigLayer()),
    ),
  );
}

describe("browser tool declarations", () => {
  const act = createBrowserActTools();
  const tools: readonly Tool<never>[] = [
    createBrowserNavigateTool(),
    createBrowserBackTool(),
    createBrowserSnapshotTool(),
    createBrowserScreenshotTool(),
    createBrowserCloseTool(),
    act.approval,
  ] as unknown as readonly Tool<never>[];

  test("gives each tool the risk tier that matches what it can do", () => {
    const riskByName = Object.fromEntries(tools.map((tool) => [tool.name, tool.riskLevel]));

    expect(riskByName).toEqual({
      browser_navigate: "low-risk",
      browser_back: "low-risk",
      browser_snapshot: "read-only",
      browser_screenshot: "low-risk",
      browser_close: "read-only",
      browser_act: "high-risk",
    });
  });

  test("marks the tools that start requests as egress and the readers as not", () => {
    const egressByName = Object.fromEntries(tools.map((tool) => [tool.name, tool.egress]));

    expect(egressByName).toEqual({
      browser_navigate: true,
      browser_back: false,
      browser_snapshot: false,
      browser_screenshot: false,
      browser_close: false,
      browser_act: true,
    });
  });

  test("withholds every browser tool from a peer's disclosure tier", () => {
    expect(tools.every((tool) => tool.disclosure === "private")).toBe(true);
  });

  test("lets a typed secret reach only the text of the approval pair", () => {
    expect(act.approval.userSecretArguments).toEqual(["text"]);
    expect(act.execute.userSecretArguments).toEqual(["text"]);
    expect(act.execute.hidden).toBe(true);
    expect(
      tools
        .filter((tool) => tool !== act.approval)
        .every((tool) => tool.userSecretArguments === undefined),
    ).toBe(true);
  });

  test("describes each tool with a summary search_tools can match", () => {
    for (const tool of tools) {
      expect(tool.summary ?? tool.description).toMatch(/browser|web page|page/i);
    }
  });
});

describe("browser_act arguments", () => {
  const act = createBrowserActTools();

  /** Arguments that pass validation reach the approval step, which answers "No page is open". */
  async function isAccepted(args: Record<string, unknown>): Promise<boolean> {
    const result = await run(act.approval as unknown as Tool<never>, args, {
      agentId: "agent-1",
      browserSessions: new BrowserSessions(),
    });
    return result.error?.startsWith("No page is open") === true;
  }

  test("accepts each action with the field it needs", async () => {
    expect(await isAccepted({ action: "click", ref: "e1" })).toBe(true);
    expect(await isAccepted({ action: "type", ref: "e2", text: "hello", submit: true })).toBe(true);
    expect(await isAccepted({ action: "select", ref: "e3", value: "fr" })).toBe(true);
    expect(await isAccepted({ action: "press", key: "Enter" })).toBe(true);
  });

  test("rejects an action that is missing its field", async () => {
    expect(await isAccepted({ action: "click" })).toBe(false);
    expect(await isAccepted({ action: "type", ref: "e2" })).toBe(false);
    expect(await isAccepted({ action: "select", ref: "e3" })).toBe(false);
    expect(await isAccepted({ action: "press" })).toBe(false);
  });

  test("rejects unknown actions and stray arguments", async () => {
    expect(await isAccepted({ action: "drag", ref: "e1" })).toBe(false);
    expect(await isAccepted({ action: "click", ref: "e1", extra: true })).toBe(false);
  });
});

describe("browser tool results", () => {
  test("browser_navigate returns the page and marks the run as having read external content", async () => {
    const { context, browser } = await contextWithBrowser({ url: "about:blank", title: "" });

    const result = await run(
      createBrowserNavigateTool() as unknown as Tool<never>,
      { url: "https://example.com/" },
      context,
    );

    expect(browser.calls).toEqual(["navigate https://example.com/"]);
    expect(result.success).toBe(true);
    expect(result.result).toContain("url: https://example.com/");
    expect(result.untrusted).toEqual({
      kind: "external",
      source: "browser_navigate https://example.com/",
    });
  });

  test("browser_snapshot returns the outline under external provenance", async () => {
    const { context } = await contextWithBrowser({ url: "https://example.com/", title: "Home" });

    const result = await run(createBrowserSnapshotTool() as unknown as Tool<never>, {}, context);

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain("refs: 1");
    expect(String(result.result)).toContain('link "Docs" [ref=e1]');
    expect(result.untrusted).toEqual({
      kind: "external",
      source: "browser_snapshot https://example.com/",
    });
  });

  test("browser_snapshot pages through a long page with startLine", async () => {
    const { context, browser } = await contextWithBrowser({
      url: "https://example.com/",
      title: "Long",
    });
    const lines = Array.from(
      { length: 4_000 },
      (_, index) => `- heading "Heading ${String(index)}"`,
    );
    (browser.session as unknown as { snapshot: () => Promise<unknown> }).snapshot = async () => ({
      url: "https://example.com/",
      title: "Long",
      snapshot: { lines, text: lines.join("\n"), refs: new Map(), truncated: false },
    });
    const snapshotTool = createBrowserSnapshotTool() as unknown as Tool<never>;

    const first = await run(snapshotTool, {}, context);
    const continuation = /startLine=(\d+) to continue/.exec(String(first.result));
    expect(continuation).not.toBeNull();
    const second = await run(snapshotTool, { startLine: Number(continuation?.[1]) }, context);

    expect(String(first.result)).toContain('- heading "Heading 0"');
    expect(String(second.result)).toContain(
      `- heading "Heading ${String(Number(continuation?.[1]) - 1)}"`,
    );
    expect(String(second.result)).not.toContain('- heading "Heading 0"');
  });

  test("a snapshot wrapped the way the agent loop wraps it is recognised as external", async () => {
    const { context } = await contextWithBrowser({ url: "https://example.com/", title: "Home" });
    const result = await run(createBrowserSnapshotTool() as unknown as Tool<never>, {}, context);

    const framed = `<untrusted-content source="${result.untrusted?.source}" kind="${result.untrusted?.kind}">`;

    expect(
      hasExternalUntrustedFrame(`${framed}\n${String(result.result)}\n</untrusted-content>`),
    ).toBe(true);
  });

  test("browser_screenshot saves a PNG artifact and returns its path", async () => {
    const { context, browser } = await contextWithBrowser({
      url: "https://example.com/",
      title: "Home",
    });

    const result = await run(
      createBrowserScreenshotTool() as unknown as Tool<never>,
      { fullPage: true },
      context,
    );

    const screenshotCall = browser.calls.find((call) => call.startsWith("screenshot "));
    expect(screenshotCall).toMatch(/\.png$/);
    expect(result.artifacts?.[0]).toMatchObject({
      kind: "image",
      mediaType: "image/png",
      tool: "browser_screenshot",
      source: "rendered",
    });
    expect(String(result.result)).toContain(`image: ${result.artifacts?.[0]?.path}`);
  });

  test("browser_close closes the browser so the next call can open a fresh one", async () => {
    const { context, browser, sessions } = await contextWithBrowser({
      url: "https://example.com/",
      title: "Home",
    });

    const result = await run(createBrowserCloseTool() as unknown as Tool<never>, {}, context);

    expect(result.success).toBe(true);
    expect(browser.closes()).toBe(1);
    expect(sessions.peek()).toBeUndefined();
    const reopened = await sessions.obtain(async () => fakeBrowser({ url: "", title: "" }).session);
    expect(reopened).toBeDefined();
  });

  test("a tool called outside a run fails with a clear message", async () => {
    const result = await run(
      createBrowserSnapshotTool() as unknown as Tool<never>,
      {},
      { agentId: "agent-1" },
    );

    expect(result).toEqual({
      success: false,
      result: null,
      error: "The browser tools work only inside an agent run.",
    });
  });
});

describe("browser_act approval", () => {
  const act = createBrowserActTools();

  async function approvalFor(
    args: Record<string, unknown>,
    page: FakePage,
    refs: Readonly<Record<string, string>>,
    userSecrets?: UserSecretStore,
  ) {
    const { context } = await contextWithBrowser(page, refs, userSecrets);
    return run(act.approval as unknown as Tool<never>, args, context);
  }

  test("names the page and the element before asking", async () => {
    const result = await approvalFor(
      { action: "click", ref: "e1" },
      { url: "https://shop.example/cart", title: "Cart" },
      { e1: 'button "Place order"' },
    );

    const proposal = result.result as {
      approvalRequired: boolean;
      message: string;
      executeToolName: string;
    };
    expect(proposal.approvalRequired).toBe(true);
    expect(proposal.executeToolName).toBe("execute_browser_act");
    expect(proposal.message).toBe('Click button "Place order"\non https://shop.example/cart');
  });

  test("answers an unknown ref without asking", async () => {
    const result = await approvalFor(
      { action: "click", ref: "e9" },
      { url: "https://shop.example/", title: "" },
      { e1: 'button "Go"' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No element has ref e9");
  });

  test("answers when no page is open without asking", async () => {
    const result = await run(
      act.approval as unknown as Tool<never>,
      { action: "press", key: "Enter" },
      { agentId: "agent-1", browserSessions: new BrowserSessions() },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No page is open");
  });

  test("always asks when a typed secret is about to be entered, and names the site", async () => {
    const secrets = new UserSecretStore();
    secrets.hold("site-password", "hunter2");

    const result = await approvalFor(
      { action: "type", ref: "e2", text: "[redacted:site-password]" },
      { url: "https://bank.example/login", title: "Sign in" },
      { e2: 'textbox "Password"' },
      secrets,
    );

    const proposal = result.result as { alwaysAsk?: boolean; message: string };
    expect(proposal.alwaysAsk).toBe(true);
    expect(proposal.message).toContain("on https://bank.example/login");
    expect(proposal.message).toContain("[redacted:site-password]");
    expect(proposal.message).not.toContain("hunter2");
  });

  test("refuses to enter a typed secret on a plain http page", async () => {
    const secrets = new UserSecretStore();
    secrets.hold("site-password", "hunter2");

    const result = await approvalFor(
      { action: "type", ref: "e2", text: "[redacted:site-password]" },
      { url: "http://bank.example/login", title: "Sign in" },
      { e2: 'textbox "Password"' },
      secrets,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not served over https");
  });

  test("allows a typed secret on a page served from this machine", async () => {
    const secrets = new UserSecretStore();
    secrets.hold("site-password", "hunter2");

    const result = await approvalFor(
      { action: "type", ref: "e2", text: "[redacted:site-password]" },
      { url: "http://localhost:3000/login", title: "Dev login" },
      { e2: 'textbox "Password"' },
      secrets,
    );

    expect((result.result as { alwaysAsk?: boolean }).alwaysAsk).toBe(true);
  });
});

describe("browser_act execution", () => {
  const act = createBrowserActTools();

  test("runs the action on the run's browser and returns the new page", async () => {
    const { context, browser } = await contextWithBrowser({
      url: "https://example.com/next",
      title: "Next",
    });

    const result = await run(
      act.execute as unknown as Tool<never>,
      { action: "type", ref: "e2", text: "hello", submit: true },
      context,
    );

    expect(browser.calls).toEqual(['act {"kind":"type","ref":"e2","text":"hello","submit":true}']);
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain("url: https://example.com/next");
    expect(result.untrusted?.kind).toBe("external");
  });

  test("reports a failure from the browser instead of throwing", async () => {
    const { context, browser } = await contextWithBrowser({
      url: "https://example.com/",
      title: "",
    });
    (browser.session as unknown as { act: () => Promise<never> }).act = async () => {
      throw new Error("No element has ref e7. Take a new snapshot and use a ref from it.");
    };

    const result = await run(
      act.execute as unknown as Tool<never>,
      { action: "click", ref: "e7" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No element has ref e7");
  });
});
