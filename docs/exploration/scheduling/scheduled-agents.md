# Scheduled Agents - Cron-Based Automation

## Overview

Scheduled Agents bring true automation to Jazz by enabling agents to run automatically on time-based
triggers. Think of it as "cron for AI agents" - your personal army of assistants working for you
24/7, even when you're not at your computer.

## The Vision

```bash
# Set up an agent to run every day at 10am
$ jazz schedule create daily-email-digest \
  --agent email-triage \
  --cron "0 10 * * *" \
  --prompt "Summarize emails I received in the last 24 hours and highlight urgent ones"

✅ Scheduled: daily-email-digest will run every day at 10:00 AM

# Every Monday at 9am, generate a weekly report
$ jazz schedule create weekly-report \
  --agent data-analyst \
  --cron "0 9 * * MON" \
  --prompt "Generate weekly metrics report and send to team"

# Every hour, check system health
$ jazz schedule create health-check \
  --agent monitoring-agent \
  --cron "0 * * * *" \
  --prompt "Check all services are healthy, alert if any issues"
```

## Architecture

### Core Components

```typescript
import { Effect, Schedule, Cron, Ref, Queue } from "effect";
import type { Agent } from "../agent/types";

/**
 * Scheduled agent configuration
 */
export interface ScheduledAgent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly agentId: string;
  readonly schedule: ScheduleConfig;
  readonly prompt: string | PromptTemplate;
  readonly enabled: boolean;
  readonly notifications?: NotificationConfig;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastRun?: Date;
  readonly nextRun?: Date;
}

/**
 * Schedule configuration supporting multiple formats
 */
export type ScheduleConfig = CronSchedule | IntervalSchedule | TimeOfDaySchedule | CustomSchedule;

export interface CronSchedule {
  readonly type: "cron";
  readonly expression: string; // Standard cron syntax
  readonly timezone?: string; // Default: system timezone
}

export interface IntervalSchedule {
  readonly type: "interval";
  readonly every: number;
  readonly unit: "minutes" | "hours" | "days" | "weeks";
}

export interface TimeOfDaySchedule {
  readonly type: "time_of_day";
  readonly time: string; // "HH:mm" format
  readonly days?: readonly DayOfWeek[]; // If not specified, every day
  readonly timezone?: string;
}

export interface CustomSchedule {
  readonly type: "custom";
  readonly schedule: Schedule.Schedule<unknown, unknown, unknown>; // Effect Schedule
}

export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/**
 * Dynamic prompt template with variables
 */
export interface PromptTemplate {
  readonly template: string;
  readonly variables?: Record<string, PromptVariable>;
}

export interface PromptVariable {
  readonly type: "static" | "dynamic" | "function";
  readonly value?: string;
  readonly resolver?: () => Effect.Effect<string, Error>;
}

/**
 * Notification configuration
 */
export interface NotificationConfig {
  readonly onSuccess?: readonly NotificationChannel[];
  readonly onFailure?: readonly NotificationChannel[];
  readonly includeOutput?: boolean;
  readonly includeLogs?: boolean;
}

export type NotificationChannel =
  | { type: "email"; address: string }
  | { type: "slack"; webhook: string }
  | { type: "discord"; webhook: string }
  | { type: "stdout" } // Print to console
  | { type: "file"; path: string };

/**
 * Execution record
 */
export interface ScheduledExecution {
  readonly id: string;
  readonly scheduledAgentId: string;
  readonly scheduledFor: Date;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly status: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly result?: string;
  readonly error?: string;
  readonly duration?: number;
  readonly iterations?: number;
  readonly toolCalls?: number;
}

/**
 * Schedule statistics
 */
export interface ScheduleStats {
  readonly scheduledAgentId: string;
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly averageDuration: number;
  readonly lastSuccess?: Date;
  readonly lastFailure?: Date;
}
```

## Scheduler Service

```typescript
import { Context, Effect, Ref, Fiber, Schedule as EffectSchedule } from "effect";
import { AgentRunner } from "../agent/agent-runner";
import { getAgentById } from "../agent-service";

export interface SchedulerService {
  /**
   * Create a new scheduled agent
   */
  readonly createSchedule: (
    config: Omit<ScheduledAgent, "id" | "createdAt" | "updatedAt">,
  ) => Effect.Effect<ScheduledAgent, Error>;

  /**
   * Update an existing scheduled agent
   */
  readonly updateSchedule: (
    id: string,
    updates: Partial<ScheduledAgent>,
  ) => Effect.Effect<ScheduledAgent, Error>;

  /**
   * Delete a scheduled agent
   */
  readonly deleteSchedule: (id: string) => Effect.Effect<void, Error>;

  /**
   * Enable/disable a scheduled agent
   */
  readonly toggleSchedule: (id: string, enabled: boolean) => Effect.Effect<void, Error>;

  /**
   * List all scheduled agents
   */
  readonly listSchedules: () => Effect.Effect<readonly ScheduledAgent[], never>;

  /**
   * Get schedule by ID
   */
  readonly getSchedule: (id: string) => Effect.Effect<ScheduledAgent, Error>;

  /**
   * Get execution history for a schedule
   */
  readonly getExecutionHistory: (
    scheduledAgentId: string,
    limit?: number,
  ) => Effect.Effect<readonly ScheduledExecution[], Error>;

  /**
   * Get statistics for a schedule
   */
  readonly getStats: (scheduledAgentId: string) => Effect.Effect<ScheduleStats, Error>;

  /**
   * Start the scheduler (begin executing scheduled agents)
   */
  readonly start: () => Effect.Effect<void, Error>;

  /**
   * Stop the scheduler
   */
  readonly stop: () => Effect.Effect<void, never>;

  /**
   * Run a scheduled agent immediately (manual trigger)
   */
  readonly runNow: (id: string) => Effect.Effect<ScheduledExecution, Error>;
}

export const SchedulerServiceTag = Context.GenericTag<SchedulerService>("SchedulerService");

export class DefaultSchedulerService implements SchedulerService {
  constructor(
    private readonly schedules: Ref.Ref<Map<string, ScheduledAgent>>,
    private readonly executions: Ref.Ref<Map<string, ScheduledExecution[]>>,
    private readonly runningFibers: Ref.Ref<Map<string, Fiber.RuntimeFiber<void, Error>>>,
  ) {}

  static create(): Effect.Effect<DefaultSchedulerService, never> {
    return Effect.gen(function* () {
      const schedules = yield* Ref.make(new Map<string, ScheduledAgent>());
      const executions = yield* Ref.make(new Map<string, ScheduledExecution[]>());
      const runningFibers = yield* Ref.make(new Map<string, Fiber.RuntimeFiber<void, Error>>());
      return new DefaultSchedulerService(schedules, executions, runningFibers);
    });
  }

  createSchedule(
    config: Omit<ScheduledAgent, "id" | "createdAt" | "updatedAt">,
  ): Effect.Effect<ScheduledAgent, Error, StorageService | LoggerService> {
    return Effect.gen(
      function* (this: DefaultSchedulerService) {
        const logger = yield* LoggerServiceTag;
        const storage = yield* StorageServiceTag;

        const id = uuid();
        const now = new Date();

        const scheduledAgent: ScheduledAgent = {
          ...config,
          id,
          createdAt: now,
          updatedAt: now,
          nextRun: calculateNextRun(config.schedule),
        };

        yield* logger.info("Creating scheduled agent", {
          id,
          name: scheduledAgent.name,
          schedule: scheduledAgent.schedule,
        });

        // Store in memory
        yield* Ref.update(this.schedules, (schedules) =>
          new Map(schedules).set(id, scheduledAgent),
        );

        // Persist to storage
        yield* storage.saveScheduledAgent(scheduledAgent);

        // Start the schedule if enabled
        if (scheduledAgent.enabled) {
          yield* this.startSchedule(scheduledAgent);
        }

        return scheduledAgent;
      }.bind(this),
    );
  }

  start(): Effect.Effect<void, Error, AgentService | LLMService | ToolRegistry | LoggerService> {
    return Effect.gen(
      function* (this: DefaultSchedulerService) {
        const logger = yield* LoggerServiceTag;
        const schedules = yield* Ref.get(this.schedules);

        yield* logger.info("Starting scheduler", {
          totalSchedules: schedules.size,
          enabledSchedules: Array.from(schedules.values()).filter((s) => s.enabled).length,
        });

        // Start all enabled schedules
        for (const schedule of schedules.values()) {
          if (schedule.enabled) {
            yield* this.startSchedule(schedule);
          }
        }

        yield* logger.info("Scheduler started successfully");
      }.bind(this),
    );
  }

  private startSchedule(
    scheduledAgent: ScheduledAgent,
  ): Effect.Effect<void, Error, AgentService | LLMService | ToolRegistry | LoggerService> {
    return Effect.gen(
      function* (this: DefaultSchedulerService) {
        const logger = yield* LoggerServiceTag;

        yield* logger.debug("Starting schedule", {
          id: scheduledAgent.id,
          name: scheduledAgent.name,
        });

        // Create the execution loop
        const executionLoop = Effect.gen(
          function* (this: DefaultSchedulerService) {
            while (true) {
              // Wait until next scheduled time
              const delay = calculateDelayUntilNext(scheduledAgent.schedule);
              yield* Effect.sleep(delay);

              // Execute the agent
              yield* this.executeScheduledAgent(scheduledAgent);
            }
          }.bind(this),
        );

        // Fork the execution loop
        const fiber = yield* Effect.fork(executionLoop);

        // Store the fiber so we can cancel it later
        yield* Ref.update(this.runningFibers, (fibers) =>
          new Map(fibers).set(scheduledAgent.id, fiber),
        );
      }.bind(this),
    );
  }

  private executeScheduledAgent(
    scheduledAgent: ScheduledAgent,
  ): Effect.Effect<void, Error, AgentService | LLMService | ToolRegistry | LoggerService> {
    return Effect.gen(
      function* (this: DefaultSchedulerService) {
        const logger = yield* LoggerServiceTag;
        const executionId = uuid();
        const now = new Date();

        yield* logger.info("Executing scheduled agent", {
          scheduledAgentId: scheduledAgent.id,
          executionId,
          name: scheduledAgent.name,
        });

        // Create execution record
        const execution: ScheduledExecution = {
          id: executionId,
          scheduledAgentId: scheduledAgent.id,
          scheduledFor: now,
          startedAt: now,
          status: "running",
        };

        // Store execution record
        yield* Ref.update(this.executions, (executions) => {
          const agentExecutions = executions.get(scheduledAgent.id) || [];
          return new Map(executions).set(scheduledAgent.id, [execution, ...agentExecutions]);
        });

        try {
          // Get the agent
          const agent = yield* getAgentById(scheduledAgent.agentId);

          // Resolve the prompt (handle templates)
          const prompt = yield* resolvePrompt(scheduledAgent.prompt);

          // Run the agent
          const response = yield* AgentRunner.run({
            agent,
            userInput: prompt,
            conversationId: `scheduled-${executionId}`,
          });

          const completedAt = new Date();
          const duration = completedAt.getTime() - now.getTime();

          // Update execution record
          const completedExecution: ScheduledExecution = {
            ...execution,
            completedAt,
            status: "completed",
            result: response.response,
            duration,
            iterations: response.iterations,
            toolCalls: response.toolCalls,
          };

          yield* Ref.update(this.executions, (executions) => {
            const agentExecutions = executions.get(scheduledAgent.id) || [];
            return new Map(executions).set(scheduledAgent.id, [
              completedExecution,
              ...agentExecutions.slice(1),
            ]);
          });

          yield* logger.info("Scheduled agent execution completed", {
            executionId,
            duration,
            iterations: response.iterations,
          });

          // Send success notifications
          if (scheduledAgent.notifications?.onSuccess) {
            yield* sendNotifications(
              scheduledAgent.notifications.onSuccess,
              scheduledAgent.name,
              response.response,
              "success",
            );
          }

          // Update lastRun and nextRun
          yield* this.updateScheduleTiming(scheduledAgent);
        } catch (error) {
          const completedAt = new Date();
          const duration = completedAt.getTime() - now.getTime();
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Update execution record with failure
          const failedExecution: ScheduledExecution = {
            ...execution,
            completedAt,
            status: "failed",
            error: errorMessage,
            duration,
          };

          yield* Ref.update(this.executions, (executions) => {
            const agentExecutions = executions.get(scheduledAgent.id) || [];
            return new Map(executions).set(scheduledAgent.id, [
              failedExecution,
              ...agentExecutions.slice(1),
            ]);
          });

          yield* logger.error("Scheduled agent execution failed", {
            executionId,
            error: errorMessage,
          });

          // Send failure notifications
          if (scheduledAgent.notifications?.onFailure) {
            yield* sendNotifications(
              scheduledAgent.notifications.onFailure,
              scheduledAgent.name,
              errorMessage,
              "failure",
            );
          }
        }
      }.bind(this),
    );
  }

  runNow(
    id: string,
  ): Effect.Effect<
    ScheduledExecution,
    Error,
    AgentService | LLMService | ToolRegistry | LoggerService
  > {
    return Effect.gen(
      function* (this: DefaultSchedulerService) {
        const schedules = yield* Ref.get(this.schedules);
        const scheduledAgent = schedules.get(id);

        if (!scheduledAgent) {
          return yield* Effect.fail(new Error(`Scheduled agent not found: ${id}`));
        }

        yield* this.executeScheduledAgent(scheduledAgent);

        const executions = yield* Ref.get(this.executions);
        const agentExecutions = executions.get(id) || [];
        return agentExecutions[0];
      }.bind(this),
    );
  }

  stop(): Effect.Effect<void, never> {
    return Effect.gen(
      function* (this: DefaultSchedulerService) {
        const fibers = yield* Ref.get(this.runningFibers);

        // Interrupt all running fibers
        for (const fiber of fibers.values()) {
          yield* Fiber.interrupt(fiber);
        }

        // Clear the fibers map
        yield* Ref.set(this.runningFibers, new Map());
      }.bind(this),
    );
  }

  // ... other methods (listSchedules, getSchedule, etc.)
}

/**
 * Calculate next run time based on schedule config
 */
function calculateNextRun(config: ScheduleConfig): Date {
  const now = new Date();

  switch (config.type) {
    case "cron": {
      // Parse cron expression and calculate next occurrence
      return parseCronNext(config.expression, config.timezone);
    }
    case "interval": {
      const ms = convertToMilliseconds(config.every, config.unit);
      return new Date(now.getTime() + ms);
    }
    case "time_of_day": {
      const [hours, minutes] = config.time.split(":").map(Number);
      const next = new Date(now);
      next.setHours(hours, minutes, 0, 0);

      // If time has passed today, schedule for tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      // If specific days are specified, find next matching day
      if (config.days && config.days.length > 0) {
        while (!config.days.includes(getDayOfWeek(next))) {
          next.setDate(next.getDate() + 1);
        }
      }

      return next;
    }
    case "custom": {
      // For custom Effect schedules, we can't pre-calculate
      return now;
    }
  }
}

/**
 * Resolve prompt template with variables
 */
function resolvePrompt(prompt: string | PromptTemplate): Effect.Effect<string, Error> {
  if (typeof prompt === "string") {
    return Effect.succeed(prompt);
  }

  return Effect.gen(function* () {
    let resolved = prompt.template;

    if (prompt.variables) {
      for (const [key, variable] of Object.entries(prompt.variables)) {
        let value: string;

        switch (variable.type) {
          case "static":
            value = variable.value || "";
            break;
          case "dynamic":
            // Dynamic variables can be date, time, etc.
            value = resolveDynamicVariable(key);
            break;
          case "function":
            if (variable.resolver) {
              value = yield* variable.resolver();
            } else {
              value = "";
            }
            break;
        }

        resolved = resolved.replace(`{{${key}}}`, value);
      }
    }

    return resolved;
  });
}

function resolveDynamicVariable(key: string): string {
  const now = new Date();

  switch (key) {
    case "date":
      return now.toISOString().split("T")[0];
    case "time":
      return now.toTimeString().split(" ")[0];
    case "datetime":
      return now.toISOString();
    case "timestamp":
      return now.getTime().toString();
    case "day_of_week":
      return getDayOfWeek(now);
    default:
      return "";
  }
}

/**
 * Send notifications through various channels
 */
function sendNotifications(
  channels: readonly NotificationChannel[],
  agentName: string,
  content: string,
  type: "success" | "failure",
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    for (const channel of channels) {
      switch (channel.type) {
        case "stdout":
          console.log(`[${type.toUpperCase()}] ${agentName}: ${content}`);
          break;
        case "email":
          // Send email notification
          yield* sendEmailNotification(channel.address, agentName, content, type);
          break;
        case "slack":
          // Send Slack notification
          yield* sendSlackNotification(channel.webhook, agentName, content, type);
          break;
        // ... other channels
      }
    }
  });
}
```

## CLI Commands

```typescript
// src/cli/commands/schedule.ts

/**
 * jazz schedule create <name>
 */
export function createScheduleCommand(): Effect.Effect<void, Error, SchedulerService> {
  return Effect.gen(function* () {
    const answers = yield* Effect.promise(() =>
      inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "Schedule name:",
          validate: (input) => input.length > 0,
        },
        {
          type: "list",
          name: "agent",
          message: "Select agent:",
          choices: yield* listAgentNames(),
        },
        {
          type: "list",
          name: "scheduleType",
          message: "Schedule type:",
          choices: ["Cron Expression", "Interval", "Time of Day"],
        },
        // ... schedule-specific questions
        {
          type: "editor",
          name: "prompt",
          message: "Enter the prompt for the agent:",
        },
      ]),
    );

    const scheduler = yield* SchedulerServiceTag;

    const schedule = yield* scheduler.createSchedule({
      name: answers.name,
      agentId: answers.agent,
      schedule: buildScheduleConfig(answers),
      prompt: answers.prompt,
      enabled: true,
    });

    console.log(`\n✅ Created scheduled agent: ${schedule.name}`);
    console.log(`   Next run: ${schedule.nextRun?.toLocaleString()}`);
  });
}

/**
 * jazz schedule list
 */
export function listSchedulesCommand(): Effect.Effect<void, Error, SchedulerService> {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const schedules = yield* scheduler.listSchedules();

    if (schedules.length === 0) {
      console.log("No scheduled agents found.");
      return;
    }

    console.log("\n📅 Scheduled Agents:\n");

    for (const schedule of schedules) {
      const status = schedule.enabled ? "✅ Enabled" : "❌ Disabled";
      const nextRun = schedule.nextRun ? schedule.nextRun.toLocaleString() : "N/A";

      console.log(`${status} ${schedule.name}`);
      console.log(`   Agent: ${schedule.agentId}`);
      console.log(`   Schedule: ${formatSchedule(schedule.schedule)}`);
      console.log(`   Next run: ${nextRun}`);
      console.log();
    }
  });
}

/**
 * jazz schedule run <name>
 */
export function runScheduleNowCommand(name: string): Effect.Effect<void, Error, SchedulerService> {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const schedules = yield* scheduler.listSchedules();
    const schedule = schedules.find((s) => s.name === name);

    if (!schedule) {
      console.log(`Schedule not found: ${name}`);
      return;
    }

    console.log(`⚡ Running ${schedule.name} now...`);

    const execution = yield* scheduler.runNow(schedule.id);

    if (execution.status === "completed") {
      console.log(`\n✅ Execution completed in ${execution.duration}ms`);
      console.log(`\nResult:\n${execution.result}`);
    } else {
      console.log(`\n❌ Execution failed: ${execution.error}`);
    }
  });
}

/**
 * jazz schedule enable/disable <name>
 */
export function toggleScheduleCommand(
  name: string,
  enabled: boolean,
): Effect.Effect<void, Error, SchedulerService> {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const schedules = yield* scheduler.listSchedules();
    const schedule = schedules.find((s) => s.name === name);

    if (!schedule) {
      console.log(`Schedule not found: ${name}`);
      return;
    }

    yield* scheduler.toggleSchedule(schedule.id, enabled);

    const status = enabled ? "enabled" : "disabled";
    console.log(`✅ Schedule ${schedule.name} ${status}`);
  });
}

/**
 * jazz schedule logs <name>
 */
export function viewScheduleLogsCommand(
  name: string,
  limit = 10,
): Effect.Effect<void, Error, SchedulerService> {
  return Effect.gen(function* () {
    const scheduler = yield* SchedulerServiceTag;
    const schedules = yield* scheduler.listSchedules();
    const schedule = schedules.find((s) => s.name === name);

    if (!schedule) {
      console.log(`Schedule not found: ${name}`);
      return;
    }

    const executions = yield* scheduler.getExecutionHistory(schedule.id, limit);

    console.log(`\n📜 Execution History for ${schedule.name}:\n`);

    for (const execution of executions) {
      const status =
        execution.status === "completed" ? "✅" : execution.status === "failed" ? "❌" : "⏳";

      console.log(`${status} ${execution.startedAt.toLocaleString()}`);
      console.log(`   Duration: ${execution.duration}ms`);

      if (execution.status === "completed") {
        console.log(`   Result: ${execution.result?.substring(0, 100)}...`);
      } else if (execution.status === "failed") {
        console.log(`   Error: ${execution.error}`);
      }

      console.log();
    }
  });
}
```

## Real-World Examples

### Example 1: Daily Email Digest

```bash
$ jazz schedule create daily-email-digest \
  --agent email-triage \
  --time "10:00" \
  --prompt "Summarize all emails I received in the last 24 hours. Highlight urgent ones and draft quick replies for simple questions."

# Or with cron syntax
$ jazz schedule create daily-email-digest \
  --agent email-triage \
  --cron "0 10 * * *" \
  --prompt "Summarize all emails I received in the last 24 hours"
```

### Example 2: Weekly Team Report

```bash
$ jazz schedule create weekly-team-report \
  --agent data-analyst \
  --cron "0 9 * * MON" \
  --prompt "Generate a weekly report:
    1. GitHub activity (PRs merged, issues closed)
    2. Deployment statistics
    3. Test coverage trends
    Send the report to #team-updates Slack channel"
```

### Example 3: Continuous System Monitoring

```bash
$ jazz schedule create system-health-check \
  --agent monitoring-agent \
  --interval "15m" \
  --prompt "Check health of all services. If any service is down or has errors, send alert to #alerts and create a PagerDuty incident."
```

### Example 4: Social Media Automation

```bash
$ jazz schedule create morning-tweet \
  --agent social-media-manager \
  --time "08:00" \
  --days "MON,WED,FRI" \
  --prompt "Create an engaging tweet about tech trends or a tip. Make it informative and include relevant hashtags. Post to Twitter."
```

### Example 5: Smart Home Automation

```bash
$ jazz schedule create evening-routine \
  --agent home-assistant \
  --time "18:00" \
  --prompt "Execute evening routine:
    - Check weather for tomorrow
    - Set thermostat to evening mode
    - Turn on lights in living room
    - Play relaxing music
    - Send me a summary of tomorrow's calendar"
```

### Example 6: Financial Tracking

```bash
$ jazz schedule create daily-stock-update \
  --agent financial-analyst \
  --cron "0 16 * * MON-FRI" \
  --prompt "Analyze my portfolio performance today. Highlight any significant changes (>5%). Check if any stocks hit my buy/sell targets."
```

### Example 7: Code Quality Watchdog

```bash
$ jazz schedule create nightly-code-quality \
  --agent code-reviewer \
  --cron "0 2 * * *" \
  --prompt "Run code quality checks:
    1. Check for security vulnerabilities
    2. Analyze test coverage
    3. Check for code smells
    4. Generate improvement suggestions
    Create GitHub issues for critical findings."
```

## Advanced Features

### Dynamic Prompts with Variables

```typescript
// Configuration file or programmatic API
const schedule: ScheduledAgent = {
  name: "dynamic-report",
  agentId: "reporter",
  schedule: { type: "cron", expression: "0 9 * * *" },
  prompt: {
    template: "Generate a report for {{date}}. Include data from the last {{days_back}} days.",
    variables: {
      date: {
        type: "dynamic", // Auto-resolved to current date
      },
      days_back: {
        type: "static",
        value: "7",
      },
    },
  },
  enabled: true,
};
```

### Conditional Execution

```typescript
export interface ConditionalSchedule extends ScheduledAgent {
  readonly condition?: (context: ExecutionContext) => Effect.Effect<boolean, Error>;
}

// Example: Only run on weekdays if markets are open
const marketAnalysis: ConditionalSchedule = {
  name: "market-analysis",
  agentId: "financial-agent",
  schedule: { type: "time_of_day", time: "16:00" },
  prompt: "Analyze market performance today",
  condition: (ctx) =>
    Effect.succeed(
      ctx.date.getDay() >= 1 &&
        ctx.date.getDay() <= 5 && // Monday-Friday
        isMarketOpen(ctx.date),
    ),
  enabled: true,
};
```

### Chained Schedules (Dependencies)

```typescript
export interface ChainedSchedule extends ScheduledAgent {
  readonly dependencies?: readonly string[]; // Other schedule IDs
  readonly waitForCompletion?: boolean;
}

// Example: Run deploy only after tests pass
const deploySchedule: ChainedSchedule = {
  name: "deploy-after-tests",
  agentId: "deploy-agent",
  schedule: { type: "cron", expression: "0 3 * * *" },
  dependencies: ["nightly-tests"],
  waitForCompletion: true,
  prompt: "Deploy to staging if all tests passed",
  enabled: true,
};
```

### Notification Templates

```typescript
const schedule: ScheduledAgent = {
  name: "backup-database",
  agentId: "db-admin",
  schedule: { type: "cron", expression: "0 2 * * *" },
  prompt: "Backup all databases",
  notifications: {
    onSuccess: [
      { type: "email", address: "admin@example.com" },
      {
        type: "slack",
        webhook: process.env.SLACK_WEBHOOK,
      },
    ],
    onFailure: [
      { type: "email", address: "admin@example.com" },
      { type: "slack", webhook: process.env.SLACK_WEBHOOK },
      { type: "stdout" },
    ],
    includeOutput: true,
    includeLogs: true,
  },
  enabled: true,
};
```

## Configuration File Support

```yaml
# jazz-schedules.yaml
schedules:
  - name: daily-email-digest
    agent: email-triage
    schedule:
      cron: "0 10 * * *"
      timezone: "America/New_York"
    prompt: "Summarize emails from last 24 hours"
    enabled: true
    notifications:
      on_success:
        - type: stdout
      on_failure:
        - type: email
          address: user@example.com

  - name: weekly-report
    agent: data-analyst
    schedule:
      cron: "0 9 * * MON"
    prompt: "Generate weekly metrics report"
    enabled: true

  - name: health-check
    agent: monitoring-agent
    schedule:
      interval:
        every: 15
        unit: minutes
    prompt: "Check all services"
    enabled: true
```

Load schedules from file:

```bash
$ jazz schedule import jazz-schedules.yaml
✅ Imported 3 schedules

$ jazz schedule export > my-schedules.yaml
✅ Exported 3 schedules to my-schedules.yaml
```

## Monitoring & Observability

### Dashboard View

```bash
$ jazz schedule dashboard

╔═══════════════════════════════════════════════════════════╗
║              Jazz Scheduled Agents Dashboard              ║
╚═══════════════════════════════════════════════════════════╝

📊 Overview
  Total Schedules: 5
  Enabled: 4
  Disabled: 1

🏃 Currently Running: 1
  • system-health-check (started 2m ago)

⏰ Upcoming Executions (next 24h)
  10:00 AM  daily-email-digest
  02:00 AM  nightly-backup
  04:00 PM  stock-update

📈 Statistics (Last 7 Days)
  Total Executions: 142
  Successful: 138 (97%)
  Failed: 4 (3%)
  Avg Duration: 23.4s

❌ Recent Failures
  stock-update (2 days ago) - API rate limit exceeded
  nightly-backup (5 days ago) - Disk space low

Press 'r' to refresh, 'q' to quit
```

### Logs and Debugging

```bash
# View detailed logs for a schedule
$ jazz schedule logs daily-email-digest --follow

[2024-01-15 10:00:00] Starting execution: daily-email-digest
[2024-01-15 10:00:01] Agent: email-triage
[2024-01-15 10:00:02] Tool call: gmail_list_emails
[2024-01-15 10:00:05] Found 23 emails
[2024-01-15 10:00:06] Tool call: llm_summarize
[2024-01-15 10:00:12] Generated summary
[2024-01-15 10:00:12] ✅ Completed in 12s

Result:
You received 23 emails today. Key highlights:
• 3 urgent: Client requests requiring immediate attention
• 8 newsletters: Tech updates and industry news
• 12 regular: Team updates and discussions
```

## Integration with Event-Driven Pattern

Scheduled agents can publish events:

```typescript
// When a scheduled agent completes
eventBus.publish({
  type: "scheduled_agent.completed",
  scheduledAgentId: schedule.id,
  result: execution.result,
});

// Other agents can subscribe
eventBus.subscribe({ types: ["scheduled_agent.completed"] }, (event) =>
  Effect.gen(function* () {
    if (event.scheduledAgentId === "daily-email-digest") {
      // Trigger follow-up action
      yield* triggerFollowUpAgent(event.result);
    }
  }),
);
```

## Implementation Roadmap

### Phase 1: Core Scheduler (MVP)

- [ ] Basic schedule types (cron, interval, time_of_day)
- [ ] Schedule CRUD operations
- [ ] Execution engine
- [ ] CLI commands (create, list, run, enable/disable)
- [ ] Execution history storage

### Phase 2: Robustness

- [ ] Persistent schedule storage
- [ ] Graceful shutdown/restart
- [ ] Error recovery and retries
- [ ] Execution logs and debugging
- [ ] Notification system (stdout, email)

### Phase 3: Advanced Features

- [ ] Dynamic prompts with variables
- [ ] Conditional execution
- [ ] Schedule dependencies
- [ ] Configuration file import/export
- [ ] Dashboard and monitoring

### Phase 4: Integrations

- [ ] Event bus integration
- [ ] Workflow orchestration integration
- [ ] Multiple notification channels (Slack, Discord, etc.)
- [ ] Cloud storage for logs
- [ ] Distributed scheduling (multi-instance)

### Phase 5: Enterprise Features

- [ ] Schedule versioning
- [ ] Audit logs
- [ ] Role-based access control
- [ ] Schedule templates marketplace
- [ ] Analytics and insights

## Summary

Scheduled Agents transform Jazz from an interactive tool into a **true automation platform**. Key
benefits:

1. **Set and Forget**: Configure once, runs forever
2. **No Manual Intervention**: Agents work while you sleep
3. **Consistent Execution**: Never miss a task
4. **Observable**: Full logs and notifications
5. **Flexible**: Multiple schedule types and configurations

This is where Jazz becomes your **personal AI workforce** - agents that genuinely automate your
life.

Would you like me to implement this feature in Jazz? This would be an incredibly powerful addition!
🚀
