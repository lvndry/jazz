/**
 * One headless browser per run, reused across the browser tools and closed when the run ends.
 *
 * `BrowserSessions` is the run-scoped holder: the runner opens one for a top-level run, hands
 * the same object to its sub-agents, and closes it when the run finishes, errors or is
 * interrupted. The browser itself launches on the first tool call, into a fresh temporary
 * profile that is deleted with it, so no cookie or login outlives the run.
 *
 * A run works in named tabs, up to `MAX_TABS`, and acts on the active one. It starts with one
 * tab named `main`; a popup is refused by the browser rather than opened. Every tab a run opens
 * is its own: in a browser the user runs, the run's tabs live in a separate browser context, so
 * they share no cookies or logins with the user's own tabs.
 *
 * The user's own tabs are invisible to the run. A tab joins only when the person adopts it: the
 * session lists the user's tabs to the host, never to the model, and `adopt` attaches to exactly
 * the one tab the person approved. An adopted tab is guarded like any other and is detached,
 * never closed, when the run ends.
 *
 * Every request a tab makes passes through `decideBrowserRequest`. Tool calls on a session run
 * one at a time, so the policy in force for a call (private addresses approved for it) is the
 * one every request during that call is judged by.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import puppeteer, {
  type Browser,
  type CDPSession,
  type Frame,
  type HTTPRequest,
  type Page,
} from "puppeteer-core";
import type { PageFlagId, PageStructuralSignals } from "@/core/types/plugin";
import type { EgressPolicy } from "../guarded-fetch";
import { readPageSignals } from "./page-signals";
import { stripSingletonLocks } from "./real-profile";
import { decideBrowserRequest } from "./request-guard";
import { describeMissingBrowser } from "../chromium-default";
import { buildSnapshot, type PageSnapshot } from "./snapshot";
import {
  DEFAULT_TAB_NAME,
  RefTable,
  STALE_REF_MESSAGE,
  TabRegistry,
  matchAdoptionCandidates,
  missingRefMessage,
  type AdoptionCandidate,
  type RefLookup,
} from "./tabs";

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

const BLANK_PAGE_URL = "about:blank";

/** What the model is told when an adoption did not happen, whatever the reason. */
export const NOT_ADOPTED_MESSAGE = "No tab was adopted.";

export const NO_TAB_MESSAGE = "No tab is open. Use browser_navigate to open one.";

export interface BrowserSettings {
  /** The browser binary to launch when nothing else answers. */
  readonly executablePath: string | null;
  /** A running browser to drive instead of launching one: an `http(s)://` or `ws(s)://` URL. */
  readonly cdpEndpoint?: string | undefined;
  /**
   * A snapshot of the user's real profile to launch on (from `snapshotRealProfile`),
   * so the agent browses as them. Only used on the launch path; when absent the run
   * gets a blank temporary profile.
   */
  readonly realProfileDir?: string | undefined;
  /** Launch with a visible window instead of headless. */
  readonly headed?: boolean;
}

/** The DevTools port a local browser the person runs listens on. Tries this first when no `browser.endpoint` is set. */
export const DEFAULT_LOOPBACK_CDP_ENDPOINT = "http://127.0.0.1:9222";

export interface PageState {
  /** The name of the tab this state describes. */
  readonly tab: string;
  readonly url: string;
  readonly title: string;
}

export interface SnapshotResult extends PageState {
  readonly snapshot: PageSnapshot;
}

export interface TabSummary extends PageState {
  readonly origin: TabOrigin;
  readonly active: boolean;
}

/** What the person is shown when asked to adopt a tab. */
export interface AdoptionOffer {
  readonly title: string;
  readonly url: string;
}

export type TabOrigin = "owned" | "adopted";

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
  "No browser is available: nothing listens at " +
  DEFAULT_LOOPBACK_CDP_ENDPOINT +
  " and no Chromium-based browser could be launched. " +
  describeMissingBrowser();

export function adoptedNavigationMessage(name: string): string {
  return `Tab "${name}" is one you adopted and stays on the page it is on. Open another tab with browser_navigate and a tab name.`;
}

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

function isWebPage(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * How a session opens tabs of its own and, in a browser the user runs, reaches the user's. The
 * session is built from one so tests can supply pages without a browser.
 */
export interface BrowserEngine {
  readonly newPage: () => Promise<Page>;
  /** The user's own pages in an attached browser; undefined for a browser this run launched. */
  readonly userPages: (() => Promise<readonly Page[]>) | undefined;
  readonly release: () => Promise<void>;
  readonly profileDirectory: string | undefined;
}

interface Tab {
  readonly origin: TabOrigin;
  readonly page: Page;
  readonly client: CDPSession;
  readonly refs: RefTable;
  /** Stop guarding the page and let go of it; an owned tab's page is also closed. */
  readonly dispose: () => Promise<void>;
}

/** A DevTools port for a launched browser. Tries a handful of candidate ports in order. */
const LAUNCH_PORTS: readonly number[] = [9331, 9332, 9333, 9334, 9335];

/** Longest the run waits for a launched browser to open its DevTools port. */
const LAUNCH_WAIT_MS = 20_000;

/**
 * Pick a free loopback port: bind to port 0 (OS-assigned) momentarily, release it, and use it.
 * Falls back to the candidate list if the ephemeral bind races. Returns a port to launch on.
 */
async function acquireLoopbackPort(): Promise<number> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const address = probe.address();
    if (address && typeof address === "object" && address.port > 0) {
      return address.port;
    }
  } finally {
    probe.close();
  }
  for (const port of LAUNCH_PORTS) {
    if (await portIsFree(port)) {
      return port;
    }
  }
  throw new Error("Could not find a free local port to launch a browser on.");
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen({ host: "127.0.0.1", port });
  });
}

/**
 * Launch `executablePath` with a DevTools port and connect to it, retrying until its
 * /json/version answers. The child is owned by this process; the returned `Browser`
 * disconnects and the caller closes it on release.
 */
interface LaunchedBrowser {
  readonly browser: Browser;
  readonly child: import("node:child_process").ChildProcess;
}

async function connectToPort(options: {
  executablePath: string;
  profileDirectory: string;
  port: number;
  headed?: boolean;
}): Promise<LaunchedBrowser> {
  const { executablePath, profileDirectory, port, headed } = options;
  const child = spawn(
    executablePath,
    [
      ...(headed ? [] : ["--headless=new"]),
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...sandboxArguments(),
      POPUP_FLAG,
      "--disable-extensions",
      "--mute-audio",
    ],
    { stdio: "ignore", detached: true },
  );
  child.on("error", () => undefined);
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${String(port)}`,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      });
      // The child outlives this call on purpose: release() closes the CDP connection and
      // kills the child; the run's end is when the profile is removed.
      child.unref();
      return { browser, child };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  child.kill("SIGKILL");
  throw new Error(`Browser did not open a DevTools port in time: ${errorMessage(lastError)}`);
}

export class BrowserSession {
  private policy: EgressPolicy = {};
  private verifiedHosts = new Set<string>();
  private readonly approvedOrigins = new Set<string>();
  private readonly tabs = new TabRegistry<Tab>();
  private readonly adoptionOffers = new Map<string, AdoptionCandidate<Page>>();
  private blocks: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private flagged: { readonly url: string; readonly flags: readonly PageFlagId[] } | undefined;

  private constructor(private readonly engine: BrowserEngine) {}

  private pendingActBinding: number | undefined;

  /**
   * Drive `settings.cdpEndpoint` when one is set. When it is not, try a browser the person
   * runs on the local DevTools port, and only then launch Chrome into a temporary profile.
   */
  static async open(settings: BrowserSettings): Promise<BrowserSession> {
    if (settings.cdpEndpoint !== undefined) {
      return BrowserSession.connect(settings.cdpEndpoint);
    }
    if (settings.executablePath === null) {
      throw new Error(MISSING_CHROME_ERROR);
    }
    try {
      return await BrowserSession.connect(DEFAULT_LOOPBACK_CDP_ENDPOINT);
    } catch {
      return BrowserSession.launch(
        settings.executablePath,
        settings.realProfileDir,
        settings.headed,
      );
    }
  }

  private static async connect(endpoint: string): Promise<BrowserSession> {
    const browser = await puppeteer
      .connect({
        ...(isWebSocketEndpoint(endpoint)
          ? { browserWSEndpoint: endpoint }
          : { browserURL: endpoint }),
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
      })
      .catch((error: unknown) => {
        throw new Error(
          `Could not reach a browser at ${endpoint}: ${errorMessage(error)}. ` +
            "Run your browser with `--remote-debugging-port=9222`, install Chrome, or set " +
            "browser.endpoint to a running browser.",
        );
      });
    const context = await browser.createBrowserContext();
    // A browser we connect to has no --block-new-web-contents, so a popup in the run's
    // context would be a page the request guard never installed. Close it instead of
    // letting it issue unguarded requests.
    context.on("page", (page: unknown) => {
      void (page as { close: () => Promise<void> }).close().catch(() => undefined);
    });
    return BrowserSession.openWith({
      newPage: () => context.newPage(),
      userPages: () => userPagesOf(browser),
      profileDirectory: undefined,
      release: async () => {
        await context.close().catch(() => undefined);
        await browser.disconnect();
      },
    });
  }

  /**
   * Launch a browser the run owns, into a temporary profile, and drive it over CDP on a
   * loopback port. Port + connect (rather than `puppeteer.launch`'s pipe transport) is used
   * because Chromium-based browsers that are not Google Chrome proper — Arc, Opera, Vivaldi
   * and other Electron-packaged engines — answer a DevTools port reliably but not always the
   * pipe handshake. The run launches its own child, so `release` closes the browser and the
   * temporary profile is deleted with it.
   */
  private static async launch(
    executablePath: string,
    realProfileDir?: string,
    headed = false,
  ): Promise<BrowserSession> {
    // The real-profile snapshot (when present) already lives under its own temporary root
    // that the caller releases; otherwise the run owns a fresh blank profile directory.
    const ownsProfile = realProfileDir === undefined;
    const profileDirectory =
      realProfileDir ?? (await mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX)));
    try {
      // A cloned profile still carries the user's running browser's singleton lock, which
      // makes the launched instance forward to it and exit: strip it before connecting.
      await stripSingletonLocks(profileDirectory);
      const port = await acquireLoopbackPort();
      const launched = await connectToPort({ executablePath, profileDirectory, port, headed });
      return await BrowserSession.openWith({
        newPage: () => launched.browser.newPage(),
        userPages: undefined,
        profileDirectory,
        release: async () => {
          // A CDP-connected browser does not kill its child on close(), so reap it here.
          await launched.browser.close().catch(() => undefined);
          launched.child.kill("SIGKILL");
          if (ownsProfile) {
            await rm(profileDirectory, { recursive: true, force: true });
          }
        },
      });
    } catch (error) {
      if (ownsProfile) {
        await rm(profileDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  /** A session over `engine`, opened on its first tab. */
  static async openWith(engine: BrowserEngine): Promise<BrowserSession> {
    const session = new BrowserSession(engine);
    try {
      await session.openOwnedTab(DEFAULT_TAB_NAME);
    } catch (error) {
      await engine.release().catch(() => undefined);
      throw error;
    }
    return session;
  }

  /** Identity of the active tab's snapshot, so an approval can bind to the page it reviewed. */
  actBinding(): number | undefined {
    const name = this.tabs.active();
    return name === undefined ? undefined : this.tabs.get(name)?.refs.pageRevision;
  }

  /** Record the snapshot the approval was shown for. */
  bindAct(): void {
    this.pendingActBinding = this.actBinding();
  }

  /** Reject the action if the page changed after the approval was shown. Call first inside the serialized operation. */
  consumeActBinding(): void {
    const bound = this.pendingActBinding;
    this.pendingActBinding = undefined;
    if (bound !== undefined && bound !== this.actBinding()) {
      throw new Error(
        "The page changed since you approved this action. Take a new browser_snapshot and approve again.",
      );
    }
  }

  /** Whether the person can adopt one of their own tabs: only in a browser they run. */
  get canAdopt(): boolean {
    return this.engine.userPages !== undefined;
  }

  private async openOwnedTab(name: string): Promise<Tab> {
    const problem = this.tabs.problemAdding(name);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    const page = await this.engine.newPage();
    let tab: Tab;
    try {
      tab = await this.attach(page, "owned");
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
    this.tabs.add(name, tab);
    return tab;
  }

  private async attach(page: Page, origin: TabOrigin): Promise<Tab> {
    const owned = origin === "owned";
    const dismissDialog = (dialog: { dismiss: () => Promise<void> }): void => {
      void dialog.dismiss().catch(() => undefined);
    };
    if (owned) {
      await page.setViewport(VIEWPORT);
      page.on("dialog", dismissDialog);
    }
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const client = await page.createCDPSession();
    await client.send("Accessibility.enable");
    if (owned) {
      try {
        await client.send("Page.setDownloadBehavior", { behavior: "deny" });
      } catch (error) {
        await page.close().catch(() => undefined);
        throw new Error(
          `Could not block downloads in the browser: ${errorMessage(error)}. ` +
            "A page might otherwise write files without being asked.",
          { cause: error },
        );
      }
    }

    const refs = new RefTable();
    const onNavigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) {
        refs.invalidate();
      }
    };
    const onRequest = (request: HTTPRequest): void => {
      void this.guard(page, request);
    };
    page.on("framenavigated", onNavigated);
    await page.setRequestInterception(true);
    page.on("request", onRequest);

    return {
      origin,
      page,
      client,
      refs,
      dispose: async () => {
        page.off("framenavigated", onNavigated);
        page.off("request", onRequest);
        if (owned) {
          page.off("dialog", dismissDialog);
          await page.close().catch(() => undefined);
          return;
        }
        await page.setRequestInterception(false).catch(() => undefined);
        await client.send("Accessibility.disable").catch(() => undefined);
        await client.detach().catch(() => undefined);
      },
    };
  }

  private async guard(page: Page, request: HTTPRequest): Promise<void> {
    const isMainFrameNavigation =
      request.isNavigationRequest() && request.frame() === page.mainFrame();
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
        throw new Error(`${errorMessage(error)}${this.blockedSummary()}`, { cause: error });
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** The requests the guard refused during the current call, worded for a failure message. */
  blockedSummary(): string {
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

  /** The active tab and its name, or an error when no tab is open. */
  private active(): { readonly name: string; readonly tab: Tab } {
    const name = this.tabs.active();
    const tab = name === undefined ? undefined : this.tabs.get(name);
    if (name === undefined || tab === undefined) {
      throw new Error(NO_TAB_MESSAGE);
    }
    return { name, tab };
  }

  private async describe(name: string, tab: Tab): Promise<PageState> {
    return { tab: name, url: tab.page.url(), title: await tab.page.title() };
  }

  /** Whether a tab is open to act on. */
  hasTab(): boolean {
    return this.tabs.active() !== undefined;
  }

  /** How many tabs are open. */
  get tabCount(): number {
    return this.tabs.size;
  }

  async state(): Promise<PageState> {
    const { name, tab } = this.active();
    return this.describe(name, tab);
  }

  /**
   * Open `url` in the tab named `tabName`, opening that tab first when it does not exist, or in
   * the active tab when no name is given. The tab becomes the active one.
   */
  async navigate(url: string, tabName?: string): Promise<PageState> {
    const decision = await decideBrowserRequest(
      { url, isMainFrameNavigation: true },
      this.policy,
      this.approvedOrigins,
      this.verifiedHosts,
    );
    if (decision.kind === "abort") {
      throw new Error(`Navigation refused: ${decision.reason}.`);
    }
    const name = await this.tabForNavigation(tabName);
    const tab = this.tabs.get(name);
    if (tab === undefined) {
      throw new Error(NO_TAB_MESSAGE);
    }
    if (tab.origin === "adopted") {
      throw new Error(adoptedNavigationMessage(name));
    }
    this.approvedOrigins.add(new URL(url).origin);
    await tab.page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    await this.settle(tab.page);
    return this.describe(name, tab);
  }

  private async tabForNavigation(requested: string | undefined): Promise<string> {
    if (requested !== undefined) {
      if (this.tabs.has(requested)) {
        this.tabs.activate(requested);
        return requested;
      }
      if (this.untouchedStartTab()) {
        this.tabs.rename(DEFAULT_TAB_NAME, requested);
        return requested;
      }
      await this.openOwnedTab(requested);
      return requested;
    }
    const active = this.tabs.active();
    if (active !== undefined) {
      return active;
    }
    await this.openOwnedTab(DEFAULT_TAB_NAME);
    return DEFAULT_TAB_NAME;
  }

  /**
   * Whether the tab the run started with is still the only one and still blank. The first named
   * navigation takes that tab over instead of leaving it empty beside the one it opens.
   */
  private untouchedStartTab(): boolean {
    const start = this.tabs.get(DEFAULT_TAB_NAME);
    return (
      this.tabs.size === 1 &&
      start !== undefined &&
      start.origin === "owned" &&
      start.page.url() === BLANK_PAGE_URL
    );
  }

  async back(): Promise<PageState> {
    const { name, tab } = this.active();
    const response = await tab.page.goBack({
      waitUntil: "load",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    if (response === null && tab.page.url() === "about:blank") {
      throw new Error("There is no earlier page in this browser's history.");
    }
    await this.settle(tab.page);
    return this.describe(name, tab);
  }

  async snapshot(): Promise<SnapshotResult> {
    const { name, tab } = this.active();
    const tree = await tab.client.send("Accessibility.getFullAXTree", {});
    const snapshot = buildSnapshot(tree.nodes);
    tab.refs.replace(snapshot.refs);
    return { ...(await this.describe(name, tab)), snapshot };
  }

  async screenshot(filePath: string, fullPage: boolean): Promise<PageState> {
    const { name, tab } = this.active();
    await tab.page.screenshot({ path: filePath, type: "png", fullPage });
    return this.describe(name, tab);
  }

  /**
   * A submit can send a typed secret over the field's form, whose action may differ from the
   * top-level page. Block a plaintext destination so the secret never travels over HTTP.
   */
  private async verifyFormDestination(ref: string): Promise<void> {
    const name = this.tabs.active();
    const tab = name === undefined ? undefined : this.tabs.get(name);
    if (tab === undefined) {
      return;
    }
    const backendNodeId = tab.refs.lookup(ref);
    if (backendNodeId.kind !== "ok") {
      return;
    }
    let formUrl: string | null;
    try {
      const resolved = (await tab.client.send("DOM.resolveNode", {
        backendNodeId: backendNodeId.backendNodeId,
      })) as unknown as { readonly object: string };
      const called = (await tab.client.send("Runtime.callFunctionOn", {
        objectId: resolved.object,
        functionDeclaration:
          "function () { const form = this.closest('form'); return form ? form.action : null; }",
        returnByValue: true,
      })) as { readonly result: { readonly value: unknown } };
      formUrl = typeof called.result.value === "string" ? called.result.value : null;
    } catch {
      return;
    }
    if (formUrl === null) {
      return;
    }
    try {
      const destination = new URL(formUrl, tab.page.url());
      const loopback = destination.hostname === "localhost" || destination.hostname === "127.0.0.1";
      if (destination.protocol === "http:" && !loopback) {
        throw new Error(
          `This form posts to ${destination.origin}, which is not served over https, so a secret you typed ` +
            "is not submitted there. Approve it over an https form instead.",
        );
      }
    } catch (error) {
      if (error instanceof TypeError) {
        return;
      }
      throw error;
    }
  }

  async act(action: PageAction): Promise<PageState> {
    if (action.kind === "type" && action.submit) {
      await this.verifyFormDestination(action.ref);
    }
    const { name, tab } = this.active();
    switch (action.kind) {
      case "click":
        await this.click(tab, this.backendNodeId(tab, action.ref));
        break;
      case "type":
        await this.type(tab, this.backendNodeId(tab, action.ref), action.text, action.submit);
        break;
      case "select":
        await this.select(tab, this.backendNodeId(tab, action.ref), action.value);
        break;
      case "press":
        await tab.page.keyboard.press(action.key as Parameters<Page["keyboard"]["press"]>[0]);
        break;
    }
    await this.settle(tab.page);
    return this.describe(name, tab);
  }

  /** What the active tab's latest snapshot says about `ref`. */
  resolveRef(ref: string): RefLookup {
    const name = this.tabs.active();
    const tab = name === undefined ? undefined : this.tabs.get(name);
    return tab === undefined ? { kind: "missing" } : tab.refs.lookup(ref);
  }

  /** Whether the active document holds a password or card field. */
  pageSignals(): Promise<PageStructuralSignals> {
    const { tab } = this.active();
    return readPageSignals(tab.page);
  }

  /** Remember the flags raised for `url`, for the approvals that follow on that page. */
  recordFlags(url: string, flags: readonly PageFlagId[]): void {
    this.flagged = { url, flags };
  }

  /** The flags last raised for `url`; none when the session has not flagged that page. */
  flagsFor(url: string): readonly PageFlagId[] {
    return this.flagged?.url === url ? this.flagged.flags : [];
  }

  private backendNodeId(tab: Tab, ref: string): number {
    const found = tab.refs.lookup(ref);
    if (found.kind === "stale") {
      throw new Error(STALE_REF_MESSAGE);
    }
    if (found.kind === "missing") {
      throw new Error(missingRefMessage(ref));
    }
    return found.backendNodeId;
  }

  /** The run's tabs with the address and title each shows now. */
  async listTabs(): Promise<readonly TabSummary[]> {
    const active = this.tabs.active();
    return Promise.all(
      this.tabs.entries().map(async ([name, tab]) => ({
        ...(await this.describe(name, tab)),
        origin: tab.origin,
        active: name === active,
      })),
    );
  }

  async switchTab(name: string): Promise<PageState> {
    const tab = this.tabs.activate(name);
    return this.describe(name, tab);
  }

  /**
   * Close the tab named `name`. A tab the person adopted is detached and left open in their
   * browser.
   */
  async closeTab(name: string): Promise<{ readonly closed: string; readonly active?: string }> {
    const tab = this.tabs.remove(name);
    await tab.dispose();
    const active = this.tabs.active();
    return active === undefined ? { closed: name } : { closed: name, active };
  }

  /**
   * The user's tabs an adoption request naming `hint` could mean, for the person who is asked,
   * never for the model. When exactly one matches it is remembered as the one on offer, so
   * `adopt` attaches to that tab and to no other.
   */
  async offerAdoption(hint: string, name: string): Promise<readonly AdoptionOffer[]> {
    const matches = matchAdoptionCandidates(await this.userCandidates(), hint);
    const key = adoptionKey(hint, name);
    this.adoptionOffers.delete(key);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) {
      this.adoptionOffers.set(key, only);
    }
    return matches.map((candidate) => ({ title: candidate.title, url: candidate.url }));
  }

  /**
   * Attach to the tab that was offered to the person for `hint` and `name`, and make it the
   * active tab. It fails, with a message that does not say why, unless the very tab and address
   * the person saw are still the only match.
   */
  async adopt(hint: string, name: string): Promise<PageState> {
    const key = adoptionKey(hint, name);
    const offered = this.adoptionOffers.get(key);
    this.adoptionOffers.delete(key);
    const matches = matchAdoptionCandidates(await this.userCandidates(), hint);
    const found = matches.length === 1 ? matches[0] : undefined;
    const problem = this.tabs.problemAdding(name);
    if (
      offered === undefined ||
      found === undefined ||
      found.page !== offered.page ||
      found.url !== offered.url ||
      problem !== undefined
    ) {
      throw new Error(NOT_ADOPTED_MESSAGE);
    }
    const tab = await this.attach(found.page, "adopted");
    try {
      this.tabs.add(name, tab);
    } catch (error) {
      await tab.dispose();
      throw error;
    }
    this.approvedOrigins.add(new URL(found.url).origin);
    return this.describe(name, tab);
  }

  private async userCandidates(): Promise<readonly AdoptionCandidate<Page>[]> {
    if (this.engine.userPages === undefined) {
      return [];
    }
    const adopted = new Set(
      this.tabs
        .entries()
        .filter(([, tab]) => tab.origin === "adopted")
        .map(([, tab]) => tab.page),
    );
    const pages = await this.engine.userPages();
    return Promise.all(
      pages
        .filter((page) => isWebPage(page.url()) && !adopted.has(page))
        .map(async (page) => ({ page, url: page.url(), title: await page.title() })),
    );
  }

  private async objectIdFor(tab: Tab, backendNodeId: number): Promise<string> {
    const { object } = await tab.client.send("DOM.resolveNode", { backendNodeId });
    if (object.objectId === undefined) {
      throw new Error("The element is no longer in the page. Take a new snapshot.");
    }
    return object.objectId;
  }

  /**
   * A mouse click at the element's centre. A browser without a layout engine has no box model to
   * aim at, so the click falls back to the element's own `click()`.
   */
  private async click(tab: Tab, backendNodeId: number): Promise<void> {
    const objectId = await this.objectIdFor(tab, backendNodeId);
    await tab.client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const anchor = this.closest ? this.closest("a") : null;
        if (anchor && anchor.target === "_blank") { anchor.target = "_self"; }
      }`,
    });
    try {
      await tab.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const { model } = await tab.client.send("DOM.getBoxModel", { backendNodeId });
      const [left, top, , , right, bottom] = model.content;
      await tab.page.mouse.click(
        ((left ?? 0) + (right ?? 0)) / 2,
        ((top ?? 0) + (bottom ?? 0)) / 2,
      );
    } catch {
      await tab.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function () { this.click(); }",
      });
    }
  }

  private async type(
    tab: Tab,
    backendNodeId: number,
    text: string,
    submit: boolean,
  ): Promise<void> {
    await tab.client.send("DOM.focus", { backendNodeId });
    const objectId = await this.objectIdFor(tab, backendNodeId);
    await tab.client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { if (this.select) { this.select(); } }",
    });
    if (text === "") {
      await tab.page.keyboard.press("Backspace");
    } else {
      await tab.page.keyboard.type(text);
    }
    if (submit) {
      await tab.page.keyboard.press("Enter");
    }
  }

  private async select(tab: Tab, backendNodeId: number, value: string): Promise<void> {
    const objectId = await this.objectIdFor(tab, backendNodeId);
    const outcome = await tab.client.send("Runtime.callFunctionOn", {
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

  private async settle(page: Page): Promise<void> {
    await page
      .waitForNetworkIdle({ idleTime: SETTLE_IDLE_MS, timeout: SETTLE_TIMEOUT_MS })
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      for (const [, tab] of this.tabs.entries()) {
        if (tab.origin === "adopted") {
          await tab.dispose().catch(() => undefined);
        }
      }
      await this.engine.release();
    } finally {
      if (this.engine.profileDirectory !== undefined) {
        await rm(this.engine.profileDirectory, { recursive: true, force: true });
      }
    }
  }
}

function adoptionKey(hint: string, name: string): string {
  return `${name}\n${hint}`;
}

/** The pages of the user's own context in an attached browser, not the run's separate one. */
async function userPagesOf(browser: Browser): Promise<readonly Page[]> {
  const userContext = browser.defaultBrowserContext();
  const pages = await browser.pages();
  return pages.filter((page) => page.browserContext() === userContext);
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
