/**
 * Publish a composition to a stable URL on the host the person picked.
 *
 * Layout (one repo per visibility, the path tells the story):
 *   public  → compositions/<slug>/index.html
 *   private → compositions/private/<slug>/index.html
 * Each page ships a Jazz-styled og.png card next to index.html, and the
 * published HTML gets og:title/og:image meta injected so shares read as
 * compositions made with jazz.
 *
 * Hosts:
 *   public  → github (default, <owner>.github.io) or cloudflare (pages.dev;
 *             a claimed custom host like lvndry.pages.dev when configured)
 *   private → cloudflare only: a private repo served by Cloudflare Pages
 *             behind a Cloudflare Access sign-in (a login-only raw link is
 *             not a private page).
 *
 * Egress: `gh`/`git` (both hosts), Cloudflare API (cloudflare host).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";
import {
  deployToCloudflare,
  type CloudflareConfig,
  type CloudflareFetch,
} from "./cloudflare-publish";
import { injectOgMeta, renderCompositionOg, titleFromHtml } from "./composition-og";
import { buildKeyFromContext } from "./context-utils";

const run = promisify(execFile);

export const PUBLISH_HTML_NOT_FOUND_ERROR = (path: string): string =>
  `publish_composition: no readable .html file at ${path}`;
export const PUBLISH_AUTH_ERROR =
  "publish_composition: `gh` is not authenticated. Run `gh auth login` (with the repo, pages and workflow scopes) and try again.";
export const PUBLISH_CLOUDFLARE_NOT_CONFIGURED =
  'write it with { "token": "…", "accountId": "…", "accessEmail": "you@email.com" } (token needs Cloudflare Pages: Edit and Access: Apps: Edit).';
export const PUBLISH_PRIVATE_REQUIRES_CLOUDFLARE =
  'publish_composition: visibility "private" needs host "cloudflare" — a private GitHub repo is served by Cloudflare Pages behind a Cloudflare Access sign-in (only the configured email gets in). Pick host "cloudflare".';

const AUTHOR_EMAIL = "jazz@users.noreply.github.com";
const AUTHOR_NAME = "Jazz";

export type PublishComposer = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export const runComposer: PublishComposer = (file, args, options) =>
  run(file, args, { maxBuffer: 16 * 1024 * 1024, cwd: options?.cwd });

/** Run `git` through the injected composer; failures carry the git output. */
async function runGit(
  args: readonly string[],
  cwd: string,
  compose: PublishComposer,
): Promise<void> {
  try {
    await compose("git", args, { cwd });
  } catch (error) {
    throw new Error(`git ${args[0]}: ${firstLine(error)}`, { cause: error });
  }
}

/** Run `git` and report whether it exited non-zero. */
async function gitFailed(
  args: readonly string[],
  cwd: string,
  compose: PublishComposer,
): Promise<boolean> {
  try {
    await compose("git", args, { cwd });
    return false;
  } catch {
    return true;
  }
}

/** Run `gh` through the injected composer, trimming stdout. */
async function runGh(
  args: readonly string[],
  compose: PublishComposer,
  options?: { cwd?: string },
): Promise<string> {
  try {
    return (await compose("gh", args, options)).stdout.trim();
  } catch (error) {
    throw new Error(`gh ${args[0]} ${args[1] ?? ""}: ${firstLine(error)}`, { cause: error });
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n").find((line) => line.trim().length > 0) ?? "command failed";
}

export type PublishCompositionResult = {
  readonly slug: string;
  readonly visibility: "public" | "private";
  readonly url: string;
  readonly repo: string;
  readonly pagesEnabled?: boolean;
  readonly ogCard: boolean;
  readonly summary: string;
};

const publishCompositionParameters = z
  .object({
    htmlPath: z
      .string()
      .min(1)
      .describe(
        "Path to the composition HTML file to publish, absolute or relative to the working directory.",
      ),
    visibility: z
      .enum(["public", "private"])
      .optional()
      .describe(
        "public: anyone with the link can open it. private: the source lives in a private repo and the page is locked behind Cloudflare Access (only the configured email can open it).",
      ),
    host: z
      .enum(["github", "cloudflare"])
      .optional()
      .describe(
        "Where the page is served: github (GitHub Pages) or cloudflare (Cloudflare Pages). Required for public; private always uses cloudflare.",
      ),
    repo: z
      .string()
      .min(1)
      .optional()
      .describe(
        "owner/name of the GitHub repo to publish into. Default: a compositions (or compositions-private) repo owned by the user.",
      ),
  })
  .strict();

type PublishCompositionArgs = z.infer<typeof publishCompositionParameters>;

export function createPublishCompositionTool(
  compose: PublishComposer = runComposer,
): Tool<FileSystem.FileSystem | FileSystemContextService> {
  return defineTool<FileSystem.FileSystem | FileSystemContextService, PublishCompositionArgs>({
    name: "publish_composition",
    disclosure: "internal",
    summary:
      "Publish a composition HTML file to a stable public or private URL (GitHub Pages or Cloudflare Pages).",
    description:
      "Publish the HTML file from create_composition to a stable URL. ALWAYS ask the user whether " +
      "they want it public or private before calling. 'public': a public repo, URL anyone can open; " +
      "ask which host they prefer — 'github' (default, GitHub Pages) or 'cloudflare' (Cloudflare " +
      "Pages). 'private': a PRIVATE repo (sensitive source stays hidden) served by Cloudflare Pages " +
      "behind Cloudflare Access, so host is always 'cloudflare' (a private GitHub repo cannot render " +
      "Pages on the free plan). First use creates the repo; re-publishing the same name redeploys at " +
      "the same URL. Each page ships a jazz-styled og.png card and og:title/og:image meta so it " +
      "looks right when shared. Requires `gh` (authenticated) and `git`; the cloudflare host also " +
      "reads ~/.config/jazz/cloudflare.json. Preview the destination URL to the user before calling; " +
      "the approval gate covers consent.",
    tags: ["ui", "visualization", "composition", "publish"],
    parameters: publishCompositionParameters,
    riskLevel: "high-risk",
    // The composition's HTML leaves the machine for a URL others can reach.
    egress: true,
    validate: makeZodValidator(publishCompositionParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workingDirectory = yield* workingDirectoryFor(context);
        return yield* Effect.promise(() => publishComposition(args, workingDirectory, compose, fs));
      }),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { slug: string; visibility: string };
      return `Published composition ${data.slug} (${data.visibility})`;
    },
  });
}

/**
 * The agent's tracked working directory, falling back to the process cwd.
 * A relative htmlPath must resolve against where the agent believes it is.
 */
function workingDirectoryFor(
  context: ToolExecutionContext,
): Effect.Effect<string, never, FileSystemContextService> {
  return Effect.gen(function* () {
    const shell = yield* FileSystemContextServiceTag;
    const cwd = yield* shell
      .getCwd(buildKeyFromContext(context))
      .pipe(Effect.catchAll(() => Effect.succeed(process.cwd())));
    return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  });
}

/** Where the Cloudflare credentials live. Never committed to a repo. */
export function cloudflareConfigPath(): string {
  return (
    process.env["JAZZ_CLOUDFLARE_CONFIG"] ?? join(homedir(), ".config", "jazz", "cloudflare.json")
  );
}

export function loadCloudflareConfig(path: string = cloudflareConfigPath()): CloudflareConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `publish_composition: no Cloudflare credentials at ${path}. ` +
        PUBLISH_CLOUDFLARE_NOT_CONFIGURED,
    );
  }
  type Parsed = {
    token?: unknown;
    accountId?: unknown;
    accessEmail?: unknown;
    pagesHost?: unknown;
  };
  let parsed: Parsed;
  try {
    parsed = JSON.parse(raw) as Parsed;
  } catch {
    throw new Error(
      `publish_composition: ${path} is not valid JSON. ` + PUBLISH_CLOUDFLARE_NOT_CONFIGURED,
    );
  }
  const token = parsed.token;
  const accountId = parsed.accountId;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      `publish_composition: ${path} must contain a non-empty token. ` +
        PUBLISH_CLOUDFLARE_NOT_CONFIGURED,
    );
  }
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error(
      `publish_composition: ${path} must contain a non-empty accountId. ` +
        PUBLISH_CLOUDFLARE_NOT_CONFIGURED,
    );
  }
  const config: CloudflareConfig = { token, accountId };
  if (typeof parsed.accessEmail === "string" && parsed.accessEmail.length > 0) {
    config.accessEmail = parsed.accessEmail;
  }
  if (typeof parsed.pagesHost === "string" && parsed.pagesHost.length > 0) {
    config.pagesHost = parsed.pagesHost;
  }
  return config;
}

/**
 * The in-repo page directory. Pages live under compositions/ in the repo
 * (public: compositions/<slug>, private: compositions/private/<slug> — the
 * Cloudflare Access path scope keys on /compositions/private).
 */
export function repoPathFor(visibility: "public" | "private", slug: string): string {
  return visibility === "private" ? `compositions/private/${slug}` : `compositions/${slug}`;
}

export function compositionRepoFor(owner: string, visibility: "public" | "private"): string {
  return `${owner}/${visibility === "private" ? "compositions-private" : "compositions"}`;
}

export function shortRepoName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

/**
 * The published URL. Cloudflare uses the claimed custom host from config
 * when present (e.g. lvndry.pages.dev), else the default <project>.pages.dev.
 */
export function publishedUrl(
  owner: string,
  repo: string,
  slug: string,
  visibility: "public" | "private",
  host: "github" | "cloudflare",
  cfHost?: string,
): string {
  if (host === "cloudflare") {
    const hostBase = cfHost ?? `${shortRepoName(repo)}.pages.dev`;
    return `https://${hostBase}/${repoPathFor(visibility, slug)}`;
  }
  // GitHub Pages serves the repo under <owner>.github.io/<repo>/ — when the
  // repo is the compositions one, its name already provides the
  // compositions/ segment, so the page path drops it; any other repo keeps
  // the full in-repo path.
  const page = repoPathFor(visibility, slug);
  const short = shortRepoName(repo);
  const path =
    short === "compositions" || short === "compositions-private"
      ? page.slice("compositions/".length)
      : page;
  return `https://${owner}.github.io/${short}/${path}`;
}
/**
 * The logged-in raw link to a private page's HTML on GitHub — how the
 * person fetches it back. (Only reachable while authenticated; the
 * Cloudflare URL is the private page itself.)
 */
export function privateRawUrl(repo: string, slug: string): string {
  return `https://github.com/${repo}/raw/main/compositions/private/${slug}/index.html`;
}

/** The og:image absolute URL (og.png sits next to index.html). */
export function ogImageUrlFor(url: string): string {
  return `${url}/og.png`;
}

/** Slug for the URL: lowercase [a-z0-9-], bounded. */
export function slugFromName(name: string): string {
  const base = basename(name).replace(/\.[^.]+$/, "");
  const slug = base
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "composition").slice(0, 80);
}

/** True when a Cloudflare Pages failure is a billing/plan limit, not a bug. */
export function isPagesPlanLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not available on the free plan|billing is required|subscription required/i.test(message);
}

export async function publishComposition(
  input: PublishCompositionArgs,
  cwd: string,
  compose: PublishComposer,
  fs: FileSystem.FileSystem,
  fetchImpl?: CloudflareFetch,
): Promise<ToolExecutionResult> {
  try {
    return { success: true, result: await runPublish(input, cwd, compose, fs, fetchImpl) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not logged in|401|authentication failed/i.test(message) || message.startsWith("gh: ")) {
      return { success: false, result: null, error: PUBLISH_AUTH_ERROR };
    }
    const prefixed = message.startsWith("publish_composition:")
      ? message
      : `publish_composition: ${message}`;
    return { success: false, result: null, error: prefixed };
  }
}

async function runPublish(
  input: PublishCompositionArgs,
  cwd: string,
  compose: PublishComposer,
  fs: FileSystem.FileSystem,
  fetchImpl: CloudflareFetch | undefined,
): Promise<PublishCompositionResult> {
  const visibility: "public" | "private" = input.visibility ?? "public";
  const host: "github" | "cloudflare" =
    input.host ?? (visibility === "private" ? "cloudflare" : "github");
  if (visibility === "private" && host !== "cloudflare") {
    throw new Error(PUBLISH_PRIVATE_REQUIRES_CLOUDFLARE);
  }

  const sourcePath = isAbsolute(input.htmlPath) ? input.htmlPath : join(cwd, input.htmlPath);
  if (extname(sourcePath).toLowerCase() !== ".html") {
    throw new Error(
      `publish_composition: ${sourcePath} is not an .html file. Pass the composition HTML to publish.`,
    );
  }
  let source: string;
  try {
    source = await Effect.runPromise(fs.readFileString(sourcePath));
  } catch {
    throw new Error(PUBLISH_HTML_NOT_FOUND_ERROR(sourcePath));
  }

  const config = host === "cloudflare" ? loadCloudflareConfig() : undefined;
  const cfHost = config?.pagesHost;

  const owner = await currentUser(compose);
  if (!owner) throw new Error(PUBLISH_AUTH_ERROR);
  const repo = input.repo ?? compositionRepoFor(owner, visibility);
  const slug = slugFromName(input.htmlPath);
  const pageDir = repoPathFor(visibility, slug);
  const url = publishedUrl(owner, repo, slug, visibility, host, cfHost);

  // OG card: render the jazz-styled card from the title, inject the meta so
  // the published page declares it. An enhancement — if it fails, the
  // publish proceeds without one.
  const title = titleFromHtml(source);
  const ogPng = renderCompositionOg(title);
  const hasOg = ogPng.length > 0;
  const finalHtml = hasOg ? injectOgMeta(source, title, ogImageUrlFor(url)) : source;

  const tmp = mkdtempSync(join(tmpdir(), "jazz-publish-"));
  try {
    const repoDir = await ensureRepo(repo, visibility, compose, tmp);
    const pageTmp = join(repoDir, pageDir);
    await mkdir(pageTmp, { recursive: true });
    writeFileSync(join(pageTmp, "index.html"), finalHtml);
    if (hasOg) writeFileSync(join(pageTmp, "og.png"), ogPng);

    await runGit(
      ["-c", `user.email=${AUTHOR_EMAIL}`, "-c", `user.name=${AUTHOR_NAME}`, "add", pageDir],
      repoDir,
      compose,
    );
    if (await gitFailed(["diff", "--cached", "--quiet"], repoDir, compose)) {
      await runGit(
        [
          "-c",
          `user.email=${AUTHOR_EMAIL}`,
          "-c",
          `user.name=${AUTHOR_NAME}`,
          "commit",
          "-m",
          `publish ${slug} (${visibility})`,
        ],
        repoDir,
        compose,
      );
    }
    await runGit(["push"], repoDir, compose);

    if (host === "cloudflare") {
      const doFetch: CloudflareFetch = fetchImpl ?? ((url, init) => fetch(url, init));
      const deployment = await deployToCloudflare(
        config!,
        shortRepoName(repo),
        pageDir,
        { indexHtml: finalHtml, ...(hasOg ? { ogPng } : {}) },
        doFetch,
      );
      const accessLine =
        visibility === "private"
          ? deployment.accessNeedsEmail
            ? " — no allow-email policy could be set (add accessEmail to ~/.config/jazz/cloudflare.json)."
            : ` — gated by Cloudflare Access${deployment.accessAppId ? ` (app ${deployment.accessAppId})` : ""}; only the configured email gets in.`
          : "";
      return {
        slug,
        visibility,
        url,
        repo,
        ogCard: hasOg,
        summary: `Published ${slug} (${visibility}) to ${repo} at ${url} (Cloudflare Pages)${accessLine}`,
      };
    }

    const pagesEnabled = await enablePages(repo, compose);
    return {
      slug,
      visibility,
      url,
      repo,
      pagesEnabled,
      ogCard: hasOg,
      summary: `Published ${slug} (${visibility}) to ${repo} at ${url} (GitHub Pages)`,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Clone the repo (or create it on first use). Returns the checkout dir:
 * `git clone` lands in `tmp`, `gh repo create --clone` in
 * `tmp/<repo-name>`.
 */
/** The logged-in GitHub login. `gh api user` prints a JSON object, not the bare name. */
async function currentUser(compose: PublishComposer): Promise<string | undefined> {
  const raw = (await runGh(["api", "user"], compose)).trim();
  try {
    const parsed = JSON.parse(raw) as { login?: unknown };
    if (typeof parsed?.login === "string" && parsed.login.length > 0) return parsed.login;
  } catch {
    // Not JSON (e.g. an error banner) — the raw first line still names the user.
  }
  return raw.split("\n")[0]?.trim();
}

async function ensureRepo(
  repo: string,
  visibility: "public" | "private",
  compose: PublishComposer,
  tmp: string,
): Promise<string> {
  const exists = await compose("gh", ["repo", "view", repo, "--json", "nameWithOwner"])
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    const flag = visibility === "private" ? "--private" : "--public";
    await compose("gh", ["repo", "create", repo, flag, "--clone"], { cwd: tmp });
    return join(tmp, shortRepoName(repo));
  }
  await compose("git", ["clone", `https://github.com/${repo}.git`, tmp]);
  return tmp;
}

async function enablePages(repo: string, compose: PublishComposer): Promise<boolean> {
  try {
    await runGh(["api", "repos", repo, "pages"], compose);
    return true;
  } catch (error) {
    if (!/404/.test(String(error instanceof Error ? error.message : error))) throw error;
  }
  try {
    await runGh(
      [
        "api",
        "-X",
        "POST",
        "repos",
        repo,
        "pages",
        "-f",
        "source[branch]=main",
        "-f",
        "source[path]=/",
      ],
      compose,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = isPagesPlanLimitError(message)
      ? `GitHub Pages is not available on this account's plan (${message}). Enable Pages on a paid plan, or publish with host "cloudflare".`
      : `enabling GitHub Pages failed: ${message}`;
    throw new Error(`publish_composition: ${detail}`, { cause: error });
  }
}
