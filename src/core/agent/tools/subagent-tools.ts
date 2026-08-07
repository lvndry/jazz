import chalk from "chalk";
import { Effect } from "effect";
import { z } from "zod";
import { getGlyphs } from "@/cli/ui/glyphs";
import { store } from "@/cli/ui/store";
import { DEFAULT_MAX_ITERATIONS } from "@/core/constants/agent";
import type { ProviderName } from "@/core/constants/models";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types";
import type { ConversationMessages } from "@/core/types/message";
import {
  getMetadataFromMap,
  getModelsDevMap,
  getModelsDevMetadata,
} from "@/core/utils/models-dev-client";
import { parseProviderModel } from "@/core/utils/provider-model";
import { defineTool, makeZodValidator } from "./base-tool";
import { AgentRunner } from "../agent-runner";
import { resolveEffectiveContextWindow } from "../context/effective-context-window";
import { Summarizer, type RecursiveRunner } from "../context/summarizer";

const SUBAGENT_PANEL_LINES = 12;

// ─── Constants ───────────────────────────────────────────────────────

/** Sub-agent execution timeout: 30 minutes */
const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Monotonic counter for unique sub-agent IDs within this process */
let subagentCounter = 0;

// ─── Sub-Agent Tool ──────────────────────────────────────────────────

const spawnSubagentSchema = z.object({
  task: z
    .string()
    .describe("Specific task description for the sub-agent, including expected output."),
  name: z
    .string()
    .optional()
    .describe(
      "Short role label for this sub-agent (e.g. 'Curriculum coach', 'Food-safety instructor'). " +
        "Shown in the sub-agent panel so parallel sub-agents are distinguishable. " +
        "Defaults to 'Sub-Agent (<persona>)' when omitted.",
    ),
  persona: z
    .enum(["default", "coder", "researcher"])
    .optional()
    .describe(
      "'coder' for code/git tasks, 'researcher' for research tasks, 'default' for general (default: 'default'). " +
        "Mutually exclusive with 'agent'.",
    ),
  agent: z
    .string()
    .optional()
    .describe(
      "Exact name of a saved agent to run this task as, taken from the delegatable_agents " +
        "roster in your system prompt. Brings that agent's reasoning effort and persona. " +
        "Mutually exclusive with 'persona'; omit both for a general-purpose sub-agent.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Override the model for this sub-agent as 'provider/model' (e.g. 'anthropic/claude-haiku-4-5'). " +
        "Choose the cheapest model that can actually do this task: mechanical or well-scoped work " +
        "does not need a frontier model, subtle work does. Call list_models for what is available " +
        "with prices. Defaults to the named agent's model, or your own when no agent is named.",
    ),
});

type SpawnSubagentArgs = z.infer<typeof spawnSubagentSchema>;

type ModelOverrideOutcome =
  | { readonly ok: true; readonly model?: `${string}/${string}`; readonly parsed?: ParsedModel }
  | { readonly ok: false; readonly error: string };

interface ParsedModel {
  readonly provider: ProviderName;
  readonly model: string;
}

/**
 * Validate a caller-chosen `provider/model` for a sub-agent run.
 *
 * Three things can go wrong, and each fails loudly rather than quietly running
 * on the inherited model: a malformed or unknown-provider string, a provider
 * with no credentials configured, and a model that cannot do tool calls (a
 * sub-agent with no tools is close to useless, and the failure would otherwise
 * surface as a confusing empty run). Capability comes from the models.dev
 * catalog; when the catalog has nothing for the model — normal for local
 * providers and brand-new releases — the choice is allowed through, because
 * refusing every uncatalogued model would make local providers undelegatable.
 */
function resolveModelOverride(
  requested: string | undefined,
  inheritedModel: string,
): Effect.Effect<ModelOverrideOutcome, never, LLMService | LoggerService> {
  return Effect.gen(function* () {
    const trimmed = requested?.trim();
    if (!trimmed || trimmed === inheritedModel) return { ok: true } as const;

    const parsed = parseProviderModel(trimmed);
    if (!parsed) {
      return {
        ok: false,
        error: `"${trimmed}" is not a valid model reference. Use "provider/model" with a known provider (e.g. "anthropic/claude-haiku-4-5"). Call list_models to see what is available.`,
      } as const;
    }

    const llmService = yield* LLMServiceTag;
    const providers = yield* llmService.listProviders();
    const providerEntry = providers.find((entry) => entry.name === parsed.provider);
    if (!providerEntry?.configured) {
      const configured = providers
        .filter((entry) => entry.configured)
        .map((entry) => entry.name)
        .join(", ");
      return {
        ok: false,
        error: `Provider "${parsed.provider}" has no credentials configured. Configured providers: ${configured || "(none)"}. Call list_models to see usable models.`,
      } as const;
    }

    const metadata = yield* Effect.tryPromise({
      try: () => getModelsDevMetadata(parsed.model, parsed.provider),
      catch: () => new Error("model catalog unavailable"),
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    if (metadata && !metadata.supportsTools) {
      return {
        ok: false,
        error: `Model "${trimmed}" does not support tool calling, so a sub-agent running on it could not use any tools. Pick a tool-capable model — call list_models.`,
      } as const;
    }

    if (!metadata) {
      const logger = yield* LoggerServiceTag;
      yield* logger.debug("No catalog metadata for sub-agent model override; allowing", {
        model: trimmed,
      });
    }

    return {
      ok: true,
      model: `${parsed.provider}/${parsed.model}` as `${string}/${string}`,
      parsed,
    } as const;
  });
}

// ─── List Models Tool ────────────────────────────────────────────────

/** Rows returned by list_models. Enough to choose on price; not a catalog dump. */
const MAX_LISTED_MODELS = 40;

const listModelsSchema = z.object({
  provider: z
    .string()
    .optional()
    .describe("Restrict to one provider (e.g. 'anthropic'). Omit to list all configured ones."),
  requires: z
    .array(z.enum(["tools", "reasoning", "vision", "pdf"]))
    .optional()
    .describe(
      "Only list models with all of these capabilities. Use 'tools' when picking a sub-agent model.",
    ),
  minContextWindow: z
    .number()
    .optional()
    .describe("Only list models whose context window is at least this many tokens."),
});

type ListModelsArgs = z.infer<typeof listModelsSchema>;

interface ListedModel {
  readonly reference: string;
  readonly contextWindow?: number;
  readonly supportsTools: boolean;
  readonly capabilities: readonly string[];
  readonly inputPricePerMillion?: number;
  readonly outputPricePerMillion?: number;
}

function formatPrice(model: ListedModel): string {
  if (model.inputPricePerMillion === undefined && model.outputPricePerMillion === undefined) {
    return "price unknown";
  }
  const input = model.inputPricePerMillion?.toFixed(2) ?? "?";
  const output = model.outputPricePerMillion?.toFixed(2) ?? "?";
  return `in $${input} / out $${output} per 1M`;
}

function formatContextWindow(tokens: number | undefined): string {
  if (tokens === undefined) return "ctx unknown";
  return tokens >= 1000 ? `ctx ${Math.round(tokens / 1000)}k` : `ctx ${tokens}`;
}

/**
 * Sort key for "cheapest that can do the job".
 *
 * Output tokens dominate an agent run's cost far more than input, so they lead;
 * input price breaks ties. Models with unknown pricing sort last rather than
 * first — an unpriced model is usually a local or unlisted one, and presenting
 * it as the cheapest option would push callers toward a model nobody can
 * reason about the cost of.
 */
function costRank(model: ListedModel): number {
  const output = model.outputPricePerMillion;
  const input = model.inputPricePerMillion;
  if (output === undefined && input === undefined) return Number.MAX_SAFE_INTEGER;
  return (output ?? 0) * 1000 + (input ?? 0);
}

// ─── Summarize Tool ──────────────────────────────────────────────────

const summarizeContextSchema = z.object({});

/**
 * Creates the sub-agent and summarize tools.
 *
 * These tools allow the agent to:
 * - Delegate specialised tasks to lightweight sub-agents (codebase exploration, deep research, etc.)
 * - Explicitly compact the current context window on demand
 */
export function createSubagentTools(): Tool<ToolRequirements>[] {
  // We cast to Tool<ToolRequirements>[] because the tools' handlers depend on
  // services (ToolRegistry, etc.) that are provided by the agent execution runtime
  // but aren't expressible in the ToolRequirements union due to circular dependency constraints.
  return [
    defineTool({
      name: "spawn_subagent",
      longRunning: true,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
      description:
        "Spawn a sub-agent with fresh context for a specific task. Personas: coder, researcher, default. " +
        "Alternatively pass 'agent' with the exact name of a saved delegatable agent to run the task as " +
        "that agent. Pass a short 'name' to label each sub-agent by its role so parallel sub-agents stay " +
        "distinguishable.",
      parameters: spawnSubagentSchema,
      hidden: false,
      riskLevel: "low-risk",
      validate: makeZodValidator(spawnSubagentSchema),
      handler: (args: SpawnSubagentArgs, context) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          const presentation = yield* PresentationServiceTag;
          const parentAgent = context.parentAgent;

          if (!parentAgent) {
            return {
              success: false,
              result: null,
              error:
                "Sub-agent tool requires parent agent context. This is a bug — please report it.",
            };
          }

          const requestedAgentName = args.agent?.trim();

          if (requestedAgentName && args.persona) {
            return {
              success: false,
              result: null,
              error:
                "Pass either 'agent' or 'persona', not both. Use 'agent' to delegate to a saved " +
                "agent, 'persona' for a general-purpose sub-agent.",
            };
          }

          const roster = context.delegatableAgents ?? [];
          let delegateTo: Agent | undefined;

          if (requestedAgentName) {
            delegateTo =
              roster.find((candidate) => candidate.name === requestedAgentName) ??
              roster.find(
                (candidate) => candidate.name.toLowerCase() === requestedAgentName.toLowerCase(),
              );

            if (!delegateTo) {
              // Fail rather than silently degrading to a persona: a task routed
              // to the wrong specialist looks like it succeeded, which is worse
              // than an error the model can correct on the next iteration.
              const available =
                roster.length > 0
                  ? roster.map((candidate) => candidate.name).join(", ")
                  : "(none — no other saved agents exist)";
              return {
                success: false,
                result: null,
                error: `No saved agent named "${requestedAgentName}". Available: ${available}. Retry with an exact name from that list, or use 'persona' instead.`,
              };
            }
          }

          const persona = delegateTo?.config.persona ?? args.persona ?? "default";

          const inheritedModel = delegateTo?.model ?? parentAgent.model;
          const modelOverride = yield* resolveModelOverride(args.model, inheritedModel);
          if (!modelOverride.ok) {
            return { success: false, result: null, error: modelOverride.error };
          }

          yield* logger.info("Spawning sub-agent", {
            task: args.task.substring(0, 200),
            persona,
            ...(delegateTo
              ? { delegateToAgentId: delegateTo.id, delegateTo: delegateTo.name }
              : {}),
            ...(modelOverride.model ? { modelOverride: modelOverride.model } : {}),
            parentAgentId: parentAgent.id,
          });

          const taskPreview = args.task.length > 80 ? `...${args.task.slice(-77)}` : args.task;
          const subagentLabel =
            args.name?.trim() || (delegateTo ? delegateTo.name : `Sub-Agent (${persona})`);
          const startedAt = Date.now();

          const regionId = store.openEphemeral("subagent", subagentLabel, SUBAGENT_PANEL_LINES);
          store.appendEphemeral(regionId, `Task: ${taskPreview}`);

          // Create an ephemeral sub-agent. Without a named agent it inherits the
          // parent's LLM config under a chosen persona; with one it takes that
          // agent's config instead. An explicit `model` overrides whichever
          // model that produced. Either way the run is capped by the parent's
          // effective toolset (toolAllowlist below).
          const baseConfig = delegateTo?.config ?? parentAgent.config;
          const subAgent: Agent = {
            id: `subagent-${++subagentCounter}-${Date.now()}`,
            name: subagentLabel,
            description: `Ephemeral sub-agent spawned for: ${args.task.substring(0, 100)}`,
            model: modelOverride.model ?? inheritedModel,
            config: {
              ...baseConfig,
              persona,
              ...(modelOverride.parsed
                ? {
                    llmProvider: modelOverride.parsed.provider,
                    llmModel: modelOverride.parsed.model,
                  }
                : {}),
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const personaHints: Record<string, string> = {
            coder: "You are a coding specialist. Focus on reading, writing, and modifying code.",
            researcher:
              "You are a research specialist. Focus on gathering, synthesising, and summarising information.",
          };
          const personaHint = delegateTo?.config.whenToUse ?? personaHints[persona] ?? "";

          const wrappedTask = `[SUB-AGENT TASK]
You are a sub-agent performing a delegated task for a parent agent. This is a ONE-SHOT task.
${personaHint ? `\n${personaHint}\n` : ""}
Rules:
- Complete the task and produce a answer
- Do NOT ask follow-up questions or wait for user input
- Do NOT continue searching indefinitely — gather enough information, then synthesise and respond
- If the task is ambiguous, state your assumptions briefly and proceed
- If you cannot complete the task fully, return what you found and explain why
- Stay within the scope of the task — do not take unrequested side actions
- Be concise; the parent agent needs the output, not background narration
- Your response will be returned directly to the parent agent

TASK:
${args.task}`;

          if (context.emitEvent) {
            yield* context.emitEvent({
              type: "subagent_start",
              task: taskPreview,
              agentName: subagentLabel,
            });
          }

          const response = yield* AgentRunner.runRecursive({
            agent: subAgent,
            userInput: wrappedTask,
            sessionId: context.sessionId ?? context.conversationId ?? `session-${Date.now()}`,
            conversationId: `subagent-conv-${++subagentCounter}-${Date.now()}`,
            maxIterations: context.parentMaxIterations ?? DEFAULT_MAX_ITERATIONS,
            ephemeralRegionId: regionId,
            // Cap the child at the parent's own effective tools. Delegating to a
            // saved agent must never widen the toolset, or a narrowly-scoped
            // parent could reach `execute_command` through a child.
            ...(context.parentToolNames ? { toolAllowlist: context.parentToolNames } : {}),
            ...(context.getAutoApprovePolicy
              ? { autoApprovePolicy: context.getAutoApprovePolicy }
              : {}),
            ...(context.autoApprovedCommands
              ? { autoApprovedCommands: context.autoApprovedCommands }
              : {}),
            ...(context.autoApprovedTools ? { autoApprovedTools: context.autoApprovedTools } : {}),
            ...(context.onAutoApproveCommand
              ? { onAutoApproveCommand: context.onAutoApproveCommand }
              : {}),
            ...(context.onAutoApproveTool ? { onAutoApproveTool: context.onAutoApproveTool } : {}),
          }).pipe(
            Effect.tapError(() =>
              Effect.sync(() =>
                store.collapseEphemeral(regionId, {
                  line: chalk.dim(chalk.italic(`${getGlyphs().error} ${subagentLabel} failed`)),
                  durationMs: Date.now() - startedAt,
                }),
              ),
            ),
            // Interruption is not a typed error, so tapError never sees it.
            // Without this, any abort that doesn't go through the double-Esc
            // handler leaves the subagent panel stuck live.
            Effect.onInterrupt(() =>
              Effect.sync(() =>
                store.collapseEphemeral(regionId, {
                  line: chalk.dim(
                    chalk.italic(`${getGlyphs().error} ${subagentLabel} interrupted`),
                  ),
                  durationMs: Date.now() - startedAt,
                }),
              ),
            ),
            // Bracket the sub-run for --events consumers, whatever the outcome.
            Effect.ensuring(
              context.emitEvent ? context.emitEvent({ type: "subagent_complete" }) : Effect.void,
            ),
          );

          // Fold the sub-agent's cost into the parent run's total so aggregated
          // pricing (one-shot JSON envelope, workflow history) includes sub-agent
          // spend. The interactive footer aggregates separately via each renderer.
          if (response.costUSD && context.recordChildCost) {
            context.recordChildCost(response.costUSD);
          }

          let result = response.content;
          if (!result?.trim() && response.messages?.length) {
            const parts: string[] = [];
            for (const msg of response.messages) {
              if (
                msg.role === "assistant" &&
                typeof msg.content === "string" &&
                msg.content.trim()
              ) {
                parts.push(msg.content.trim());
              }
            }
            if (parts.length > 0) {
              result = `[Sub-agent reached iteration limit. Partial results below]\n\n${parts.join("\n\n")}`;
            }
          }

          const durationMs = Date.now() - startedAt;
          const seconds = (durationMs / 1000).toFixed(1);
          const summaryLine = chalk.dim(
            chalk.italic(`${getGlyphs().success} ${subagentLabel} completed · ${seconds}s`),
          );
          store.collapseEphemeral(regionId, { line: summaryLine, durationMs });

          const fullResult = result?.trim() || "No output";
          const maxLines = 10;
          const previewLines = fullResult.split("\n").slice(-maxLines).join("\n");
          const indentedLines = previewLines.split("\n").map((line) => `     ${line}`);
          yield* presentation.writeOutput(indentedLines.join("\n"));

          yield* logger.info("Sub-agent completed", {
            parentAgentId: parentAgent.id,
            persona,
            ...(delegateTo ? { delegateTo: delegateTo.name } : {}),
            responseLength: (result || "").length,
          });

          return {
            success: true,
            result: result || "Sub-agent completed but returned no content.",
          };
        }),
      createSummary: (result) => {
        if (!result.success) return `Sub-agent failed: ${result.error}`;
        const content = String(result.result);
        return `Sub-agent returned ${content.length} chars`;
      },
    }),

    defineTool({
      name: "list_models",
      description:
        "List models available across configured providers, with capabilities, context window " +
        "and per-million-token prices, cheapest first. Use before overriding a sub-agent's " +
        "model to pick the cheapest model that can do the task.",
      parameters: listModelsSchema,
      hidden: false,
      riskLevel: "read-only",
      validate: makeZodValidator(listModelsSchema),
      handler: (args: ListModelsArgs) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          const llmService = yield* LLMServiceTag;

          const providers = yield* llmService.listProviders();
          const configured = providers.filter((entry) => entry.configured);

          const requestedProvider = args.provider?.trim().toLowerCase();
          const targets = requestedProvider
            ? configured.filter((entry) => entry.name.toLowerCase() === requestedProvider)
            : configured;

          if (targets.length === 0) {
            const names = configured.map((entry) => entry.name).join(", ");
            return {
              success: false,
              result: null,
              error: requestedProvider
                ? `Provider "${args.provider}" is not configured. Configured providers: ${names || "(none)"}.`
                : "No LLM providers are configured, so no models can be listed.",
            };
          }

          const catalog = yield* Effect.tryPromise({
            try: () => getModelsDevMap(),
            catch: () => new Error("model catalog unavailable"),
          }).pipe(Effect.catchAll(() => Effect.succeed(null)));

          const listed: ListedModel[] = [];
          for (const target of targets) {
            // A provider that fails to resolve (revoked key, unreachable local
            // server) must not sink the whole listing — skip it and carry on.
            const provider = yield* llmService
              .getProvider(target.name)
              .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            if (!provider) {
              yield* logger.debug("Skipping provider in list_models", { provider: target.name });
              continue;
            }

            for (const model of provider.supportedModels) {
              const metadata = getMetadataFromMap(catalog, model.id, target.name);
              const supportsTools = metadata?.supportsTools ?? model.supportsTools;
              const contextWindow = metadata?.contextWindow ?? model.contextWindow;
              const capabilities = [
                ...(supportsTools ? ["tools"] : []),
                ...((metadata?.isReasoningModel ?? model.isReasoningModel) ? ["reasoning"] : []),
                ...((metadata?.supportsVision ?? model.supportsVision) ? ["vision"] : []),
                ...((metadata?.supportsPdf ?? model.supportsPdf) ? ["pdf"] : []),
              ];

              listed.push({
                reference: `${target.name}/${model.id}`,
                supportsTools,
                capabilities,
                ...(contextWindow !== undefined ? { contextWindow } : {}),
                ...(metadata?.inputPricePerMillion !== undefined
                  ? { inputPricePerMillion: metadata.inputPricePerMillion }
                  : {}),
                ...(metadata?.outputPricePerMillion !== undefined
                  ? { outputPricePerMillion: metadata.outputPricePerMillion }
                  : {}),
              });
            }
          }

          const required = args.requires ?? [];
          const matching = listed.filter((model) => {
            if (!required.every((capability) => model.capabilities.includes(capability))) {
              return false;
            }
            if (args.minContextWindow !== undefined) {
              if (model.contextWindow === undefined) return false;
              if (model.contextWindow < args.minContextWindow) return false;
            }
            return true;
          });

          if (matching.length === 0) {
            return {
              success: true,
              result:
                `No models across ${targets.length} configured provider(s) match those filters` +
                `${required.length > 0 ? ` (requires: ${required.join(", ")})` : ""}` +
                `${args.minContextWindow !== undefined ? ` (min context ${args.minContextWindow})` : ""}.` +
                " Relax the filters and try again.",
            };
          }

          const ranked = [...matching].sort((first, second) => costRank(first) - costRank(second));
          const shown = ranked.slice(0, MAX_LISTED_MODELS);

          const lines = shown.map((model) => {
            const capabilities =
              model.capabilities.length > 0
                ? model.capabilities.join(",")
                : "no known capabilities";
            return `${model.reference} · ${formatPrice(model)} · ${formatContextWindow(model.contextWindow)} · ${capabilities}`;
          });

          // Say what was dropped. A silently truncated list reads as "these are
          // all the options", which is exactly the wrong basis for a cost choice.
          const omitted = ranked.length - shown.length;
          const footer =
            omitted > 0
              ? `\n\n(${omitted} more model(s) matched but were omitted; filter by provider or capability to narrow.)`
              : "";

          return {
            success: true,
            result: `${shown.length} model(s), cheapest first:\n${lines.join("\n")}${footer}`,
          };
        }),
      createSummary: (result) => {
        if (!result.success) return `list_models failed: ${result.error}`;
        const firstLine = String(result.result).split("\n")[0] ?? "";
        return firstLine;
      },
    }),

    defineTool({
      name: "summarize_context",
      longRunning: true,
      description:
        "Compact conversation by summarizing older messages to free token budget. " +
        "Always performs summarization when called — use proactively before complex tasks " +
        "to reduce context size, save costs, and prevent context rot.",
      parameters: summarizeContextSchema,
      hidden: false,
      riskLevel: "read-only",
      validate: makeZodValidator(summarizeContextSchema),
      handler: (_args, context) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          const parentAgent = context.parentAgent;
          const conversationMessages = context.conversationMessages;

          if (!parentAgent) {
            return {
              success: false,
              result: null,
              error:
                "Summarize tool requires parent agent context. This is a bug — please report it.",
            };
          }

          if (!conversationMessages || conversationMessages.length === 0) {
            return {
              success: true,
              result: "No conversation history to summarize.",
            };
          }

          yield* logger.info("Starting context summarization", {
            messageCount: conversationMessages.length,
            parentAgentId: parentAgent.id,
          });

          // Fetch model's actual context window from models.dev (used for splitting budget)
          const modelMetadata = yield* Effect.tryPromise({
            try: () =>
              getModelsDevMetadata(parentAgent.config.llmModel, parentAgent.config.llmProvider),
            catch: () => new Error("Failed to fetch model metadata"),
          }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

          const contextWindowMaxTokens = resolveEffectiveContextWindow({
            provider: parentAgent.config.llmProvider,
            ...(modelMetadata && { modelMaxTokens: modelMetadata.contextWindow }),
            ...(typeof parentAgent.config.numCtx === "number" && {
              pinnedContextWindow: parentAgent.config.numCtx,
            }),
          }).tokens;

          const { systemMessage, messagesToSummarize, sanitizedRecentMessages } =
            Summarizer.splitMessages(
              [...conversationMessages] as unknown as ConversationMessages,
              contextWindowMaxTokens,
            );

          if (messagesToSummarize.length === 0) {
            return {
              success: true,
              result:
                "Not enough conversation history to summarize — need at least a few messages beyond the system prompt.",
            };
          }

          const runRecursive: RecursiveRunner = (runOpts) => AgentRunner.runRecursive(runOpts);

          // Summarize older messages into a single condensed message
          const summaryMessage = yield* Summarizer.summarizeHistory(
            messagesToSummarize,
            parentAgent,
            context.sessionId ?? context.conversationId ?? `session-${Date.now()}`,
            context.conversationId ?? `conv-${Date.now()}`,
            runRecursive,
          );

          const compacted = [
            systemMessage,
            summaryMessage,
            ...sanitizedRecentMessages,
          ] as ConversationMessages;

          // Replace messages in the executor loop via callback
          if (context.compactConversation) {
            context.compactConversation(compacted);
          }

          yield* logger.info("Context summarization completed", {
            originalMessageCount: conversationMessages.length,
            compactedMessageCount: compacted.length,
            summarizedMessageCount: messagesToSummarize.length,
          });

          return {
            success: true,
            result: `Context compacted from ${conversationMessages.length} to ${compacted.length} messages (summarized ${messagesToSummarize.length} older messages).`,
          };
        }),
      createSummary: (result) => {
        if (!result.success) return `Summarization failed: ${result.error}`;
        const content = String(result.result);
        return `Context summarized (${content.length} chars)`;
      },
    }),
  ] as Tool<ToolRequirements>[];
}
