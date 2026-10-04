/**
 * Offline Cloudflare protocol regressions. The fake account assigns hostnames,
 * retains Access apps and policies, and replaces its production manifest on each
 * deployment, matching the provider boundaries that single-response stubs miss.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  deployToCloudflare,
  prepareCloudflarePublish,
  type CloudflareAsset,
  type CloudflareConfig,
  type CloudflareFetch,
} from "./cloudflare-publish";

const config: CloudflareConfig = {
  token: "fake-token",
  accountId: "account",
  accessEmail: "me@example.com",
};
const allow = { decision: "allow", include: [{ email: { email: "me@example.com" } }] };
interface FakeApp {
  readonly id: string;
  readonly type: string;
  readonly domain: string;
  readonly policies: readonly unknown[];
}
function fakeAccount(
  options: {
    hostname?: string;
    domains?: readonly string[];
    apps?: readonly FakeApp[];
    failAccess?: boolean;
    failDeploy?: boolean;
    missingProject?: boolean;
    invalidProject?: boolean;
    lostPolicies?: boolean;
  } = {},
) {
  const hostname = options.hostname ?? "reports-assigned.pages.dev";
  const apps = [...(options.apps ?? [])];
  const requests: { readonly method: string; readonly url: string; readonly body: unknown }[] = [];
  const uploads: unknown[] = [];
  let production: Record<string, string> = {};
  const fetch: CloudflareFetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    requests.push({ method, url, body });
    const ok = (result: unknown, extra = {}) => ({
      status: 200,
      json: async () => ({ success: true, result, ...extra }),
    });
    const fail = (message: string, status = 403) => ({
      status,
      json: async () => ({ success: false, errors: [{ message }] }),
    });
    if (url.includes("/access/apps")) {
      if (options.failAccess) return fail("Access not_enabled");
      const appId = url.match(/access\/apps\/([^/]+)\/policies(?:\?|$)/)?.[1];
      if (appId) {
        const policies = apps.find((app) => app.id === appId)?.policies ?? [];
        const page = Number(new URL(url).searchParams.get("page"));
        return ok(policies.slice((page - 1) * 50, page * 50), {
          result_info: { total_pages: Math.max(1, Math.ceil(policies.length / 50)) },
        });
      }
      if (method === "GET") {
        const page = Number(new URL(url).searchParams.get("page"));
        return ok(apps.slice((page - 1) * 50, page * 50), {
          result_info: { total_pages: Math.max(1, Math.ceil(apps.length / 50)) },
        });
      }
      const parsed = z
        .object({ type: z.string(), domain: z.string(), policies: z.array(z.unknown()) })
        .parse(body);
      const app: FakeApp = {
        ...parsed,
        id: `app-${apps.length + 1}`,
        policies: options.lostPolicies ? [] : parsed.policies,
      };
      apps.push(app);
      return ok(app);
    }
    if (url.endsWith("/upload-token")) return ok({ jwt: "fake-upload-token" });
    if (url.endsWith("/check-missing"))
      return ok(z.object({ hashes: z.array(z.string()) }).parse(body).hashes);
    if (url.endsWith("/assets/upload")) {
      uploads.push(body);
      return ok({});
    }
    if (url.endsWith("/upsert-hashes")) return ok({});
    if (url.endsWith("/deployments")) {
      if (options.failDeploy) return fail("deployment refused");
      if (!(body instanceof FormData)) throw new Error("deployment must be multipart");
      production = z.record(z.string(), z.string()).parse(JSON.parse(String(body.get("manifest"))));
      expect(body.get("branch")).toBe("main");
      return ok({ url: `https://immutable.${hostname}` });
    }
    if (url.includes("/pages/projects")) {
      if (method === "GET" && options.missingProject) return fail("missing project", 404);
      return ok(
        options.invalidProject
          ? {}
          : { subdomain: hostname, production_branch: "main", domains: options.domains ?? [] },
      );
    }
    throw new Error(`unexpected API request ${method} ${url}`);
  };
  return { fetch, requests, apps, uploads, production: () => production };
}
function asset(path: string, content = path): CloudflareAsset {
  return { path, contentType: "text/html", read: async () => Buffer.from(content) };
}

describe("Cloudflare composition publishing", () => {
  test("protects assigned canonical and immutable hostnames before any upload", async () => {
    const account = fakeAccount({ missingProject: true });
    const prepared = await prepareCloudflarePublish(
      config,
      "reports",
      "private",
      "compositions/private/one",
      account.fetch,
    );
    expect(prepared.url).toBe("https://reports-assigned.pages.dev/compositions/private/one/");
    expect(account.apps.map((app) => app.domain)).toEqual([
      "reports-assigned.pages.dev",
      "*.reports-assigned.pages.dev",
    ]);
    expect(
      account.requests.some(
        (request) => request.url.includes("/upload-token") || request.url.endsWith("/deployments"),
      ),
    ).toBe(false);
    await deployToCloudflare(
      config,
      prepared,
      [asset("/compositions/private/one/index.html")],
      account.fetch,
    );
    const gateVerification = account.requests.reduce(
      (last, request, index) => (request.url.includes("/policies") ? index : last),
      -1,
    );
    expect(gateVerification).toBeLessThan(
      account.requests.findIndex((request) => request.url.endsWith("/upload-token")),
    );
  });

  test("Access failure never uploads or deploys content", async () => {
    const account = fakeAccount({ failAccess: true });
    await expect(
      prepareCloudflarePublish(
        config,
        "reports",
        "private",
        "compositions/private/one",
        account.fetch,
      ),
    ).rejects.toThrow("not_enabled");
    expect(
      account.requests.some(
        (request) => request.url.endsWith("/deployments") || request.url.endsWith("/upload-token"),
      ),
    ).toBe(false);
  });

  test("requires the newly created allow policy to exist", async () => {
    const account = fakeAccount({ lostPolicies: true });
    await expect(
      prepareCloudflarePublish(
        config,
        "reports",
        "private",
        "compositions/private/one",
        account.fetch,
      ),
    ).rejects.toThrow("email identities");
  });

  test("a rejected direct deployment propagates to the caller", async () => {
    const account = fakeAccount({ failDeploy: true, missingProject: true });
    const prepared = await prepareCloudflarePublish(
      config,
      "reports",
      "public",
      "compositions/one",
      account.fetch,
    );
    await expect(
      deployToCloudflare(config, prepared, [asset("/compositions/one/index.html")], account.fetch),
    ).rejects.toThrow("deployment refused");
  });

  test("complete snapshots retain old pages and use Wrangler-compatible rooted hashes", async () => {
    const account = fakeAccount();
    const prepared = await prepareCloudflarePublish(
      config,
      "reports",
      "public",
      "compositions/one",
      account.fetch,
    );
    const one = asset("/compositions/one/index.html", "<h1>one</h1>");
    await deployToCloudflare(config, prepared, [one], account.fetch);
    await deployToCloudflare(
      config,
      prepared,
      [one, asset("/compositions/two/index.html")],
      account.fetch,
    );
    expect(Object.keys(account.production())).toEqual([
      "/compositions/one/index.html",
      "/compositions/two/index.html",
    ]);
    const expectedHash = "6061cd73d880b689c3a9d2438291152d";
    expect(account.production()[one.path]).toBe(expectedHash);
    expect(account.uploads).toHaveLength(3);
  });

  test("custom hosts must be attached and private paths protect every project alias", async () => {
    const account = fakeAccount({ domains: ["cards.example.com", "other.example.com"] });
    const customConfig = { ...config, pagesHost: "cards.example.com" };
    const prepared = await prepareCloudflarePublish(
      customConfig,
      "reports",
      "private",
      "compositions/private/one",
      account.fetch,
    );
    expect(prepared.url).toBe("https://cards.example.com/compositions/private/one/");
    expect(account.apps.map((app) => app.domain)).toEqual([
      "reports-assigned.pages.dev",
      "*.reports-assigned.pages.dev",
      "cards.example.com/compositions/private",
      "other.example.com",
    ]);
    await expect(
      prepareCloudflarePublish(
        { ...config, pagesHost: "unattached.example.com" },
        "reports",
        "private",
        "compositions/private/one",
        account.fetch,
      ),
    ).rejects.toThrow("attached");
  });

  test("preserves an existing email allow list without rewriting it", async () => {
    const app = {
      id: "owner-app",
      type: "self_hosted",
      domain: "reports-assigned.pages.dev",
      policies: [
        allow,
        { decision: "allow", include: [{ email: { email: "friend@example.com" } }] },
      ],
    };
    const account = fakeAccount({ apps: [app] });
    const prepared = await prepareCloudflarePublish(
      config,
      "reports",
      "private",
      "compositions/private/one",
      account.fetch,
    );
    expect(prepared.accessAppIds).toContain("owner-app");
    expect(account.apps[0]).toEqual(app);
    expect(
      account.requests.filter(
        (request) => request.method === "POST" && request.url.endsWith("/access/apps"),
      ),
    ).toHaveLength(1);
  });

  test("rejects a narrower immutable-host bypass even when it is on a later API page", async () => {
    const apps: FakeApp[] = Array.from({ length: 50 }, (_, index) => ({
      id: `unrelated-${index}`,
      type: "self_hosted",
      domain: `app${index}.example.com`,
      policies: [allow],
    }));
    apps.push({
      id: "bypass",
      type: "self_hosted",
      domain: "immutable.reports-assigned.pages.dev/compositions/private",
      policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
    });
    const account = fakeAccount({ apps });
    await expect(
      prepareCloudflarePublish(
        config,
        "reports",
        "private",
        "compositions/private/one",
        account.fetch,
      ),
    ).rejects.toThrow("bypass");
    expect(account.requests.some((request) => request.url.includes("page=2"))).toBe(true);
    expect(account.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("rejects malformed project metadata instead of guessing a hostname", async () => {
    const account = fakeAccount({ invalidProject: true });
    await expect(
      prepareCloudflarePublish(config, "reports", "public", "compositions/one", account.fetch),
    ).rejects.toThrow();
  });

  test("checks every policy page before trusting an existing Access app", async () => {
    const account = fakeAccount({
      apps: [
        {
          id: "many-policies",
          type: "self_hosted",
          domain: "reports-assigned.pages.dev",
          policies: [
            ...Array.from({ length: 50 }, () => allow),
            { decision: "bypass", include: [{ everyone: {} }] },
          ],
        },
      ],
    });
    await expect(
      prepareCloudflarePublish(
        config,
        "reports",
        "private",
        "compositions/private/one",
        account.fetch,
      ),
    ).rejects.toThrow("bypass");
    expect(
      account.requests.some(
        (request) => request.url.includes("/policies?") && request.url.includes("page=2"),
      ),
    ).toBe(true);
  });
});
