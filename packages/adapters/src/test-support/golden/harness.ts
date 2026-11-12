/**
 * Runs the real agent runner against a replayed model, for golden-session scenario tests.
 *
 * `createGoldenSession` wires the shipping pieces: `AgentRunner.run`, the agent loop, the real
 * tool registry and tool executor (with its approval gate), the run store used for parking, and
 * conversation persistence (`saveConversation` into a temp Jazz home, written from the runner's
 * `onCheckpoint` exactly as interactive chat does). Only the model is replayed and the tools a
 * scenario registers are scripted, so a run needs no keys, network or daemon.
 *
 * The session records what a scenario asserts on: `events` (every stream event the renderer
 * received), `checkpoints` (each transcript handed to `onCheckpoint`, with its phase), the
 * persisted conversation (`loadSaved`), and the replay's observed requests. Assert on those with
 * the helpers in `./transcript`, never by comparing text byte for byte.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { isRunParkRequested } from "@jazz/core/agent/run/park-signal";
import { resumeRun } from "@jazz/core/agent/run/resume";
import type { RunId } from "@jazz/core/agent/run/run-state";
import { createToolRegistryLayer } from "@jazz/core/agent/tools/tool-registry";
import type { AgentRunnerOptions, CheckpointPhase } from "@jazz/core/agent/types";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import type { AgentService } from "@jazz/core/interfaces/agent-service";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import type { FileSystemContextService } from "@jazz/core/interfaces/fs";
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import type { LoggerService } from "@jazz/core/interfaces/logger";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import type { MCPServerManager } from "@jazz/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@jazz/core/interfaces/mcp-server";
import type { PersonaService } from "@jazz/core/interfaces/persona-service";
import { PersonaServiceTag } from "@jazz/core/interfaces/persona-service";
import type { PresentationService } from "@jazz/core/interfaces/presentation";
import { PresentationServiceTag } from "@jazz/core/interfaces/presentation";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type Tool,
  type ToolRequirements,
} from "@jazz/core/interfaces/tool-registry";
import type { SkillService } from "@jazz/core/skills/skill-service";
import { SkillServiceTag } from "@jazz/core/skills/skill-service";
import type { StreamEvent } from "@jazz/core/types";
import type { Agent } from "@jazz/core/types/agent";
import type { ChatMessage } from "@jazz/core/types/message";
import { Cause, Effect, FileSystem, Layer } from "effect";
import type { z } from "zod";
import {
  EMPTY_CONVERSATION_REVISION,
  loadConversation,
  saveConversation,
  type ConversationRevision,
} from "../../history/conversation-history-service";
import type { GoldenFixture } from "../../llm/golden/fixture";
import { InMemoryRunStore } from "../../storage/run-store";
import { partialFake } from "../fakes";
import { createGoldenReplay, type GoldenReplay } from "./replay";

export const GOLDEN_PROVIDER = "openai";
export const GOLDEN_MODEL = "gpt-4";
export const GOLDEN_CONVERSATION_ID = "golden-conversation";
export const GOLDEN_AGENT_ID = "golden-agent";

/** A scripted tool a scenario registers in the real tool registry. */
export interface ScenarioTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodTypeAny;
  readonly riskLevel: Tool<ToolRequirements>["riskLevel"];
  readonly execute: (args: Record<string, unknown>) => Effect.Effect<unknown>;
}

export interface Checkpoint {
  readonly phase: CheckpointPhase;
  readonly messages: readonly ChatMessage[];
}

export interface GoldenSessionOptions {
  readonly fixture: GoldenFixture;
  readonly tools: readonly ScenarioTool[];
}

export interface GoldenRunOptions {
  readonly userInput: string;
  readonly conversationHistory?: readonly ChatMessage[];
  readonly parkWhenUnattended?: boolean;
  readonly autoApprovePolicy?: AgentRunnerOptions["autoApprovePolicy"];
  readonly maxIterations?: number;
}

type AnyLayerEffect<Value> = Effect.Effect<Value, unknown, never>;

export interface GoldenSession {
  readonly replay: GoldenReplay;
  readonly runStore: InMemoryRunStore;
  readonly jazzHome: string;
  readonly events: StreamEvent[];
  readonly checkpoints: Checkpoint[];
  /** Runs one turn; resolves to the exit so a parked or failed run is data, not a throw. */
  run(options: GoldenRunOptions): Promise<GoldenRunExit>;
  /** Resumes the first parked run with the given approval. */
  resumeParked(approved: boolean): Promise<GoldenRunExit>;
  /** Starts a turn and hands back its fiber so the test can interrupt it mid-batch. */
  start(options: GoldenRunOptions): {
    readonly interrupt: () => Promise<void>;
    readonly done: Promise<GoldenRunExit>;
  };
  loadSaved(): Promise<readonly ChatMessage[]>;
  parkedRunId(): Promise<RunId | undefined>;
  cleanup(): void;
}

export type GoldenRunExit =
  | {
      readonly kind: "completed";
      readonly content: string;
      readonly messages: readonly ChatMessage[];
      readonly iterationLimited: boolean;
    }
  | { readonly kind: "parked" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "interrupted" };

const STARTED_AT = "2026-01-01T00:00:00.000Z";

function silentLogger(): LoggerService {
  return partialFake<LoggerService>(new Proxy({}, { get: () => () => Effect.void }));
}

export function createGoldenSession(sessionOptions: GoldenSessionOptions): GoldenSession {
  const jazzHome = mkdtempSync(join(os.tmpdir(), "jazz-golden-"));
  const conversationsDir = join(jazzHome, "conversations");
  const replay = createGoldenReplay(sessionOptions.fixture);
  const runStore = new InMemoryRunStore();
  const events: StreamEvent[] = [];
  const checkpoints: Checkpoint[] = [];
  let savedRevision: ConversationRevision = EMPTY_CONVERSATION_REVISION;

  const registry = Effect.runSync(
    Effect.gen(function* () {
      return yield* ToolRegistryTag;
    }).pipe(Effect.provide(createToolRegistryLayer())),
  );
  for (const scripted of sessionOptions.tools) {
    const tool: Tool<ToolRequirements> = {
      name: scripted.name,
      description: scripted.description,
      summary: scripted.description,
      parameters: scripted.parameters,
      hidden: false,
      riskLevel: scripted.riskLevel,
      disclosure: "internal",
      egress: false,
      execute: (args) =>
        scripted.execute(args).pipe(Effect.map((result) => ({ success: true, result }))),
      createSummary: undefined,
    };
    Effect.runSync(registry.registerTool(tool));
  }

  const agent: Agent = {
    id: GOLDEN_AGENT_ID,
    name: GOLDEN_AGENT_ID,
    config: {
      persona: "default",
      llm: { provider: GOLDEN_PROVIDER, model: GOLDEN_MODEL },
      tools: sessionOptions.tools.map((tool) => tool.name),
    },
    createdAt: new Date(STARTED_AT),
    updatedAt: new Date(STARTED_AT),
  };

  const renderer = {
    handleEvent: (event: StreamEvent) => Effect.sync(() => void events.push(event)),
    setInterruptHandler: () => Effect.void,
    reset: () => Effect.void,
    flush: () => Effect.void,
  };

  const quiet = () => Effect.void;
  const presentation = partialFake<PresentationService>({
    createStreamingRenderer: () => Effect.succeed(renderer),
    presentThinking: quiet,
    presentThinkingEnd: quiet,
    renderMarkdown: (content: string) => Effect.succeed(content),
    presentAgentResponse: quiet,
    presentCompletion: quiet,
    presentWarning: quiet,
    presentStatus: quiet,
    writeOutput: quiet,
    writeBlankLine: quiet,
    writeError: quiet,
    formatToolExecutionStart: () => Effect.succeed(""),
    formatToolExecutionComplete: () => Effect.succeed(""),
    formatToolResult: () => "",
    formatToolExecutionError: () => Effect.succeed(""),
    formatToolsDetected: () => Effect.succeed(""),
    signalToolExecutionStarted: quiet,
    canPromptForApproval: () => false,
    requestApproval: () => Effect.succeed({ approved: false as const }),
  });

  const layers = Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, silentLogger()),
    Layer.succeed(PresentationServiceTag, presentation),
    Layer.succeed(ToolRegistryTag, registry),
    replay.layer,
    Layer.succeed(
      AgentServiceTag,
      partialFake<AgentService>({
        getAgent: () => Effect.succeed(agent),
        listAgents: () => Effect.succeed([agent]),
      }),
    ),
    Layer.succeed(RunStoreTag, runStore),
    Layer.succeed(
      SkillServiceTag,
      partialFake<SkillService>({ listSkills: () => Effect.succeed([]) }),
    ),
    Layer.succeed(
      AgentConfigServiceTag,
      partialFake<AgentConfigService>({
        appConfig: Effect.succeed({
          output: { showMetrics: false, streaming: { enabled: true }, mode: "text" as const },
          llm: { openai: { api_key: "golden-replay-key" } },
        }),
        get: () => Effect.succeed(undefined),
        getOrElse: (_key: string, fallback: unknown) => Effect.succeed(fallback),
        getOrFail: () => Effect.succeed(undefined),
        has: () => Effect.succeed(false),
        set: () => Effect.void,
      }),
    ),
    Layer.succeed(
      PersonaServiceTag,
      partialFake<PersonaService>({
        getPersonaByIdentifier: () =>
          Effect.succeed({
            name: "default",
            description: "golden replay persona",
            systemPrompt: "You are a replayed test agent.",
          }),
      }),
    ),
    Layer.succeed(MCPServerManagerTag, partialFake<MCPServerManager>({})),
    Layer.succeed(TerminalServiceTag, partialFake<TerminalService>({})),
    Layer.succeed(FileSystem.FileSystem, partialFake<FileSystem.FileSystem>({})),
    Layer.succeed(
      FileSystemContextServiceTag,
      partialFake<FileSystemContextService>({
        getCwd: () => Effect.succeed(jazzHome),
        setCwd: () => Effect.void,
      }),
    ),
  );

  const saveCheckpoint = (messages: readonly ChatMessage[]): Effect.Effect<void, Error> =>
    saveConversation(
      {
        conversationId: GOLDEN_CONVERSATION_ID,
        title: "",
        agentId: GOLDEN_AGENT_ID,
        startedAt: STARTED_AT,
        messages: [...messages],
        basedOn: savedRevision,
      },
      conversationsDir,
    ).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.tap((revision) =>
        Effect.sync(() => {
          savedRevision = revision;
        }),
      ),
      Effect.asVoid,
      Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
    );

  const program = (options: GoldenRunOptions): AnyLayerEffect<unknown> =>
    AgentRunner.run({
      agent,
      userInput: options.userInput,
      conversationId: GOLDEN_CONVERSATION_ID,
      stream: true,
      ...(options.conversationHistory
        ? { conversationHistory: [...options.conversationHistory] }
        : {}),
      ...(options.parkWhenUnattended ? { parkWhenUnattended: true } : {}),
      ...(options.autoApprovePolicy ? { autoApprovePolicy: options.autoApprovePolicy } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      onCheckpoint: (messages, phase) => {
        checkpoints.push({ phase, messages: [...messages] });
        return saveCheckpoint(messages);
      },
    }).pipe(Effect.provide(layers)) as AnyLayerEffect<unknown>;

  const toExit = (
    exit: Awaited<ReturnType<typeof Effect.runPromiseExit<unknown, unknown>>>,
  ): GoldenRunExit => {
    if (exit._tag === "Success") {
      const response = exit.value as {
        content: string;
        messages?: ChatMessage[];
        iterationLimited?: boolean;
      };
      return {
        kind: "completed",
        content: response.content,
        messages: response.messages ?? [],
        iterationLimited: response.iterationLimited === true,
      };
    }
    if (Cause.hasInterrupts(exit.cause)) {
      return { kind: "interrupted" };
    }
    const value = Cause.squash(exit.cause);
    return isRunParkRequested(value) ? { kind: "parked" } : { kind: "failed", error: value };
  };

  /** Saves a finished turn's transcript the way chat does when a turn ends cleanly. */
  const settle = async (exit: GoldenRunExit): Promise<GoldenRunExit> => {
    if (exit.kind === "completed") {
      await Effect.runPromise(saveCheckpoint(exit.messages));
    }
    return exit;
  };

  return {
    replay,
    runStore,
    jazzHome,
    events,
    checkpoints,
    run: async (options) => settle(toExit(await Effect.runPromiseExit(program(options)))),
    resumeParked: async (approved) => {
      const parked = (await Effect.runPromise(runStore.list()))[0];
      if (parked === undefined) {
        throw new Error("no parked run to resume");
      }
      const exit = await Effect.runPromiseExit(
        resumeRun({ runId: parked.runId, outcome: { kind: "approval", value: { approved } } }).pipe(
          Effect.provide(layers),
        ) as AnyLayerEffect<unknown>,
      );
      return settle(toExit(exit));
    },
    start: (options) => {
      const controller = new AbortController();
      const done = Effect.runPromiseExit(program(options), { signal: controller.signal }).then(
        (exit) => settle(toExit(exit)),
      );
      return {
        interrupt: async () => {
          controller.abort();
          await done;
        },
        done,
      };
    },
    loadSaved: async () => {
      const loaded = await Effect.runPromise(
        loadConversation(GOLDEN_AGENT_ID, GOLDEN_CONVERSATION_ID, conversationsDir).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      );
      return loaded?.messages ?? [];
    },
    parkedRunId: async () => (await Effect.runPromise(runStore.list()))[0]?.runId,
    cleanup: () => rmSync(jazzHome, { recursive: true, force: true }),
  };
}
