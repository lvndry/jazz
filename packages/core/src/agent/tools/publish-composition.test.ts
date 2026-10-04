/**
 * publish_composition: slug sanitization, source validation, URL construction
 * (GitHub + Cloudflare, public + private, clean nested URLs), the
 * private-requires-cloudflare contract, repo exists/create decision, and the
 * Cloudflare deploy sequence (incl. the Access gate). `gh`/`git` are stubbed
 * through the injected composer and the Cloudflare API through a stubbed
 * fetch — no network.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { CloudflareFetch } from "./cloudflare-publish";
import {
  compositionRepoFor,
  createPublishCompositionTool,
  isPagesPlanLimitError,
  ogImageUrlFor,
  PUBLISH_AUTH_ERROR,
  PUBLISH_CLOUDFLARE_NOT_CONFIGURED,
  PUBLISH_HTML_NOT_FOUND_ERROR,
  PUBLISH_PRIVATE_REQUIRES_CLOUDFLARE,
  privateRawUrl,
  publishedUrl,
  publishComposition,
  repoPathFor,
  shortRepoName,
  slugFromName,
  type PublishComposer,
} from "./publish-composition";

const MINIMAL_HTML = "<html><head><title>Weekly Spending</title></head><body>hi</body></html>";

function makeComposer(
  handler: (
    file: string,
    args: readonly string[],
    options?: { cwd?: string },
  ) => {
    stdout: string;
    stderr: string;
  },
) {
  const calls: string[] = [];
  const compose: PublishComposer = async (file, args, options) => {
    calls.push(`${file} ${args.join(" ")}${options?.cwd ? " @cwd" : ""}`);
    return handler(file, args, options);
  };
  return { compose, calls };
}

function handlerFor(options: {
  owner?: string;
  repoExists?: boolean;
  repoPrivate?: boolean;
  branch?: string;
  cloneSeed?: (directory: string) => void;
  pages?: "enabled" | "create-ok" | "plan-limit";
}) {
  const owner = options.owner ?? "octo";
  let repoExists = options.repoExists ?? false;
  let repoPrivate = options.repoPrivate ?? false;
  const pages = options.pages ?? "create-ok";
  return (file: string, args: readonly string[]): { stdout: string; stderr: string } => {
    if (file !== "gh" && file !== "git") throw new Error(`unexpected command: ${file}`);
    if (file === "gh") {
      if (args[0] === "auth") return { stdout: "Logged in", stderr: "" };
      if (args[0] === "api" && args[1] === "user")
        return { stdout: JSON.stringify({ login: owner }), stderr: "" };
      if (args[0] === "repo" && args[1] === "view") {
        if (!repoExists) throw new Error("HTTP 404: Not found");
        return {
          stdout: JSON.stringify({
            nameWithOwner: args[2],
            isPrivate: repoPrivate,
            defaultBranchRef: { name: options.branch ?? "main" },
          }),
          stderr: "",
        };
      }
      if (args[0] === "repo" && args[1] === "create") {
        repoExists = true;
        repoPrivate = args.includes("--private");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "api") {
        const endpoint = args[1] === "-X" ? args[3] : args[1];
        if (!endpoint?.match(/^repos\/[^/]+\/[^/]+\/pages$/)) throw new Error("accepts 1 arg(s)");
        if (args[1] === "-X") {
          if (pages === "plan-limit")
            throw new Error("HTTP 422: GitHub Pages is not available on the Free plan");
          return { stdout: "{}", stderr: "" };
        }
        if (pages === "enabled") return { stdout: "{}", stderr: "" };
        throw new Error("HTTP 404: Not found");
      }
      throw new Error(`unexpected gh command: ${args.join(" ")}`);
    }
    if (args[0] === "clone" && args[2]) options.cloneSeed?.(args[2]);
    if (args[0] === "diff" && args[1] === "--cached") {
      const e = new Error("differences found") as Error & { code: number };
      e.code = 1;
      throw e;
    }
    return { stdout: "", stderr: "" };
  };
}

async function nodeFs(): Promise<FileSystem.FileSystem> {
  return Effect.runPromise(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer));
}

type CfResponse = { status: number; json: () => Promise<unknown> };

function mockCfFetch(requests: string[]): CloudflareFetch {
  const policies = [{ decision: "allow", include: [{ email: { email: "me@example.com" } }] }];
  return async (url, init): Promise<CfResponse> => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    const respond = (result: unknown): CfResponse => ({
      status: 200,
      json: async () => ({ success: true, result }),
    });
    const project = url.match(/pages\/projects\/([^/?]+)$/)?.[1];
    if (project)
      return respond({ subdomain: `${project}.pages.dev`, production_branch: "main", domains: [] });
    const deployment = url.match(/pages\/projects\/([^/]+)\/deployments$/);
    if (deployment) return respond({ url: `https://abcd1234.${deployment[1]}.pages.dev` });
    if (url.includes("/upload-token")) return respond({ jwt: "test-jwt" });
    if (url.includes("/check-missing")) return respond([]);
    if (url.includes("/pages/assets")) return respond({});
    if (url.includes("/policies")) return respond(policies);
    if (url.includes("/access/apps") && method === "GET") return respond([]);
    if (url.includes("/access/apps") && method === "POST" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { domain: string };
      return respond({ id: "app-1", type: "self_hosted", domain: body.domain });
    }
    throw new Error(`unexpected Cloudflare request: ${method} ${url}`);
  };
}

describe("slugFromName", () => {
  test("sanitizes to lowercase [a-z0-9-]", () => {
    expect(slugFromName("Weekly Spending #1")).toBe("weekly-spending-1");
    expect(slugFromName("My__Report--v2")).toBe("my-report-v2");
  });

  test("collapses runs of non-slug characters into a single hyphen", () => {
    expect(slugFromName("A   B  C")).toBe("a-b-c");
  });

  test("strips leading and trailing hyphens", () => {
    expect(slugFromName("!!dash!!")).toBe("dash");
  });

  test("falls back for a name with nothing usable in it", () => {
    expect(slugFromName("???")).toBe("composition");
    expect(slugFromName("___")).toBe("composition");
  });

  test("bounds the length", () => {
    expect(slugFromName("a".repeat(200))).toHaveLength(80);
  });
});

describe("repo and URL construction", () => {
  test("routes each visibility to its own repo", () => {
    expect(compositionRepoFor("octo", "public")).toBe("octo/compositions");
    expect(compositionRepoFor("octo", "private")).toBe("octo/compositions-private");
  });

  test("repo path: private nests under compositions/private", () => {
    expect(repoPathFor("public", "chart")).toBe("compositions/chart");
    expect(repoPathFor("private", "chart")).toBe("compositions/private/chart");
  });

  test("shortRepoName takes the last path segment", () => {
    expect(shortRepoName("octo/compositions")).toBe("compositions");
    expect(shortRepoName("octo")).toBe("octo");
  });

  test("public GitHub Pages URL is a clean nested path", () => {
    expect(publishedUrl("octo/compositions", "weekly-spending-1", "public")).toBe(
      "https://octo.github.io/compositions/compositions/weekly-spending-1/",
    );
  });

  test("public GitHub Pages URL honours an owner/name repo override", () => {
    expect(publishedUrl("somebody/else-site", "chart", "public")).toBe(
      "https://somebody.github.io/else-site/compositions/chart/",
    );
  });

  test("owner-site repositories have no repository prefix", () => {
    expect(publishedUrl("octo/octo.github.io", "chart", "public")).toBe(
      "https://octo.github.io/compositions/chart/",
    );
  });

  test("og:image URL sits next to the page", () => {
    expect(ogImageUrlFor("https://lvndry.pages.dev/compositions/chart")).toBe(
      "https://lvndry.pages.dev/compositions/chart/og.png",
    );
  });

  test("private raw (logged-in) URL", () => {
    expect(privateRawUrl("octo/compositions-private", "chart")).toBe(
      "https://github.com/octo/compositions-private/raw/main/compositions/private/chart/index.html",
    );
  });
});

describe("isPagesPlanLimitError", () => {
  test("matches plan and billing wording", () => {
    expect(isPagesPlanLimitError("GitHub Pages is not available on the Free plan")).toBe(true);
    expect(isPagesPlanLimitError("HTTP 403: billing is required")).toBe(true);
    expect(isPagesPlanLimitError("Subscription required for private Pages")).toBe(true);
  });

  test("does not match an ordinary failure", () => {
    expect(isPagesPlanLimitError("HTTP 500: Internal Server Error")).toBe(false);
    expect(isPagesPlanLimitError("connection refused")).toBe(false);
  });
});

describe("publishComposition", () => {
  let dir: string;
  let htmlPath: string;
  let fs: FileSystem.FileSystem;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "jazz-publish-flow-"));
    htmlPath = join(dir, "weekly-spending.html");
    writeFileSync(htmlPath, MINIMAL_HTML);
    fs = await nodeFs();
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["JAZZ_CLOUDFLARE_CONFIG"];
  });

  function expectPublish(result: Awaited<ReturnType<typeof publishComposition>>, label: string) {
    if (!result.success) console.error("ERR in", label, ":", (result as { error?: string }).error);
    expect(result.success).toBe(true);
    return (result as { success: true; result: unknown }).result as {
      url: string;
      repo: string;
      slug: string;
      visibility: string;
      ogCard: boolean;
      pagesEnabled?: boolean;
      summary: string;
    };
  }

  function cfConfigPath(): string {
    return join(dir, "cloudflare.json");
  }

  function writeCfConfig(extra?: Record<string, unknown>): void {
    process.env["JAZZ_CLOUDFLARE_CONFIG"] = cfConfigPath();
    writeFileSync(
      cfConfigPath(),
      JSON.stringify({ schemaVersion: 1, token: "t", accountId: "a", ...extra }),
    );
  }

  async function withCfFetch(
    args: { htmlPath: string; visibility?: "public" | "private"; host?: "github" | "cloudflare" },
    compose: PublishComposer,
  ): Promise<[Awaited<ReturnType<typeof publishComposition>>, string[]]> {
    const urls: string[] = [];
    return [await publishComposition(args, dir, compose, fs, mockCfFetch(urls)), urls];
  }

  test("fails cleanly when the html file does not exist", async () => {
    const { compose } = makeComposer(handlerFor({}));
    const missing = join(dir, "missing.html");
    const result = await publishComposition({ htmlPath: missing }, dir, compose, fs);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toBe(PUBLISH_HTML_NOT_FOUND_ERROR(missing));
  });

  test("rejects a non-.html path", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello");
    const { compose } = makeComposer(handlerFor({}));
    const result = await publishComposition({ htmlPath: join(dir, "notes.txt") }, dir, compose, fs);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain("is not an .html file");
  });

  test("resolves a relative htmlPath against the working directory", async () => {
    writeFileSync(join(dir, "relative.html"), MINIMAL_HTML);
    const { compose } = makeComposer(handlerFor({}));
    const result = await publishComposition({ htmlPath: "relative.html" }, dir, compose, fs);
    const out = expectPublish(result, "relative");
    expect(out.slug).toBe("relative");
  });

  test("first use creates the public repo, publishes, and returns the clean github.io URL", async () => {
    const { compose, calls } = makeComposer(handlerFor({ owner: "octo", repoExists: false }));
    const out = expectPublish(
      await publishComposition({ htmlPath, visibility: "public" }, dir, compose, fs),
      "first-use",
    );
    expect(out.repo).toBe("octo/compositions");
    expect(out.slug).toBe("weekly-spending");
    expect(out.visibility).toBe("public");
    expect(out.url).toBe("https://octo.github.io/compositions/compositions/weekly-spending/");
    expect(out.pagesEnabled).toBe(true);
    expect(calls.some((c) => c.startsWith("gh repo create octo/compositions --public"))).toBe(true);
    expect(calls.some((c) => c.startsWith("git clone"))).toBe(true);
    expect(calls.some((c) => c.includes("user.email=jazz@users.noreply.github.com"))).toBe(true);
  });

  test("recognizes first-publish 404 diagnostics from real subprocess stderr", async () => {
    const handler = handlerFor({ repoExists: false });
    const { compose, calls } = makeComposer((file, args) => {
      try {
        return handler(file, args);
      } catch (error) {
        if (file !== "gh" || !(error instanceof Error)) throw error;
        throw Object.assign(new Error(`Command failed: gh ${args.join(" ")}`), {
          stderr: `${error.message}\n`,
          stdout: "",
          code: 1,
        });
      }
    });
    const out = expectPublish(
      await publishComposition({ htmlPath, visibility: "public" }, dir, compose, fs),
      "stderr-first-use",
    );
    expect(out.pagesEnabled).toBe(true);
    expect(calls.some((call) => call.startsWith("gh repo create"))).toBe(true);
    expect(
      calls.some((call) => call.startsWith("gh api -X POST repos/octo/compositions/pages")),
    ).toBe(true);
  });

  test("an existing repo is cloned, not re-created", async () => {
    const { compose, calls } = makeComposer(handlerFor({ owner: "octo", repoExists: true }));
    const out = expectPublish(
      await publishComposition({ htmlPath, visibility: "public" }, dir, compose, fs),
      "existing",
    );
    expect(out.url).toBe("https://octo.github.io/compositions/compositions/weekly-spending/");
    expect(
      calls.some((c) => c.startsWith("git clone https://github.com/octo/compositions.git")),
    ).toBe(true);
    expect(calls.some((c) => c.startsWith("gh repo create"))).toBe(false);
  });

  test("fails with the auth hint when gh is not logged in", async () => {
    const { compose } = makeComposer((file, args) => {
      if (file === "gh" && args[0] === "api" && args[1] === "user") {
        throw new Error("HTTP 401: Bad credentials");
      }
      return handlerFor({})(file, args);
    });
    const result = await publishComposition({ htmlPath, visibility: "public" }, dir, compose, fs);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toBe(PUBLISH_AUTH_ERROR);
  });

  test("visibility private with host github is rejected before any work", async () => {
    const { compose, calls } = makeComposer(handlerFor({}));
    const result = await publishComposition(
      { htmlPath, visibility: "private", host: "github" },
      dir,
      compose,
      fs,
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toBe(PUBLISH_PRIVATE_REQUIRES_CLOUDFLARE);
    expect(calls.some((c) => c.startsWith("gh repo"))).toBe(false);
  });

  test("a private publish goes to the private repo on the cloudflare host", async () => {
    const { compose, calls } = makeComposer(handlerFor({ owner: "octo", repoExists: false }));
    writeCfConfig({ accessEmail: "me@example.com" });
    const [result, urls] = await withCfFetch({ htmlPath, visibility: "private" }, compose);
    const out = expectPublish(result, "private-cf");
    expect(out.repo).toBe("octo/compositions-private");
    expect(out.url).toBe(
      "https://compositions-private.pages.dev/compositions/private/weekly-spending/",
    );
    expect(
      calls.some((c) => c.startsWith("gh repo create octo/compositions-private --private")),
    ).toBe(true);
    expect(
      urls.some(
        (u) => u.startsWith("POST") && u.includes("/access/apps") && !u.includes("/policies"),
      ),
    ).toBe(true);
    expect(urls.filter((u) => u.startsWith("POST") && u.endsWith("/access/apps"))).toHaveLength(2);
    expect(out.summary).toContain("Cloudflare Access");
  });

  test("a public cloudflare publish deploys via fetch and returns the pages.dev URL", async () => {
    const { compose } = makeComposer(handlerFor({ owner: "octo", repoExists: false }));
    writeCfConfig();
    const [result, urls] = await withCfFetch(
      { htmlPath, visibility: "public", host: "cloudflare" },
      compose,
    );
    const out = expectPublish(result, "public-cf");
    expect(out.url).toBe("https://compositions.pages.dev/compositions/weekly-spending/");
    expect(out.summary).toContain("Cloudflare Pages");
    expect(urls.some((u) => u.includes("/pages/projects/compositions/upload-token"))).toBe(true);
    expect(urls.some((u) => u.includes("/pages/projects/compositions/deployments"))).toBe(true);
    expect(urls.some((u) => u.includes("/access/apps"))).toBe(false);
  });

  test("private publishing without accessEmail fails before creating or pushing content", async () => {
    const { compose, calls } = makeComposer(handlerFor({}));
    writeCfConfig();
    const [result, urls] = await withCfFetch({ htmlPath, visibility: "private" }, compose);
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
    expect(urls).toHaveLength(0);
  });

  test("cloudflare host without credentials fails with the config hint", async () => {
    const { compose } = makeComposer(handlerFor({ owner: "octo", repoExists: false }));
    process.env["JAZZ_CLOUDFLARE_CONFIG"] = join(dir, "does-not-exist.json");
    const result = await publishComposition(
      { htmlPath, visibility: "public", host: "cloudflare" },
      dir,
      compose,
      fs,
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain(PUBLISH_CLOUDFLARE_NOT_CONFIGURED);
  });

  test("refuses a public repository before pushing private content", async () => {
    writeCfConfig({ accessEmail: "me@example.com" });
    const { compose, calls } = makeComposer((file, args) => {
      if (file === "gh" && args[0] === "repo" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            nameWithOwner: "octo/compositions-private",
            isPrivate: false,
            defaultBranchRef: { name: "main" },
          }),
          stderr: "",
        };
      }
      return handlerFor({ repoExists: true })(file, args);
    });
    const result = await publishComposition(
      { htmlPath, visibility: "private" },
      dir,
      compose,
      fs,
      mockCfFetch([]),
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain("does not match requested visibility private");
    expect(calls.some((call) => call.startsWith("git push"))).toBe(false);
  });

  test("protects private publications with a custom repository name", async () => {
    writeCfConfig({ accessEmail: "me@example.com" });
    const { compose } = makeComposer(handlerFor({}));
    const requests: string[] = [];
    const result = await publishComposition(
      { htmlPath, visibility: "private", repo: "octo/reports" },
      dir,
      compose,
      fs,
      mockCfFetch(requests),
    );
    expect(result.success).toBe(true);
    expect(requests.some((request) => request.includes("/access/apps"))).toBe(true);
  });

  test("finishes protection before a push can trigger a Git-integrated deployment", async () => {
    writeCfConfig({ accessEmail: "me@example.com" });
    const requests: string[] = [];
    const handler = handlerFor({});
    let pushed = false;
    const { compose } = makeComposer((file, args) => {
      if (file === "git" && args[0] === "push") {
        expect(requests.filter((request) => request.includes("/policies"))).toHaveLength(2);
        expect(requests.some((request) => request.endsWith("/deployments"))).toBe(false);
        pushed = true;
      }
      return handler(file, args);
    });
    const result = await publishComposition(
      { htmlPath, visibility: "private" },
      dir,
      compose,
      fs,
      mockCfFetch(requests),
    );
    expect(result.success).toBe(true);
    expect(pushed).toBe(true);
  });

  test("Access failure prevents any push or upload", async () => {
    writeCfConfig({ accessEmail: "me@example.com" });
    const { compose, calls } = makeComposer(handlerFor({}));
    const requests: string[] = [];
    const baseFetch = mockCfFetch(requests);
    const fetch: CloudflareFetch = async (url, init) =>
      url.includes("/access/apps")
        ? {
            status: 403,
            json: async () => ({ success: false, errors: [{ message: "Access not enabled" }] }),
          }
        : baseFetch(url, init);
    const result = await publishComposition(
      { htmlPath, visibility: "private" },
      dir,
      compose,
      fs,
      fetch,
    );
    expect(result.success).toBe(false);
    expect(calls.some((call) => call.startsWith("git push"))).toBe(false);
    expect(
      requests.some(
        (request) => request.includes("/upload-token") || request.includes("/deployments"),
      ),
    ).toBe(false);
  });

  test("deployment failure returns a failed tool result", async () => {
    writeCfConfig();
    const { compose } = makeComposer(handlerFor({}));
    const baseFetch = mockCfFetch([]);
    const fetch: CloudflareFetch = async (url, init) =>
      url.endsWith("/deployments")
        ? {
            status: 500,
            json: async () => ({ success: false, errors: [{ message: "deployment refused" }] }),
          }
        : baseFetch(url, init);
    const result = await publishComposition(
      { htmlPath, host: "cloudflare" },
      dir,
      compose,
      fs,
      fetch,
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain("deployment refused");
  });

  test("the publisher includes old compositions from the checkout in the snapshot", async () => {
    writeCfConfig();
    const { compose } = makeComposer(
      handlerFor({
        repoExists: true,
        cloneSeed: (directory) => {
          const old = join(directory, "compositions", "old");
          mkdirSync(old, { recursive: true });
          writeFileSync(join(old, "index.html"), "<html>old page</html>");
        },
      }),
    );
    const baseFetch = mockCfFetch([]);
    let paths: readonly string[] = [];
    const fetch: CloudflareFetch = async (url, init) => {
      if (url.endsWith("/deployments") && init?.body instanceof FormData) {
        paths = Object.keys(
          JSON.parse(String(init.body.get("manifest"))) as Record<string, unknown>,
        );
      }
      return baseFetch(url, init);
    };
    const result = await publishComposition(
      { htmlPath, host: "cloudflare" },
      dir,
      compose,
      fs,
      fetch,
    );
    expect(result.success).toBe(true);
    expect(paths).toContain("/compositions/old/index.html");
    expect(paths).toContain("/compositions/weekly-spending/index.html");
  });

  test("linked composition directories cannot redirect writes outside the checkout", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const { compose, calls } = makeComposer(
      handlerFor({
        repoExists: true,
        cloneSeed: (directory) => {
          symlinkSync(outside, join(directory, "compositions"), "dir");
        },
      }),
    );
    const result = await publishComposition({ htmlPath }, dir, compose, fs);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(result.error).toContain("symbolic links");
    expect(existsSync(join(outside, "weekly-spending"))).toBe(false);
    expect(calls.some((call) => call.startsWith("git push"))).toBe(false);
  });

  test("Pages creation uses one endpoint and the checkout's default branch", async () => {
    const { compose, calls } = makeComposer(handlerFor({ repoExists: true, branch: "trunk" }));
    const result = await publishComposition({ htmlPath }, dir, compose, fs);
    expect(result.success).toBe(true);
    expect(calls).toContain(
      "gh api -X POST repos/octo/compositions/pages -f source[branch]=trunk -f source[path]=/",
    );
    expect(calls).toContain("git push --set-upstream origin HEAD:trunk @cwd");
  });
});

describe("createPublishCompositionTool", () => {
  test("builds a high-risk tool that declares egress", () => {
    const tool = createPublishCompositionTool();
    expect(tool.name).toBe("publish_composition");
    expect(tool.riskLevel).toBe("high-risk");
    expect(tool.egress).toBe(true);
    expect(tool.tags).toContain("composition");
  });
});
