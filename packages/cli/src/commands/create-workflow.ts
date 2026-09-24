import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listAllAgents } from "@jazz/core/agent/agent-service";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types/agent";
import type { AutoApprovePolicy } from "@jazz/core/types/tools";
import { describeCronSchedule, isValidCronExpression } from "@jazz/core/utils/cron";
import { getGlobalWorkflowsDirectory } from "@jazz/core/utils/paths";
import { WorkflowServiceTag } from "@jazz/core/workflows/workflow-service";
import { Effect } from "effect";

interface WorkflowAnswers {
  name: string;
  description: string;
  schedule: string;
  agent: string;
  autoApprove: AutoApprovePolicy;
  catchUpOnRestart: boolean;
  location: "local" | "global";
  prompt: string;
}

type WizardStep =
  | "name"
  | "description"
  | "schedule"
  | "agent"
  | "autoApprove"
  | "catchUp"
  | "location"
  | "prompt"
  | "done";

interface WizardState {
  step: WizardStep;
  name?: string;
  description?: string;
  schedule?: string;
  agent?: string;
  autoApprove?: AutoApprovePolicy;
  catchUpOnRestart?: boolean;
  location?: "local" | "global";
  prompt?: string;
}

const STEP_ORDER: WizardStep[] = [
  "name",
  "description",
  "schedule",
  "agent",
  "autoApprove",
  "catchUp",
  "location",
  "prompt",
  "done",
];

function previousStep(current: WizardStep): WizardStep | null {
  const index = STEP_ORDER.indexOf(current);
  return index > 0 ? STEP_ORDER[index - 1]! : null;
}

export function createWorkflowCommand() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading("Create a New Workflow");
    yield* terminal.log("Let's set up a recurring task step by step.");
    yield* terminal.log("");
    yield* terminal.info("Press ESC at any step to go back.");

    const agents = yield* listAllAgents().pipe(
      Effect.catchAll(() => Effect.succeed([] as readonly Agent[])),
    );

    const answers = yield* Effect.tryPromise({
      try: () => promptForWorkflowInfo(terminal, agents),
      catch: (error) =>
        new Error(
          `Workflow creation failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    if (answers === null) {
      yield* terminal.info("Workflow creation cancelled.");
      return;
    }

    const workflowDir =
      answers.location === "global"
        ? path.join(getGlobalWorkflowsDirectory(), answers.name)
        : path.join(process.cwd(), "workflows", answers.name);

    yield* Effect.tryPromise({
      try: () => fs.mkdir(workflowDir, { recursive: true }),
      catch: (error) =>
        new Error(
          `Failed to create directory: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const frontmatter = buildFrontmatter(answers);
    const content = `---\n${frontmatter}---\n\n${answers.prompt}\n`;
    const filePath = path.join(workflowDir, "WORKFLOW.md");

    yield* Effect.tryPromise({
      try: () => fs.writeFile(filePath, content, "utf-8"),
      catch: (error) =>
        new Error(
          `Failed to write workflow: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    const workflowService = yield* WorkflowServiceTag;
    yield* workflowService.refreshCache();

    yield* terminal.log("");
    yield* terminal.success("Workflow created!");
    yield* terminal.log(`   Name: ${answers.name}`);
    yield* terminal.log(`   File: ${filePath}`);
    const scheduleDesc = describeCronSchedule(answers.schedule);
    yield* terminal.log(`   Schedule: ${scheduleDesc ?? answers.schedule}`);
    yield* terminal.log(`   Agent: ${answers.agent}`);
    yield* terminal.log(`   Auto-approve: ${String(answers.autoApprove)}`);
    yield* terminal.log("");
    yield* terminal.info("Next steps:");
    yield* terminal.log(`   jazz workflow run ${answers.name}      # test it first`);
    yield* terminal.log(`   jazz workflow schedule ${answers.name}  # then schedule it`);
  });
}

function buildFrontmatter(answers: WorkflowAnswers): string {
  const lines: string[] = [];
  lines.push(`name: ${answers.name}`);
  lines.push(`description: ${answers.description}`);
  lines.push(`schedule: "${answers.schedule}"`);
  if (answers.agent !== "default") {
    lines.push(`agent: ${answers.agent}`);
  }
  lines.push(`autoApprove: ${String(answers.autoApprove)}`);
  if (answers.catchUpOnRestart) {
    lines.push("catchUpOnRestart: true");
  }
  return lines.map((line) => `${line}\n`).join("");
}

async function promptForWorkflowInfo(
  terminal: TerminalService,
  agents: readonly Agent[],
): Promise<WorkflowAnswers | null> {
  const state: WizardState = { step: "name" };
  const hint = "(ESC to go back)";

  while (state.step !== "done") {
    switch (state.step) {
      case "name": {
        const result = await Effect.runPromise(
          terminal.ask("Workflow name:", {
            ...(state.name !== undefined && { defaultValue: state.name }),
            placeholder: "my-workflow",
            cancellable: true,
            simple: true,
            validate: (value: string): boolean | string => {
              if (!value || value.trim().length === 0) {
                return "Name cannot be empty";
              }
              if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
                return "Use lowercase letters, numbers, and hyphens (kebab-case)";
              }
              if (value.length > 100) {
                return "Name cannot exceed 100 characters";
              }
              return true;
            },
          }),
        );

        if (result === undefined) {
          return null;
        }

        state.name = result;
        state.step = "description";
        break;
      }

      case "description": {
        const result = await Effect.runPromise(
          terminal.ask(`Description ${hint}:`, {
            ...(state.description !== undefined && { defaultValue: state.description }),
            placeholder: "Brief one-line summary of what this workflow does",
            cancellable: true,
            simple: true,
            validate: (value: string): boolean | string => {
              if (!value || value.trim().length === 0) {
                return "Description cannot be empty";
              }
              if (value.length > 200) {
                return "Keep it under 200 characters";
              }
              return true;
            },
          }),
        );

        if (result === undefined) {
          state.step = previousStep("description")!;
          break;
        }

        state.description = result;
        state.step = "schedule";
        break;
      }

      case "schedule": {
        const result = await Effect.runPromise(
          terminal.select<string>(`When should this run? ${hint}`, {
            choices: [
              { name: "Every hour", value: "0 * * * *" },
              { name: "Every morning at 8am", value: "0 8 * * *" },
              { name: "Every morning at 9am (weekdays)", value: "0 9 * * 1-5" },
              { name: "Every 15 minutes", value: "*/15 * * * *" },
              { name: "Every evening at 6pm", value: "0 18 * * *" },
              { name: "Every Monday at 9am", value: "0 9 * * 1" },
              { name: "First of every month", value: "0 0 1 * *" },
              { name: "Custom cron expression...", value: "custom" },
            ],
            default: state.schedule ?? "0 8 * * *",
          }),
        );

        if (result === undefined) {
          state.step = previousStep("schedule")!;
          break;
        }

        if (result === "custom") {
          const cronResult = await Effect.runPromise(
            terminal.ask(`Cron expression (min hour dom month dow) ${hint}:`, {
              ...(state.schedule !== undefined && { defaultValue: state.schedule }),
              placeholder: "0 8 * * *",
              cancellable: true,
              simple: true,
              validate: (value: string): boolean | string => {
                if (!isValidCronExpression(value)) {
                  return "Invalid cron expression. Format: minute hour day-of-month month day-of-week";
                }
                return true;
              },
            }),
          );

          if (cronResult === undefined) {
            break;
          }

          state.schedule = cronResult;
        } else {
          state.schedule = result;
        }

        state.step = "agent";
        break;
      }

      case "agent": {
        const agentChoices: Array<{ name: string; value: string }> = [
          { name: "default", value: "default" },
        ];
        for (const agent of agents) {
          if (agent.name !== "default") {
            const desc = agent.description ? ` — ${agent.description}` : "";
            agentChoices.push({ name: `${agent.name}${desc}`, value: agent.name });
          }
        }

        const result = await Effect.runPromise(
          terminal.select<string>(`Which agent should run this? ${hint}`, {
            choices: agentChoices,
            default: state.agent ?? "default",
          }),
        );

        if (result === undefined) {
          state.step = previousStep("agent")!;
          break;
        }

        state.agent = result;
        state.step = "autoApprove";
        break;
      }

      case "autoApprove": {
        const result = await Effect.runPromise(
          terminal.select<AutoApprovePolicy>(`Auto-approve policy ${hint}:`, {
            choices: [
              {
                name: "read-only — only reads/searches, no modifications",
                value: "read-only" as AutoApprovePolicy,
              },
              {
                name: "low-risk — modifies data but reversible (labeling, archiving)",
                value: "low-risk" as AutoApprovePolicy,
              },
              {
                name: "high-risk — deletes, sends, executes commands",
                value: "high-risk" as AutoApprovePolicy,
              },
              {
                name: "false — always ask for approval",
                value: false as AutoApprovePolicy,
              },
            ],
            default: state.autoApprove ?? "read-only",
          }),
        );

        if (result === undefined) {
          state.step = previousStep("autoApprove")!;
          break;
        }

        state.autoApprove = result;
        state.step = "catchUp";
        break;
      }

      case "catchUp": {
        const result = await Effect.runPromise(
          terminal.confirm(
            `Catch up missed runs on restart? ${hint}`,
            state.catchUpOnRestart ?? false,
          ),
        );

        if (result === undefined) {
          state.step = previousStep("catchUp")!;
          break;
        }

        state.catchUpOnRestart = result;
        state.step = "location";
        break;
      }

      case "location": {
        const result = await Effect.runPromise(
          terminal.select<"local" | "global">(`Where should this workflow live? ${hint}`, {
            choices: [
              {
                name: `Global (~/.jazz/workflows/${state.name}/)`,
                value: "global",
                description: "Available everywhere, personal automation",
              },
              {
                name: `Local (./workflows/${state.name}/)`,
                value: "local",
                description: "Project-specific, can be committed to git",
              },
            ],
            default: state.location ?? "global",
          }),
        );

        if (result === undefined) {
          state.step = previousStep("location")!;
          break;
        }

        state.location = result;
        state.step = "prompt";
        break;
      }

      case "prompt": {
        const defaultPrompt =
          state.prompt ??
          `# ${titleCase(state.name!)}\n\n[Describe what the agent should do each run]`;

        const result = await Effect.runPromise(
          terminal.ask(`Workflow instructions (the prompt the agent will follow) ${hint}:`, {
            defaultValue: defaultPrompt,
            cancellable: true,
            simple: true,
            validate: (value: string): boolean | string => {
              if (!value || value.trim().length === 0) {
                return "Instructions cannot be empty";
              }
              return true;
            },
          }),
        );

        if (result === undefined) {
          state.step = previousStep("prompt")!;
          break;
        }

        state.prompt = result;
        state.step = "done";
        break;
      }
    }
  }

  return {
    name: state.name!,
    description: state.description!,
    schedule: state.schedule!,
    agent: state.agent!,
    autoApprove: state.autoApprove!,
    catchUpOnRestart: state.catchUpOnRestart!,
    location: state.location!,
    prompt: state.prompt!,
  };
}

function titleCase(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
