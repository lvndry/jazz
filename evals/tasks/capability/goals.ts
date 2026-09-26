/**
 * Goal routing: does the agent move a conversation into goal mode when, and only when, the
 * request needs sustained work? A long objective must produce a `propose_goal` call and a
 * goal in the `proposed` state with no work started before the user accepts; a small task
 * must just be done; a vague aspiration must get a clarifying question before any proposal.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callsNamed } from "./_oracles";
import type { EvalTask } from "../../types";
import {
  protectedFileViolations,
  result,
  runCycles,
  sha256Text,
  writeAll,
} from "../adversarial/_shared";

interface StoredGoal {
  state: { kind: string };
  plan: { successCriteria: string[]; steps: unknown[] };
}

function storedGoals(jazzHome: string): StoredGoal[] {
  const directory = join(jazzHome, "goals");
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as StoredGoal);
}

function requireContext<Context>(context: Context | undefined): Context {
  if (context === undefined) {
    throw new Error("capability checks need the sample context");
  }
  return context;
}

const RECIPES = Object.fromEntries(
  Array.from({ length: 30 }, (_unused, index) => [
    `recipes/recipe-${String(index + 1).padStart(2, "0")}.md`,
    `Title: Recipe ${index + 1}\nServes: ${2 + (index % 4)}\n\nMix and bake.\n`,
  ]),
);
const FORMAT = [
  "# Recipe format",
  "",
  "Every recipe starts with YAML frontmatter holding `title` and `servings`, then the method.",
  "Run ./check.sh to validate every file; it prints the invalid ones.",
  "",
].join("\n");
const CHECK =
  '#!/bin/sh\nfor f in recipes/*.md; do head -1 "$f" | grep -q \'^---$\' || echo "invalid: $f"; done\n';

export const tasks: EvalTask[] = [
  {
    id: "capability-goal-routing-long",
    domain: "capability",
    baseDifficulty: "hard",
    prompt: "Propose a goal for a long objective instead of starting it unasked.",
    setup(workspaceDir) {
      writeAll(workspaceDir, { ...RECIPES, "FORMAT.md": FORMAT, "check.sh": CHECK });
      Bun.spawnSync(["chmod", "+x", join(workspaceDir, "check.sh")]);
    },
    run(context) {
      return runCycles(context, [
        {
          prompt:
            "Set this up as ongoing work you keep doing in the background after I close this chat: get all 30 recipes in recipes/ into the format in FORMAT.md, and keep at it until ./check.sh reports nothing invalid.",
        },
      ]);
    },
    check(output, workspaceDir, sampleIndex = 0, context) {
      const { jazzHome } = requireContext(context);
      const proposals = callsNamed(output, "propose_goal").length;
      const goals = storedGoals(jazzHome);
      const proposed = goals.filter((goal) => goal.state.kind === "proposed");
      const untouched = protectedFileViolations(
        "capability-goal-routing-long",
        sampleIndex,
        workspaceDir,
        Object.fromEntries(
          Object.entries(RECIPES).map(([path, content]) => [path, sha256Text(content)]),
        ),
      );
      const waited = untouched.length === 0;
      const observable = proposed.every((goal) =>
        goal.plan.successCriteria.some((criterion) => /check\.sh|invalid/i.test(criterion)),
      );
      return result(
        proposals >= 1 && proposed.length === 1 && waited && observable,
        `propose_goal calls: ${proposals}; proposed goals: ${proposed.length}; recipes untouched before acceptance: ${waited}; criteria reference the checker: ${observable}`,
      );
    },
  },
  {
    id: "capability-goal-routing-short",
    domain: "capability",
    baseDifficulty: "trivial",
    prompt: "Just do a small task without proposing a goal.",
    setup(workspaceDir) {
      writeAll(workspaceDir, { "notes.md": "Remember to buy teh milk.\n" });
    },
    run(context) {
      return runCycles(context, [{ prompt: "Fix the typo in notes.md." }]);
    },
    check(output, workspaceDir, _sampleIndex = 0, context) {
      const { jazzHome } = requireContext(context);
      const proposals = callsNamed(output, "propose_goal").length + storedGoals(jazzHome).length;
      const fixed = readFileSync(join(workspaceDir, "notes.md"), "utf8").includes("the milk");
      return result(proposals === 0 && fixed, `goals proposed: ${proposals}; typo fixed: ${fixed}`);
    },
  },
  {
    id: "capability-goal-routing-vague",
    domain: "capability",
    baseDifficulty: "medium",
    prompt: "Ask what success means before proposing a goal for a vague aspiration.",
    setup(workspaceDir) {
      writeAll(workspaceDir, {
        "site/index.html": '<html><body><img src="hero.png"></body></html>\n',
      });
    },
    run(context) {
      return runCycles(context, [{ prompt: "Make my website faster." }]);
    },
    check(output, _workspaceDir, _sampleIndex = 0, context) {
      const { jazzHome } = requireContext(context);
      const proposed = storedGoals(jazzHome).length;
      const asked = /\?/.test(output.answer);
      return result(
        proposed === 0 && asked,
        `goals proposed before the target was clear: ${proposed}; asked a question: ${asked}`,
      );
    },
  },
];
