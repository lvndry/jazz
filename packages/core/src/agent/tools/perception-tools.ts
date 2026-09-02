/**
 * @fileoverview `analyze_media`: delegating perception to a model that can actually do it
 *
 * An agent whose own model cannot see, hear, or watch hits the modality wall the moment
 * work involves an image, a recording, or a clip. Rather than dead-ending ("I can't view
 * images"), it delegates: this tool runs an ephemeral companion on a model that accepts
 * the modality, hands it the files as attachments (paths on a message — never bytes),
 * and brings the companion's textual answer back as the tool result.
 *
 * Who chooses the companion:
 * - **A human, always, interactively.** The proposal carries the capable models as
 *   picker-style approval options (`ApprovalRequest.options`); the executor renders
 *   them like any approval card and never auto-approves them — there is nothing to
 *   approve until somebody picked a row.
 * - **A pre-bound companion, unattended.** `config.companions[capability]` names a
 *   `"provider/model"` chosen ahead of time; binding it *is* the consent, so bound runs
 *   skip the prompt entirely — which is what makes cron and bridge runs work where no
 *   one can answer a picker.
 *
 * When nothing capable is available, the failure says exactly what would fix it — add an
 * API key for a provider that has such models — rather than a bare refusal.
 */

import { Effect, Option } from "effect";
import { z } from "zod";
import { isZeroCostLocalModel } from "@/core/constants/local-providers";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import type { Tool, ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types/agent";
import type { MessageAttachment } from "@/core/types/attachment";
import type { ToolExecutionContext } from "@/core/types/tools";
import { generateConversationId } from "@/core/utils/conversation-id";
import { resolveMediaAttachments } from "@/core/utils/media-attachments";
import {
  attachmentKindForCapability,
  describeCapability,
  filterCapableModels,
  formatModelPriceLine,
  type CapableModel,
  type PerceptionCapability,
} from "@/core/utils/model-capabilities";
import { getModelsDevProviderModels } from "@/core/utils/models-dev";
import { agentModelString, parseProviderModel } from "@/core/utils/provider-model";
import { defineTool, makeZodValidator, type ToolValidatorResult } from "./base-tool";
import { AgentRunner } from "../agent-runner";

/** Companion execution timeout: matches spawn_subagent. */
const COMPANION_TIMEOUT_MS = 30 * 60 * 1000;

/** A perception run answers from one batch of media; it needs no iteration budget. */
const COMPANION_MAX_ITERATIONS = 4;

/**
 * Reserved argument key the executor fills with the human's picker choice.
 * Never documented to the model: it is set after approval or not at all.
 */
export const SELECTED_OPTION_KEY = "_selectedOptionId";

const analyzeMediaSchema = z.object({
  capability: z
    .enum(["vision", "audio", "video"])
    .describe(
      "Which modality to delegate: vision for images, audio for recordings, video for clips.",
    ),
  task: z
    .string()
    .min(1)
    .describe(
      "What to extract from the media, stated precisely — questions to answer, details to read, " +
        "the exact shape of the answer you need back.",
    ),
  mediaPaths: z
    .array(z.string().min(1))
    .min(1)
    .max(8)
    .describe("Absolute paths of the media files the companion should perceive."),
});

type AnalyzeMediaArgs = z.infer<typeof analyzeMediaSchema>;

type ExecuteArgs = AnalyzeMediaArgs & { readonly [SELECTED_OPTION_KEY]?: string };

const executeSchema: z.ZodType<Record<string, unknown>> = analyzeMediaSchema.extend({
  [SELECTED_OPTION_KEY]: z.string().optional(),
});

/**
 * Validator that parses the shared schema but preserves the executor-injected
 * selection. Zod would strip the unknown key; the selection is the one argument
 * that legitimately arrives from outside the model.
 */
function validateWithSelection(args: Record<string, unknown>): ToolValidatorResult<ExecuteArgs> {
  const result = makeZodValidator(executeSchema)(args);
  if (!result.valid || result.value === undefined) {
    return result as ToolValidatorResult<ExecuteArgs>;
  }
  const selectedOptionId = args[SELECTED_OPTION_KEY];
  return {
    valid: true as const,
    value: {
      ...result.value,
      ...(typeof selectedOptionId === "string" ? { [SELECTED_OPTION_KEY]: selectedOptionId } : {}),
    } as ExecuteArgs,
  };
}

interface CandidateList {
  readonly available: readonly {
    readonly id: `${string}/${string}`;
    readonly provider: string;
    readonly model: CapableModel;
  }[];
  /** Providers whose catalog lists capable models but which have no API key configured. */
  readonly missingKeyProviders: readonly string[];
}

function listCandidates(
  capability: PerceptionCapability,
): Effect.Effect<CandidateList, never, LLMService> {
  const modality = attachmentKindForCapability(capability);
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const providerItems = yield* llmService.listProviders();

    const available: NonNullable<CandidateList["available"][number]>[] = [];
    const missingKeyProviders: string[] = [];

    for (const item of providerItems) {
      if (!item.configured) {
        const hasCapable = yield* Effect.promise(() => catalogHasCapability(item.name, modality));
        if (hasCapable) missingKeyProviders.push(item.name);
        continue;
      }
      const provider = yield* llmService.getProvider(item.name).pipe(Effect.option);
      if (Option.isNone(provider)) continue;
      for (const model of filterCapableModels(provider.value.supportedModels, capability)) {
        available.push({
          id: `${item.name}/${model.modelId}` as `${string}/${string}`,
          provider: item.name,
          model,
        });
      }
    }
    return { available, missingKeyProviders };
  });
}

/** Whether the catalog lists any conversational model with this input modality for a provider. */
async function catalogHasCapability(
  providerId: string,
  modality: "image" | "audio" | "video",
): Promise<boolean> {
  try {
    const entries = await getModelsDevProviderModels(providerId);
    return entries.some((entry) => {
      if (entry.status === "deprecated") return false;
      if (!entry.inputModalities.includes("text")) return false;
      if (!entry.outputModalities.includes("text")) return false;
      if (modality === "image") return entry.metadata.ingestImage;
      if (modality === "audio") return entry.metadata.ingestAudio;
      return entry.metadata.ingestVideo;
    });
  } catch {
    return false;
  }
}

function buildCompanionAgent(
  parentAgent: Agent,
  selectedId: `${string}/${string}`,
  capability: PerceptionCapability,
  counter: number,
): Agent | null {
  const parsed = parseProviderModel(selectedId);
  if (parsed === null) return null;
  const now = new Date();
  return {
    id: `companion-${counter}-${Date.now()}`,
    name: `Model Companion (${capability})`,
    description: `Ephemeral ${describeCapability(capability)} companion delegated by ${parentAgent.name}`,
    config: {
      persona: "default",
      llmProvider: parsed.provider,
      llmModel: parsed.model,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function wrapTask(task: string, capability: PerceptionCapability): string {
  return `[MODEL COMPANION TASK]
You are a perception specialist. A parent agent delegated media to you because its own model
cannot perform ${describeCapability(capability)}. This is a ONE-SHOT task.

Rules:
- Answer strictly from the attached media and the task below
- Produce the exact answer shape the task asks for; be precise and concrete
- If something is unreadable or ambiguous, say so plainly rather than guessing
- Do not ask follow-up questions; your response goes straight back to the parent

TASK:
${task}`;
}

export function createPerceptionTools(): Tool<ToolRequirements>[] {
  let companionCounter = 0;

  const runCompanion = (
    parentAgent: Agent,
    args: AnalyzeMediaArgs,
    companionAgent: Agent,
    attachments: readonly MessageAttachment[],
    context: ToolExecutionContext,
  ): Effect.Effect<string, Error, ToolRequirements | ToolRegistry> =>
    Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;
      const presentation = yield* PresentationServiceTag;

      const label = companionAgent.name;
      const startedAt = Date.now();
      const regionId = yield* presentation.openEphemeralRegion("subagent", label);
      yield* presentation.appendEphemeralRegion(
        regionId,
        `Task: ${args.task.length > 80 ? `...${args.task.slice(-77)}` : args.task}`,
      );

      yield* logger.info("Running model companion", {
        parentAgentId: parentAgent.id,
        companionModel: agentModelString(companionAgent.config),
        capability: args.capability,
        attachmentCount: attachments.length,
      });

      const response = yield* AgentRunner.runRecursive({
        agent: companionAgent,
        userInput: wrapTask(args.task, args.capability),
        conversationId: generateConversationId("companion"),
        maxIterations: COMPANION_MAX_ITERATIONS,
        ephemeralRegionId: regionId,
        initialAttachments: [...attachments],
        // Eyes and ears need no tools — and many perception-capable models cannot
        // use them anyway. An empty allowlist strips every tool.
        toolAllowlist: [],
        subagentDepth: (context.subagentDepth ?? 0) + 1,
        ...(context.getAutoApprovePolicy
          ? { autoApprovePolicy: context.getAutoApprovePolicy }
          : {}),
        ...(context.autoApprovedCommands
          ? { autoApprovedCommands: context.autoApprovedCommands }
          : {}),
        ...(context.autoApprovedTools ? { autoApprovedTools: context.autoApprovedTools } : {}),
      }).pipe(
        Effect.tapError(() =>
          presentation.collapseEphemeralRegion(regionId, label, {
            status: "failed",
            durationMs: Date.now() - startedAt,
          }),
        ),
        Effect.onInterrupt(() =>
          presentation.collapseEphemeralRegion(regionId, label, {
            status: "interrupted",
            durationMs: Date.now() - startedAt,
          }),
        ),
      );

      if (response.costUSD && context.recordChildCost) {
        context.recordChildCost(response.costUSD);
      }
      const childCostUnknown =
        response.costIncomplete === true ||
        (response.costUSD === undefined &&
          !isZeroCostLocalModel(companionAgent.config.llmProvider, companionAgent.config.llmModel));
      if (childCostUnknown) context.recordChildCostUnknown?.();

      yield* presentation.collapseEphemeralRegion(regionId, label, {
        status: "completed",
        durationMs: Date.now() - startedAt,
        ...(response.costUSD !== undefined ? { costUSD: response.costUSD } : {}),
        ...(response.usage
          ? { totalTokens: response.usage.promptTokens + response.usage.completionTokens }
          : {}),
      });
      yield* logger.info("Model companion completed", {
        parentAgentId: parentAgent.id,
        responseLength: response.content.length,
      });

      return response.content.trim() || "The companion returned no content.";
    });

  const proposalTool = defineTool({
    name: "analyze_media",
    disclosure: "internal",
    longRunning: true,
    timeoutMs: COMPANION_TIMEOUT_MS,
    riskLevel: "high-risk",
    description:
      "Delegate image, audio, or video analysis to a model that accepts that modality, and get a " +
      "textual answer back. Use this when the user asks about media your own model cannot ingest " +
      "(check your supported kinds) or when higher-fidelity perception would help. The person at " +
      "the keyboard picks which model does the looking; name every file explicitly in mediaPaths " +
      "and put everything you want answered into task — the companion sees nothing else of this " +
      "conversation.",
    parameters: analyzeMediaSchema,
    validate: makeZodValidator(analyzeMediaSchema),
    handler: (args: AnalyzeMediaArgs, context) =>
      Effect.gen(function* () {
        const logger = yield* LoggerServiceTag;
        const presentation = yield* PresentationServiceTag;
        const parentAgent = context.parentAgent;
        if (!parentAgent) {
          return {
            success: false,
            result: null,
            error: "analyze_media requires parent agent context. This is a bug — please report it.",
          };
        }

        const expectedKind = attachmentKindForCapability(args.capability);
        const resolution = yield* Effect.tryPromise({
          try: () => resolveMediaAttachments(args.mediaPaths, expectedKind),
          catch: (error) => new Error(String(error)),
        });
        if (resolution.errors.length > 0 || resolution.attachments.length === 0) {
          return {
            success: false,
            result: null,
            error:
              resolution.errors.length > 0
                ? `No media was delegated. ${resolution.errors.join(" ")}`
                : "No media was delegated: none of the paths resolved.",
          };
        }

        // Standing consent: a pre-bound companion needs no picker. This is also the
        // only path an unattended run can take, which is why binding matters.
        const boundCompanion = parentAgent.config.companions?.[args.capability];
        if (boundCompanion) {
          const companionAgent = buildCompanionAgent(
            parentAgent,
            boundCompanion,
            args.capability,
            ++companionCounter,
          );
          if (companionAgent === null) {
            return {
              success: false,
              result: null,
              error: `Bound ${args.capability} companion "${boundCompanion}" is not a valid provider/model id.`,
            };
          }
          const content = yield* runCompanion(
            parentAgent,
            args,
            companionAgent,
            resolution.attachments,
            context,
          );
          return { success: true, result: content };
        }

        let candidateList = yield* listCandidates(args.capability);

        if (candidateList.available.length === 0) {
          const canPrompt = presentation.canPromptForApproval?.() === true;

          // The kind refusal: if a provider has capable models but no key, offer to
          // add one right here and rescan — the human never leaves the flow.
          if (canPrompt && candidateList.missingKeyProviders.length > 0) {
            const terminalOption = yield* Effect.serviceOption(TerminalServiceTag);
            if (Option.isSome(terminalOption)) {
              const terminal = terminalOption.value;
              const wantsKey = yield* terminal.confirm(
                `No ${args.capability}-capable model is reachable yet. Add an API key now?`,
                true,
              );
              if (wantsKey) {
                const missingProviders = candidateList.missingKeyProviders;
                const provider =
                  missingProviders.length === 1
                    ? missingProviders[0]!
                    : yield* terminal.select("Which provider?", {
                        choices: missingProviders.map((name) => ({ name, value: name })),
                      });
                if (provider !== undefined) {
                  const apiKey = yield* terminal.ask(`${provider} API Key:`, {
                    simple: true,
                    secret: true,
                    cancellable: true,
                    placeholder: "Paste your API key... (Esc to cancel)",
                  });
                  if (apiKey !== undefined && apiKey.trim().length > 0) {
                    const configService = yield* AgentConfigServiceTag;
                    yield* configService.set(`llm.${provider}.api_key`, apiKey.trim());
                    yield* terminal.success("API key saved.");
                    candidateList = yield* listCandidates(args.capability);
                  }
                }
              }
            }
          }
        }

        if (candidateList.available.length === 0) {
          const canPrompt = presentation.canPromptForApproval?.() === true;
          const keyHint =
            candidateList.missingKeyProviders.length > 0
              ? ` No ${args.capability}-capable model is reachable yet: adding an API key for ${candidateList.missingKeyProviders.join(", ")} would fix this.`
              : ` No provider in the catalog currently offers a conversational model with ${describeCapability(args.capability)}.`;
          const message = canPrompt
            ? `Cannot delegate ${args.capability}.${keyHint}`
            : `Cannot delegate ${args.capability}: nobody can pick a companion in this session.${keyHint} Bind one ahead of time with \`jazz agent edit\` (companions).`;
          yield* logger.info("analyze_media found no capable models", {
            capability: args.capability,
            missingKeyProviders: candidateList.missingKeyProviders,
          });
          return { success: false, result: null, error: message };
        }

        const options = candidateList.available.map((candidate) => ({
          id: candidate.id,
          label: candidate.model.displayName ?? candidate.model.modelId,
          detail: `${candidate.provider} · ${formatModelPriceLine(candidate.model)}`,
        }));

        const described = resolution.attachments
          .map((attachment) => `${attachment.kind}:${attachment.path}`)
          .join(", ");
        return {
          success: false,
          result: {
            approvalRequired: true,
            message:
              `Delegate ${args.capability} analysis to a capable model.\n` +
              `Media: ${described}\nTask: ${args.task}`,
            executeToolName: "execute_analyze_media",
            executeArgs: args as unknown as Record<string, unknown>,
            options,
          },
          error: "analyze_media requires the person to pick a companion model.",
        };
      }),
  });

  const executeTool = defineTool({
    name: "execute_analyze_media",
    disclosure: "internal",
    hidden: true,
    longRunning: true,
    timeoutMs: COMPANION_TIMEOUT_MS,
    riskLevel: "high-risk",
    description:
      "EXECUTION TOOL: runs the delegation after a companion model was picked. Called by the system only.",
    parameters: analyzeMediaSchema,
    validate: validateWithSelection,
    handler: (args: ExecuteArgs, context) =>
      Effect.gen(function* () {
        const parentAgent = context.parentAgent;
        const selectedId = args[SELECTED_OPTION_KEY];
        if (!parentAgent || typeof selectedId !== "string") {
          return {
            success: false,
            result: null,
            error: "execute_analyze_media reached without a picked companion. This is a bug.",
          };
        }
        const companionAgent = buildCompanionAgent(
          parentAgent,
          selectedId as `${string}/${string}`,
          args.capability,
          ++companionCounter,
        );
        if (companionAgent === null) {
          return {
            success: false,
            result: null,
            error: `Picked companion "${selectedId}" is not a valid provider/model id.`,
          };
        }
        const expectedKind = attachmentKindForCapability(args.capability);
        const resolution = yield* Effect.tryPromise({
          try: () => resolveMediaAttachments(args.mediaPaths, expectedKind),
          catch: (error) => new Error(String(error)),
        });
        if (resolution.attachments.length === 0) {
          return {
            success: false,
            result: null,
            error:
              resolution.errors.length > 0
                ? `Media could no longer be resolved. ${resolution.errors.join(" ")}`
                : "Media could no longer be resolved.",
          };
        }
        const content = yield* runCompanion(
          parentAgent,
          args,
          companionAgent,
          resolution.attachments,
          context,
        );
        return { success: true, result: content };
      }),
    createSummary: (result) => {
      if (!result.success) return `analyze_media failed: ${result.error}`;
      const content = String(result.result);
      return `Companion analyzed the media (${content.length} chars)`;
    },
  });

  return [proposalTool, executeTool] as Tool<ToolRequirements>[];
}
