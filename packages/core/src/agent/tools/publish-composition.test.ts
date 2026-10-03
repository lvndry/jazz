/**
 * publish_composition: slug sanitization, source validation, URL construction
 * (public + private), the repo exists/create decision, and the private Pages
 * plan-limit fallback. `gh`/`git` are stubbed through the injected composer —
 * no network.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  compositionRepoFor,
  createPublishCompositionTool,
  isPagesPlanLimitError,
  PUBLISH_AUTH_ERROR,
  PUBLISH_HTML_NOT_FOUND_ERROR,
  privateRawUrl,
  publishedUrl,
  publishComposition,
  shortRepoName,
  slugFromName,
  type PublishComposer,
} from "./publish-composition";

const MINIMAL_HTML = "<html><body>hi</body></html>";

/**
 * Build a composer from a handler and record every call as "file arg0 arg1…".
 * A handler that throws simulates a failing command.
 */
function makeComposer(
  handler: (file: string, args: readonly string[]) => { stdout: string; stderr: string },
) {
  const calls: string[] = [];
  const compose: PublishComposer = async (file, args) => {
    calls.push(`${file} ${args.join(" ")}`);
    return handler(file, args);
  };
  return { compose, calls };
}

/**
 * A scripted command environment: routes on which command is in flight. The
 * repo-existence and Pages outcomes are the knobs.
 */
function handlerFor(options: {
  owner?: string;
  repoExists?: boolean;
  /** "enabled" (GET ok), "create-ok" (GET 404, POST ok), "plan-limit" (GET 404, POSTs fail on plan). */
  pages?: "enabled" | "create-ok" | "plan-limit";
}) {
  const owner = options.owner ?? "octo";
  const repoExists = options.repoExists ?? false;
  const pages = options.pages ?? "create-ok";
  return (file: string, args: readonly string[]): { stdout: string; stderr: string } => {
    if (file !== "gh" && file !== "git") throw new Error(`unexpected command: ${file}`);
    if (file === "gh") {
      if (args[0] === "auth") return { stdout: "Logged in", stderr: "" };
      if (args[0] === "api" && args[1] === "user") return { stdout: `${owner}\n`, stderr: "" };
      if (args[0] === "repo" && args[1] === "view") {
        if (!repoExists) throw new Error("HTTP 404: Not found");
        return { stdout: `${owner}/compositions\n`, stderr: "" };
      }
      if (args[0] === "repo" && args[1] === "create") return { stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "-X") {
        // POST repos/.../pages.
        if (pages === "plan-limit") {
          throw new Error("HTTP 422: GitHub Pages is not available on the Free plan");
        }
        return { stdout: "{}\n", stderr: "" };
      }
      if (args[0] === "api") {
        // GET repos/.../pages.
        if (pages === "enabled") return { stdout: "{}\n", stderr: "" };
        throw new Error("HTTP 404: Not found");
      }
      throw new Error(`unexpected gh command: ${args.join(" ")}`);
    }
    // git: diff --cached --quiet signals "changes found" via exit code 1 so
    // the commit path runs; add, commit, push, clone all succeed.
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

  test("shortRepoName takes the last path segment", () => {
    expect(shortRepoName("octo/compositions")).toBe("compositions");
    expect(shortRepoName("octo")).toBe("octo");
  });

  test("public Pages URL", () => {
    expect(publishedUrl("octo", "octo/compositions", "weekly-spending-1")).toBe(
      "https://octo.github.io/compositions/weekly-spending-1.html",
    );
  });

  test("public Pages URL honours an owner/name repo override", () => {
    expect(publishedUrl("octo", "somebody/else-site", "chart")).toBe(
      "https://octo.github.io/else-site/chart.html",
    );
  });

  test("private raw (logged-in) URL", () => {
    expect(privateRawUrl("octo/compositions-private", "chart")).toBe(
      "https://github.com/octo/compositions-private/raw/main/chart.html",
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
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function expectPublish(result: Awaited<ReturnType<typeof publishComposition>>, label: string) {
    if (!result.success) console.error("ERR in", label, ":", result.error);
    expect(result.success).toBe(true);
    return result.result as {
      url: string;
      repo: string;
      slug: string;
      pagesEnabled: boolean;
      summary: string;
    };
  }

  test("fails cleanly when the html file does not exist", async () => {
    const { compose } = makeComposer(handlerFor({}));
    const missing = join(dir, "missing.html");
    const result = await publishComposition({ htmlPath: missing }, dir, compose, fs);
    expect(result.success).toBe(false);
    expect(result.error).toBe(PUBLISH_HTML_NOT_FOUND_ERROR(missing));
  });

  test("rejects a non-.html path", async () => {
    writeFileSync(join(dir, "notes.txt"), "hello");
    const { compose } = makeComposer(handlerFor({}));
    const result = await publishComposition({ htmlPath: join(dir, "notes.txt") }, dir, compose, fs);
    expect(result.success).toBe(false);
    expect(result.error).toContain("no readable .html file");
  });

  test("resolves a relative htmlPath against the working directory", async () => {
    writeFileSync(join(dir, "relative.html"), MINIMAL_HTML);
    const { compose } = makeComposer(handlerFor({}));
    const result = await publishComposition({ htmlPath: "relative.html" }, dir, compose, fs);
    const out = expectPublish(result, "relative");
    expect(out.slug).toBe("relative");
  });

  test("first use creates the public repo, publishes, and returns the github.io URL", async () => {
    const { compose, calls } = makeComposer(handlerFor({ owner: "octo", repoExists: false }));
    const out = expectPublish(
      await publishComposition({ htmlPath, visibility: "public" }, dir, compose, fs),
      "first-use",
    );
    expect(out.repo).toBe("octo/compositions");
    expect(out.slug).toBe("weekly-spending");
    expect(out.url).toBe("https://octo.github.io/compositions/weekly-spending.html");
    expect(out.pagesEnabled).toBe(true);
    // Repo did not exist -> `gh repo create … --public --clone …`, not `git clone`.
    expect(
      calls.some((c) => c.startsWith("gh repo create octo/compositions --public --clone")),
    ).toBe(true);
    expect(calls.some((c) => c.startsWith("git clone"))).toBe(false);
    // Explicit author so no global git config is needed.
    expect(calls.some((c) => c.includes("user.email=jazz@users.noreply.github.com"))).toBe(true);
  });

  test("an existing repo is cloned, not re-created", async () => {
    const { compose, calls } = makeComposer(handlerFor({ owner: "octo", repoExists: true }));
    expectPublish(await publishComposition({ htmlPath }, dir, compose, fs), "clone");
    expect(
      calls.some((c) => c.startsWith("git clone https://github.com/octo/compositions.git ")),
    ).toBe(true);
    expect(calls.some((c) => c.startsWith("gh repo create"))).toBe(false);
  });

  test("a repo override is used verbatim and drives the URL", async () => {
    const { compose } = makeComposer(handlerFor({ owner: "octo", repoExists: false }));
    const out = expectPublish(
      await publishComposition({ htmlPath, repo: "someone/site-pages" }, dir, compose, fs),
      "override",
    );
    expect(out.repo).toBe("someone/site-pages");
    expect(out.url).toBe("https://octo.github.io/site-pages/weekly-spending.html");
  });

  test("a failing auth check reports the gh login hint and stops early", async () => {
    const { compose, calls } = makeComposer((file, args) => {
      if (file === "gh" && args[0] === "auth") throw new Error("You are not logged in");
      return handlerFor({})(file, args);
    });
    const result = await publishComposition({ htmlPath }, dir, compose, fs);
    expect(result.success).toBe(false);
    expect(result.error).toBe(PUBLISH_AUTH_ERROR);
    // It stopped before touching the repo.
    expect(calls.some((c) => c.startsWith("gh repo"))).toBe(false);
  });

  test("private Pages gated by the plan falls back to the logged-in raw URL, not an error", async () => {
    const { compose } = makeComposer(
      handlerFor({ owner: "octo", repoExists: false, pages: "plan-limit" }),
    );
    const out = expectPublish(
      await publishComposition({ htmlPath, visibility: "private" }, dir, compose, fs),
      "plan-limit",
    );
    expect(out.repo).toBe("octo/compositions-private");
    expect(out.pagesEnabled).toBe(false);
    expect(out.url).toBe(
      "https://github.com/octo/compositions-private/raw/main/weekly-spending.html",
    );
    expect(out.summary).toContain("paid plan");
    expect(out.summary).toContain(out.url);
  });

  test("private Pages that can be enabled returns the github.io URL", async () => {
    const { compose, calls } = makeComposer(
      handlerFor({ owner: "octo", repoExists: false, pages: "create-ok" }),
    );
    const out = expectPublish(
      await publishComposition({ htmlPath, visibility: "private" }, dir, compose, fs),
      "private-ok",
    );
    expect(out.pagesEnabled).toBe(true);
    expect(out.url).toBe("https://octo.github.io/compositions-private/weekly-spending.html");
    // Private repo was created with --private.
    expect(
      calls.some((c) => c.startsWith("gh repo create octo/compositions-private --private")),
    ).toBe(true);
  });
});

describe("createPublishCompositionTool wiring", () => {
  test("exposes the tool with high risk, egress, and internal disclosure", () => {
    const tool = createPublishCompositionTool(() => Promise.reject(new Error("not called")));
    expect(tool.name).toBe("publish_composition");
    expect(tool.riskLevel).toBe("high-risk");
    expect(tool.egress).toBe(true);
    expect(tool.disclosure).toBe("internal");
  });
});
