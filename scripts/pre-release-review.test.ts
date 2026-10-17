/**
 * Exercises the pre-release review trust boundary with local temporary Git repos.
 * GitHub calls and pushes are intercepted: tests never contact or mutate a remote.
 * Fixtures include reverted commits, agent-created commits, tampered reports,
 * metadata/workflow paths, symbolic links, and replay-safe publication.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  readReviewArtifact,
  runPreReleaseReview,
  validateIndexChanges,
  validatePatchPaths,
  validateReviewPath,
  validateReviewReport,
  type ReviewContext,
  type ReviewRuntime,
} from "./pre-release-review";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const value = mkdtempSync(path.join(tmpdir(), "jazz-pre-release-review-"));
  temporary.push(value);
  return value;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function commit(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(
    cwd,
    "-c",
    "user.name=Review Test",
    "-c",
    "user.email=review@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  );
  return git(cwd, "rev-parse", "HEAD").trim();
}

function fixture(): { runtime: ReviewRuntime; context: ReviewContext; calls: string[][] } {
  const cwd = directory();
  const review = directory();
  const calls: string[][] = [];
  git(cwd, "init", "-b", "main");
  writeFileSync(path.join(cwd, "source.ts"), "export const answer = 1;\n");
  writeFileSync(path.join(cwd, "stable.ts"), "export const stable = true;\n");
  const releaseSha = commit(cwd, "release");
  git(cwd, "tag", "v1.2.3");
  writeFileSync(path.join(cwd, "source.ts"), "export const answer = 2;\n");
  const mainSha = commit(cwd, "feature");
  const remote = directory();
  git(cwd, "clone", "--bare", cwd, remote);
  git(cwd, "remote", "add", "origin", remote);
  const context: ReviewContext = {
    mainSha,
    releaseSha,
    releaseTag: "v1.2.3",
    branch: `automation/pre-release-review/${mainSha}`,
    commits: [mainSha],
    changedFiles: ["source.ts"],
  };
  const runtime: ReviewRuntime = {
    cwd,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_OUTPUT: path.join(review, "outputs"),
      GITHUB_STEP_SUMMARY: path.join(review, "summary"),
      REVIEW_DIRECTORY: review,
      PINNED_MAIN_SHA: mainSha,
      PINNED_RELEASE_SHA: releaseSha,
      PINNED_RELEASE_TAG: "v1.2.3",
    },
    run: (program, args, input) => {
      calls.push([program, ...args]);
      if (program === "gh") {
        if (args[0] === "api")
          return JSON.stringify({ tag_name: "v1.2.3", draft: false, prerelease: false });
        if (args[1] === "list") return "[]";
        if (args[1] === "create") return "https://github.com/owner/repo/pull/12\n";
        throw new Error("Unexpected gh call");
      }
      if (args.includes("ls-remote") || args.includes("push")) return "";
      return execFileSync(program, [...args], {
        cwd,
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    },
  };
  return { runtime, context, calls };
}

function report(context: ReviewContext, status: "fixed" | "unresolved" = "fixed") {
  return {
    summary: "Corrects the verified calculation regression.",
    reviewedCommits: context.commits,
    reviewedFiles: context.changedFiles,
    findings: [
      {
        title: "Wrong answer",
        body: "The feature changed a verified result.",
        path: "source.ts",
        status,
      },
    ],
  };
}

function writeReport(runtime: ReviewRuntime, value: unknown): void {
  writeFileSync(path.join(runtime.env["REVIEW_DIRECTORY"]!, "report.json"), JSON.stringify(value));
}

describe("pre-release review scope and report", () => {
  test("fetches a newly published tag missing from the initial checkout", () => {
    const { runtime, context, calls } = fixture();
    git(runtime.cwd, "tag", "-d", context.releaseTag);
    runPreReleaseReview("prepare", runtime);
    expect(git(runtime.cwd, "rev-parse", `refs/tags/${context.releaseTag}^{commit}`).trim()).toBe(
      context.releaseSha,
    );
    const fetch = calls.find((call) => call.includes("fetch"));
    expect(fetch).toContain(`refs/tags/${context.releaseTag}:refs/tags/${context.releaseTag}`);
    expect(fetch).not.toContain("--force");
    expect(fetch).toContain("credential.helper=!gh auth git-credential");
  });

  test("refuses to replace a conflicting local release tag", () => {
    const { runtime, context } = fixture();
    git(runtime.cwd, "tag", "-f", context.releaseTag, context.mainSha);
    expect(() => runPreReleaseReview("prepare", runtime)).toThrow();
    expect(git(runtime.cwd, "rev-parse", `refs/tags/${context.releaseTag}^{commit}`).trim()).toBe(
      context.mainSha,
    );
  });

  test("prepare pins the release, includes reverted files, and writes safe outputs", () => {
    const { runtime } = fixture();
    const file = "reverted\nfile.ts";
    writeFileSync(path.join(runtime.cwd, file), "temporary\n");
    commit(runtime.cwd, "temporary addition");
    rmSync(path.join(runtime.cwd, file));
    commit(runtime.cwd, "revert addition");
    runPreReleaseReview("prepare", runtime);
    const context = JSON.parse(
      readFileSync(path.join(runtime.env["REVIEW_DIRECTORY"]!, "context.json"), "utf8"),
    ) as ReviewContext;
    expect(context.commits).toHaveLength(3);
    expect(context.changedFiles).toEqual([file, "source.ts"]);
    expect(context.mainSha).toBe(git(runtime.cwd, "rev-parse", "HEAD").trim());
    expect(readFileSync(runtime.env["GITHUB_OUTPUT"]!, "utf8")).toContain("should_review=true\n");
  });

  test("coverage includes both paths of a rename from the release", () => {
    const { runtime } = fixture();
    git(runtime.cwd, "mv", "stable.ts", "renamed.ts");
    commit(runtime.cwd, "rename stable file");
    runPreReleaseReview("prepare", runtime);
    const context = JSON.parse(
      readFileSync(path.join(runtime.env["REVIEW_DIRECTORY"]!, "context.json"), "utf8"),
    ) as ReviewContext;
    expect(new Set(context.changedFiles)).toEqual(
      new Set(["source.ts", "stable.ts", "renamed.ts"]),
    );
  });

  test("prepare skips a duplicate open PR", () => {
    const { runtime } = fixture();
    const duplicate: ReviewRuntime = {
      ...runtime,
      run: (program, args, input) =>
        program === "gh" && args[1] === "list"
          ? '[{"url":"https://github.com/owner/repo/pull/9"}]'
          : runtime.run!(program, args, input),
    };
    runPreReleaseReview("prepare", duplicate);
    expect(readFileSync(runtime.env["GITHUB_OUTPUT"]!, "utf8")).toContain("should_review=false\n");
    expect(readFileSync(runtime.env["GITHUB_STEP_SUMMARY"]!, "utf8")).toContain("pull/9");
  });

  test("prepare refuses absent or unstable releases and nonancestor tags", () => {
    const { runtime } = fixture();
    for (const tag of ["plugin-v1.0.0", "v1.0.0-rc.1", "v1.2.3\nmalicious=value"]) {
      const invalid: ReviewRuntime = {
        ...runtime,
        run: (program, args, input) =>
          program === "gh" && args[0] === "api"
            ? JSON.stringify({ tag_name: tag, draft: false, prerelease: false })
            : runtime.run!(program, args, input),
      };
      expect(() => runPreReleaseReview("prepare", invalid)).toThrow("stable vX.Y.Z");
    }
    git(runtime.cwd, "checkout", "--orphan", "unrelated");
    commit(runtime.cwd, "unrelated root");
    expect(() => runPreReleaseReview("prepare", runtime)).toThrow();
  });

  test("rejects omitted/duplicate coverage and out-of-scope or malformed findings", () => {
    const { context } = fixture();
    expect(() =>
      validateReviewReport({ ...report(context), reviewedCommits: [] }, context),
    ).toThrow("commit coverage");
    expect(() =>
      validateReviewReport(
        { ...report(context), reviewedFiles: ["source.ts", "source.ts"] },
        context,
      ),
    ).toThrow("file coverage");
    expect(() =>
      validateReviewReport(
        { ...report(context), findings: [{ ...report(context).findings[0], path: "other.ts" }] },
        context,
      ),
    ).toThrow("outside review scope");
    expect(() =>
      validateReviewReport(
        { ...report(context), findings: [{ ...report(context).findings[0], status: "maybe" }] },
        context,
      ),
    ).toThrow("status");
  });
});

describe("pre-release review artifacts", () => {
  test("collect captures new files and agent commits relative to authoritative main", () => {
    const { runtime, context } = fixture();
    writeFileSync(path.join(runtime.cwd, "source.ts"), "export const answer = 1;\n");
    commit(runtime.cwd, "agent-created fix commit");
    writeFileSync(path.join(runtime.cwd, "regression.test.ts"), "test fixture\n");
    writeReport(runtime, report(context));
    writeFileSync(path.join(runtime.env["REVIEW_DIRECTORY"]!, "context.json"), "tampered");
    runPreReleaseReview("collect", runtime);
    const patch = readFileSync(
      path.join(runtime.env["REVIEW_DIRECTORY"]!, "changes.patch"),
      "utf8",
    );
    expect(patch).toContain("regression.test.ts");
    expect(patch).toContain("+export const answer = 1;");
    expect(readFileSync(runtime.env["GITHUB_OUTPUT"]!, "utf8")).toContain("has_changes=true");
  });

  test("rejects fixed findings without a patch and patches without a fixed finding", () => {
    const { runtime, context } = fixture();
    writeReport(runtime, report(context));
    expect(() => runPreReleaseReview("collect", runtime)).toThrow("must agree");
    writeFileSync(path.join(runtime.cwd, "source.ts"), "changed\n");
    writeReport(runtime, report(context, "unresolved"));
    expect(() => runPreReleaseReview("collect", runtime)).toThrow("must agree");
  });

  test("collect replaces a preexisting patch symlink without following it", () => {
    const { runtime, context } = fixture();
    const target = path.join(directory(), "untouched");
    writeFileSync(target, "untouched");
    symlinkSync(target, path.join(runtime.env["REVIEW_DIRECTORY"]!, "changes.patch"));
    writeReport(runtime, report(context));
    writeFileSync(path.join(runtime.cwd, "source.ts"), "fixed\n");
    runPreReleaseReview("collect", runtime);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(
      readReviewArtifact(path.join(runtime.env["REVIEW_DIRECTORY"]!, "changes.patch"), 1024 * 1024),
    ).toContain("+fixed");
  });

  test("refuses links and bounded artifacts", () => {
    const root = directory();
    const file = path.join(root, "report.json");
    writeFileSync(file, "12345");
    expect(() => readReviewArtifact(file, 4)).toThrow("oversized");
    symlinkSync(file, path.join(root, "linked"));
    expect(() => readReviewArtifact(path.join(root, "linked"), 10)).toThrow();
    expect(() => readReviewArtifact(root, 100)).toThrow("Invalid");
  });

  test("blocks Git metadata, workflow patches, unsafe modes, and renamed metadata", () => {
    for (const unsafe of [
      "../escape",
      ".git/config",
      "src/.git/config",
      "/absolute",
      "C:/file",
      "src\\file",
    ]) {
      expect(() => validateReviewPath(unsafe)).toThrow("Unsafe");
    }
    for (const mode of ["120000", "160000"]) {
      expect(() => validateIndexChanges(`:000000 ${mode} 0000000 abcdef0 A\0link\0`)).toThrow(
        "Symlink",
      );
    }
    expect(() =>
      validateIndexChanges(":100644 000000 abcdef0 0000000 D\0.github/workflows/ci.yml\0"),
    ).toThrow("manual review");
    expect(() => validatePatchPaths("1\t1\t.github/workflows/push.yml\0")).toThrow("manual review");
    expect(() => validatePatchPaths("0\t0\t\0source.ts\0.git/config\0")).toThrow("Unsafe");
    expect(() => validatePatchPaths("1\t1\tvalid\0unparsed")).toThrow("Malformed");
  });

  test("collect rejects actual symlink and workflow additions", () => {
    for (const kind of ["symlink", "workflow"] as const) {
      const { runtime, context } = fixture();
      writeReport(runtime, report(context));
      if (kind === "symlink") symlinkSync("source.ts", path.join(runtime.cwd, "link"));
      else {
        mkdirSync(path.join(runtime.cwd, ".github"));
        writeFileSync(path.join(runtime.cwd, ".github", "new-action.yml"), "on: push\n");
      }
      expect(() => runPreReleaseReview("collect", runtime)).toThrow();
    }
  });
});

describe("pre-release review publisher", () => {
  test("applies a patch locally, commits with hooks disabled, pushes once, and opens one PR", () => {
    const { runtime, context, calls } = fixture();
    writeReport(runtime, report(context));
    writeFileSync(path.join(runtime.cwd, "source.ts"), "export const answer = 1;\n");
    runPreReleaseReview("collect", runtime);
    git(runtime.cwd, "reset", "--hard", context.mainSha);
    runPreReleaseReview("publish", runtime);
    expect(git(runtime.cwd, "branch", "--show-current").trim()).toBe(context.branch);
    expect(readFileSync(path.join(runtime.cwd, "source.ts"), "utf8")).toContain("answer = 1");
    expect(calls.filter((call) => call.includes("push"))).toHaveLength(1);
    expect(calls.find((call) => call.includes("push"))).toContain(
      "credential.helper=!gh auth git-credential",
    );
    const create = calls.find((call) => call[0] === "gh" && call[2] === "create");
    expect(create).toContain("--body-file");
    expect(create).not.toContain("--draft");
    expect(
      calls
        .filter((call) => call[0] === "git")
        .every((call) => call.includes("core.hooksPath=/dev/null")),
    ).toBe(true);
    expect(readFileSync(runtime.env["GITHUB_STEP_SUMMARY"]!, "utf8")).toContain("pull/12");
  });

  test("uses draft status for unresolved findings alongside fixes", () => {
    const { runtime, context, calls } = fixture();
    writeReport(runtime, {
      ...report(context),
      findings: [...report(context).findings, ...report(context, "unresolved").findings],
    });
    writeFileSync(path.join(runtime.cwd, "source.ts"), "fixed\n");
    runPreReleaseReview("collect", runtime);
    git(runtime.cwd, "reset", "--hard", context.mainSha);
    runPreReleaseReview("publish", runtime);
    expect(calls.find((call) => call[0] === "gh" && call[2] === "create")).toContain("--draft");
  });

  test("does not overwrite an existing branch without an open PR", () => {
    const { runtime, context, calls } = fixture();
    writeReport(runtime, report(context));
    writeFileSync(path.join(runtime.cwd, "source.ts"), "fixed\n");
    runPreReleaseReview("collect", runtime);
    git(runtime.cwd, "reset", "--hard", context.mainSha);
    const existing: ReviewRuntime = {
      ...runtime,
      run: (program, args, input) =>
        args.includes("ls-remote")
          ? `${context.mainSha}\trefs/heads/${context.branch}\n`
          : runtime.run!(program, args, input),
    };
    expect(() => runPreReleaseReview("publish", existing)).toThrow("refusing to overwrite");
    expect(calls.some((call) => call.includes("push"))).toBe(false);
  });

  test("revalidates a tampered workflow patch before applying or pushing it", () => {
    const { runtime, context, calls } = fixture();
    writeReport(runtime, report(context));
    mkdirSync(path.join(runtime.cwd, ".github"));
    writeFileSync(path.join(runtime.cwd, ".github", "unreviewed.yml"), "on: push\n");
    git(runtime.cwd, "add", "-A");
    const patch = git(runtime.cwd, "diff", "--cached", "--binary", context.mainSha);
    git(runtime.cwd, "reset", "--hard", context.mainSha);
    writeFileSync(path.join(runtime.env["REVIEW_DIRECTORY"]!, "changes.patch"), patch);
    expect(() => runPreReleaseReview("publish", runtime)).toThrow("manual review");
    expect(calls.some((call) => call.includes("push"))).toBe(false);
    expect(git(runtime.cwd, "status", "--porcelain")).toBe("");
  });

  test("clean reports publish nothing and duplicate open PRs are reused", () => {
    const { runtime, context, calls } = fixture();
    writeReport(runtime, { ...report(context), findings: [] });
    runPreReleaseReview("collect", runtime);
    runPreReleaseReview("publish", runtime);
    expect(calls.some((call) => call.includes("push"))).toBe(false);
    writeReport(runtime, report(context));
    writeFileSync(path.join(runtime.cwd, "source.ts"), "fixed\n");
    runPreReleaseReview("collect", runtime);
    const duplicate: ReviewRuntime = {
      ...runtime,
      run: (program, args, input) =>
        program === "gh" && args[1] === "list"
          ? '[{"url":"https://github.com/owner/repo/pull/9"}]'
          : runtime.run!(program, args, input),
    };
    runPreReleaseReview("publish", duplicate);
    expect(calls.some((call) => call.includes("push"))).toBe(false);
    expect(readFileSync(runtime.env["GITHUB_STEP_SUMMARY"]!, "utf8")).toContain("pull/9");
  });
});
