/**
 * Trusted boundary for the manual pre-release review workflow. Run `prepare` in a
 * clean main checkout to pin the published release and review scope, `collect`
 * after the credential-free agent exits, and `publish` in a fresh pinned checkout.
 * REVIEW_DIRECTORY holds context.json, the agent's report.json, and changes.patch.
 * Collect/publish derive authority from PINNED_MAIN_SHA, PINNED_RELEASE_SHA, and
 * PINNED_RELEASE_TAG, never from files the agent can edit. This module only uses
 * Node builtins, so the publisher never installs or executes reviewed code.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_LIMIT = 1024 * 1024;
const PATCH_LIMIT = 10 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export interface ReviewContext {
  readonly mainSha: string;
  readonly releaseSha: string;
  readonly releaseTag: string;
  readonly branch: string;
  readonly commits: readonly string[];
  readonly changedFiles: readonly string[];
}

interface Finding {
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly status: "fixed" | "unresolved";
}

export interface ReviewReport {
  readonly summary: string;
  readonly reviewedCommits: readonly string[];
  readonly reviewedFiles: readonly string[];
  readonly findings: readonly Finding[];
}

/** Inject commands in tests; production executes argument arrays directly, never a shell. */
export interface ReviewRuntime {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly run?: (program: string, args: readonly string[], input?: string) => string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value.map((item: unknown) => text(item, label));
}

/** Git metadata, traversal, absolute paths, and Windows path aliases are never patch targets. */
export function validateReviewPath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || /^\.git$/i.test(part))
  ) {
    throw new Error("Unsafe review path");
  }
}

function exactCoverage(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const entries = new Set(actual);
  if (
    entries.size !== actual.length ||
    entries.size !== expected.length ||
    expected.some((v) => !entries.has(v))
  ) {
    throw new Error(`Incomplete or duplicate ${label} coverage`);
  }
}

/** Validate the agent's claims against refs and scope reconstructed outside its writable files. */
export function validateReviewReport(value: unknown, context: ReviewContext): ReviewReport {
  const report = object(value);
  const reviewedCommits = strings(report["reviewedCommits"], "reviewedCommits");
  const reviewedFiles = strings(report["reviewedFiles"], "reviewedFiles");
  exactCoverage(reviewedCommits, context.commits, "commit");
  exactCoverage(reviewedFiles, context.changedFiles, "file");
  if (!Array.isArray(report["findings"])) throw new Error("Invalid findings");
  const changedFiles = new Set(context.changedFiles);
  const findings = report["findings"].map((item: unknown): Finding => {
    const finding = object(item);
    const findingPath = text(finding["path"], "finding path");
    validateReviewPath(findingPath);
    if (!changedFiles.has(findingPath)) throw new Error("Finding outside review scope");
    if (finding["status"] !== "fixed" && finding["status"] !== "unresolved") {
      throw new Error("Invalid finding status");
    }
    return {
      title: text(finding["title"], "finding title"),
      body: text(finding["body"], "finding body"),
      path: findingPath,
      status: finding["status"],
    };
  });
  return { summary: text(report["summary"], "summary"), reviewedCommits, reviewedFiles, findings };
}

function command(
  runtime: ReviewRuntime,
  program: string,
  args: readonly string[],
  input?: string,
): string {
  if (runtime.run) return runtime.run(program, args, input);
  return execFileSync(program, [...args], {
    cwd: runtime.cwd,
    env: {
      ...runtime.env,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function git(runtime: ReviewRuntime, args: readonly string[], input?: string): string {
  return command(
    runtime,
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      `safe.directory=${runtime.cwd}`,
      ...args,
    ],
    input,
  );
}

function repository(runtime: ReviewRuntime): string {
  const repo = required(runtime.env, "GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid GITHUB_REPOSITORY");
  return repo;
}

/** Use the publisher's GH_TOKEN through gh, with no credential stored in the remote URL. */
function authenticatedGit(runtime: ReviewRuntime, args: readonly string[]): string {
  return git(runtime, [
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    ...args,
  ]);
}

function branchFor(mainSha: string): string {
  return `automation/pre-release-review/${mainSha}`;
}

function scope(
  runtime: ReviewRuntime,
  mainSha: string,
  releaseSha: string,
  releaseTag: string,
): ReviewContext {
  if (!SHA.test(mainSha) || !SHA.test(releaseSha) || !RELEASE_TAG.test(releaseTag)) {
    throw new Error("Invalid pinned release refs");
  }
  git(runtime, ["merge-base", "--is-ancestor", releaseSha, mainSha]);
  const commits = git(runtime, ["rev-list", "--reverse", `${releaseSha}..${mainSha}`])
    .trim()
    .split("\n")
    .filter(Boolean);
  const changedFiles = [
    ...new Set(
      git(runtime, [
        "log",
        "--format=",
        "--name-only",
        "--no-renames",
        "-z",
        "--diff-merges=first-parent",
        `${releaseSha}..${mainSha}`,
      ])
        .split("\0")
        .filter(Boolean),
    ),
  ];
  for (const commit of commits) if (!SHA.test(commit)) throw new Error("Invalid commit SHA");
  changedFiles.forEach(validateReviewPath);
  return { mainSha, releaseSha, releaseTag, branch: branchFor(mainSha), commits, changedFiles };
}

function pinnedScope(runtime: ReviewRuntime): ReviewContext {
  return scope(
    runtime,
    required(runtime.env, "PINNED_MAIN_SHA"),
    required(runtime.env, "PINNED_RELEASE_SHA"),
    required(runtime.env, "PINNED_RELEASE_TAG"),
  );
}

function output(runtime: ReviewRuntime, values: Readonly<Record<string, string>>): void {
  const destination = runtime.env["GITHUB_OUTPUT"];
  if (destination)
    appendFileSync(
      destination,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
}

function summary(runtime: ReviewRuntime, message: string): void {
  const destination = runtime.env["GITHUB_STEP_SUMMARY"];
  if (destination) appendFileSync(destination, `${message}\n`);
}

function reviewFile(runtime: ReviewRuntime, name: string): string {
  return path.join(required(runtime.env, "REVIEW_DIRECTORY"), name);
}

/** Reject links, devices, oversized artifacts, and artifacts that grow during a read. */
export function readReviewArtifact(file: string, limit: number): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit)
      throw new Error("Invalid or oversized review artifact");
    const contents = readFileSync(fd);
    if (contents.length > limit) throw new Error("Oversized review artifact");
    return contents.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

interface PullRequest {
  readonly url: string;
}

function existingPullRequest(
  runtime: ReviewRuntime,
  context: ReviewContext,
): PullRequest | undefined {
  const response: unknown = JSON.parse(
    command(runtime, "gh", [
      "pr",
      "list",
      "--repo",
      repository(runtime),
      "--base",
      "main",
      "--head",
      context.branch,
      "--state",
      "open",
      "--json",
      "url",
    ]),
  );
  if (!Array.isArray(response) || response.length > 1)
    throw new Error("Invalid pull request lookup");
  if (response.length === 0) return undefined;
  return { url: text(object(response[0])["url"], "pull request URL") };
}

function prepare(runtime: ReviewRuntime): void {
  const release = object(
    JSON.parse(command(runtime, "gh", ["api", `repos/${repository(runtime)}/releases/latest`])),
  );
  const tag = text(release["tag_name"], "release tag");
  if (!RELEASE_TAG.test(tag) || release["draft"] !== false || release["prerelease"] !== false) {
    throw new Error("Latest published release must have a stable vX.Y.Z tag");
  }
  const mainSha = git(runtime, ["rev-parse", "HEAD"]).trim();
  authenticatedGit(runtime, ["fetch", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  const releaseSha = git(runtime, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).trim();
  const context = scope(runtime, mainSha, releaseSha, tag);
  mkdirSync(required(runtime.env, "REVIEW_DIRECTORY"), { recursive: true });
  writeFileSync(reviewFile(runtime, "context.json"), `${JSON.stringify(context, null, 2)}\n`);
  const prior = existingPullRequest(runtime, context);
  output(runtime, {
    main_sha: mainSha,
    release_sha: releaseSha,
    release_tag: tag,
    branch: context.branch,
    should_review: String(context.commits.length > 0 && prior === undefined),
  });
  if (prior) summary(runtime, `Pre-release review already open: ${prior.url}`);
  else if (context.commits.length === 0) summary(runtime, `No main commits since ${tag}.`);
}

function checkReportPatch(report: ReviewReport, patch: string): void {
  const fixed = report["findings"].some((finding) => finding["status"] === "fixed");
  if (patch.length > 0 !== fixed) throw new Error("Fixed findings and patch must agree");
}

/** Read raw index entries after staging/application; no new symlinks or submodules may publish. */
export function validateIndexChanges(raw: string): void {
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length - 1; i += 2) {
    const header = parts[i];
    const file = parts[i + 1];
    if (header === undefined || file === undefined) throw new Error("Malformed index diff");
    const modes = /^:[0-7]{6} ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ [A-Z]$/.exec(header);
    if (!modes) throw new Error("Malformed index diff");
    validatePatchPath(file);
    if (modes[1] !== "000000" && modes[1] !== "100644" && modes[1] !== "100755") {
      throw new Error("Symlink and submodule changes cannot be published");
    }
  }
  if (parts.at(-1) !== "" || parts.length % 2 !== 1) throw new Error("Malformed index diff");
}

function validatePatchPath(file: string): void {
  validateReviewPath(file);
  if (file.split("/")[0]?.toLowerCase() === ".github") {
    throw new Error("Changes under .github require manual review and cannot be published");
  }
}

function validateIndex(runtime: ReviewRuntime, context: ReviewContext): void {
  validateIndexChanges(
    git(runtime, [
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      context.mainSha,
    ]),
  );
}

function collect(runtime: ReviewRuntime): void {
  const context = pinnedScope(runtime);
  const report = validateReviewReport(
    JSON.parse(readReviewArtifact(reviewFile(runtime, "report.json"), REPORT_LIMIT)),
    context,
  );
  git(runtime, ["add", "-A"]);
  validateIndex(runtime, context);
  const patch = git(runtime, [
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    context.mainSha,
  ]);
  if (Buffer.byteLength(patch) > PATCH_LIMIT) throw new Error("Review patch exceeds 10 MiB");
  checkReportPatch(report, patch);
  const destination = reviewFile(runtime, "changes.patch");
  try {
    unlinkSync(destination);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  writeFileSync(destination, patch, { flag: "wx" });
  output(runtime, { has_changes: String(patch.length > 0) });
  summary(
    runtime,
    `${report["summary"]}\n\n${report["findings"].length} finding(s), ${report["findings"].filter((finding) => finding["status"] === "fixed").length} fixed.`,
  );
}

/** Validate every numstat path before git apply touches the publisher's clean checkout. */
export function validatePatchPaths(numstat: string): void {
  const entries = numstat.split("\0");
  if (entries.pop() !== "") throw new Error("Malformed patch paths");
  for (let i = 0; i < entries.length; i++) {
    const match = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]*)$/.exec(entries[i] ?? "");
    if (!match) throw new Error("Malformed patch paths");
    if (match[1] === "") {
      validatePatchPath(entries[++i] ?? "");
      validatePatchPath(entries[++i] ?? "");
    } else {
      validatePatchPath(match[1] ?? "");
    }
  }
}

function pullRequestBody(
  runtime: ReviewRuntime,
  context: ReviewContext,
  report: ReviewReport,
): string {
  const runUrl = `https://github.com/${repository(runtime)}/actions/runs/${required(runtime.env, "GITHUB_RUN_ID")}`;
  return [
    `TLDR: ${report["summary"]}`,
    `Reviewed all ${context.commits.length} main commits since ${context.releaseTag} (${context.releaseSha}), through ${context.mainSha}.`,
    ...report["findings"].map(
      (finding) =>
        `### ${finding["status"] === "fixed" ? "Fixed" : "Unresolved"}: ${finding["title"]}\n\nPath: \`${finding["path"]}\`\n\n${finding["body"]}`,
    ),
    `Validation and review artifacts: [workflow run](${runUrl}).`,
    "This automated review is advisory; review the fixes and validation before merging.",
  ].join("\n\n");
}

function publish(runtime: ReviewRuntime): void {
  const context = pinnedScope(runtime);
  const report = validateReviewReport(
    JSON.parse(readReviewArtifact(reviewFile(runtime, "report.json"), REPORT_LIMIT)),
    context,
  );
  const patch = readReviewArtifact(reviewFile(runtime, "changes.patch"), PATCH_LIMIT);
  checkReportPatch(report, patch);
  if (patch.length === 0) {
    summary(
      runtime,
      `${report["summary"]}\n\nNo fixes to publish. ${report["findings"].length} unresolved finding(s).`,
    );
    return;
  }
  const prior = existingPullRequest(runtime, context);
  if (prior) {
    summary(runtime, `Pre-release review already open: ${prior.url}`);
    return;
  }
  if (
    git(runtime, ["rev-parse", "HEAD"]).trim() !== context.mainSha ||
    git(runtime, ["status", "--porcelain", "--untracked-files=all"]).length > 0
  ) {
    throw new Error("Publisher requires a clean pinned main checkout");
  }
  if (
    authenticatedGit(runtime, [
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${context.branch}`,
    ]).trim()
  ) {
    throw new Error("Review branch already exists without an open PR; refusing to overwrite it");
  }
  validatePatchPaths(git(runtime, ["apply", "--numstat", "-z", "-"], patch));
  git(runtime, ["apply", "--index", "--whitespace=nowarn", "-"], patch);
  validateIndex(runtime, context);
  if (git(runtime, ["diff", "--cached", "--name-only"]).length === 0)
    throw new Error("Patch has no changes");
  git(runtime, ["switch", "-c", context.branch]);
  git(runtime, [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    `fix: pre-release review since ${context.releaseTag}`,
  ]);
  authenticatedGit(runtime, ["push", "origin", `HEAD:refs/heads/${context.branch}`]);
  const bodyFile = reviewFile(runtime, "pr-body.md");
  writeFileSync(bodyFile, pullRequestBody(runtime, context, report));
  const draft = report["findings"].some((finding) => finding["status"] === "unresolved")
    ? ["--draft"]
    : [];
  const url = command(runtime, "gh", [
    "pr",
    "create",
    "--repo",
    repository(runtime),
    "--base",
    "main",
    "--head",
    context.branch,
    "--title",
    `fix: pre-release review since ${context.releaseTag}`,
    "--body-file",
    bodyFile,
    ...draft,
  ]).trim();
  summary(runtime, `Pre-release review PR: ${url}`);
}

/** Entry point exported so tests can exercise commands without contacting GitHub. */
export function runPreReleaseReview(mode: string, runtime: ReviewRuntime): void {
  switch (mode) {
    case "prepare":
      prepare(runtime);
      return;
    case "collect":
      collect(runtime);
      return;
    case "publish":
      publish(runtime);
      return;
    default:
      throw new Error("Expected prepare, collect, or publish");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runPreReleaseReview(process.argv[2] ?? "", { cwd: process.cwd(), env: process.env });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Pre-release review failed");
    process.exitCode = 1;
  }
}
