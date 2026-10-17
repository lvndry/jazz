/**
 * Executes the pre-release workflow's actual host-side artifact and output readers against
 * hostile local fixtures. Docker and GitHub are never contacted. The YAML assertions guard
 * the pinned checkout and credential boundaries surrounding those readers.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

interface WorkflowStep {
  readonly if?: string;
  readonly name: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string;
  readonly steps: readonly WorkflowStep[];
}

interface ReviewWorkflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly "cache-mode": string;
  readonly jobs: { readonly review: WorkflowJob; readonly publish: WorkflowJob };
}

const workflow = Bun.YAML.parse(
  readFileSync(new URL("../.github/workflows/pre-release-review.yml", import.meta.url), "utf8"),
) as ReviewWorkflow;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function step(job: WorkflowJob, name: string): WorkflowStep {
  const result = job.steps.find((candidate) => candidate.name === name);
  if (result === undefined) throw new Error(`Missing workflow step: ${name}`);
  return result;
}

function inlineNode(name: string): string {
  const source = step(workflow.jobs.review, name).run ?? "";
  const match = /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/.exec(source);
  if (match?.[1] === undefined) throw new Error(`Missing inline Node reader: ${name}`);
  return match[1];
}

const artifactReader = inlineNode("Stage only regular bounded artifacts outside agent mounts");
const outputReader = inlineNode("Validate review coverage and collect patch in isolation");
const resultReader = inlineNode("Review and fix unreleased commits");

function fixture(): {
  readonly review: string;
  readonly destination: string;
  readonly env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(path.join(tmpdir(), "jazz-workflow-boundary-"));
  directories.push(root);
  const review = path.join(root, "agent-mount");
  mkdirSync(review);
  return {
    review,
    destination: path.join(root, "pre-release-review-artifact"),
    env: {
      PATH: process.env["PATH"],
      REVIEW_DIRECTORY: review,
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: path.join(root, "host-output"),
      GITHUB_STEP_SUMMARY: path.join(root, "host-summary"),
    },
  };
}

function execute(source: string, env: NodeJS.ProcessEnv) {
  return spawnSync("node", ["--input-type=module"], {
    input: source,
    env,
    encoding: "utf8",
    timeout: 5000,
  });
}

function writeArtifacts(review: string): void {
  writeFileSync(
    path.join(review, "report.json"),
    JSON.stringify({ summary: "Reviewed", findings: [] }),
  );
  writeFileSync(path.join(review, "changes.patch"), "reviewed patch\n");
}

describe("pre-release workflow isolation", () => {
  test("dependency lifecycle scripts run before reviewer credentials are available", () => {
    const install = step(workflow.jobs.review, "Install review dependencies without credentials");
    const agent = step(workflow.jobs.review, "Review and fix unreleased commits");
    expect(workflow.jobs.review.steps.indexOf(install)).toBeLessThan(
      workflow.jobs.review.steps.indexOf(agent),
    );
    const instructions = step(
      workflow.jobs.review,
      "Prepare agent and instructions outside the checkout",
    );
    expect(workflow.jobs.review.steps.indexOf(instructions)).toBeLessThan(
      workflow.jobs.review.steps.indexOf(install),
    );
    expect(install.if).toBe(agent.if);
    expect(install.env ?? {}).toEqual({});
    expect(install.run).toContain("bun install --frozen-lockfile");
    expect(install.run).toContain("source=$GITHUB_WORKSPACE,target=/workspace");
    expect(install.run).not.toContain("/review");
    expect(install.run).not.toContain("--env");
    expect(install.run).not.toContain("JAZZ_CHATGPT_CREDENTIAL");
    expect(agent.run).not.toMatch(/bun install|npm install/);
  });

  test("manual main snapshots and a fresh publisher never persist checkout credentials", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow["cache-mode"]).toBe("none");
    expect(workflow.jobs.review.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.publish.needs).toBe("review");
    const reviewCheckout = step(workflow.jobs.review, "Checkout the selected main snapshot");
    const publishCheckout = step(
      workflow.jobs.publish,
      "Checkout trusted publishing code at the reviewed main commit",
    );
    expect(reviewCheckout.with?.["ref"]).toBe("${{ github.sha }}");
    expect(publishCheckout.with?.["ref"]).toBe("${{ needs.review.outputs.main_sha }}");
    for (const checkout of [reviewCheckout, publishCheckout]) {
      expect(checkout.with?.["persist-credentials"]).toBe(false);
    }
    const agent = step(workflow.jobs.review, "Review and fix unreleased commits");
    expect(Object.keys(agent.env ?? {})).toEqual(["JAZZ_CHATGPT_CREDENTIAL"]);
    for (const candidate of workflow.jobs.review.steps.filter((candidate) =>
      candidate.run?.includes("docker run"),
    )) {
      expect(candidate.run).not.toMatch(/--env\s+(?:GH_TOKEN|GITHUB_TOKEN|ACTIONS_)/);
      expect(candidate.run).not.toContain("docker.sock");
    }
    const publisher = step(workflow.jobs.publish, "Open the fix PR from a fresh runner");
    expect(publisher.run).toContain('bun "$RUNNER_TEMP/pre-release-review-publisher.ts" publish');
    expect(publisher.run).not.toMatch(/bun (?:install|run)|npm|npx/);
  });
});

describe("workflow host artifact reader", () => {
  test("copies regular bounded artifacts outside the agent mount", () => {
    const { review, destination, env } = fixture();
    writeArtifacts(review);
    const result = execute(artifactReader, env);
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(destination, "changes.patch"), "utf8")).toBe("reviewed patch\n");
    writeFileSync(path.join(review, "changes.patch"), "later tampering");
    expect(readFileSync(path.join(destination, "changes.patch"), "utf8")).toBe("reviewed patch\n");
    expect(readFileSync(env["GITHUB_STEP_SUMMARY"]!, "utf8")).toContain("Reviewed");
  });

  for (const name of ["report.json", "changes.patch"] as const) {
    test(`refuses a ${name} symlink without disclosing its target`, () => {
      const { review, destination, env } = fixture();
      writeArtifacts(review);
      const secret = path.join(env["RUNNER_TEMP"]!, "host-secret");
      writeFileSync(secret, "secret-target-contents");
      rmSync(path.join(review, name));
      symlinkSync(secret, path.join(review, name));
      const result = execute(artifactReader, env);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain("secret-target-contents");
      expect(existsSync(path.join(destination, name))).toBe(false);
    });

    test(`refuses a ${name} named pipe without blocking`, () => {
      const { review, destination, env } = fixture();
      writeArtifacts(review);
      rmSync(path.join(review, name));
      execFileSync("mkfifo", [path.join(review, name)]);
      const result = execute(artifactReader, env);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(destination, name))).toBe(false);
    });

    test(`refuses an oversized ${name}`, () => {
      const { review, destination, env } = fixture();
      writeArtifacts(review);
      truncateSync(path.join(review, name), (name === "report.json" ? 1048576 : 10485760) + 1);
      expect(execute(artifactReader, env).status).not.toBe(0);
      expect(existsSync(path.join(destination, name))).toBe(false);
    });
  }
});

describe("workflow host collector-output reader", () => {
  test.each(["true", "false"])("accepts only the exact boolean %s output", (value) => {
    const { review, env } = fixture();
    const output = `has_changes=${value}\n`;
    writeFileSync(path.join(review, "collect-output.txt"), output);
    expect(execute(outputReader, env).status).toBe(0);
    expect(readFileSync(env["GITHUB_OUTPUT"]!, "utf8")).toBe(output);
  });

  test.each([
    "has_changes=true\nbranch=main\n",
    "has_changes=true\n\nhas_changes=false\n",
    "has_changes=true",
    "has_changes=true\n" + "x".repeat(65),
  ])("rejects injected or malformed output %j", (output) => {
    const { review, env } = fixture();
    writeFileSync(path.join(review, "collect-output.txt"), output);
    expect(execute(outputReader, env).status).not.toBe(0);
    expect(existsSync(env["GITHUB_OUTPUT"]!)).toBe(false);
  });

  test("rejects a symlink even when its target contains an accepted boolean", () => {
    const { review, env } = fixture();
    const target = path.join(env["RUNNER_TEMP"]!, "forged-output");
    writeFileSync(target, "has_changes=true\n");
    symlinkSync(target, path.join(review, "collect-output.txt"));
    expect(execute(outputReader, env).status).not.toBe(0);
    expect(existsSync(env["GITHUB_OUTPUT"]!)).toBe(false);
  });
});

describe("workflow agent completion gate", () => {
  test("accepts a complete successful result outside the agent mount", () => {
    const { review, env } = fixture();
    const file = path.join(env["RUNNER_TEMP"]!, "pre-release-review-result.json");
    expect(path.dirname(file)).not.toBe(review);
    writeFileSync(
      file,
      JSON.stringify({
        ok: true,
        answer: "The complete range was reviewed.",
        finishReason: "stop",
        stoppedToolCalls: [],
        costCapped: false,
        tokenCapped: false,
        durationCapped: false,
        iterationLimited: false,
        truncated: false,
        toolsDisabled: false,
        stalled: false,
        interrupted: false,
      }),
    );
    expect(execute(resultReader, env).status).toBe(0);
    expect(step(workflow.jobs.review, "Review and fix unreleased commits").run).toContain(
      '> "$RUNNER_TEMP/pre-release-review-result.json"',
    );
  });

  test.each([
    { costCapped: true },
    { tokenCapped: true },
    { durationCapped: true },
    { iterationLimited: true },
    { truncated: true },
    { toolsDisabled: true },
    { stalled: true },
    { interrupted: true },
    { finishReason: "length" },
    { stoppedToolCalls: [{ id: "unfinished-tool" }] },
  ])("rejects an early stop even when the envelope says ok: %j", (partial) => {
    const { env } = fixture();
    writeFileSync(
      path.join(env["RUNNER_TEMP"]!, "pre-release-review-result.json"),
      JSON.stringify({ ok: true, ...partial }),
    );
    const result = execute(resultReader, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The review stopped early");
  });

  test.each(["not JSON", '{"ok":false,"error":"failed"}', "null", "{}"])(
    "rejects invalid or unsuccessful results: %s",
    (contents) => {
      const { env } = fixture();
      writeFileSync(path.join(env["RUNNER_TEMP"]!, "pre-release-review-result.json"), contents);
      expect(execute(resultReader, env).status).not.toBe(0);
    },
  );

  test("rejects oversized results before reading or parsing them", () => {
    const { env } = fixture();
    const file = path.join(env["RUNNER_TEMP"]!, "pre-release-review-result.json");
    writeFileSync(file, '{"ok":true}');
    truncateSync(file, 16777217);
    const result = execute(resultReader, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Review result exceeds 16 MiB");
  });
});
