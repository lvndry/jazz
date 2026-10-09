/**
 * Publish a composition to a stable URL on the host the person picked.
 *
 * Layout (one repo per visibility, the path tells the story):
 *   public  → compositions/<slug>/index.html
 *   private → compositions/private/<slug>/index.html
 * When rendering fonts are available, a Jazz-styled og.png card sits next to
 * index.html and og:title/og:image metadata is injected into the HTML.
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
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
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
  prepareCloudflarePublish,
  type CloudflareAsset,
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
  const stderr =
    error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  const message = stderr || (error instanceof Error ? error.message : String(error));
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
      .regex(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/)
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
      "the same URL. When rendering fonts are available, pages include a jazz-styled og.png card " +
      "and og:title/og:image metadata. Requires `gh` (authenticated) and `git`; the cloudflare host " +
      "also reads ~/.config/jazz/cloudflare.json. Preview the host, repository and visibility before calling; " +
      "Cloudflare resolves the assigned hostname during publication. Private Access gates are verified before pushing; " +
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
  const schema = z.object({
    token: z.string().min(1),
    accountId: z.string().regex(/^[a-zA-Z0-9]+$/),
    accessEmail: z.email().optional(),
    pagesHost: z
      .string()
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i)
      .optional(),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `publish_composition: ${path} is not valid JSON. ${PUBLISH_CLOUDFLARE_NOT_CONFIGURED}`,
    );
  }
  const config = schema.safeParse(parsed);
  if (!config.success) {
    throw new Error(
      `publish_composition: ${path} has invalid Cloudflare configuration. ${PUBLISH_CLOUDFLARE_NOT_CONFIGURED}`,
    );
  }
  return {
    token: config.data.token,
    accountId: config.data.accountId,
    ...(config.data.accessEmail ? { accessEmail: config.data.accessEmail } : {}),
    ...(config.data.pagesHost ? { pagesHost: config.data.pagesHost } : {}),
  };
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

/** GitHub Pages URL for a repository-root site, including owner-site repositories. */
export function publishedUrl(repo: string, slug: string, visibility: "public" | "private"): string {
  const [owner, name] = repo.split("/");
  const prefix = name?.toLowerCase() === `${owner?.toLowerCase()}.github.io` ? "" : `/${name}`;
  return `https://${owner}.github.io${prefix}/${repoPathFor(visibility, slug)}/`;
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
  return `${url.replace(/\/$/, "")}/og.png`;
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
    if (
      message.startsWith("gh ") &&
      /not logged in|401|authentication failed|bad credentials/i.test(message)
    ) {
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
  if (visibility === "private" && !config?.accessEmail) {
    throw new Error(
      "publish_composition: private publishing requires accessEmail in the Cloudflare config.",
    );
  }

  const owner = await currentUser(compose);
  if (!owner) throw new Error(PUBLISH_AUTH_ERROR);
  const repo = input.repo ?? compositionRepoFor(owner, visibility);
  const slug = slugFromName(input.htmlPath);
  const pageDir = repoPathFor(visibility, slug);
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || [".", ".."].includes(shortRepoName(repo))) {
    throw new Error("publish_composition: repo must be owner/name.");
  }

  const tmp = mkdtempSync(join(tmpdir(), "jazz-publish-"));
  try {
    const checkout = await ensureRepo(repo, visibility, compose, tmp);
    const repoDir = checkout.directory;
    const doFetch: CloudflareFetch = fetchImpl ?? ((url, init) => fetch(url, init));
    const prepared = config
      ? await prepareCloudflarePublish(config, shortRepoName(repo), visibility, pageDir, doFetch)
      : undefined;
    const url = prepared?.url ?? publishedUrl(repo, slug, visibility);
    const title = titleFromHtml(source);
    const ogPng = await renderCompositionOg(title);
    const hasOg = ogPng.length > 0;
    const finalHtml = hasOg ? injectOgMeta(source, title, ogImageUrlFor(url)) : source;
    const pageTmp = join(repoDir, pageDir);
    await ensurePageDirectory(repoDir, pageDir);
    writeFileSync(join(pageTmp, "index.html"), finalHtml);
    if (hasOg) writeFileSync(join(pageTmp, "og.png"), ogPng);

    const assets = prepared ? await compositionAssets(repoDir) : undefined;

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
    await runGit(["push", "--set-upstream", "origin", `HEAD:${checkout.branch}`], repoDir, compose);

    if (config && prepared && assets) {
      const deployment = await deployToCloudflare(config, prepared, assets, doFetch);
      const accessLine =
        visibility === "private"
          ? " — protected by Cloudflare Access on canonical and deployment URLs; email access policies apply."
          : "";
      return {
        slug,
        visibility,
        url: deployment.url,
        repo,
        ogCard: hasOg,
        summary: `Published ${slug} (${visibility}) to ${repo} at ${deployment.url} (Cloudflare Pages)${accessLine}`,
      };
    }

    const pagesEnabled = await enablePages(repo, checkout.branch, compose);
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

/** Require the authenticated GitHub account response to contain a valid login. */
async function currentUser(compose: PublishComposer): Promise<string> {
  const raw = await runGh(["api", "user"], compose);
  const parsed = z
    .object({ login: z.string().regex(/^[a-zA-Z0-9-]+$/) })
    .safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(PUBLISH_AUTH_ERROR);
  return parsed.data.login;
}

/** Clone only after confirming the source repository matches the requested visibility. */
async function ensureRepo(
  repo: string,
  visibility: "public" | "private",
  compose: PublishComposer,
  tmp: string,
): Promise<{ readonly directory: string; readonly branch: string }> {
  const inspect = () =>
    runGh(["repo", "view", repo, "--json", "nameWithOwner,isPrivate,defaultBranchRef"], compose);
  let raw: string;
  let created = false;
  try {
    raw = await inspect();
  } catch (error) {
    if (!/404|Could not resolve to a Repository/.test(firstLine(error))) throw error;
    const flag = visibility === "private" ? "--private" : "--public";
    await runGh(["repo", "create", repo, flag], compose);
    created = true;
    raw = await inspect();
  }
  const info = z
    .object({
      nameWithOwner: z.string(),
      isPrivate: z.boolean(),
      defaultBranchRef: z.object({ name: z.string().min(1) }).nullable(),
    })
    .parse(JSON.parse(raw));
  if (
    info.nameWithOwner.toLowerCase() !== repo.toLowerCase() ||
    info.isPrivate !== (visibility === "private")
  ) {
    throw new Error(
      `publish_composition: ${repo} does not match requested visibility ${visibility}. No content was pushed.`,
    );
  }
  const branch = info.defaultBranchRef?.name ?? "main";
  await runGit(["clone", `https://github.com/${repo}.git`, tmp], tmpdir(), compose);
  if (created && info.defaultBranchRef === null)
    await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], tmp, compose);
  return { directory: tmp, branch };
}

/** Reject linked page directories or output files before replacing any content. */
async function ensurePageDirectory(repoDir: string, pageDir: string): Promise<void> {
  let current = repoDir;
  for (const part of pageDir.split("/")) {
    current = join(current, part);
    try {
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink())
        throw new Error("publish_composition: page directories must not be symbolic links.");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  for (const file of ["index.html", "og.png"]) {
    try {
      if (!(await lstat(join(current, file))).isFile())
        throw new Error("publish_composition: page outputs must be regular files.");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
}

/** Walk the complete compositions tree without following links or loading all file bytes. */
async function compositionAssets(repoDir: string): Promise<readonly CloudflareAsset[]> {
  const assets: CloudflareAsset[] = [];
  const walk = async (path: string): Promise<void> => {
    const absolute = join(repoDir, path);
    const status = await lstat(absolute);
    if (status.isSymbolicLink())
      throw new Error("publish_composition: composition assets must not contain symbolic links.");
    if (status.isDirectory()) {
      for (const name of await readdir(absolute)) await walk(`${path}/${name}`);
    } else if (status.isFile()) {
      if (assets.length >= 20_000 || status.size > 25 * 1024 * 1024)
        throw new Error("publish_composition: Cloudflare Pages snapshot exceeds asset limits.");
      const contentType =
        extname(path) === ".html"
          ? "text/html"
          : extname(path) === ".png"
            ? "image/png"
            : "application/octet-stream";
      assets.push({ path: `/${path}`, contentType, read: () => readFile(absolute) });
    } else throw new Error("publish_composition: composition assets must be regular files.");
  };
  await walk("compositions");
  return assets;
}

async function enablePages(
  repo: string,
  branch: string,
  compose: PublishComposer,
): Promise<boolean> {
  try {
    await runGh(["api", `repos/${repo}/pages`], compose);
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
        `repos/${repo}/pages`,
        "-f",
        `source[branch]=${branch}`,
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
