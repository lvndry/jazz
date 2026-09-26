/**
 * Goal planning: what `jazz goal draft --inspect --json` makes of a request, before any work
 * runs. A clear objective must become a plan whose finish line a command can check, a vague
 * one must come back as questions, an objective its own constraints rule out must not be
 * called plausible, and a constraint the user states must survive into the plan.
 */
import { join } from "node:path";
import { lastOutputLine, spawnJazz } from "../../run-jazz";
import { emptyResult, type EvalTask, type OneShotResult, type TaskRunContext } from "../../types";
import { result, writeAll } from "../adversarial/_shared";

interface DraftedPlan {
  successCriteria: string[];
  constraints: string[];
  steps: { objective: string; successCriteria: string[] }[];
  feasibility: { assessment: string; rationale: string };
}

type Draft =
  | { ok: true; kind: "plan"; plan: DraftedPlan }
  | { ok: true; kind: "questions"; questions: string[] }
  | { ok: false; error: string };

async function draftGoal(context: TaskRunContext, request: string): Promise<OneShotResult> {
  const startedAt = performance.now();
  const proc = spawnJazz(
    ["goal", "draft", request, "--agent", context.agentId, "--inspect", "--json"],
    {
      workspaceDir: context.workspaceDir,
      cassettePath: context.cassettePath,
      jazzHome: context.jazzHome,
      environment: context.environment,
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), context.timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  return emptyResult({
    answer: lastOutputLine(stdout) ?? "",
    costKnown: false,
    durationMs: Math.round(performance.now() - startedAt),
    cycles: 1,
  });
}

function parseDraft(output: OneShotResult): Draft | undefined {
  try {
    return JSON.parse(output.answer) as Draft;
  } catch {
    return undefined;
  }
}

function describeDraft(draft: Draft | undefined): string {
  if (draft === undefined) {
    return "no JSON envelope";
  }
  if (!draft.ok) {
    return `failed: ${draft.error}`;
  }
  if (draft.kind === "questions") {
    return `questions: ${JSON.stringify(draft.questions)}`;
  }
  return `plan: criteria ${JSON.stringify(draft.plan.successCriteria)}; constraints ${JSON.stringify(draft.plan.constraints)}; ${draft.plan.steps.length} steps; feasibility ${draft.plan.feasibility.assessment}`;
}

const RECIPE_CHECK =
  '#!/bin/sh\nfor f in recipes/*.md; do head -1 "$f" | grep -q \'^---$\' || echo "invalid: $f"; done\n';

export const tasks: EvalTask[] = [
  {
    id: "capability-planner-checkable-finish",
    domain: "capability",
    baseDifficulty: "medium",
    prompt: "Draft a plan whose finish line is the checker the workspace already has.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "check.sh": RECIPE_CHECK,
        "FORMAT.md": "Every recipe starts with YAML frontmatter holding `title` and `servings`.\n",
        ...Object.fromEntries(
          Array.from({ length: 12 }, (_unused, index) => [
            `recipes/recipe-${index + 1}.md`,
            `Title: Recipe ${index + 1}\nServes: ${2 + (index % 4)}\n\nMix and bake.\n`,
          ]),
        ),
      });
      Bun.spawnSync(["chmod", "+x", join(workspaceDir, "check.sh")]);
    },
    run(context) {
      return draftGoal(context, "Convert every recipe to the format in FORMAT.md.");
    },
    check(output) {
      const draft = parseDraft(output);
      const plan = draft?.ok === true && draft.kind === "plan" ? draft.plan : undefined;
      const checkable =
        plan?.successCriteria.some((criterion) => /check\.sh|invalid/i.test(criterion)) ?? false;
      return result(
        checkable && (plan?.steps.length ?? 0) >= 2 && plan?.feasibility.assessment === "plausible",
        describeDraft(draft),
      );
    },
  },
  {
    id: "capability-planner-vague-asks",
    domain: "capability",
    baseDifficulty: "medium",
    prompt: "Come back with questions for an objective with no finish line.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "site/index.html": '<html><body><img src="hero.png"></body></html>\n',
      });
    },
    run(context) {
      return draftGoal(context, "Make my website better.");
    },
    check(output) {
      const draft = parseDraft(output);
      return result(draft?.ok === true && draft.kind === "questions", describeDraft(draft));
    },
  },
  {
    id: "capability-planner-infeasible",
    domain: "capability",
    baseDifficulty: "hard",
    prompt: "Do not call an objective plausible when its own constraints rule it out.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "package.json": '{ "name": "billing", "scripts": { "test": "bun test" } }\n',
        "src/invoice.js":
          "export function total(lines) {\n  return lines.reduce((sum, line) => sum + line.amount, 0);\n}\n\nexport function tax(amount) {\n  return amount * 0.2;\n}\n",
        "tests/invoice.test.js":
          'import { expect, it } from "bun:test";\nimport { total } from "../src/invoice.js";\n\nit("adds lines", () => {\n  expect(total([{ amount: 2 }, { amount: 3 }])).toBe(5);\n});\n',
      });
    },
    run(context) {
      return draftGoal(
        context,
        "Get src/invoice.js to 100% test coverage. Do not add, edit, or delete any file under tests/ or src/, and do not create test files anywhere else.",
      );
    },
    check(output) {
      const draft = parseDraft(output);
      const flagged =
        draft?.ok === true &&
        (draft.kind === "questions" || draft.plan.feasibility.assessment !== "plausible");
      return result(flagged, describeDraft(draft));
    },
  },
  {
    id: "capability-planner-keeps-constraint",
    domain: "capability",
    baseDifficulty: "medium",
    prompt: "Carry a constraint the user stated into the drafted plan.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "src/user.ts": "export interface User {\n  userId: string;\n}\n",
        "src/session.ts":
          'import type { User } from "./user";\n\nexport const owner = (user: User) => user.userId;\n',
        "migrations/001-users.sql": "CREATE TABLE users (userId TEXT PRIMARY KEY);\n",
      });
    },
    run(context) {
      return draftGoal(
        context,
        "Rename the userId field to accountId across src/, and leave the migrations/ folder exactly as it is.",
      );
    },
    check(output) {
      const draft = parseDraft(output);
      const plan = draft?.ok === true && draft.kind === "plan" ? draft.plan : undefined;
      const kept = plan?.constraints.some((constraint) => /migrations/i.test(constraint)) ?? false;
      return result(kept, describeDraft(draft));
    },
  },
];
