import { Effect } from "effect";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import React from "react";
import { store } from "@/cli/ui/store";
import { THEME } from "@/cli/ui/theme";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier, listAllAgents } from "@/core/agent/agent-service";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import type { Agent } from "@/core/types/agent";
import { describeCronSchedule } from "@/core/utils/cron-utils";
import {
  type CatchUpCandidate,
  decideCatchUp,
  getCatchUpCandidates,
  runCatchUpForWorkflows,
} from "@/core/workflows/catch-up";
import {
  addRunRecord,
  getRecentRuns,
  getRunHistoryFilePath,
  loadRunHistory,
  updateLatestRunRecord,
} from "@/core/workflows/run-history";
import { SchedulerServiceTag } from "@/core/workflows/scheduler-service";
import { WorkflowServiceTag, type WorkflowMetadata } from "@/core/workflows/workflow-service";
import { groupWorkflows, formatWorkflow } from "@/core/workflows/workflow-utils";

/**
 * CLI commands for managing and running workflows.
 */

/**
 * List all available workflows.
 */
export function listWorkflowsCommand() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const workflowService = yield* WorkflowServiceTag;
    const scheduler = yield* SchedulerServiceTag;

    yield* terminal.heading("📋 Available Workflows");
    yield* terminal.log("");

    const workflows = yield* workflowService.listWorkflows();

    if (workflows.length === 0) {
      yield* terminal.info("No workflows found.");
      yield* terminal.log("");
      yield* terminal.info("Create a workflow by adding a WORKFLOW.md file to:");
      yield* terminal.log("  • ./workflows/<name>/WORKFLOW.md (local)");
      yield* terminal.log("  • ~/.jazz/workflows/<name>/WORKFLOW.md (global)");
      return;
    }

    // Resolve scheduled and running status (best-effort; ignore scheduler errors on unsupported platforms)
    const scheduledNames = yield* scheduler.listScheduled().pipe(
      Effect.map((list) => new Set(list.map((s) => s.workflowName))),
      Effect.catchAll(() => Effect.succeed(new Set<string>())),
    );
    const runningNames = yield* loadRunHistory().pipe(
      Effect.map(
        (history) =>
          new Set(history.filter((r) => r.status === "running").map((r) => r.workflowName)),
      ),
      Effect.catchAll(() => Effect.succeed(new Set<string>())),
    );

    const { local, global, builtin } = groupWorkflows(workflows);

    function statusBadge(w: WorkflowMetadata): string {
      if (runningNames.has(w.name)) return " ● running";
      if (scheduledNames.has(w.name)) return " ○ scheduled";
      if (w.schedule) return " — not scheduled";
      return "";
    }

    if (local.length > 0) {
      yield* terminal.log("Local workflows:");
      for (const w of local) {
        yield* terminal.log(formatWorkflow(w, { statusBadge: statusBadge(w) }));
      }
      yield* terminal.log("");
    }

    if (global.length > 0) {
      yield* terminal.log("Global workflows (~/.jazz/workflows):");
      for (const w of global) {
        yield* terminal.log(formatWorkflow(w, { statusBadge: statusBadge(w) }));
      }
      yield* terminal.log("");
    }

    if (builtin.length > 0) {
      yield* terminal.log("Built-in workflows:");
      for (const w of builtin) {
        yield* terminal.log(formatWorkflow(w, { statusBadge: statusBadge(w) }));
      }
      yield* terminal.log("");
    }

    yield* terminal.info(`Total: ${workflows.length} workflow(s)`);
  });
}

/**
 * Show details of a specific workflow.
 */
export function showWorkflowCommand(workflowName: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const workflowService = yield* WorkflowServiceTag;

    const workflow = yield* workflowService.loadWorkflow(workflowName).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* terminal.error(`Workflow not found: ${workflowName}`);
          yield* terminal.info("Run 'jazz workflow list' to see available workflows.");
          return yield* Effect.fail(error);
        }),
      ),
    );

    yield* terminal.heading(`📋 Workflow: ${workflow.metadata.name}`);
    yield* terminal.log("");
    yield* terminal.log(`Description: ${workflow.metadata.description}`);
    yield* terminal.log(`Path: ${workflow.metadata.path}`);

    if (workflow.metadata.agent) {
      yield* terminal.log(`Agent: ${workflow.metadata.agent}`);
    }

    if (workflow.metadata.schedule) {
      const desc = describeCronSchedule(workflow.metadata.schedule);
      const scheduleDisplay = desc
        ? `${desc} (${workflow.metadata.schedule})`
        : workflow.metadata.schedule;
      yield* terminal.log(`Schedule: ${scheduleDisplay}`);
    }

    if (workflow.metadata.autoApprove !== undefined) {
      yield* terminal.log(`Auto-approve: ${workflow.metadata.autoApprove}`);
    }

    if (workflow.metadata.skills && workflow.metadata.skills.length > 0) {
      yield* terminal.log(`Skills: ${workflow.metadata.skills.join(", ")}`);
    }

    if (workflow.metadata.catchUpOnStartup !== undefined) {
      yield* terminal.log(`Catch-up on startup: ${workflow.metadata.catchUpOnStartup}`);
    }

    if (workflow.metadata.maxCatchUpAge !== undefined) {
      yield* terminal.log(`Max catch-up age (seconds): ${workflow.metadata.maxCatchUpAge}`);
    }

    yield* terminal.log("");
    yield* terminal.log("─".repeat(60));
    yield* terminal.log("Prompt:");
    yield* terminal.log("─".repeat(60));
    yield* terminal.log(workflow.prompt);
  });
}

/** Default max iterations for workflows */
const DEFAULT_MAX_ITERATIONS = 50;

/**
 * Run a workflow once (manually or via system scheduler).
 *
 * When `options.scheduled` is true, the run was triggered by the system scheduler
 * (launchd/cron). In this case, we verify that a scheduled time was actually missed
 * before running. This prevents spurious runs from launchd's RunAtLoad (which fires
 * immediately when the plist is loaded, e.g. during `jazz workflow schedule` or on login
 * when no run was actually missed).
 */
export function runWorkflowCommand(
  workflowName: string,
  options?: {
    autoApprove?: boolean;
    agent?: string;
    scheduled?: boolean;
  },
) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const workflowService = yield* WorkflowServiceTag;
    const logger = yield* LoggerServiceTag;

    const isHeadless = options?.autoApprove === true;
    const isSchedulerTriggered = options?.scheduled === true;

    // When triggered by the system scheduler (--scheduled), verify that a scheduled
    // time was recently missed before proceeding. This guards against RunAtLoad firing
    // the workflow immediately when the plist is first loaded (e.g. during scheduling)
    // while still allowing it to run on login/wake when a real run was missed.
    if (isSchedulerTriggered) {
      const workflow = yield* workflowService
        .getWorkflow(workflowName)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));

      if (workflow?.schedule) {
        const history = yield* loadRunHistory().pipe(Effect.catchAll(() => Effect.succeed([])));
        const lastRun = history
          .filter((r) => r.workflowName === workflowName)
          .reduce<Date | undefined>((latest, r) => {
            const ts = r.completedAt ?? r.startedAt;
            const parsed = new Date(ts);
            if (Number.isNaN(parsed.getTime())) return latest;
            return !latest || parsed.getTime() > latest.getTime() ? parsed : latest;
          }, undefined);

        const now = new Date();
        const decision = decideCatchUp(
          // Use the workflow metadata but force catchUpOnStartup to true for this check,
          // since the scheduler guard should always evaluate whether a run was missed
          // regardless of the workflow's catch-up preference.
          { ...workflow, catchUpOnStartup: true },
          lastRun,
          now,
        );

        if (!decision.shouldRun) {
          yield* logger.info("Scheduler-triggered run skipped: no missed run detected", {
            workflow: workflowName,
            reason: decision.reason,
          });
          return;
        }

        yield* logger.info("Scheduler-triggered run proceeding: missed run detected", {
          workflow: workflowName,
          scheduledAt: decision.scheduledAt?.toISOString(),
        });
      }
    }

    yield* terminal.heading(`🚀 Running workflow: ${workflowName}`);
    yield* terminal.log("");

    // Load the workflow
    const workflow = yield* workflowService.loadWorkflow(workflowName).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* terminal.error(`Workflow not found: ${workflowName}`);
          yield* terminal.info("Run 'jazz workflow list' to see available workflows.");
          return yield* Effect.fail(error);
        }),
      ),
    );

    // Determine which agent to use (CLI flag > workflow metadata > default)
    const agentIdentifier = options?.agent || workflow.metadata.agent || "default";

    // Try to get the specified agent, or prompt user to select one
    let agent: Agent;
    const agentResult = yield* getAgentByIdentifier(agentIdentifier).pipe(Effect.either);

    if (agentResult._tag === "Right") {
      agent = agentResult.right;
      yield* terminal.info(`Using agent: ${agent.name}`);
    } else {
      // In headless mode (--auto-approve), fail immediately if agent not found
      if (isHeadless) {
        yield* terminal.error(`Agent '${agentIdentifier}' not found.`);
        yield* terminal.info(
          "Scheduled workflows require a valid agent. Update the workflow or create the agent.",
        );
        return yield* Effect.fail(
          new Error(`Agent '${agentIdentifier}' not found for headless workflow execution`),
        );
      }

      // Agent not found - list available agents and let user choose
      const allAgents = yield* listAllAgents();

      if (allAgents.length === 0) {
        yield* terminal.error("No agents available.");
        yield* terminal.info("Create an agent first with: jazz agent create");
        return yield* Effect.fail(
          new Error("No agents available. Create an agent first with: jazz agent create"),
        );
      }

      if (agentIdentifier !== "default") {
        yield* terminal.warn(`Agent '${agentIdentifier}' not found.`);
      } else {
        yield* terminal.info("No default agent configured.");
      }
      yield* terminal.log("");

      // Prompt user to select an agent
      const selectedAgent = yield* selectAgentForWorkflow(
        allAgents,
        "Select an agent to run this workflow:",
      );
      if (!selectedAgent) {
        yield* terminal.info("Workflow cancelled.");
        return;
      }

      agent = selectedAgent;
      yield* terminal.info(`Using agent: ${agent.name}`);
    }

    // Determine auto-approve policy
    const autoApprovePolicy =
      options?.autoApprove === true
        ? (workflow.metadata.autoApprove ?? true)
        : workflow.metadata.autoApprove;

    if (autoApprovePolicy) {
      yield* terminal.info(`Auto-approve policy: ${autoApprovePolicy}`);
    }

    yield* terminal.log("");
    yield* logger.info("Starting workflow execution", {
      workflow: workflowName,
      agent: agent.name,
      autoApprove: autoApprovePolicy,
    });

    // Record the run start
    const startedAt = new Date().toISOString();
    yield* addRunRecord({
      workflowName,
      startedAt,
      status: "running",
      triggeredBy: isHeadless ? "scheduled" : "manual",
    }).pipe(Effect.catchAll(() => Effect.void)); // Don't fail if history tracking fails

    // Use configurable max iterations from workflow metadata
    const maxIterations = workflow.metadata.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // Run the agent with the workflow prompt
    yield* AgentRunner.run({
      agent,
      userInput: workflow.prompt,
      sessionId: `workflow-${workflowName}-${Date.now()}`,
      conversationId: `workflow-${workflowName}-${Date.now()}`,
      maxIterations,
      ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
    }).pipe(
      Effect.tap(() =>
        updateLatestRunRecord(workflowName, {
          completedAt: new Date().toISOString(),
          status: "completed",
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.tapError((error) =>
        updateLatestRunRecord(workflowName, {
          completedAt: new Date().toISOString(),
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    );

    yield* terminal.log("");
    yield* terminal.success(`Workflow completed: ${workflowName}`);
  });
}

/**
 * Schedule a workflow for periodic execution.
 */
export function scheduleWorkflowCommand(workflowName: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const workflowService = yield* WorkflowServiceTag;
    const scheduler = yield* SchedulerServiceTag;

    yield* terminal.heading(`⏰ Scheduling workflow: ${workflowName}`);
    yield* terminal.log("");

    // Load the workflow to verify it exists and has a schedule
    const workflow = yield* workflowService.loadWorkflow(workflowName).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* terminal.error(`Workflow not found: ${workflowName}`);
          yield* terminal.info("Run 'jazz workflow list' to see available workflows.");
          return yield* Effect.fail(error);
        }),
      ),
    );

    if (!workflow.metadata.schedule) {
      yield* terminal.error(`Workflow '${workflowName}' has no schedule defined.`);
      yield* terminal.info("Add a 'schedule' field to the workflow's WORKFLOW.md frontmatter.");
      yield* terminal.log("");
      yield* terminal.log("Example:");
      yield* terminal.log("  ---");
      yield* terminal.log("  name: my-workflow");
      yield* terminal.log('  schedule: "0 * * * *"  # Every hour');
      yield* terminal.log("  ---");
      return;
    }

    const schedulerType = scheduler.getSchedulerType();
    if (schedulerType === "unsupported") {
      yield* terminal.error("Scheduling is not supported on this platform.");
      yield* terminal.info("Supported platforms: macOS (launchd), Linux (cron)");
      return;
    }

    // Check if already scheduled
    const isScheduled = yield* scheduler.isScheduled(workflowName);
    if (isScheduled) {
      yield* terminal.info(`Workflow '${workflowName}' is already scheduled. Updating...`);
    }

    // Determine which agent to use for scheduled runs
    let agentId: string;
    let agentName: string;
    const workflowAgentId = workflow.metadata.agent || "default";

    // Try to verify the agent exists
    const agentResult = yield* getAgentByIdentifier(workflowAgentId).pipe(Effect.either);

    if (agentResult._tag === "Right") {
      agentId = workflowAgentId;
      agentName = agentResult.right.name;
      yield* terminal.info(`Using agent: ${agentName}`);
    } else {
      // Agent not found or not specified - prompt user to select one
      const allAgents = yield* listAllAgents();

      if (allAgents.length === 0) {
        yield* terminal.error("No agents available.");
        yield* terminal.info("Create an agent first with: jazz agent create");
        return yield* Effect.fail(
          new Error("No agents available. Create an agent first with: jazz agent create"),
        );
      }

      if (workflowAgentId !== "default") {
        yield* terminal.warn(`Agent '${workflowAgentId}' specified in workflow not found.`);
      } else {
        yield* terminal.info("No agent specified in workflow. Please select an agent:");
      }
      yield* terminal.log("");

      // Prompt user to select an agent
      const selectedAgent = yield* selectAgentForWorkflow(
        allAgents,
        "Select an agent to run this scheduled workflow:",
      );
      if (!selectedAgent) {
        yield* terminal.info("Scheduling cancelled.");
        return;
      }

      agentId = selectedAgent.id;
      agentName = selectedAgent.name;
      yield* terminal.info(`Using agent: ${agentName}`);
    }

    yield* terminal.log("");

    // On macOS, ask if the workflow should also run on login/wake to catch missed runs
    let runAtLoad = false;
    if (schedulerType === "launchd") {
      runAtLoad = yield* terminal.confirm(
        "Run on login? (catches missed runs when your Mac was asleep)",
        false,
      );
      yield* terminal.log("");
    }

    // Schedule the workflow with the selected agent
    yield* scheduler.schedule(workflow.metadata, agentId, { runAtLoad });

    yield* terminal.success(`Workflow '${workflowName}' scheduled successfully!`);
    yield* terminal.log("");
    yield* terminal.log(`  Schedule: ${workflow.metadata.schedule}`);
    yield* terminal.log(`  Agent: ${agentName}`);
    yield* terminal.log(`  Scheduler: ${schedulerType}`);
    if (runAtLoad) {
      yield* terminal.log(`  Run on login: yes`);
    }
    yield* terminal.log("");

    if (workflow.metadata.autoApprove) {
      yield* terminal.info(`Auto-approve policy: ${workflow.metadata.autoApprove}`);
    } else {
      yield* terminal.warn(
        "No auto-approve policy set. The workflow may pause for approval during scheduled runs.",
      );
      yield* terminal.info("Add 'autoApprove: true' or 'autoApprove: low-risk' to the workflow.");
    }

    yield* terminal.log("");
    yield* terminal.info("Logs will be written to: ~/.jazz/logs/");
    yield* terminal.info(`To unschedule: jazz workflow unschedule ${workflowName}`);
  });
}

/**
 * Remove a workflow from the schedule.
 */
export function unscheduleWorkflowCommand(workflowName: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const scheduler = yield* SchedulerServiceTag;

    yield* terminal.heading(`🛑 Unscheduling workflow: ${workflowName}`);
    yield* terminal.log("");

    const schedulerType = scheduler.getSchedulerType();
    if (schedulerType === "unsupported") {
      yield* terminal.error("Scheduling is not supported on this platform.");
      return;
    }

    // Check if scheduled
    const isScheduled = yield* scheduler.isScheduled(workflowName);
    if (!isScheduled) {
      yield* terminal.info(`Workflow '${workflowName}' is not currently scheduled.`);
      return;
    }

    // Unschedule the workflow
    yield* scheduler.unschedule(workflowName);

    yield* terminal.success(`Workflow '${workflowName}' unscheduled successfully.`);
  });
}

/**
 * List workflows that need catch-up, let user select which to run, then run them.
 */
export function catchupWorkflowCommand() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    yield* terminal.heading("🔄 Workflow catch-up");
    yield* terminal.log("");
    yield* terminal.info(
      "Scheduled runs only fire when the machine is awake. If your Mac was asleep or off at the scheduled time, those runs were missed. Here you can run them now.",
    );
    yield* terminal.log("");

    const candidates = yield* getCatchUpCandidates().pipe(
      Effect.catchAll(() => Effect.succeed([] as readonly CatchUpCandidate[])),
    );

    if (candidates.length === 0) {
      yield* terminal.info("No workflows need catch-up right now.");
      yield* terminal.log("");
      yield* terminal.info(
        "Workflows must be scheduled, have catchUpOnStartup: true, and have missed their last run within the max catch-up window.",
      );
      return;
    }

    yield* terminal.log("Workflows that missed a scheduled run:");
    yield* terminal.log("");

    for (const c of candidates) {
      const scheduledStr = c.decision.scheduledAt?.toISOString() ?? "—";
      const scheduleLabel = describeCronSchedule(c.entry.schedule) ?? c.entry.schedule;
      yield* terminal.log(
        `  • ${c.entry.workflowName} (${scheduleLabel}) — missed at ${scheduledStr}`,
      );
    }

    yield* terminal.log("");

    const choices = candidates.map((c) => ({
      name: `${c.entry.workflowName} (${c.decision.scheduledAt?.toISOString() ?? "—"})`,
      value: c.entry.workflowName,
    }));

    const selected = yield* terminal.checkbox<string>(
      "Select workflows to run now (Space to toggle, Enter to confirm):",
      { choices, default: [] },
    );

    if (selected.length === 0) {
      yield* terminal.info("No workflows selected. Exiting.");
      return;
    }

    const entriesToRun = candidates
      .filter((c) => selected.includes(c.entry.workflowName))
      .map((c) => c.entry);

    yield* terminal.log("");
    yield* terminal.info(`Running catch-up for ${entriesToRun.length} workflow(s)...`);
    yield* terminal.log("");

    yield* runCatchUpForWorkflows(entriesToRun);

    yield* terminal.log("");
    yield* terminal.success("Catch-up finished.");
  });
}

/**
 * List all scheduled workflows.
 */
export function listScheduledWorkflowsCommand() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const scheduler = yield* SchedulerServiceTag;

    yield* terminal.heading("⏰ Scheduled Workflows");
    yield* terminal.log("");

    const schedulerType = scheduler.getSchedulerType();
    if (schedulerType === "unsupported") {
      yield* terminal.error("Scheduling is not supported on this platform.");
      yield* terminal.info("Supported platforms: macOS (launchd), Linux (cron)");
      return;
    }

    yield* terminal.info(`Scheduler: ${schedulerType}`);
    yield* terminal.log("");

    const scheduled = yield* scheduler.listScheduled();

    if (scheduled.length === 0) {
      yield* terminal.info("No workflows are currently scheduled.");
      yield* terminal.log("");
      yield* terminal.info("To schedule a workflow: jazz workflow schedule <name>");
      return;
    }

    for (const s of scheduled) {
      const status = s.enabled ? "✓ enabled" : "✗ disabled";
      const scheduleLabel = describeCronSchedule(s.schedule) ?? s.schedule;
      yield* terminal.log(`  ${s.workflowName} (${scheduleLabel}) agent: ${s.agent} ${status}`);
    }

    yield* terminal.log("");
    yield* terminal.info(`Total: ${scheduled.length} scheduled workflow(s)`);
  });
}

/**
 * Show workflow run history.
 */
export function workflowHistoryCommand(workflowName?: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    if (workflowName) {
      yield* terminal.heading(`📜 Run History: ${workflowName}`);
    } else {
      yield* terminal.heading("📜 Recent Workflow Runs");
    }
    yield* terminal.log("");

    const runs = yield* getRecentRuns(20);

    // Filter by workflow name if provided
    const filteredRuns = workflowName ? runs.filter((r) => r.workflowName === workflowName) : runs;

    if (filteredRuns.length === 0) {
      yield* terminal.info("No run history found.");
      yield* terminal.log(`   History file: ${getRunHistoryFilePath()}`);
      return;
    }

    for (const run of filteredRuns) {
      const statusIcon = run.status === "completed" ? "✓" : run.status === "failed" ? "✗" : "…";

      const duration = run.completedAt
        ? `${Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
        : "in progress";

      const trigger = run.triggeredBy === "scheduled" ? " (scheduled)" : "";

      yield* terminal.log(
        `  ${statusIcon} ${run.workflowName}${trigger} - ${run.status} (${duration})`,
      );
      yield* terminal.log(`    Started: ${run.startedAt}`);
      if (run.error) {
        yield* terminal.log(`    Error: ${run.error}`);
      }
      yield* terminal.log("");
    }

    yield* terminal.info(`Showing ${filteredRuns.length} most recent run(s)`);
  });
}

/**
 * Helper to prompt user to select an agent for workflow execution.
 */
function selectAgentForWorkflow(
  agents: readonly Agent[],
  prompt: string,
): Effect.Effect<Agent | null, never> {
  return Effect.async<Agent | null, never>((resume) => {
    const items = [
      ...agents.map((agent) => ({
        label: `${agent.name} (${agent.config.llmModel})`,
        value: agent.id,
      })),
      { label: "Cancel", value: "__cancel__" },
    ];

    store.setCustomView(
      React.createElement(
        Box,
        { flexDirection: "column", padding: 1 },
        React.createElement(Text, { bold: true, color: THEME.primary }, prompt),
        React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(SelectInput, {
            items,
            onSelect: (item) => {
              store.setCustomView(null);
              const value = item.value as string;
              if (value === "__cancel__") {
                resume(Effect.succeed(null));
              } else {
                const selected = agents.find((a) => a.id === value) || null;
                resume(Effect.succeed(selected));
              }
            },
          }),
        ),
      ),
    );
  });
}
