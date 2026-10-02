import { describe, expect, test } from "bun:test";
import type { EgressPolicy } from "../guarded-fetch";
import { decideBrowserRequest } from "./request-guard";

function resolverTo(table: Readonly<Record<string, readonly string[]>>) {
  const lookups: string[] = [];
  const resolveHost = async (hostname: string): Promise<readonly string[]> => {
    lookups.push(hostname);
    const addresses = table[hostname];
    if (addresses === undefined) {
      throw new Error(`no such host ${hostname}`);
    }
    return addresses;
  };
  return { resolveHost, lookups };
}

const PUBLIC_HOSTS = {
  "example.com": ["93.184.216.34"],
  "cdn.example.net": ["93.184.216.35"],
  "intranet.local": ["10.0.0.5"],
  "rebind.example.org": ["127.0.0.1"],
};

function navigation(url: string) {
  return { url, isMainFrameNavigation: true };
}

function subresource(url: string) {
  return { url, isMainFrameNavigation: false };
}

describe("decideBrowserRequest", () => {
  test("lets a public http(s) page and its subresources load", async () => {
    const policy: EgressPolicy = { resolveHost: resolverTo(PUBLIC_HOSTS).resolveHost };

    expect(
      await decideBrowserRequest(navigation("https://example.com/"), policy, new Set()),
    ).toEqual({
      kind: "continue",
    });
    expect(
      await decideBrowserRequest(subresource("https://cdn.example.net/app.js"), policy, new Set()),
    ).toEqual({ kind: "continue" });
  });

  test("refuses file: URLs for navigations and subresources", async () => {
    const policy: EgressPolicy = {};

    for (const request of [navigation("file:///etc/passwd"), subresource("file:///etc/passwd")]) {
      expect(await decideBrowserRequest(request, policy, new Set())).toEqual({
        kind: "abort",
        reason: "file: URLs are not supported",
      });
    }
  });

  test("refuses other schemes such as chrome: and ws:", async () => {
    for (const url of ["chrome://settings", "ws://example.com/socket", "ftp://example.com/x"]) {
      const decision = await decideBrowserRequest(subresource(url), {}, new Set());
      expect(decision.kind).toBe("abort");
    }
  });

  test("allows in-page schemes for subresources but not as a navigation target", async () => {
    expect(
      await decideBrowserRequest(subresource("data:image/png;base64,AAAA"), {}, new Set()),
    ).toEqual({
      kind: "continue",
    });
    expect(
      await decideBrowserRequest(subresource("blob:https://example.com/id"), {}, new Set()),
    ).toEqual({
      kind: "continue",
    });
    expect(
      await decideBrowserRequest(navigation("data:text/html,<p>x</p>"), {}, new Set()),
    ).toEqual({
      kind: "abort",
      reason: "navigation to data: URLs is not supported",
    });
    expect(await decideBrowserRequest(navigation("about:blank"), {}, new Set())).toEqual({
      kind: "continue",
    });
  });

  test("refuses private and loopback destinations a public page asks for", async () => {
    const policy: EgressPolicy = { resolveHost: resolverTo(PUBLIC_HOSTS).resolveHost };

    for (const url of [
      "http://127.0.0.1:8080/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://intranet.local/",
      "http://rebind.example.org/",
      "http://[::1]/",
    ]) {
      const decision = await decideBrowserRequest(subresource(url), policy, new Set());
      expect(decision.kind).toBe("abort");
    }
  });

  test("allows a private host that network.allowPrivateHosts names", async () => {
    const policy: EgressPolicy = {
      resolveHost: resolverTo(PUBLIC_HOSTS).resolveHost,
      allowPrivateHosts: ["intranet.local"],
    };

    expect(
      await decideBrowserRequest(navigation("http://intranet.local/"), policy, new Set()),
    ).toEqual({
      kind: "continue",
    });
  });

  test("refuses a host that does not resolve", async () => {
    const policy: EgressPolicy = { resolveHost: resolverTo({}).resolveHost };

    const decision = await decideBrowserRequest(
      navigation("https://nowhere.test/"),
      policy,
      new Set(),
    );

    expect(decision.kind).toBe("abort");
  });

  test("refuses URLs with embedded credentials", async () => {
    const policy: EgressPolicy = { resolveHost: resolverTo(PUBLIC_HOSTS).resolveHost };

    const decision = await decideBrowserRequest(
      navigation("https://user:secret@example.com/"),
      policy,
      new Set(),
    );

    expect(decision.kind).toBe("abort");
  });

  test("resolves a host once per verified set", async () => {
    const { resolveHost, lookups } = resolverTo(PUBLIC_HOSTS);
    const policy: EgressPolicy = { resolveHost };
    const verified = new Set<string>();

    for (const path of ["a.js", "b.js", "c.css"]) {
      await decideBrowserRequest(
        subresource(`https://cdn.example.net/${path}`),
        policy,
        new Set(),
        verified,
      );
    }

    expect(lookups).toEqual(["cdn.example.net"]);
  });

  test("does not remember a refused host as verified", async () => {
    const { resolveHost, lookups } = resolverTo(PUBLIC_HOSTS);
    const policy: EgressPolicy = { resolveHost };
    const verified = new Set<string>();

    await decideBrowserRequest(subresource("http://intranet.local/a"), policy, new Set(), verified);
    await decideBrowserRequest(subresource("http://intranet.local/b"), policy, new Set(), verified);

    expect(lookups).toEqual(["intranet.local", "intranet.local"]);
    expect(verified.size).toBe(0);
  });

  describe("with a network.httpApproval URL list", () => {
    const policy: EgressPolicy = {
      resolveHost: resolverTo(PUBLIC_HOSTS).resolveHost,
      httpApproval: ["https://example.com/docs/*"],
    };

    test("loads a granted navigation and refuses an ungranted one", async () => {
      expect(
        await decideBrowserRequest(navigation("https://example.com/docs/intro"), policy, new Set()),
      ).toEqual({ kind: "continue" });

      const refused = await decideBrowserRequest(
        navigation("https://example.com/account"),
        policy,
        new Set(),
      );
      expect(refused).toEqual({ kind: "abort", reason: "outside network.httpApproval" });
    });

    test("lets an approved origin load its own subresources but not a third origin's", async () => {
      const approvedOrigins = new Set(["https://example.com"]);

      expect(
        await decideBrowserRequest(
          subresource("https://example.com/static/app.js"),
          policy,
          approvedOrigins,
        ),
      ).toEqual({ kind: "continue" });
      expect(
        await decideBrowserRequest(
          subresource("https://cdn.example.net/track.gif"),
          policy,
          approvedOrigins,
        ),
      ).toEqual({ kind: "abort", reason: "outside network.httpApproval" });
    });

    test("never widens a main-frame navigation to a whole approved origin", async () => {
      const decision = await decideBrowserRequest(
        navigation("https://example.com/account"),
        policy,
        new Set(["https://example.com"]),
      );

      expect(decision.kind).toBe("abort");
    });

    test("honours the URL approved for one call", async () => {
      const oneCall: EgressPolicy = { ...policy, approvedHttpUrl: "https://example.com/account" };

      expect(
        await decideBrowserRequest(navigation("https://example.com/account"), oneCall, new Set()),
      ).toEqual({ kind: "continue" });
    });

    test("still refuses a granted URL that resolves to a private address", async () => {
      const privatePolicy: EgressPolicy = {
        resolveHost: resolverTo(PUBLIC_HOSTS).resolveHost,
        httpApproval: ["http://intranet.local/*"],
      };

      const decision = await decideBrowserRequest(
        navigation("http://intranet.local/x"),
        privatePolicy,
        new Set(),
      );

      expect(decision.kind).toBe("abort");
    });
  });

  test("treats the allow policy as no URL list", async () => {
    const policy: EgressPolicy = {
      resolveHost: resolverTo(PUBLIC_HOSTS).resolveHost,
      httpApproval: "allow",
    };

    expect(
      await decideBrowserRequest(navigation("https://example.com/anything"), policy, new Set()),
    ).toEqual({
      kind: "continue",
    });
  });
});
