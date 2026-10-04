/**
 * Publish a composition HTML file to a stable public or private URL.
 *
 * Public: `<owner>.compositions` on the chosen host — GitHub Pages (default)
 * or Cloudflare Pages; the agent asks the user which they prefer. Private:
 * `<owner>.compositions-private`, a PRIVATE repo (sensitive source stays
 * hidden) served by Cloudflare Pages behind Cloudflare Access — so
 * `visibility: "private"` requires `host: "cloudflare"` (a private GitHub
 * repo cannot render Pages on the free plan, and a public repo would expose
 * the source).
 *
 * A re-publish with the same name overwrites the same URL instead of minting
 * a new one. The repo is created on first use on the account `gh` is logged
 * in as; the HTML leaves the machine for a URL others can reach, so the tool
 * is high-risk: the approval gate shows the destination before it runs.
 *
 * `gh` (authenticated) and `git` are required; the cloudflare host also
 * reads ~/.config/jazz/cloudflare.json.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { toError } from "@/core/utils/errors";
import { defineTool, makeZodValidator } from "./base-tool";
import { deployToCloudflare, type CloudflareConfig } from "./cloudflare-publish";
import { buildKeyFromContext } from "./context-utils";

const pexecFile = promisify(execFile);

/**
 * Run `file` with `args` and resolve with `{ stdout, stderr }` as strings.
 * This is the one place in this module that touches a real subprocess, and
 * it is injected everywhere else so tests never need git/gh installed. It
 * mirrors the execFile convention the other tools already use.
 */
export type PublishComposer = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/** The real subprocess runner. */
export async function runComposer(
  file: string,
  args: readonly string[],
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const result = await pexecFile(file, [...args], {
    cwd: options?.cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export const PUBLISH_HTML_NOT_FOUND_ERROR = (htmlPath: string) =>
  `publish_composition: no readable .html file at ${htmlPath}. ` +
  "The path must point at the file create_composition wrote (look at its htmlPath result).";

export const PUBLISH_AUTH_ERROR =
  "publish_composition needs the GitHub CLI: `gh auth status` did not pass. " +
  "Run `gh auth login` and retry.";

export const PUBLISH_PRIVATE_REQUIRES_CLOUDFLARE =
  'visibility "private" requires host "cloudflare": a private GitHub repo cannot render Pages ' +
  "on the free plan, and a public repo would expose the source. Re-call with " +
  'host "cloudflare" — the private composition goes to a private repo served by ' +
  "Cloudflare Pages behind Cloudflare Access, so both the source and the page stay private.";

export const PUBLISH_CLOUDFLARE_NOT_CONFIGURED =
  "publish_composition (host cloudflare) needs Cloudflare credentials: create " +
  "~/.config/jazz/cloudflare.json with { schemaVersion: 1, token, accountId, accessEmail? } " +
  "(an Account-level token with Pages:Edit and Access:Apps:Edit).";

/**
 * A readable slug for the published file: lowercase [a-z0-9-], no leading or
 * trailing hyphens. Falls back to a fixed name so a name with nothing usable
 * in it still publishes rather than failing.
 */
export function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "composition";
}

/**
 * The owner/name repo each visibility publishes into. The repo *name* is
 * `compositions` (or `compositions-private`) because GitHub Pages serves a repo
 * at `<owner>.github.io/<repo-name>/`; the private one hides its source.
 */
export function compositionRepoFor(owner: string, visibility: "public" | "private"): string {
  return visibility === "private" ? `${owner}/compositions-private` : `${owner}/compositions`;
}

/** The repo's short name — the last path segment of "owner/name". */
export function shortRepoName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

/** The stable GitHub Pages URL for one published slug. */
export function publishedUrl(owner: string, repo: string, slug: string): string {
  return `https://${owner}.github.io/${shortRepoName(repo)}/${slug}.html`;
}

/** The stable Cloudflare Pages URL for one published slug. */
export function cloudflareUrl(project: string, slug: string): string {
  return `https://${project}.pages.dev/${slug}.html`;
}

/**
 * The logged-in viewing URL for a private composition when Pages is not
 * enabled: a private repo's raw file is readable while logged in.
 */
export function privateRawUrl(repo: string, slug: string): string {
  return `https://github.com/${repo}/raw/main/${slug}.html`;
}

/**
 * Whether a failed Pages call is the paid-plan gate: GitHub returns plan or
 * billing wording when private Pages is unavailable on the account's plan.
 * Everything else is a real failure that should surface.
 */
export function isPagesPlanLimitError(message: string): boolean {
  return /plan|billing|subscription|not available/i.test(message);
}

/**
 * Where the Cloudflare credentials live. The account id cannot be discovered
 * with a minimal token (GET /accounts needs Account:Read), so it is stored
 * alongside the token. Never committed to a repo — it is a local config file.
 * An env override lets tests and CI point at a fixture.
 */
export function cloudflareConfigPath(): string {
  return (
    process.env["JAZZ_CLOUDFLARE_CONFIG"] ?? join(homedir(), ".config", "jazz", "cloudflare.json")
  );
}

/**
 * Read the Cloudflare credentials. Throws a human-readable error when the
 * file is missing or incomplete so the agent can relay it to the user.
 */
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
  type Parsed = { token?: unknown; accountId?: unknown; accessEmail?: unknown };
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
  return config;
}

const publishCompositionParameters = z
  .object({
    htmlPath: z
      .string()
      .min(1)
      .describe(
        "Path to the .html file to publish, absolute or relative to the working directory.",
      ),
    name: z
      .string()
      .optional()
      .describe(
        "Slug for the published file. Defaults to the htmlPath basename, sanitized to [a-z0-9-].",
      ),
    visibility: z
      .enum(["public", "private"])
      .optional()
      .describe(
        "Ask the user which of these they want before publishing. " +
          "'public' (default): a public repo, URL anyone can open. " +
          "'private': a PRIVATE repo (sensitive source stays hidden) served by " +
          "Cloudflare Pages behind Cloudflare Access — only the configured email can open it.",
      ),
    host: z
      .enum(["github", "cloudflare"])
      .optional()
      .describe(
        "Where the page is served. 'github' (default for public) → GitHub Pages. " +
          "'cloudflare' → Cloudflare Pages. For visibility 'private' this MUST be 'cloudflare'. " +
          "Ask the user which host they prefer when publishing public.",
      ),
    repo: z
      .string()
      .optional()
      .describe(
        'Override the target repo "owner/name". Defaults to <gh-user>.compositions (public) ' +
          "or <gh-user>.compositions-private (private).",
      ),
  })
  .strict();

type PublishCompositionArgs = z.infer<typeof publishCompositionParameters>;

/**
 * The meaningful line of a failing command's output. `execFile` errors carry
 * only "Command failed: …" in the message — the actual text (where GitHub's
 * "Your current plan does not support GitHub Pages…" lives) is in stderr,
 * which the composer's rejection includes.
 */
function trimError(error: unknown): string {
  const message = toError(error).message;
  const rawStderr = (error as { stderr?: string | Buffer }).stderr;
  const stderr = typeof rawStderr === "string" ? rawStderr : (rawStderr?.toString() ?? "");
  const line =
    [...message.split("\n"), ...stderr.split("\n")]
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("Command failed")) ?? message;
  return line.slice(0, 300);
}

/** Run `gh`, trimming stdout; failures carry the first line of the output. */
async function runGh(
  args: readonly string[],
  compose: PublishComposer,
  options?: { cwd?: string },
): Promise<string> {
  try {
    return (await compose("gh", args, options)).stdout.trim();
  } catch (error) {
    throw new Error(`gh ${args[0]} ${args[1] ?? ""}: ${trimError(error)}`.trim(), {
      cause: error,
    });
  }
}

/** Run `git` in the working repo. */
async function runGit(
  args: readonly string[],
  cwd: string,
  compose: PublishComposer,
): Promise<void> {
  try {
    await compose("git", args, { cwd });
  } catch (error) {
    throw new Error(`git ${args[0]}: ${trimError(error)}`, { cause: error });
  }
}

/**
 * The publish flow, separated from the tool wrapper so tests drive it with a
 * scripted composer and a real or stubbed filesystem.
 */
export async function publishComposition(
  args: PublishCompositionArgs,
  workingDirectory: string,
  compose: PublishComposer,
  fs: FileSystem.FileSystem,
): Promise<ToolExecutionResult> {
  try {
    const htmlPath = isAbsolute(args.htmlPath)
      ? args.htmlPath
      : resolvePath(workingDirectory, args.htmlPath);
    await verifySourceFile(fs, htmlPath);

    const slug = slugFromName(args.name ?? basename(htmlPath, ".html"));
    const visibility = args.visibility ?? "public";
    const host = args.host ?? (visibility === "private" ? "cloudflare" : "github");
    if (visibility === "private" && host !== "cloudflare") {
      return { success: false, result: null, error: PUBLISH_PRIVATE_REQUIRES_CLOUDFLARE };
    }

    await compose("gh", ["auth", "status"]).catch(() => {
      throw new Error(PUBLISH_AUTH_ERROR);
    });
    const owner = await runGh(["api", "user", "--jq", ".login"], compose);
    const repo = args.repo ?? compositionRepoFor(owner, visibility);

    const tempDir = await mkdtemp(join(tmpdir(), "jazz-publish-composition-"));
    try {
      const repoDir = await cloneOrCreateRepo(compose, repo, tempDir, visibility);

      // Same slug re-publish = overwrite: one file per slug at the repo root.
      await cp(htmlPath, join(repoDir, `${slug}.html`));

      await runGit(["add", "-A"], repoDir, compose);
      await commitIfChanged(compose, repoDir, slug, visibility);
      await runGit(["push"], repoDir, compose);

      if (host === "cloudflare") {
        const config = loadCloudflareConfig();
        const fileBytes = await readFile(htmlPath);
        const deploy = await deployToCloudflare(
          config,
          shortRepoName(repo),
          slug,
          new Uint8Array(fileBytes),
          globalThis.fetch,
        );
        const project = shortRepoName(repo);
        const accessNote =
          visibility === "private"
            ? deploy.accessPreexisting
              ? ` Cloudflare Access already gates ${project}.pages.dev (app ${deploy.accessAppId}).`
              : deploy.accessNeedsEmail
                ? ` A Cloudflare Access app was created for ${project}.pages.dev, but no allow-email policy yet: add accessEmail to ${cloudflareConfigPath()} and re-publish to lock it; until then, treat the URL as sensitive.`
                : ` Cloudflare Access now gates ${project}.pages.dev (app ${deploy.accessAppId}, allow: ${config.accessEmail}).`
            : "";
        return {
          success: true,
          result: {
            url: deploy.url,
            slug,
            visibility,
            host,
            repo,
            summary:
              `Published ${slug} (${visibility}) to ${deploy.url}. ` +
              `Source is in the ${visibility} repo ${repo}; the page is served by Cloudflare Pages ` +
              `and takes a short time to go live.` +
              accessNote,
          },
        } satisfies ToolExecutionResult;
      }

      const pages = await ensurePages(compose, owner, repo);
      const url = pages.enabled ? publishedUrl(owner, repo, slug) : privateRawUrl(repo, slug);

      return {
        success: true,
        result: {
          url,
          slug,
          visibility,
          host,
          repo,
          pagesEnabled: pages.enabled,
          summary: publishSummary(url, slug, visibility, repo, pages),
        },
      } satisfies ToolExecutionResult;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    return { success: false, result: null, error: toError(error).message };
  }
}

async function verifySourceFile(fs: FileSystem.FileSystem, htmlPath: string): Promise<void> {
  const missing = new Error(PUBLISH_HTML_NOT_FOUND_ERROR(htmlPath));
  let info;
  try {
    info = await stat(htmlPath);
  } catch {
    throw missing;
  }
  if (!info.isFile() || !htmlPath.toLowerCase().endsWith(".html")) {
    throw missing;
  }
  // A stat that passed is not proof the file is readable: read it.
  try {
    await Effect.runPromise(fs.readFileString(htmlPath));
  } catch {
    throw missing;
  }
}

/**
 * Clone an existing repo, or create and clone it on first use. Returns the
 * directory holding the checkout: `gh repo create --clone` clones into
 * `<tempDir>/<repo-name>`, while `git clone` uses `tempDir` directly.
 */
async function cloneOrCreateRepo(
  compose: PublishComposer,
  repo: string,
  tempDir: string,
  visibility: "public" | "private",
): Promise<string> {
  let exists = false;
  try {
    exists =
      (
        await runGh(
          ["repo", "view", repo, "--json", "nameWithOwner", "-q", ".nameWithOwner"],
          compose,
        )
      ).length > 0;
  } catch {
    // `gh repo view` fails for a repo that is not there yet: create it.
  }
  if (exists) {
    await runGit(["clone", `https://github.com/${repo}.git`, tempDir], tempDir, compose);
    return tempDir;
  }
  // `--clone` is a flag that clones into the current directory, not a
  // value-taking option: run it with the (empty) temp dir as cwd, which
  // yields the checkout at tempDir/<repo-name>.
  await runGh(["repo", "create", repo, `--${visibility}`, "--clone"], compose, {
    cwd: tempDir,
  });
  return join(tempDir, shortRepoName(repo));
}

/**
 * Commit with an explicit author so no global git config is needed. A
 * re-publish of identical content leaves nothing to commit: `git diff
 * --cached --quiet` exits 0 when the index matches HEAD (skip the commit)
 * and 1 when it does not (proceed). The branch still gets pushed as-is, so a
 * no-op re-publish is success.
 */
async function commitIfChanged(
  compose: PublishComposer,
  repoDir: string,
  slug: string,
  visibility: "public" | "private",
): Promise<void> {
  let changed = false;
  try {
    await compose("git", ["diff", "--cached", "--quiet"], { cwd: repoDir });
  } catch (error) {
    // execFile rejects on every non-zero exit; 1 is "differences found".
    if ((error as { code?: number }).code !== 1) throw error;
    changed = true;
  }
  if (!changed) return; // nothing staged: identical re-publish.
  await runGit(
    [
      "-c",
      "user.name=jazz",
      "-c",
      "user.email=jazz@users.noreply.github.com",
      "commit",
      "-m",
      `publish ${slug} (${visibility})`,
    ],
    repoDir,
    compose,
  );
}

export type PagesStatus =
  { readonly enabled: true } | { readonly enabled: false; readonly reason: "plan-limit" };

/**
 * Enable Pages when it is not already on. When GitHub refuses because private
 * Pages needs a paid plan, the file is still stored and readable while logged
 * in, which the caller reports instead of failing the publish.
 */
async function ensurePages(
  compose: PublishComposer,
  owner: string,
  repo: string,
): Promise<PagesStatus> {
  const repoPath = `repos/${owner}/${shortRepoName(repo)}`;
  const deploymentPost = () =>
    runGh(
      [
        "api",
        "-X",
        "POST",
        `${repoPath}/pages`,
        "-f",
        "build_type=deployment",
        "-f",
        "source[branch]=main",
        "-f",
        "source[path]=/",
      ],
      compose,
    );
  const legacyPost = () =>
    runGh(
      [
        "api",
        "-X",
        "POST",
        `${repoPath}/pages`,
        "-f",
        "source[branch]=main",
        "-f",
        "source[path]=/",
      ],
      compose,
    );

  try {
    await runGh(["api", `${repoPath}/pages`], compose);
    return { enabled: true };
  } catch {
    // No site yet: enable it. GitHub defaults new sites to Actions-based
    // builds; a one-file repo has no workflow, so ask for a direct deployment
    // of the branch, with the legacy parameter shape as the fallback.
    try {
      await deploymentPost();
      return { enabled: true };
    } catch (deploymentError) {
      try {
        await legacyPost();
        return { enabled: true };
      } catch (legacyError) {
        if (isPagesPlanLimitError(toError(legacyError).message)) {
          return { enabled: false, reason: "plan-limit" };
        }
        // A plan-limit refusal on the deployment call falls through here too.
        if (isPagesPlanLimitError(toError(deploymentError).message)) {
          return { enabled: false, reason: "plan-limit" };
        }
        throw legacyError;
      }
    }
  }
}

/** The message the agent relays; the approval gate already covered the URL. */
function publishSummary(
  url: string,
  slug: string,
  visibility: "public" | "private",
  repo: string,
  pages: PagesStatus,
): string {
  if (!pages.enabled) {
    return (
      `Published ${slug} to private repo ${repo}. GitHub Pages for private repos needs a ` +
      `paid plan on the account, so Pages was not enabled — the file is stored privately and ` +
      `can be opened while logged in at ${url}. For a rendered page only you can open, ` +
      `publish with host "cloudflare" instead.`
    );
  }
  return (
    `Published ${slug} (${visibility}) to ${url}. ` +
    `GitHub Pages takes about a minute to go live; if the URL 404s, wait and retry.`
  );
}

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
      "Pages on the free plan). First use creates the repo; re-publishing the same name overwrites " +
      "the same URL. Requires `gh` (authenticated) and `git`; the cloudflare host also reads " +
      "~/.config/jazz/cloudflare.json. Preview the destination URL to the user before calling; the " +
      "approval gate covers consent.",
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
