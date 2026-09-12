/**
 * @fileoverview `analyze_media` / `generate_media`: delegating media work to a model that can do it
 *
 * An agent whose own model cannot see, hear, watch — or draw — hits the modality wall the
 * moment work involves an image, a recording, or a clip. Rather than dead-ending ("I can't
 * view images"), it delegates: an ephemeral companion runs on a model that does handle the
 * modality, and its result comes back as the tool result.
 *
 * The two directions are separate tools because they are separate jobs with separate
 * bindings, and a model that reads a modality rarely produces it:
 * - `analyze_media` hands the companion files as attachments (paths on a message — never
 *   bytes) and returns its textual answer.
 * - `generate_media` hands it a description and returns the files it painted, as artifacts,
 *   the same shape `create_pdf` returns.
 *
 * Who chooses the companion:
 * - **A human, always, interactively.** The proposal carries the capable models as
 *   picker-style approval options (`ApprovalRequest.options`); the executor renders
 *   them like any approval card and never auto-approves them — there is nothing to
 *   approve until somebody picked a row.
 * - **A pre-bound companion, unattended.** `config.companions["<action>:<modality>"]` names a
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
import type { ApprovalOption, ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { generateConversationId } from "@/core/utils/conversation-id";
import { resolveMediaAttachments } from "@/core/utils/media-attachments";
import {
  companionRole,
  describeRole,
  filterCapableModels,
  formatModelPriceLine,
  modelSupportsRole,
  type CapableModel,
  type CompanionRole,
  type MediaModality,
} from "@/core/utils/model-capabilities";
import { getModelsDevProviderModels } from "@/core/utils/models-dev";
import { agentModelString, parseProviderModel } from "@/core/utils/provider-model";
import { defineTool, makeZodValidator, type ToolValidatorResult } from "./base-tool";
import { AgentRunner } from "../agent-runner";
import type { AgentResponse } from "../types";

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
  modality: z
    .enum(["image", "audio", "video"])
    .describe(
      "Which media kind to delegate: image for pictures, audio for recordings, video for clips.",
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

const generateMediaSchema = z.object({
  modality: z
    .enum(["image", "audio", "video"])
    .describe("Which media kind to produce: image, audio, or video."),
  prompt: z
    .string()
    .min(1)
    .describe(
      "The full description of what to produce, standalone — style, subject, composition, " +
        "length, voice, everything that matters. The companion sees nothing else of this " +
        "conversation, so a reference to 'the chart above' produces nothing.",
    ),
});

type GenerateMediaArgs = z.infer<typeof generateMediaSchema>;

/**
 * The role these tools delegate. `analyze_media` only ever reads media, so the action
 * half is fixed here rather than asked of the model — the modality is the only choice
 * it has to make.
 */
function roleFor(modality: MediaModality): CompanionRole {
  return companionRole("analyze", modality);
}

type WithSelection<Args> = Args & { readonly [SELECTED_OPTION_KEY]?: string };

/**
 * Validator that parses the tool's own schema but preserves the executor-injected
 * selection. Zod would strip the unknown key; the selection is the one argument
 * that legitimately arrives from outside the model.
 */
function validateWithSelection<Args>(
  schema: z.ZodType<Args>,
): (args: Record<string, unknown>) => ToolValidatorResult<WithSelection<Args>> {
  const withSelection: z.ZodType<Record<string, unknown>> = (
    schema as unknown as z.ZodObject<z.ZodRawShape>
  ).extend({ [SELECTED_OPTION_KEY]: z.string().optional() });
  return (args) => {
    const result = makeZodValidator(withSelection)(args);
    if (!result.valid || result.value === undefined) {
      return result as ToolValidatorResult<WithSelection<Args>>;
    }
    const selectedOptionId = args[SELECTED_OPTION_KEY];
    return {
      valid: true as const,
      value: {
        ...result.value,
        ...(typeof selectedOptionId === "string"
          ? { [SELECTED_OPTION_KEY]: selectedOptionId }
          : {}),
      } as WithSelection<Args>,
    };
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

function listCandidates(role: CompanionRole): Effect.Effect<CandidateList, never, LLMService> {
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const providerItems = yield* llmService.listProviders();

    const available: NonNullable<CandidateList["available"][number]>[] = [];
    const missingKeyProviders: string[] = [];

    for (const item of providerItems) {
      if (!item.configured) {
        const hasCapable = yield* Effect.promise(() => catalogHasRole(item.name, role));
        if (hasCapable) missingKeyProviders.push(item.name);
        continue;
      }
      const provider = yield* llmService.getProvider(item.name).pipe(Effect.option);
      if (Option.isNone(provider)) continue;
      for (const model of filterCapableModels(provider.value.supportedModels, role)) {
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

/** Whether the catalog lists any conversational model that can do this role for a provider. */
async function catalogHasRole(providerId: string, role: CompanionRole): Promise<boolean> {
  try {
    const entries = await getModelsDevProviderModels(providerId);
    return entries.some((entry) => {
      if (entry.status === "deprecated") return false;
      if (!entry.inputModalities.includes("text")) return false;
      if (!entry.outputModalities.includes("text")) return false;
      return modelSupportsRole(entry.metadata, role);
    });
  } catch {
    return false;
  }
}

function buildCompanionAgent(
  parentAgent: Agent,
  selectedId: `${string}/${string}`,
  role: CompanionRole,
  counter: number,
): Agent | null {
  const parsed = parseProviderModel(selectedId);
  if (parsed === null) return null;
  const now = new Date();
  return {
    id: `companion-${counter}-${Date.now()}`,
    name: `Model Companion (${role})`,
    description: `Ephemeral ${describeRole(role)} companion delegated by ${parentAgent.name}`,
    config: {
      persona: "default",
      llmProvider: parsed.provider,
      llmModel: parsed.model,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function wrapAnalysisTask(task: string, role: CompanionRole): string {
  return `[MODEL COMPANION TASK]
You are a perception specialist. A parent agent delegated media to you because its own model
cannot perform ${describeRole(role)}. This is a ONE-SHOT task.

Rules:
- Answer strictly from the attached media and the task below
- Produce the exact answer shape the task asks for; be precise and concrete
- If something is unreadable or ambiguous, say so plainly rather than guessing
- Do not ask follow-up questions; your response goes straight back to the parent

TASK:
${task}`;
}

/**
 * The generation counterpart.
 *
 * The one rule that carries weight is "return the file": a model asked for an image will
 * cheerfully answer with a paragraph describing one, and a description is not what the
 * parent asked for. The tool checks for the file too — this just asks first.
 */
function wrapGenerationTask(prompt: string, modality: MediaModality): string {
  return `[MODEL COMPANION TASK]
You are a media generation specialist. A parent agent delegated this to you because its own
model cannot produce ${modality}. This is a ONE-SHOT task.

Rules:
- Actually produce the ${modality} and return it as a file; do not describe one in words
- Follow the brief below exactly; it is everything you know about the request
- If the brief is impossible or refused, say why in one line rather than producing something else
- Do not ask follow-up questions; your response goes straight back to the parent

BRIEF:
${prompt}`;
}

/**
 * Who should run a role: the companion already bound, the models worth offering, or
 * why there is neither.
 */
type CompanionChoice =
  | { readonly kind: "bound"; readonly companion: Agent }
  | { readonly kind: "pick"; readonly options: readonly ApprovalOption[] }
  | { readonly kind: "unavailable"; readonly error: string };

/**
 * What a generation companion's run amounts to: the files it made, or why it made none.
 *
 * No artifact is a failure, not an empty success. A model that answered "here is a sunset"
 * without attaching one has not produced the media, and reporting that as success hands the
 * parent a promise it will repeat to the user. Files of another kind do not count either —
 * an audio clip is not an answer to "draw me a chart".
 */
export function describeGeneratedMedia(
  response: Pick<AgentResponse, "content" | "artifacts">,
  modality: MediaModality,
  companionModel: string,
): ToolExecutionResult {
  const artifacts = (response.artifacts ?? []).filter((artifact) => artifact.kind === modality);
  const said = response.content.trim();
  if (artifacts.length === 0) {
    return {
      success: false,
      result: null,
      error:
        `${companionModel} returned no ${modality} file.` +
        (said.length > 0 ? ` It said: ${said.slice(0, 500)}` : ""),
    };
  }
  return {
    success: true,
    result: {
      artifacts,
      paths: artifacts.map((artifact) => artifact.path),
      ...(said.length > 0 ? { note: said } : {}),
    },
    artifacts,
  };
}

/** One delegated run: everything that differs between analysis and generation. */
interface CompanionJob {
  readonly role: CompanionRole;
  /** Exactly what the companion receives as its user message, already wrapped. */
  readonly input: string;
  /** One line describing the ask, shown in the ephemeral region while it runs. */
  readonly summary: string;
  readonly attachments: readonly MessageAttachment[];
}

export function createPerceptionTools(): Tool<ToolRequirements>[] {
  let companionCounter = 0;

  const runCompanion = (
    parentAgent: Agent,
    job: CompanionJob,
    companionAgent: Agent,
    context: ToolExecutionContext,
  ): Effect.Effect<AgentResponse, Error, ToolRequirements | ToolRegistry> =>
    Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;
      const presentation = yield* PresentationServiceTag;

      const label = companionAgent.name;
      const startedAt = Date.now();
      const regionId = yield* presentation.openEphemeralRegion("subagent", label);
      yield* presentation.appendEphemeralRegion(
        regionId,
        `Task: ${job.summary.length > 80 ? `...${job.summary.slice(-77)}` : job.summary}`,
      );

      yield* logger.info("Running model companion", {
        parentAgentId: parentAgent.id,
        companionModel: agentModelString(companionAgent.config),
        role: job.role,
        attachmentCount: job.attachments.length,
      });

      const response = yield* AgentRunner.runRecursive({
        agent: companionAgent,
        userInput: job.input,
        conversationId: generateConversationId("companion"),
        maxIterations: COMPANION_MAX_ITERATIONS,
        ephemeralRegionId: regionId,
        initialAttachments: [...job.attachments],
        // Eyes, ears and hands need no tools — and many media-capable models cannot
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
        artifactCount: response.artifacts?.length ?? 0,
      });

      return response;
    });

  /** An analysis companion's answer, or a plain note when it said nothing at all. */
  const runAnalysis = (
    parentAgent: Agent,
    args: AnalyzeMediaArgs,
    companionAgent: Agent,
    attachments: readonly MessageAttachment[],
    context: ToolExecutionContext,
  ): Effect.Effect<string, Error, ToolRequirements | ToolRegistry> =>
    runCompanion(
      parentAgent,
      {
        role: roleFor(args.modality),
        input: wrapAnalysisTask(args.task, roleFor(args.modality)),
        summary: args.task,
        attachments,
      },
      companionAgent,
      context,
    ).pipe(
      Effect.map((response) => response.content.trim() || "The companion returned no content."),
    );

  /** A generation companion's files, or a failure that names what it did instead. */
  const runGeneration = (
    parentAgent: Agent,
    args: GenerateMediaArgs,
    companionAgent: Agent,
    context: ToolExecutionContext,
  ): Effect.Effect<ToolExecutionResult, Error, ToolRequirements | ToolRegistry> =>
    runCompanion(
      parentAgent,
      {
        role: companionRole("generate", args.modality),
        input: wrapGenerationTask(args.prompt, args.modality),
        summary: args.prompt,
        attachments: [],
      },
      companionAgent,
      context,
    ).pipe(
      Effect.map((response) =>
        describeGeneratedMedia(response, args.modality, agentModelString(companionAgent.config)),
      ),
    );

  /**
   * Standing consent first, then a picker, then the kind refusal.
   *
   * Both directions take exactly this path — only the copy around it differs — so the
   * key-setup detour and the "nobody can pick here" wording live once. A bound companion
   * skips the prompt entirely, which is the only path an unattended run can take.
   */
  const resolveCompanion = (parentAgent: Agent, role: CompanionRole, toolName: string) =>
    Effect.gen(function* () {
      const logger = yield* LoggerServiceTag;
      const presentation = yield* PresentationServiceTag;

      const boundCompanion = parentAgent.config.companions?.[role];
      if (boundCompanion) {
        const companion = buildCompanionAgent(
          parentAgent,
          boundCompanion,
          role,
          ++companionCounter,
        );
        return (
          companion === null
            ? {
                kind: "unavailable",
                error: `Bound ${role} companion "${boundCompanion}" is not a valid provider/model id.`,
              }
            : { kind: "bound", companion }
        ) satisfies CompanionChoice;
      }

      let candidateList = yield* listCandidates(role);

      if (candidateList.available.length === 0) {
        const canPrompt = presentation.canPromptForApproval?.() === true;

        // The kind refusal: if a provider has capable models but no key, offer to
        // add one right here and rescan — the human never leaves the flow.
        if (canPrompt && candidateList.missingKeyProviders.length > 0) {
          const terminalOption = yield* Effect.serviceOption(TerminalServiceTag);
          if (Option.isSome(terminalOption)) {
            const terminal = terminalOption.value;
            const wantsKey = yield* terminal.confirm(
              `No model that can do ${describeRole(role)} is reachable yet. Add an API key now?`,
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
                  candidateList = yield* listCandidates(role);
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
            ? ` No model that can do ${describeRole(role)} is reachable yet: adding an API key for ${candidateList.missingKeyProviders.join(", ")} would fix this.`
            : ` No provider in the catalog currently offers a conversational model with ${describeRole(role)}.`;
        yield* logger.info(`${toolName} found no capable models`, {
          role,
          missingKeyProviders: candidateList.missingKeyProviders,
        });
        return {
          kind: "unavailable",
          error: canPrompt
            ? `Cannot delegate ${role}.${keyHint}`
            : `Cannot delegate ${role}: nobody can pick a companion in this session.${keyHint} Bind one ahead of time with \`jazz agent edit\` (companions).`,
        } satisfies CompanionChoice;
      }

      return {
        kind: "pick",
        options: candidateList.available.map((candidate) => ({
          id: candidate.id,
          label: candidate.model.displayName ?? candidate.model.modelId,
          detail: `${candidate.provider} · ${formatModelPriceLine(candidate.model)}`,
        })),
      } satisfies CompanionChoice;
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
        const parentAgent = context.parentAgent;
        if (!parentAgent) {
          return {
            success: false,
            result: null,
            error: "analyze_media requires parent agent context. This is a bug — please report it.",
          };
        }

        const resolution = yield* Effect.tryPromise({
          try: () => resolveMediaAttachments(args.mediaPaths, args.modality),
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

        const choice = yield* resolveCompanion(
          parentAgent,
          roleFor(args.modality),
          "analyze_media",
        );
        if (choice.kind === "unavailable") {
          return { success: false, result: null, error: choice.error };
        }
        if (choice.kind === "bound") {
          const content = yield* runAnalysis(
            parentAgent,
            args,
            choice.companion,
            resolution.attachments,
            context,
          );
          return { success: true, result: content };
        }

        const described = resolution.attachments
          .map((attachment) => `${attachment.kind}:${attachment.path}`)
          .join(", ");
        return {
          success: false,
          result: {
            approvalRequired: true,
            message:
              `Delegate ${args.modality} analysis to a capable model.\n` +
              `Media: ${described}\nTask: ${args.task}`,
            executeToolName: "execute_analyze_media",
            executeArgs: args as unknown as Record<string, unknown>,
            options: choice.options,
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
    validate: validateWithSelection(analyzeMediaSchema),
    handler: (args: WithSelection<AnalyzeMediaArgs>, context) =>
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
          roleFor(args.modality),
          ++companionCounter,
        );
        if (companionAgent === null) {
          return {
            success: false,
            result: null,
            error: `Picked companion "${selectedId}" is not a valid provider/model id.`,
          };
        }
        const resolution = yield* Effect.tryPromise({
          try: () => resolveMediaAttachments(args.mediaPaths, args.modality),
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
        const content = yield* runAnalysis(
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

  const generateProposalTool = defineTool({
    name: "generate_media",
    disclosure: "internal",
    longRunning: true,
    timeoutMs: COMPANION_TIMEOUT_MS,
    riskLevel: "high-risk",
    description:
      "Produce an image, audio clip, or video by delegating to a model that generates that " +
      "medium, and get the file back. Use this when the user asks you to make media your own " +
      "model cannot produce. The person at the keyboard picks which model draws; put the entire " +
      "brief into prompt — the companion sees nothing else of this conversation. If your own " +
      "model already produces this medium, do it yourself instead: that costs one call, not two.",
    parameters: generateMediaSchema,
    validate: makeZodValidator(generateMediaSchema),
    handler: (args: GenerateMediaArgs, context) =>
      Effect.gen(function* () {
        const parentAgent = context.parentAgent;
        if (!parentAgent) {
          return {
            success: false,
            result: null,
            error:
              "generate_media requires parent agent context. This is a bug — please report it.",
          };
        }

        const role = companionRole("generate", args.modality);
        const choice = yield* resolveCompanion(parentAgent, role, "generate_media");
        if (choice.kind === "unavailable") {
          return { success: false, result: null, error: choice.error };
        }
        if (choice.kind === "bound") {
          return yield* runGeneration(parentAgent, args, choice.companion, context);
        }

        return {
          success: false,
          result: {
            approvalRequired: true,
            message:
              `Delegate ${args.modality} generation to a capable model.\n` +
              `Brief: ${args.prompt}`,
            executeToolName: "execute_generate_media",
            executeArgs: args as unknown as Record<string, unknown>,
            options: choice.options,
          },
          error: "generate_media requires the person to pick a companion model.",
        };
      }),
  });

  const generateExecuteTool = defineTool({
    name: "execute_generate_media",
    disclosure: "internal",
    hidden: true,
    longRunning: true,
    timeoutMs: COMPANION_TIMEOUT_MS,
    riskLevel: "high-risk",
    description:
      "EXECUTION TOOL: runs the generation after a companion model was picked. Called by the system only.",
    parameters: generateMediaSchema,
    validate: validateWithSelection(generateMediaSchema),
    handler: (args: WithSelection<GenerateMediaArgs>, context) =>
      Effect.gen(function* () {
        const parentAgent = context.parentAgent;
        const selectedId = args[SELECTED_OPTION_KEY];
        if (!parentAgent || typeof selectedId !== "string") {
          return {
            success: false,
            result: null,
            error: "execute_generate_media reached without a picked companion. This is a bug.",
          };
        }
        const companionAgent = buildCompanionAgent(
          parentAgent,
          selectedId as `${string}/${string}`,
          companionRole("generate", args.modality),
          ++companionCounter,
        );
        if (companionAgent === null) {
          return {
            success: false,
            result: null,
            error: `Picked companion "${selectedId}" is not a valid provider/model id.`,
          };
        }
        return yield* runGeneration(parentAgent, args, companionAgent, context);
      }),
    createSummary: (result) => {
      if (!result.success) return `generate_media failed: ${result.error}`;
      const paths = (result.result as { paths?: readonly string[] }).paths ?? [];
      return `Companion generated ${paths.length} file(s): ${paths.join(", ")}`;
    },
  });

  return [
    proposalTool,
    executeTool,
    generateProposalTool,
    generateExecuteTool,
  ] as Tool<ToolRequirements>[];
}
