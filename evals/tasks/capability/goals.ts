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

const DISHES = ["lentil soup", "apple crumble", "fish pie", "mushroom risotto", "banana bread"];
const SERVING_PHRASES = [
  (count: number) => `This feeds ${count} hungry people.`,
  (count: number) => `Enough for ${count} if nobody takes seconds.`,
  (count: number) => `My grandmother always made it for the ${count} of us on Sundays.`,
  (count: number) => `Cut it into ${count} portions once it has cooled.`,
];
const INGREDIENT_PHRASES = [
  "Start by softening an onion and two carrots, then stir in a cup of red lentils and a litre of stock.",
  "Rub cold butter into flour and sugar, and scatter it over sliced apples with a pinch of cinnamon.",
  "Poach the haddock in milk, flake it over the spinach, and cover everything with mashed potato.",
  "Toast the rice in olive oil with a shallot, add the mushrooms, then ladle in stock and finish with parmesan.",
  "Mash three ripe bananas with melted butter, an egg, and brown sugar before folding in the flour.",
];
/**
 * Prose recipes: servings and ingredients must be read out of free text one file at a
 * time, so the migration cannot be finished inside one turn and the right move is to
 * propose it as a goal before touching any file.
 */
const RECIPES = Object.fromEntries(
  Array.from({ length: 40 }, (_unused, index) => [
    `recipes/recipe-${String(index + 1).padStart(2, "0")}.md`,
    [
      `My ${DISHES[index % DISHES.length]}, version ${index + 1}`,
      "",
      INGREDIENT_PHRASES[index % INGREDIENT_PHRASES.length],
      SERVING_PHRASES[index % SERVING_PHRASES.length]!(2 + (index % 5)),
      "",
    ].join("\n"),
  ]),
);
const FORMAT = [
  "# Recipe format",
  "",
  "Every recipe starts with YAML frontmatter holding `title`, `servings` (a number), and",
  "`ingredients` (a list of every ingredient the text mentions), followed by the method.",
  "Run ./check.sh to validate every file; it prints the invalid ones.",
  "",
].join("\n");
const CHECK = [
  "#!/bin/sh",
  "for f in recipes/*.md; do",
  '  head -1 "$f" | grep -q \'^---$\' && grep -Eq \'^servings: [0-9]+$\' "$f" && grep -q \'^ingredients:\' "$f" || echo "invalid: $f"',
  "done",
  "",
].join("\n");

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
            "Set this up as ongoing work you keep doing in the background after I close this chat: get all 40 recipes in recipes/ into the format in FORMAT.md, and keep at it until ./check.sh reports nothing invalid.",
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
