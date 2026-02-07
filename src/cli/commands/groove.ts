import { Effect } from "effect";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import React from "react";
import { store } from "@/cli/ui/App";
import { AgentRunner } from "@/core/agent/agent-runner";
import { getAgentByIdentifier, listAllAgents } from "@/core/agent/agent-service";
import {
  type CatchUpCandidate,
  getCatchUpCandidates,
  runCatchUpForGrooves,
} from "@/core/grooves/catch-up";
import {
  GrooveServiceTag,
  type GrooveMetadata,
} from "@/core/grooves/groove-service";
import {
  addRunRecord,
  getRecentRuns,
  getRunHistoryFilePath,
  loadRunHistory,
  updateLatestRunRecord,
} from "@/core/grooves/run-history";
import { SchedulerServiceTag } from "@/core/grooves/scheduler-service";
import { groupGrooves, formatGroove } from "@/core/grooves/utils";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import type { Agent } from "@/core/types/agent";
import { describeCronSchedule } from "@/core/utils/cron-utils";

/**
 * CLI commands for managing and running grooves.
 */

/**
 * List all available grooves.
 */
export function listGroovesCommand() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const grooveService = yield* GrooveServiceTag;
    const scheduler = yield* SchedulerServiceTag;

    yield* terminal.heading("📋 Available Grooves");
    yield* terminal.log("");

    const grooves = yield* grooveService.listGrooves();

    if (grooves.length === 0) {
      yield* terminal.info("No grooves found.");
      yield* terminal.log("");
      yield* terminal.info("Create a groove by adding a GROOVE.md file to:");
      yield* terminal.log("  • ./grooves/<name>/GROOVE.md (local)");
      yield* terminal.log("  • ~/.jazz/grooves/<name>/GROOVE.md (global)");
      return;
    }

    // Resolve scheduled and running status (best-effort; ignore scheduler errors on unsupported platforms)
    const scheduledNames = yield* scheduler.listScheduled().pipe(
      Effect.map((list) => new Set(list.map((s) => s.grooveName))),
      Effect.catchAll(() => Effect.succeed(new Set<string>())),
    );
    const runningNames = yield* loadRunHistory().pipe(
      Effect.map((history) => new Set(history.filter((r) => r.status === "running").map((r) => r.grooveName))),
      Effect.catchAll(() => Effect.succeed(new Set<string>())),
    );

    const { local, global, builtin } = groupGrooves(grooves);

    function statusBadge(g: GrooveMetadata): string {
      if (runningNames.has(g.name)) return " ● running";
      if (scheduledNames.has(g.name)) return " ○ scheduled";
      if (g.schedule) return " — not scheduled";
      return "";
    }

    if (local.length > 0) {
      yield* terminal.log("Local grooves:");
      for (const g of local) {
        yield* terminal.log(formatGroove(g, { statusBadge: statusBadge(g) }));
      }
      yield* terminal.log("");
    }

    if (global.length > 0) {
      yield* terminal.log("Global grooves (~/.jazz/grooves):");
      for (const g of global) {
        yield* terminal.log(formatGroove(g, { statusBadge: statusBadge(g) }));
      }
      yield* terminal.log("");
    }

    if (builtin.length > 0) {
      yield* terminal.log("Built-in grooves:");
      for (const g of builtin) {
        yield* terminal.log(formatGroove(g, { statusBadge: statusBadge(g) }));
      }
      yield* terminal.log("");
    }

    yield* terminal.info(`Total: ${grooves.length} groove(s)`);
  });
}

/**
 * Show details of a specific groove.
 */
export function showGrooveCommand(grooveName: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const grooveService = yield* GrooveServiceTag;

    const groove = yield* grooveService.loadGroove(grooveName).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* terminal.error(`Groove not found: ${grooveName}`);
          yield* terminal.info("Run 'jazz groove list' to see available grooves.");
          return yield* Effect.fail(error);
        }),
      ),
    );

    yield* terminal.heading(`📋 Groove: ${groove.metadata.name}`);
    yield* terminal.log("");
    yield* terminal.log(`Description: ${groove.metadata.description}`);
    yield* terminal.log(`Path: ${groove.metadata.path}`);

    if (groove.metadata.agent) {
      yield* terminal.log(`Agent: ${groove.metadata.agent}`);
    }

    if (groove.metadata.schedule) {
      const desc = describeCronSchedule(groove.metadata.schedule);
      const scheduleDisplay = desc
        ? `${desc} (${groove.metadata.schedule})`
        : groove.metadata.schedule;
      yield* terminal.log(`Schedule: ${scheduleDisplay}`);
    }

    if (groove.metadata.autoApprove !== undefined) {
      yield* terminal.log(`Auto-approve: ${groove.metadata.autoApprove}`);
    }

    if (groove.metadata.skills && groove.metadata.skills.length > 0) {
      yield* terminal.log(`Skills: ${groove.metadata.skills.join(", ")}`);
    }

    if (groove.metadata.catchUpOnStartup !== undefined) {
      yield* terminal.log(`Catch-up on startup: ${groove.metadata.catchUpOnStartup}`);
    }

    if (groove.metadata.maxCatchUpAge !== undefined) {
      yield* terminal.log(`Max catch-up age (seconds): ${groove.metadata.maxCatchUpAge}`);
    }

    yield* terminal.log("");
    yield* terminal.log("─".repeat(60));
    yield* terminal.log("Prompt:");
    yield* terminal.log("─".repeat(60));
    yield* terminal.log(groove.prompt);
  });
}

/** Default max iterations for grooves */
const DEFAULT_MAX_ITERATIONS = 50;

/**
 * Run a groove once (manually).
 */
export function runGrooveCommand(
  grooveName: string,
  options?: {
    autoApprove?: boolean;
    agent?: string;
  },
) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const grooveService = yield* GrooveServiceTag;
    const logger = yield* LoggerServiceTag;

    const isHeadless = options?.autoApprove === true;

    yield* terminal.heading(`🚀 Running groove: ${grooveName}`);
    yield* terminal.log("");

    // Load the groove
    const groove = yield* grooveService.loadGroove(grooveName).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* terminal.error(`Groove not found: ${grooveName}`);
          yield* terminal.info("Run 'jazz groove list' to see available grooves.");
          return yield* Effect.fail(error);
        }),
      ),
    );

    // Determine which agent to use (CLI flag > groove metadata > default)
    const agentIdentifier = options?.agent || groove.metadata.agent || "default";

    // Try to get the specified agent, or prompt user to select one
    let agent: Agent;
    const agentResult = yield* getAgentByIdentifier(agentIdentifier).pipe(
      Effect.either,
    );

    if (agentResult._tag === "Right") {
      agent = agentResult.right;
      yield* terminal.info(`Using agent: ${agent.name}`);
    } else {
      // In headless mode (--auto-approve), fail immediately if agent not found
      if (isHeadless) {
        yield* terminal.error(`Agent '${agentIdentifier}' not found.`);
        yield* terminal.info(
          "Scheduled grooves require a valid agent. Update the groove or create the agent.",
        );
        return yield* Effect.fail(
          new Error(`Agent '${agentIdentifier}' not found for headless groove execution`),
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
      const selectedAgent = yield* selectAgentForGroove(allAgents, "Select an agent to run this groove:");
      if (!selectedAgent) {
        yield* terminal.info("Groove cancelled.");
        return;
      }

      agent = selectedAgent;
      yield* terminal.info(`Using agent: ${agent.name}`);
    }

    // Determine auto-approve policy
    const autoApprovePolicy =
      options?.autoApprove === true
        ? groove.metadata.autoApprove ?? true
        : groove.metadata.autoApprove;

    if (autoApprovePolicy) {
      yield* terminal.info(`Auto-approve policy: ${autoApprovePolicy}`);
    }

    yield* terminal.log("");
    yield* logger.info("Starting groove execution", {
      groove: grooveName,
      agent: agent.name,
      autoApprove: autoApprovePolicy,
    });

    // Record the run start
    const startedAt = new Date().toISOString();
    yield* addRunRecord({
      grooveName,
      startedAt,
      status: "running",
      triggeredBy: isHeadless ? "scheduled" : "manual",
    }).pipe(Effect.catchAll(() => Effect.void)); // Don't fail if history tracking fails

    // Use configurable max iterations from groove metadata
    const maxIterations = groove.metadata.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    // Run the agent with the groove prompt
    yield* AgentRunner.run({
      agent,
      userInput: groove.prompt,
      sessionId: `groove-${grooveName}-${Date.now()}`,
      conversationId: `groove-${grooveName}-${Date.now()}`,
      maxIterations,
      ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
    }).pipe(
      Effect.tap(() =>
        updateLatestRunRecord(grooveName, {
          completedAt: new Date().toISOString(),
          status: "completed",
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
      Effect.tapError((error) =>
        updateLatestRunRecord(grooveName, {
          completedAt: new Date().toISOString(),
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.catchAll(() => Effect.void)),
      ),
    );

    yield* terminal.log("");
    yield* terminal.success(`Groove completed: ${grooveName}`);
  });
}

/**
 * Schedule a groove for periodic execution.
 */
export function scheduleGrooveCommand(grooveName: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const grooveService = yield* GrooveServiceTag;
    const scheduler = yield* SchedulerServiceTag;

    yield* terminal.heading(`⏰ Scheduling groove: ${grooveName}`);
    yield* terminal.log("");

    // Load the groove to verify it exists and has a schedule
    const groove = yield* grooveService.loadGroove(grooveName).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* terminal.error(`Groove not found: ${grooveName}`);
          yield* terminal.info("Run 'jazz groove list' to see available grooves.");
          return yield* Effect.fail(error);
        }),
      ),
    );

    if (!groove.metadata.schedule) {
      yield* terminal.error(`Groove '${grooveName}' has no schedule defined.`);
      yield* terminal.info("Add a 'schedule' field to the groove's GROOVE.md frontmatter.");
      yield* terminal.log("");
      yield* terminal.log("Example:");
      yield* terminal.log("  ---");
      yield* terminal.log('  name: my-groove');
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
    const isScheduled = yield* scheduler.isScheduled(grooveName);
    if (isScheduled) {
      yield* terminal.info(`Groove '${grooveName}' is already scheduled. Updating...`);
    }

    // Determine which agent to use for scheduled runs
    let agentId: string;
    let agentName: string;
    const grooveAgentId = groove.metadata.agent || "default";

    // Try to verify the agent exists
    const agentResult = yield* getAgentByIdentifier(grooveAgentId).pipe(Effect.either);

    if (agentResult._tag === "Right") {
      agentId = grooveAgentId;
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

      if (grooveAgentId !== "default") {
        yield* terminal.warn(`Agent '${grooveAgentId}' specified in groove not found.`);
      } else {
        yield* terminal.info("No agent specified in groove. Please select an agent:");
      }
      yield* terminal.log("");

      // Prompt user to select an agent
      const selectedAgent = yield* selectAgentForGroove(
        allAgents,
        "Select an agent to run this scheduled groove:",
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

    // Schedule the groove with the selected agent
    yield* scheduler.schedule(groove.metadata, agentId);

    yield* terminal.success(`Groove '${grooveName}' scheduled successfully!`);
    yield* terminal.log("");
    yield* terminal.log(`  Schedule: ${groove.metadata.schedule}`);
    yield* terminal.log(`  Agent: ${agentName}`);
    yield* terminal.log(`  Scheduler: ${schedulerType}`);
    yield* terminal.log("");

    if (groove.metadata.autoApprove) {
      yield* terminal.info(`Auto-approve policy: ${groove.metadata.autoApprove}`);
    } else {
      yield* terminal.warn(
        "No auto-approve policy set. The groove may pause for approval during scheduled runs.",
      );
      yield* terminal.info("Add 'autoApprove: true' or 'autoApprove: low-risk' to the groove.");
    }

    yield* terminal.log("");
    yield* terminal.info("Logs will be written to: ~/.jazz/logs/");
    yield* terminal.info(`To unschedule: jazz groove unschedule ${grooveName}`);
  });
}

/**
 * Remove a groove from the schedule.
 */
export function unscheduleGrooveCommand(grooveName: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const scheduler = yield* SchedulerServiceTag;

    yield* terminal.heading(`🛑 Unscheduling groove: ${grooveName}`);
    yield* terminal.log("");

    const schedulerType = scheduler.getSchedulerType();
    if (schedulerType === "unsupported") {
      yield* terminal.error("Scheduling is not supported on this platform.");
      return;
    }

    // Check if scheduled
    const isScheduled = yield* scheduler.isScheduled(grooveName);
    if (!isScheduled) {
      yield* terminal.info(`Groove '${grooveName}' is not currently scheduled.`);
      return;
    }

    // Unschedule the groove
    yield* scheduler.unschedule(grooveName);

    yield* terminal.success(`Groove '${grooveName}' unscheduled successfully.`);
  });
}

/**
 * List grooves that need catch-up, let user select which to run, then run them.
 */
export function catchupGrooveCommand() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    yield* terminal.heading("🔄 Groove catch-up");
    yield* terminal.log("");
    yield* terminal.info(
      "Scheduled runs only fire when the machine is awake. If your Mac was asleep or off at the scheduled time, those runs were missed. Here you can run them now.",
    );
    yield* terminal.log("");

    const candidates = yield* getCatchUpCandidates().pipe(
      Effect.catchAll(() => Effect.succeed([] as readonly CatchUpCandidate[])),
    );

    if (candidates.length === 0) {
      yield* terminal.info("No grooves need catch-up right now.");
      yield* terminal.log("");
      yield* terminal.info(
        "Grooves must be scheduled, have catchUpOnStartup: true, and have missed their last run within the max catch-up window.",
      );
      return;
    }

    yield* terminal.log("Grooves that missed a scheduled run:");
    yield* terminal.log("");

    for (const c of candidates) {
      const scheduledStr = c.decision.scheduledAt?.toISOString() ?? "—";
      const scheduleLabel = describeCronSchedule(c.entry.schedule) ?? c.entry.schedule;
      yield* terminal.log(
        `  • ${c.entry.grooveName} (${scheduleLabel}) — missed at ${scheduledStr}`,
      );
    }

    yield* terminal.log("");

    const choices = candidates.map((c) => ({
      name: `${c.entry.grooveName} (${c.decision.scheduledAt?.toISOString() ?? "—"})`,
      value: c.entry.grooveName,
    }));

    const selected = yield* terminal.checkbox<string>(
      "Select grooves to run now (Space to toggle, Enter to confirm):",
      { choices, default: [] },
    );

    if (selected.length === 0) {
      yield* terminal.info("No grooves selected. Exiting.");
      return;
    }

    const entriesToRun = candidates
      .filter((c) => selected.includes(c.entry.grooveName))
      .map((c) => c.entry);

    yield* terminal.log("");
    yield* terminal.info(`Running catch-up for ${entriesToRun.length} groove(s)...`);
    yield* terminal.log("");

    yield* runCatchUpForGrooves(entriesToRun);

    yield* terminal.log("");
    yield* terminal.success("Catch-up finished.");
  });
}

/**
 * List all scheduled grooves.
 */
export function listScheduledGroovesCommand() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const scheduler = yield* SchedulerServiceTag;

    yield* terminal.heading("⏰ Scheduled Grooves");
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
      yield* terminal.info("No grooves are currently scheduled.");
      yield* terminal.log("");
      yield* terminal.info("To schedule a groove: jazz groove schedule <name>");
      return;
    }

    for (const s of scheduled) {
      const status = s.enabled ? "✓ enabled" : "✗ disabled";
      const scheduleLabel = describeCronSchedule(s.schedule) ?? s.schedule;
      yield* terminal.log(`  ${s.grooveName} (${scheduleLabel}) agent: ${s.agent} ${status}`);
    }

    yield* terminal.log("");
    yield* terminal.info(`Total: ${scheduled.length} scheduled groove(s)`);
  });
}

/**
 * Show groove run history.
 */
export function grooveHistoryCommand(grooveName?: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    if (grooveName) {
      yield* terminal.heading(`📜 Run History: ${grooveName}`);
    } else {
      yield* terminal.heading("📜 Recent Groove Runs");
    }
    yield* terminal.log("");

    const runs = yield* getRecentRuns(20);

    // Filter by groove name if provided
    const filteredRuns = grooveName
      ? runs.filter((r) => r.grooveName === grooveName)
      : runs;

    if (filteredRuns.length === 0) {
      yield* terminal.info("No run history found.");
      yield* terminal.log(`   History file: ${getRunHistoryFilePath()}`);
      return;
    }

    for (const run of filteredRuns) {
      const statusIcon =
        run.status === "completed" ? "✓" : run.status === "failed" ? "✗" : "…";

      const duration = run.completedAt
        ? `${Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
        : "in progress";

      const trigger = run.triggeredBy === "scheduled" ? " (scheduled)" : "";

      yield* terminal.log(
        `  ${statusIcon} ${run.grooveName}${trigger} - ${run.status} (${duration})`,
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
 * Helper to prompt user to select an agent for groove execution.
 */
function selectAgentForGroove(
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
        React.createElement(Text, { bold: true, color: "cyan" }, prompt),
        React.createElement(Box, { marginTop: 1 },
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
