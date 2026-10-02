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
 * - **A human, always, interactively.** The person first picks a provider from those with
 *   models capable of the requested role. If it needs an API key, Jazz asks for it in a
 *   masked prompt and stores it through the config service. The approval picker then lists
 *   only that provider's capable models; choosing and approving one is required before
 *   media is sent.
 * - **A pre-bound companion, unattended.** `config.companions["<action>:<modality>"]` names a
 *   `"provider/model"` chosen ahead of time; binding it *is* the consent, so bound runs
 *   skip the prompt entirely — which is what makes cron and bridge runs work where no
 *   one can answer a picker. During batch approval preflight, bound tools only resolve
 *   that consent; the companion runs after the entire batch is cleared to execute.
 *
 * When no capable provider is available, the failure says what would fix it — configure a
 * provider whose models support the requested role — rather than returning a bare refusal.
 */

import { Effect, Either, Option } from "effect";
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
import { childRunAuthority } from "./child-run-authority";

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
  modality: z.enum(["image", "audio", "video"]).describe("Media kind to analyze."),
  task: z.string().min(1).describe("Exactly what to extract and the answer shape you need."),
  mediaPaths: z.array(z.string().min(1)).min(1).max(8).describe("Absolute file paths."),
});

type AnalyzeMediaArgs = z.infer<typeof analyzeMediaSchema>;

const generateMediaSchema = z.object({
  modality: z.enum(["image", "audio", "video"]).describe("Media kind to produce."),
  prompt: z.string().min(1).describe("Complete standalone brief: subject, style, length, voice."),
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
      llm: { provider: parsed.provider, model: parsed.model },
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

/** What a companion run came to once any model switch was offered. */
type CompanionAttempt<Value> =
  | { readonly kind: "done"; readonly value: Value }
  | { readonly kind: "failed"; readonly error: string };

const CANCEL_RETRY_VALUE = "__cancel__";

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
      // A companion makes one tool-less completion, so there is no step boundary at
      // which a message could reach it.
      const regionId = yield* presentation.openEphemeralRegion("subagent", label, {
        agentRun: { task: job.summary, acceptsMessages: false },
      });
      yield* presentation.appendEphemeralRegion(
        regionId,
        `Task: ${job.summary.length > 80 ? `...${job.summary.slice(-77)}` : job.summary}`,
      );

      yield* logger.info("Running model companion", {
        parentAgentId: parentAgent.id,
        companionModel: agentModelString(companionAgent.config.llm),
        role: job.role,
        attachmentCount: job.attachments.length,
      });

      const response = yield* AgentRunner.runRecursive({
        agent: companionAgent,
        userInput: job.input,
        conversationId: generateConversationId("companion"),
        ...(context.telemetryTraceParent && {
          telemetryParent: {
            ...context.telemetryTraceParent,
            ...(context.toolCallId ? { parentToolCallId: context.toolCallId } : {}),
          },
        }),
        maxIterations: COMPANION_MAX_ITERATIONS,
        ephemeralRegionId: regionId,
        initialAttachments: [...job.attachments],
        ...childRunAuthority(context),
        // Eyes, ears and hands need no tools — and many media-capable models cannot
        // use them anyway. An empty allowlist strips every tool.
        toolAllowlist: [],
        subagentDepth: (context.subagentDepth ?? 0) + 1,
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
          !isZeroCostLocalModel(
            companionAgent.config.llm.provider,
            companionAgent.config.llm.model,
          ));
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
        describeGeneratedMedia(
          response,
          args.modality,
          agentModelString(companionAgent.config.llm),
        ),
      ),
    );

  /**
   * Runs a companion and, when it throws (credits exhausted, auth, quota, outage), offers the
   * person the other capable models instead of ending the delegation. Unattended sessions and
   * declined retries end with an error that names the failed model and what to do next.
   */
  const runWithRecovery = <Value>(
    parentAgent: Agent,
    role: CompanionRole,
    toolName: string,
    firstCompanion: Agent,
    run: (companion: Agent) => Effect.Effect<Value, Error, ToolRequirements | ToolRegistry>,
  ): Effect.Effect<CompanionAttempt<Value>, never, ToolRequirements | ToolRegistry> =>
    Effect.gen(function* () {
      const presentation = yield* PresentationServiceTag;
      const terminalOption = yield* Effect.serviceOption(TerminalServiceTag);
      const triedModels = new Set<string>();
      let companion = firstCompanion;

      while (true) {
        const attempt = yield* run(companion).pipe(Effect.either);
        if (Either.isRight(attempt)) {
          return { kind: "done", value: attempt.right } as const;
        }

        const failedModel = agentModelString(companion.config.llm);
        triedModels.add(failedModel);
        const reason = `${failedModel} failed: ${attempt.left.message}`;

        if (presentation.canPromptForApproval?.() !== true || Option.isNone(terminalOption)) {
          return {
            kind: "failed",
            error: `${reason}. Fix that provider's credentials or billing, or bind another model under companions["${role}"] in agent config.`,
          } as const;
        }

        const candidateList = yield* listCandidates(role);
        const alternatives = candidateList.available.filter(
          (candidate) => !triedModels.has(candidate.id),
        );
        if (alternatives.length === 0) {
          return {
            kind: "failed",
            error: `${reason}. No other capable model is available; add credentials for another provider.`,
          } as const;
        }

        const pickedId = yield* terminalOption.value.search<string>(
          `${reason}\nTry another model?`,
          {
            choices: [
              ...alternatives.map((candidate) => ({
                name: `${candidate.model.displayName ?? candidate.model.modelId}  —  ${candidate.provider} · ${formatModelPriceLine(candidate.model)}`,
                value: candidate.id,
              })),
              { name: "No, give up", value: CANCEL_RETRY_VALUE },
            ],
            placeholder: "Type to filter models",
          },
        );
        if (pickedId === undefined || pickedId === CANCEL_RETRY_VALUE) {
          return {
            kind: "failed",
            error: `${reason}. The person chose not to try another model; calling ${toolName} again reopens the model picker if they ask to retry.`,
          } as const;
        }

        const next = buildCompanionAgent(
          parentAgent,
          pickedId as `${string}/${string}`,
          role,
          ++companionCounter,
        );
        if (next === null) {
          return {
            kind: "failed",
            error: `${reason}. Picked companion "${pickedId}" is not a valid provider/model id.`,
          } as const;
        }
        companion = next;
      }
    });

  /**
   * Standing consent first, then a provider picker and a model approval, then the kind refusal.
   *
   * A bound companion skips prompts: binding it in agent config is standing consent. Interactive
   * runs choose a provider first, configure its credential if needed, then expose only that
   * provider's models capable of the requested role in the existing approval picker.
   */
  const resolveCompanion = (parentAgent: Agent, role: CompanionRole, _toolName: string) =>
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

      const canPrompt = presentation.canPromptForApproval?.() === true;
      if (!canPrompt) {
        const candidateList = yield* listCandidates(role);
        const keyHint =
          candidateList.missingKeyProviders.length > 0
            ? ` Add an API key for ${candidateList.missingKeyProviders.join(", ")} and bind a companion in agent config.`
            : " Bind a companion in agent config.";
        return {
          kind: "unavailable",
          error: `Cannot delegate ${role}: nobody can pick a companion in this session.${keyHint}`,
        } satisfies CompanionChoice;
      }

      const terminalOption = yield* Effect.serviceOption(TerminalServiceTag);
      if (Option.isNone(terminalOption)) {
        return {
          kind: "unavailable",
          error: `Cannot delegate ${role}: no interactive provider picker is available. Bind a companion in agent config.`,
        } satisfies CompanionChoice;
      }
      const terminal = terminalOption.value;
      let candidateList = yield* listCandidates(role);
      const providers = [
        ...new Set([
          ...candidateList.available.map((candidate) => candidate.provider),
          ...candidateList.missingKeyProviders,
        ]),
      ].sort((left, right) => left.localeCompare(right));

      if (providers.length === 0) {
        const message = `No provider in the catalog currently offers a conversational model with ${describeRole(role)}.`;
        yield* logger.info("No capable companion models available", { role });
        return { kind: "unavailable", error: message } satisfies CompanionChoice;
      }

      const provider = yield* terminal.search<string>(
        `Choose a provider for ${describeRole(role)}:`,
        {
          choices: providers.map((name) => ({
            name,
            value: name,
            ...(candidateList.missingKeyProviders.includes(name)
              ? { tag: "API key needed", tagTone: "warning" as const }
              : {}),
          })),
          placeholder: "Type to filter providers",
        },
      );
      if (provider === undefined) {
        return {
          kind: "unavailable",
          error: `No provider selected for ${role}; media delegation was cancelled.`,
        } satisfies CompanionChoice;
      }

      if (candidateList.missingKeyProviders.includes(provider)) {
        if (provider === "chatgpt") {
          return {
            kind: "unavailable",
            error:
              "ChatGPT uses subscription sign-in rather than an API key. Sign in with `jazz config`, then retry the companion selection.",
          } satisfies CompanionChoice;
        }
        const apiKey = yield* terminal.ask(`${provider} API key:`, {
          simple: true,
          secret: true,
          cancellable: true,
          placeholder: "Paste the key; Esc cancels",
        });
        if (apiKey === undefined || apiKey.trim().length === 0) {
          return {
            kind: "unavailable",
            error: `No API key was added for ${provider}; media delegation was cancelled.`,
          } satisfies CompanionChoice;
        }
        const configService = yield* AgentConfigServiceTag;
        yield* configService.set(`llm.${provider}.api_key`, apiKey.trim());
        yield* terminal.success(`${provider} API key saved.`);
        candidateList = yield* listCandidates(role);
      }

      const providerModels = candidateList.available.filter(
        (candidate) => candidate.provider === provider,
      );
      if (providerModels.length === 0) {
        const error = `No model from ${provider} is currently available for ${describeRole(role)}. Check its credentials and model access, then try again.`;
        return { kind: "unavailable", error } satisfies CompanionChoice;
      }

      return {
        kind: "pick",
        options: providerModels.map((candidate) => ({
          id: candidate.id,
          label: candidate.model.displayName ?? candidate.model.modelId,
          detail: `${candidate.provider} · ${formatModelPriceLine(candidate.model)}`,
        })),
      } satisfies CompanionChoice;
    });

  const proposalTool = defineTool({
    name: "analyze_media",
    approvalExecuteToolName: "execute_analyze_media",
    disclosure: "internal",
    longRunning: true,
    timeoutMs: COMPANION_TIMEOUT_MS,
    riskLevel: "high-risk",
    description:
      "Have another model analyze image, audio or video you cannot ingest, and get text back. It sees only mediaPaths and task.",
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
          if (context.approvalPhase === "preflight") {
            return { success: true, result: null };
          }
          const attempt = yield* runWithRecovery(
            parentAgent,
            roleFor(args.modality),
            "analyze_media",
            choice.companion,
            (companion) =>
              runAnalysis(parentAgent, args, companion, resolution.attachments, context),
          );
          return attempt.kind === "done"
            ? { success: true, result: attempt.value }
            : { success: false, result: null, error: attempt.error };
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
        const attempt = yield* runWithRecovery(
          parentAgent,
          roleFor(args.modality),
          "analyze_media",
          companionAgent,
          (companion) => runAnalysis(parentAgent, args, companion, resolution.attachments, context),
        );
        return attempt.kind === "done"
          ? { success: true, result: attempt.value }
          : { success: false, result: null, error: attempt.error };
      }),
    createSummary: (result) => {
      if (!result.success) return `analyze_media failed: ${result.error}`;
      const content = String(result.result);
      return `Companion analyzed the media (${content.length} chars)`;
    },
  });

  const generateProposalTool = defineTool({
    name: "generate_media",
    approvalExecuteToolName: "execute_generate_media",
    disclosure: "internal",
    longRunning: true,
    timeoutMs: COMPANION_TIMEOUT_MS,
    riskLevel: "high-risk",
    description:
      "Have another model generate an image, audio or video file for you. It sees only prompt.",
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
          if (context.approvalPhase === "preflight") {
            return { success: true, result: null };
          }
          const attempt = yield* runWithRecovery(
            parentAgent,
            role,
            "generate_media",
            choice.companion,
            (companion) => runGeneration(parentAgent, args, companion, context),
          );
          return attempt.kind === "done"
            ? attempt.value
            : { success: false, result: null, error: attempt.error };
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
        const attempt = yield* runWithRecovery(
          parentAgent,
          companionRole("generate", args.modality),
          "generate_media",
          companionAgent,
          (companion) => runGeneration(parentAgent, args, companion, context),
        );
        return attempt.kind === "done"
          ? attempt.value
          : { success: false, result: null, error: attempt.error };
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
