/**
 * One headless browser per run, reused across the browser tools and closed when the run ends.
 *
 * `BrowserSessions` is the run-scoped holder: the runner opens one for a top-level run, hands
 * the same object to its sub-agents, and closes it when the run finishes, errors or is
 * interrupted. The browser itself launches on the first tool call, into a fresh temporary
 * profile that is deleted with it, so no cookie or login outlives the run. A run has exactly one
 * tab; a popup is refused by the browser rather than opened.
 *
 * Every request the page makes passes through `decideBrowserRequest`. Tool calls on a session
 * run one at a time, so the policy in force for a call (private addresses approved for it) is
 * the one every request during that call is judged by.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import puppeteer, { type CDPSession, type HTTPRequest, type Page } from "puppeteer-core";
import type { EgressPolicy } from "../guarded-fetch";
import { decideBrowserRequest } from "./request-guard";
import { buildSnapshot, type PageSnapshot, type SnapshotRef } from "./snapshot";

/** Time one navigation may take before it fails. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/** Time one click, keystroke or other page action may take before it fails. */
export const ACTION_TIMEOUT_MS = 15_000;

/** Longest a single DevTools command may take, so a hung page cannot stall the run. */
const PROTOCOL_TIMEOUT_MS = 30_000;

/** How long the network must be quiet before an action counts as settled. */
const SETTLE_IDLE_MS = 500;

/** Longest an action waits for the network to go quiet after it runs. */
const SETTLE_TIMEOUT_MS = 5_000;

const VIEWPORT = { width: 1280, height: 800 } as const;

/** Blocked requests reported back per call; the rest are summarised as a count. */
const MAX_REPORTED_BLOCKS = 5;

const PROFILE_PREFIX = "jazz-browser-";

const POPUP_FLAG = "--block-new-web-contents";

export interface BrowserSettings {
  /** Chrome to launch, from `resolveBrowserExecutablePath`. Unused when `cdpEndpoint` is set. */
  readonly executablePath: string | null;
  /** A running browser to drive instead of launching one: an `http(s)://` or `ws(s)://` URL. */
  readonly cdpEndpoint?: string | undefined;
}

export interface PageState {
  readonly url: string;
  readonly title: string;
}

export interface SnapshotResult extends PageState {
  readonly snapshot: PageSnapshot;
}

export type PageAction =
  | { readonly kind: "click"; readonly ref: string }
  | {
      readonly kind: "type";
      readonly ref: string;
      readonly text: string;
      readonly submit: boolean;
    }
  | { readonly kind: "select"; readonly ref: string; readonly value: string }
  | { readonly kind: "press"; readonly key: string };

export const MISSING_CHROME_ERROR =
  "The browser tools need a Chrome or Chromium install, and none was found. Install Google " +
  "Chrome or Chromium, point PUPPETEER_EXECUTABLE_PATH at a browser binary, or set " +
  "network.browserEndpoint to a running browser.";

function isWebSocketEndpoint(endpoint: string): boolean {
  return endpoint.startsWith("ws://") || endpoint.startsWith("wss://");
}

/** Chrome's own sandbox needs kernel privileges that a root container does not grant. */
function sandboxArguments(): readonly string[] {
  return process.getuid?.() === 0 ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BrowserSession {
  private policy: EgressPolicy = {};
  private verifiedHosts = new Set<string>();
  private readonly approvedOrigins = new Set<string>();
  private refs: ReadonlyMap<string, SnapshotRef> = new Map();
  private blocks: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly page: Page,
    private readonly client: CDPSession,
    private readonly owned: { readonly profileDirectory: string | undefined },
    private readonly release: () => Promise<void>,
  ) {}

  /** Launch Chrome into a temporary profile, or connect to `settings.cdpEndpoint`. */
  static open(settings: BrowserSettings): Promise<BrowserSession> {
    if (settings.cdpEndpoint !== undefined) {
      return BrowserSession.connect(settings.cdpEndpoint);
    }
    if (settings.executablePath === null) {
      return Promise.reject(new Error(MISSING_CHROME_ERROR));
    }
    return BrowserSession.launch(settings.executablePath);
  }

  private static async connect(endpoint: string): Promise<BrowserSession> {
    const browser = await puppeteer.connect({
      ...(isWebSocketEndpoint(endpoint)
        ? { browserWSEndpoint: endpoint }
        : { browserURL: endpoint }),
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
    });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    return BrowserSession.prepare(page, { profileDirectory: undefined }, async () => {
      await context.close().catch(() => undefined);
      await browser.disconnect();
    });
  }

  private static async launch(executablePath: string): Promise<BrowserSession> {
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
    try {
      const browser = await puppeteer.launch({
        browser: "chrome",
        executablePath,
        headless: true,
        userDataDir: profileDirectory,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
        args: [...sandboxArguments(), POPUP_FLAG, "--disable-extensions", "--mute-audio"],
      });
      const page = await browser.newPage();
      return await BrowserSession.prepare(page, { profileDirectory }, async () => {
        await browser.close();
      });
    } catch (error) {
      await rm(profileDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private static async prepare(
    page: Page,
    owned: { readonly profileDirectory: string | undefined },
    release: () => Promise<void>,
  ): Promise<BrowserSession> {
    await page.setViewport(VIEWPORT);
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    const client = await page.createCDPSession();
    await client.send("Accessibility.enable");
    await client.send("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);

    const session = new BrowserSession(page, client, owned, release);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void session.guard(request);
    });
    return session;
  }

  private async guard(request: HTTPRequest): Promise<void> {
    const isMainFrameNavigation =
      request.isNavigationRequest() && request.frame() === this.page.mainFrame();
    try {
      const decision = await decideBrowserRequest(
        { url: request.url(), isMainFrameNavigation },
        this.policy,
        this.approvedOrigins,
        this.verifiedHosts,
      );
      if (decision.kind === "continue") {
        await request.continue();
        return;
      }
      this.blocks.push(`${request.url()} (${decision.reason})`);
      await request.abort("blockedbyclient");
    } catch {
      await request.abort("blockedbyclient").catch(() => undefined);
    }
  }

  /**
   * Run `operation` with `policy` in force, after any earlier call on this session finished.
   * Requests the guard refused during the call are appended to a failure's message.
   */
  exclusive<T>(policy: EgressPolicy, operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.closed) {
        throw new Error("The browser for this run is closed.");
      }
      this.policy = policy;
      this.verifiedHosts = new Set();
      this.blocks = [];
      try {
        return await operation();
      } catch (error) {
        throw new Error(`${errorMessage(error)}${this.describeBlocks()}`, { cause: error });
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private describeBlocks(): string {
    if (this.blocks.length === 0) {
      return "";
    }
    const listed = this.blocks.slice(0, MAX_REPORTED_BLOCKS).join("; ");
    const more =
      this.blocks.length > MAX_REPORTED_BLOCKS
        ? ` and ${String(this.blocks.length - MAX_REPORTED_BLOCKS)} more`
        : "";
    return ` Blocked requests: ${listed}${more}.`;
  }

  async state(): Promise<PageState> {
    return { url: this.page.url(), title: await this.page.title() };
  }

  async navigate(url: string): Promise<PageState> {
    const decision = await decideBrowserRequest(
      { url, isMainFrameNavigation: true },
      this.policy,
      this.approvedOrigins,
      this.verifiedHosts,
    );
    if (decision.kind === "abort") {
      throw new Error(`Navigation refused: ${decision.reason}.`);
    }
    this.approvedOrigins.add(new URL(url).origin);
    await this.page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    await this.settle();
    return this.state();
  }

  async back(): Promise<PageState> {
    const response = await this.page.goBack({ waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    if (response === null && this.page.url() === "about:blank") {
      throw new Error("There is no earlier page in this browser's history.");
    }
    await this.settle();
    return this.state();
  }

  async snapshot(): Promise<SnapshotResult> {
    const tree = await this.client.send("Accessibility.getFullAXTree", {});
    const snapshot = buildSnapshot(tree.nodes);
    this.refs = snapshot.refs;
    return { ...(await this.state()), snapshot };
  }

  async screenshot(filePath: string, fullPage: boolean): Promise<PageState> {
    await this.page.screenshot({ path: filePath, type: "png", fullPage });
    return this.state();
  }

  async act(action: PageAction): Promise<PageState> {
    switch (action.kind) {
      case "click":
        await this.click(this.backendNodeId(action.ref));
        break;
      case "type":
        await this.type(this.backendNodeId(action.ref), action.text, action.submit);
        break;
      case "select":
        await this.select(this.backendNodeId(action.ref), action.value);
        break;
      case "press":
        await this.page.keyboard.press(action.key as Parameters<Page["keyboard"]["press"]>[0]);
        break;
    }
    await this.settle();
    return this.state();
  }

  /** The role and name the last snapshot gave `ref`, or undefined when it has no such ref. */
  describeRef(ref: string): string | undefined {
    return this.refs.get(ref)?.label;
  }

  private backendNodeId(ref: string): number {
    const found = this.refs.get(ref);
    if (found === undefined) {
      throw new Error(`No element has ref ${ref}. Take a new snapshot and use a ref from it.`);
    }
    return found.backendNodeId;
  }

  private async objectIdFor(backendNodeId: number): Promise<string> {
    const { object } = await this.client.send("DOM.resolveNode", { backendNodeId });
    if (object.objectId === undefined) {
      throw new Error("The element is no longer in the page. Take a new snapshot.");
    }
    return object.objectId;
  }

  /**
   * A mouse click at the element's centre. A browser without a layout engine has no box model to
   * aim at, so the click falls back to the element's own `click()`.
   */
  private async click(backendNodeId: number): Promise<void> {
    const objectId = await this.objectIdFor(backendNodeId);
    await this.client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const anchor = this.closest ? this.closest("a") : null;
        if (anchor && anchor.target === "_blank") { anchor.target = "_self"; }
      }`,
    });
    try {
      await this.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const { model } = await this.client.send("DOM.getBoxModel", { backendNodeId });
      const [left, top, , , right, bottom] = model.content;
      await this.page.mouse.click(
        ((left ?? 0) + (right ?? 0)) / 2,
        ((top ?? 0) + (bottom ?? 0)) / 2,
      );
    } catch {
      await this.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function () { this.click(); }",
      });
    }
  }

  private async type(backendNodeId: number, text: string, submit: boolean): Promise<void> {
    await this.client.send("DOM.focus", { backendNodeId });
    const objectId = await this.objectIdFor(backendNodeId);
    await this.client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { if (this.select) { this.select(); } }",
    });
    if (text === "") {
      await this.page.keyboard.press("Backspace");
    } else {
      await this.page.keyboard.type(text);
    }
    if (submit) {
      await this.page.keyboard.press("Enter");
    }
  }

  private async select(backendNodeId: number, value: string): Promise<void> {
    const objectId = await this.objectIdFor(backendNodeId);
    const outcome = await this.client.send("Runtime.callFunctionOn", {
      objectId,
      arguments: [{ value }],
      returnByValue: true,
      functionDeclaration: `function (wanted) {
        const options = this.options ? Array.from(this.options) : [];
        const match = options.find(
          (option) => option.value === wanted || option.label === wanted || option.text.trim() === wanted,
        );
        if (!match) { return false; }
        this.value = match.value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }`,
    });
    if (outcome.result.value !== true) {
      throw new Error(`No option of that element matches ${JSON.stringify(value)}.`);
    }
  }

  private async settle(): Promise<void> {
    await this.page
      .waitForNetworkIdle({ idleTime: SETTLE_IDLE_MS, timeout: SETTLE_TIMEOUT_MS })
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.release();
    } finally {
      if (this.owned.profileDirectory !== undefined) {
        await rm(this.owned.profileDirectory, { recursive: true, force: true });
      }
    }
  }
}

/**
 * The run's browser: launched on first use, closed once when the run ends. Sub-agents share
 * their parent's, and the parent closes it.
 */
export class BrowserSessions {
  private session: Promise<BrowserSession> | undefined;
  private closed = false;

  /** The run's browser, launching it with `launch` the first time. */
  obtain(launch: () => Promise<BrowserSession>): Promise<BrowserSession> {
    if (this.closed) {
      return Promise.reject(new Error("The browser for this run is closed."));
    }
    if (this.session === undefined) {
      const pending = launch();
      this.session = pending;
      pending.catch(() => {
        if (this.session === pending) {
          this.session = undefined;
        }
      });
    }
    return this.session;
  }

  /** The run's browser when one was launched, without launching it. */
  peek(): Promise<BrowserSession> | undefined {
    return this.session;
  }

  /** Close the browser if one was launched; the next `obtain` launches a fresh one. */
  async release(): Promise<void> {
    const pending = this.session;
    this.session = undefined;
    if (pending === undefined) {
      return;
    }
    const session = await pending.catch(() => undefined);
    await session?.close();
  }

  /**
   * End the run's use of the browser: close it and refuse to launch another. Safe to call twice
   * and while a launch is pending.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.release();
  }
}
