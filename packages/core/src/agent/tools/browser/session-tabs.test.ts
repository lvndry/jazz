import { describe, expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { BrowserSession, NOT_ADOPTED_MESSAGE, type BrowserEngine } from "./session";
import { MAX_TABS, STALE_REF_MESSAGE } from "./tabs";

type Listener = (...args: unknown[]) => void;

const BUTTON_TREE = [
  { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Shop" }, childIds: ["2"] },
  {
    nodeId: "2",
    role: { value: "button" },
    name: { value: "Buy" },
    parentId: "1",
    backendDOMNodeId: 42,
  },
];

class FakeClient {
  readonly calls: string[] = [];
  detached = false;

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push(
      method === "DOM.resolveNode" ? `${method} ${String(params?.["backendNodeId"])}` : method,
    );
    if (method === "Accessibility.getFullAXTree") {
      return { nodes: BUTTON_TREE };
    }
    if (method === "DOM.resolveNode") {
      return { object: { objectId: "object-1" } };
    }
    if (method === "DOM.getBoxModel") {
      return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
    }
    return {};
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

class FakeRequest {
  decision: "continued" | "aborted" | undefined;

  constructor(
    private readonly address: string,
    private readonly frameObject: object,
    private readonly navigation = false,
  ) {}

  url(): string {
    return this.address;
  }

  isNavigationRequest(): boolean {
    return this.navigation;
  }

  frame(): object {
    return this.frameObject;
  }

  async continue(): Promise<void> {
    this.decision = "continued";
  }

  async abort(): Promise<void> {
    this.decision = "aborted";
  }
}

class FakePage {
  readonly client = new FakeClient();
  readonly listeners = new Map<string, Set<Listener>>();
  readonly mainFrameObject = { name: "main-frame" };
  interception = false;
  closed = false;
  failAttach = false;
  pressed: string[] = [];
  clicks = 0;
  keyboard = {
    press: async (key: string) => void this.pressed.push(key),
    type: async () => undefined,
  };
  mouse = { click: async () => void (this.clicks += 1) };

  constructor(
    private address: string,
    private readonly pageTitle: string,
    private readonly context: object,
  ) {}

  on(event: string, handler: Listener): this {
    const handlers = this.listeners.get(event) ?? new Set<Listener>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  off(event: string, handler: Listener): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(...args);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  async request(address: string, navigation = false): Promise<FakeRequest> {
    const request = new FakeRequest(address, this.mainFrameObject, navigation);
    this.emit("request", request);
    for (let attempt = 0; attempt < 50 && request.decision === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return request;
  }

  async setViewport(): Promise<void> {}
  setDefaultTimeout(): void {}
  setDefaultNavigationTimeout(): void {}

  async createCDPSession(): Promise<FakeClient> {
    if (this.failAttach) {
      throw new Error("attach failed");
    }
    return this.client;
  }

  async setRequestInterception(value: boolean): Promise<void> {
    this.interception = value;
  }

  mainFrame(): object {
    return this.mainFrameObject;
  }

  url(): string {
    return this.address;
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  async goto(address: string): Promise<void> {
    this.address = address;
  }

  async waitForNetworkIdle(): Promise<void> {}

  browserContext(): object {
    return this.context;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeEngine(options: { userPages?: readonly FakePage[] } = {}) {
  const ownedContext = {};
  const owned: FakePage[] = [];
  let released = 0;
  let userPageCalls = 0;
  let failNextAttach = false;
  const engine: BrowserEngine = {
    newPage: async () => {
      const page = new FakePage("about:blank", "", ownedContext);
      page.failAttach = failNextAttach;
      failNextAttach = false;
      owned.push(page);
      return page as unknown as Page;
    },
    userPages:
      options.userPages === undefined
        ? undefined
        : async () => {
            userPageCalls += 1;
            return options.userPages as unknown as readonly Page[];
          },
    profileDirectory: undefined,
    release: async () => {
      released += 1;
    },
  };
  return {
    engine,
    owned,
    released: () => released,
    userPageCalls: () => userPageCalls,
    failNextAttach: () => {
      failNextAttach = true;
    },
  };
}

const USER_CONTEXT = {};

function userPage(address: string, title: string): FakePage {
  return new FakePage(address, title, USER_CONTEXT);
}

const PUBLIC_ADDRESS = "http://93.184.216.34/";
const PRIVATE_ADDRESS = "http://127.0.0.1:9/";

describe("a session's tabs", () => {
  test("opens with one owned tab named main", async () => {
    const { engine } = makeEngine();

    const session = await BrowserSession.openWith(engine);

    expect(await session.listTabs()).toEqual([
      { tab: "main", url: "about:blank", title: "", origin: "owned", active: true },
    ]);
  });

  test("opens a named tab on navigation and makes it the active one", async () => {
    const { engine, owned } = makeEngine();
    const session = await BrowserSession.openWith(engine);

    const state = await session.navigate(PUBLIC_ADDRESS, "checkout");

    expect(state.tab).toBe("checkout");
    expect(owned).toHaveLength(2);
    const tabs = await session.listTabs();
    expect(tabs.map((tab) => [tab.tab, tab.active])).toEqual([
      ["main", false],
      ["checkout", true],
    ]);
  });

  test("navigates the active tab when no name is given", async () => {
    const { engine, owned } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    await session.navigate(PUBLIC_ADDRESS, "checkout");

    await session.navigate("http://93.184.216.35/");

    expect(owned).toHaveLength(2);
    expect(owned[1]?.url()).toBe("http://93.184.216.35/");
  });

  test("switches back to an existing tab by name", async () => {
    const { engine } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    await session.navigate(PUBLIC_ADDRESS, "checkout");

    const state = await session.switchTab("main");

    expect(state.tab).toBe("main");
    await expect(session.switchTab("missing")).rejects.toThrow('No tab named "missing"');
  });

  test("refuses a navigation the policy forbids without opening a tab", async () => {
    const { engine, owned } = makeEngine();
    const session = await BrowserSession.openWith(engine);

    await expect(session.navigate(PRIVATE_ADDRESS, "sneaky")).rejects.toThrow("Navigation refused");

    expect(owned).toHaveLength(1);
  });

  test("stops at the tab cap with a message naming the way out", async () => {
    const { engine, owned } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    for (let index = 1; index < MAX_TABS; index += 1) {
      await session.navigate(PUBLIC_ADDRESS, `tab-${String(index)}`);
    }

    await expect(session.navigate(PUBLIC_ADDRESS, "one-too-many")).rejects.toThrow(
      "Close one with browser_tabs",
    );

    expect(owned).toHaveLength(MAX_TABS);
  });

  test("closes an owned tab's page and moves the active tab", async () => {
    const { engine, owned } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    await session.navigate(PUBLIC_ADDRESS, "checkout");

    const closed = await session.closeTab("checkout");

    expect(closed).toEqual({ closed: "checkout", active: "main" });
    expect(owned[1]?.closed).toBe(true);
    expect(owned[0]?.closed).toBe(false);
  });

  test("closes a page it could not finish setting up", async () => {
    const { engine, owned, failNextAttach } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    failNextAttach();

    await expect(session.navigate(PUBLIC_ADDRESS, "broken")).rejects.toThrow("attach failed");

    expect(owned[1]?.closed).toBe(true);
    expect(session.tabCount).toBe(1);
  });

  test("guards the requests of every tab it opens, not just the first", async () => {
    const { engine, owned } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    await session.navigate(PUBLIC_ADDRESS, "checkout");

    for (const page of owned) {
      expect(page.interception).toBe(true);
      const blocked = await page.request(PRIVATE_ADDRESS);
      const allowed = await page.request(PUBLIC_ADDRESS);
      expect(blocked.decision).toBe("aborted");
      expect(allowed.decision).toBe("continued");
    }
  });

  test("closes the engine once, however often it is asked", async () => {
    const { engine, released } = makeEngine();
    const session = await BrowserSession.openWith(engine);

    await Promise.all([session.close(), session.close()]);

    expect(released()).toBe(1);
  });
});

describe("refs across a page change", () => {
  test("refuses a ref after the page navigates, until the next snapshot", async () => {
    const { engine, owned } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    await session.snapshot();
    expect(session.resolveRef("e1").kind).toBe("ok");

    owned[0]?.emit("framenavigated", owned[0].mainFrameObject);

    expect(session.resolveRef("e1")).toEqual({ kind: "stale" });
    await expect(session.act({ kind: "click", ref: "e1" })).rejects.toThrow(STALE_REF_MESSAGE);
    expect(owned[0]?.clicks).toBe(0);

    await session.snapshot();
    await session.act({ kind: "click", ref: "e1" });
    expect(owned[0]?.clicks).toBe(1);
  });

  test("keeps a ref good when only a subframe navigates", async () => {
    const { engine, owned } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    await session.snapshot();

    owned[0]?.emit("framenavigated", { name: "subframe" });

    expect(session.resolveRef("e1").kind).toBe("ok");
  });

  test("keeps each tab's refs apart", async () => {
    const { engine } = makeEngine();
    const session = await BrowserSession.openWith(engine);
    await session.snapshot();
    await session.navigate(PUBLIC_ADDRESS, "checkout");

    expect(session.resolveRef("e1")).toEqual({ kind: "missing" });

    await session.switchTab("main");
    expect(session.resolveRef("e1").kind).toBe("ok");
  });
});

describe("a tab the user already had open", () => {
  test("stays out of every view the model gets until it is adopted", async () => {
    const mail = userPage("https://mail.example.com/", "Inbox");
    const bank = userPage("https://bank.example.com/", "Accounts");
    const { engine, userPageCalls } = makeEngine({ userPages: [mail, bank] });
    const session = await BrowserSession.openWith(engine);

    await session.navigate(PUBLIC_ADDRESS, "checkout");
    await session.switchTab("main");
    const tabs = await session.listTabs();

    expect(tabs.map((tab) => tab.tab)).toEqual(["main", "checkout"]);
    expect(JSON.stringify(tabs)).not.toContain("mail.example.com");
    expect(JSON.stringify(tabs)).not.toContain("bank.example.com");
    expect(userPageCalls()).toBe(0);
  });

  test("is offered only to the person, with its title and address, when a hint matches it", async () => {
    const { engine } = makeEngine({
      userPages: [
        userPage("https://mail.example.com/", "Inbox"),
        userPage("https://bank.example.com/", "Accounts"),
      ],
    });
    const session = await BrowserSession.openWith(engine);

    const offers = await session.offerAdoption("inbox", "mail");

    expect(offers).toEqual([{ title: "Inbox", url: "https://mail.example.com/" }]);
  });

  test("is never offered when it is not a web page", async () => {
    const { engine } = makeEngine({
      userPages: [
        userPage("chrome://settings/", "Settings"),
        userPage("file:///Users/me/notes.html", "Notes"),
        userPage("about:blank", ""),
      ],
    });
    const session = await BrowserSession.openWith(engine);

    expect(await session.offerAdoption("settings", "x")).toEqual([]);
    expect(await session.offerAdoption("notes", "x")).toEqual([]);
  });

  test("is attached, guarded and made the active tab once adopted", async () => {
    const mail = userPage("https://mail.example.com/", "Inbox");
    const { engine } = makeEngine({ userPages: [mail] });
    const session = await BrowserSession.openWith(engine);
    await session.offerAdoption("inbox", "mail");

    const state = await session.adopt("inbox", "mail");

    expect(state).toEqual({ tab: "mail", url: "https://mail.example.com/", title: "Inbox" });
    expect(mail.interception).toBe(true);
    expect((await mail.request(PRIVATE_ADDRESS)).decision).toBe("aborted");
    expect((await session.listTabs()).map((tab) => [tab.tab, tab.origin, tab.active])).toEqual([
      ["main", "owned", false],
      ["mail", "adopted", true],
    ]);
  });

  test("leaves the user's window alone: no viewport change and no dialog handler", async () => {
    const mail = userPage("https://mail.example.com/", "Inbox");
    const { engine } = makeEngine({ userPages: [mail] });
    const session = await BrowserSession.openWith(engine);
    await session.offerAdoption("inbox", "mail");

    await session.adopt("inbox", "mail");

    expect(mail.listenerCount("dialog")).toBe(0);
    expect(mail.client.calls).not.toContain("Page.setDownloadBehavior");
  });

  test("refuses to navigate an adopted tab", async () => {
    const { engine } = makeEngine({ userPages: [userPage("https://mail.example.com/", "Inbox")] });
    const session = await BrowserSession.openWith(engine);
    await session.offerAdoption("inbox", "mail");
    await session.adopt("inbox", "mail");

    await expect(session.navigate(PUBLIC_ADDRESS, "mail")).rejects.toThrow("one you adopted");
  });

  test("is detached, not closed, when the run closes its tab", async () => {
    const mail = userPage("https://mail.example.com/", "Inbox");
    const { engine } = makeEngine({ userPages: [mail] });
    const session = await BrowserSession.openWith(engine);
    await session.offerAdoption("inbox", "mail");
    await session.adopt("inbox", "mail");

    await session.closeTab("mail");

    expect(mail.closed).toBe(false);
    expect(mail.interception).toBe(false);
    expect(mail.client.detached).toBe(true);
    expect(mail.listenerCount("request")).toBe(0);
  });

  test("is detached, not closed, when the run ends", async () => {
    const mail = userPage("https://mail.example.com/", "Inbox");
    const { engine, released } = makeEngine({ userPages: [mail] });
    const session = await BrowserSession.openWith(engine);
    await session.offerAdoption("inbox", "mail");
    await session.adopt("inbox", "mail");

    await session.close();

    expect(mail.closed).toBe(false);
    expect(mail.interception).toBe(false);
    expect(mail.client.detached).toBe(true);
    expect(released()).toBe(1);
  });

  test("is not adopted without an offer the person saw", async () => {
    const { engine } = makeEngine({ userPages: [userPage("https://mail.example.com/", "Inbox")] });
    const session = await BrowserSession.openWith(engine);

    await expect(session.adopt("inbox", "mail")).rejects.toThrow(NOT_ADOPTED_MESSAGE);
    expect(session.tabCount).toBe(1);
  });

  test("is not adopted when a hint matches several tabs", async () => {
    const { engine } = makeEngine({
      userPages: [
        userPage("https://mail.example.com/", "Inbox"),
        userPage("https://mail.example.org/", "Inbox"),
      ],
    });
    const session = await BrowserSession.openWith(engine);

    const offers = await session.offerAdoption("inbox", "mail");

    expect(offers).toHaveLength(2);
    await expect(session.adopt("inbox", "mail")).rejects.toThrow(NOT_ADOPTED_MESSAGE);
  });

  test("is not adopted when the tab moved to another address after the person saw it", async () => {
    const mail = userPage("https://mail.example.com/", "Inbox");
    const { engine } = makeEngine({ userPages: [mail] });
    const session = await BrowserSession.openWith(engine);
    await session.offerAdoption("inbox", "mail");

    await mail.goto("https://mail.example.com/compose");

    await expect(session.adopt("inbox", "mail")).rejects.toThrow(NOT_ADOPTED_MESSAGE);
    expect(mail.interception).toBe(false);
  });

  test("is not adopted under a name that is taken or invalid", async () => {
    const { engine } = makeEngine({ userPages: [userPage("https://mail.example.com/", "Inbox")] });
    const session = await BrowserSession.openWith(engine);
    await session.offerAdoption("inbox", "main");
    await expect(session.adopt("inbox", "main")).rejects.toThrow(NOT_ADOPTED_MESSAGE);

    await session.offerAdoption("inbox", "Not Valid");
    await expect(session.adopt("inbox", "Not Valid")).rejects.toThrow(NOT_ADOPTED_MESSAGE);
  });

  test("is not offered again once adopted", async () => {
    const { engine } = makeEngine({ userPages: [userPage("https://mail.example.com/", "Inbox")] });
    const session = await BrowserSession.openWith(engine);
    await session.offerAdoption("inbox", "mail");
    await session.adopt("inbox", "mail");

    expect(await session.offerAdoption("inbox", "again")).toEqual([]);
  });

  test("cannot be adopted in a browser the run launched itself", async () => {
    const { engine } = makeEngine();
    const session = await BrowserSession.openWith(engine);

    expect(session.canAdopt).toBe(false);
    expect(await session.offerAdoption("anything", "x")).toEqual([]);
  });
});
