import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LLMServiceTag } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { TerminalService } from "@/core/interfaces/terminal";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import type { Agent } from "@/core/types/agent";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import * as modelsDevActual from "@/core/utils/models-dev";

// Deterministic catalog for the unconfigured-provider lookup: openai has an
// image-capable chat model, everything else is absent.
mock.module("@/core/utils/models-dev", () => ({
  ...modelsDevActual,
  getModelsDevProviderModels: async (providerId: string) => {
    if (providerId !== "openai") throw new Error(`provider ${providerId} not in catalog`);
    return [
      {
        id: "gpt-5-vision",
        displayName: "GPT-5 Vision",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        metadata: {
          contextWindow: 128000,
          supportsTools: true,
          isReasoningModel: false,
          ingestImage: true,
          ingestPdf: false,
          ingestAudio: false,
          ingestVideo: false,
          generatesImage: false,
          generatesAudio: false,
          generatesVideo: false,
          supportsTemperature: true,
        },
      },
    ];
  },
}));

// Imported after mock.module so the tool's catalog lookup sees the stub.
const { createPerceptionTools, describeGeneratedMedia } = await import("./perception-tools");

const parentAgent: Agent = {
  id: "agent-parent",
  name: "Text Agent",
  description: "",
  config: {
    persona: "default",
    llmProvider: "mistral",
    llmModel: "mistral-small",
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    agentId: parentAgent.id,
    parentAgent,
    ...overrides,
  } as ToolExecutionContext;
}

const logger = {
  info: () => Effect.void,
  debug: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
} as unknown as LoggerService;

function makePresentation(canPrompt: boolean): PresentationService {
  return {
    canPromptForApproval: () => canPrompt,
    openEphemeralRegion: () => Effect.succeed("region"),
    appendEphemeralRegion: () => Effect.void,
    collapseEphemeralRegion: () => Effect.void,
  } as unknown as PresentationService;
}

/** Both providers configured, so the proposal path never touches the models.dev catalog. */
function makeLlmService(): LLMService {
  const textOnly = {
    id: "mistral-small",
    displayName: "Mistral Small",
    supportsTools: true,
    ingestImage: false,
  };
  const visionOnly = {
    id: "gemma4:12b",
    displayName: "Gemma 4 12B",
    supportsTools: false,
    ingestImage: true,
  };
  const painter = {
    id: "draws-things",
    displayName: "Draws Things",
    supportsTools: false,
    generatesImage: true,
  };
  return {
    listProviders: () =>
      Effect.succeed([
        { name: "mistral", configured: true },
        { name: "ollama", configured: true },
      ]),
    getProvider: (name: string) =>
      Effect.succeed({
        name,
        supportedModels: name === "ollama" ? [visionOnly, painter] : [textOnly],
        defaultModel: "x",
        authenticate: () => Effect.void,
      }),
  } as unknown as LLMService;
}

let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "jazz-perception-test-"));
  await mkdir(directory, { recursive: true });
  // Minimal valid PNG header so resolution and probing succeed.
  await writeFile(
    join(directory, "shot.png"),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from("IHDR", "ascii"),
      Buffer.from([0, 0, 0, 1]),
      Buffer.from([0, 0, 0, 1]),
      Buffer.alloc(9),
    ]),
  );
});

afterAll(async () => {
  await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true, force: true }));
});

interface ProposalOutcome {
  readonly success: boolean;
  readonly result: unknown;
  readonly error?: string;
}

function runProposal(args: Record<string, unknown>, context: ToolExecutionContext) {
  const tools = createPerceptionTools();
  const proposal = tools.find((candidate) => candidate.name === "analyze_media")!;
  const layer = Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, logger),
    Layer.succeed(PresentationServiceTag, makePresentation(true)),
    Layer.succeed(LLMServiceTag, makeLlmService()),
  );
  return Effect.runPromise(
    proposal.execute(args, context).pipe(Effect.provide(layer)) as Effect.Effect<
      ToolExecutionResult,
      Error,
      never
    >,
  ) as Promise<ProposalOutcome>;
}

describe("analyze_media empty state", () => {
  it("offers API-key setup, saves it, rescans, and then proposes the picker", async () => {
    let openaiConfigured = false;
    const setCalls: string[] = [];

    const llmService: LLMService = {
      listProviders: () =>
        Effect.succeed([
          { name: "mistral", configured: true },
          { name: "openai", configured: openaiConfigured },
        ]),
      getProvider: (name: string) =>
        Effect.succeed({
          name,
          supportedModels:
            name === "openai" && openaiConfigured
              ? [
                  {
                    id: "gpt-5",
                    displayName: "GPT-5",
                    supportsTools: true,
                    ingestImage: true,
                    inputPricePerMillion: 1.25,
                  },
                ]
              : [],
          defaultModel: "x",
          authenticate: () => Effect.void,
        }),
    } as unknown as LLMService;

    const terminal = {
      confirm: () => Effect.succeed(true),
      ask: () => Effect.succeed("sk-test-key"),
      success: () => Effect.void,
    };
    const configService = {
      set: (_key: string, _value: unknown) =>
        Effect.sync(() => {
          setCalls.push(_key);
          openaiConfigured = true;
        }),
    };

    const tools = createPerceptionTools();
    const proposal = tools.find((candidate) => candidate.name === "analyze_media")!;
    const layer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, logger),
      Layer.succeed(PresentationServiceTag, makePresentation(true)),
      Layer.succeed(LLMServiceTag, llmService),
      Layer.succeed(TerminalServiceTag, terminal as unknown as TerminalService),
      Layer.succeed(AgentConfigServiceTag, configService as unknown as AgentConfigService),
    );

    const outcome = (await Effect.runPromise(
      proposal
        .execute(
          {
            modality: "image",
            task: "what is this?",
            mediaPaths: [join(directory, "shot.png")],
          },
          makeContext(),
        )
        .pipe(Effect.provide(layer)) as Effect.Effect<ToolExecutionResult, Error, never>,
    )) as ProposalOutcome;

    expect(setCalls).toEqual(["llm.openai.api_key"]);
    const result = outcome.result as { approvalRequired: boolean; options?: { id: string }[] };
    expect(result.approvalRequired).toBe(true);
    expect(result.options?.map((option) => option.id)).toEqual(["openai/gpt-5"]);
  });

  it("falls back to guidance when the person declines key setup", async () => {
    const llmService: LLMService = {
      listProviders: () =>
        Effect.succeed([
          { name: "mistral", configured: true },
          { name: "openai", configured: false },
        ]),
      getProvider: (name: string) =>
        Effect.succeed({
          name,
          supportedModels: [
            { id: "mistral-small", displayName: "Mistral Small", supportsTools: true },
          ],
          defaultModel: "x",
          authenticate: () => Effect.void,
        }),
    } as unknown as LLMService;

    const terminal = {
      confirm: () => Effect.succeed(false),
    };
    const tools = createPerceptionTools();
    const proposal = tools.find((candidate) => candidate.name === "analyze_media")!;
    const layer = Layer.mergeAll(
      Layer.succeed(LoggerServiceTag, logger),
      Layer.succeed(PresentationServiceTag, makePresentation(true)),
      Layer.succeed(LLMServiceTag, llmService),
      Layer.succeed(TerminalServiceTag, terminal as unknown as TerminalService),
    );

    const outcome = (await Effect.runPromise(
      proposal
        .execute(
          {
            modality: "image",
            task: "t",
            mediaPaths: [join(directory, "shot.png")],
          },
          makeContext(),
        )
        .pipe(Effect.provide(layer)) as Effect.Effect<ToolExecutionResult, Error, never>,
    )) as ProposalOutcome;

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("adding an API key for openai");
  });
});

describe("analyze_media proposal", () => {
  it("fails loudly when a named media file does not resolve", async () => {
    const outcome = await runProposal(
      { modality: "image", task: "describe", mediaPaths: ["/definitely/not/here.png"] },
      makeContext(),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("file not found");
  });

  it("refuses to delegate audio files to a vision companion", async () => {
    const outcome = await runProposal(
      { modality: "image", task: "describe", mediaPaths: ["anything.mp3"] },
      makeContext(),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("audio file was given for image analysis");
  });

  it("proposes picker-style approval listing only models that can actually see", async () => {
    const outcome = await runProposal(
      {
        modality: "image",
        task: "what is in this image?",
        mediaPaths: [join(directory, "shot.png")],
      },
      makeContext(),
    );

    expect(outcome.success).toBe(false);
    const result = outcome.result as {
      approvalRequired: boolean;
      executeToolName: string;
      options: { id: string; label: string; detail: string }[];
      message: string;
    };

    expect(result.approvalRequired).toBe(true);
    expect(result.executeToolName).toBe("execute_analyze_media");
    // The text-only provider's model is absent; only the capable one appears.
    expect(result.options).toHaveLength(1);
    expect(result.options[0]?.id).toBe("ollama/gemma4:12b");
    expect(result.options[0]?.detail).toContain("ollama");
    expect(result.options[0]?.detail).toContain("price unknown");
    expect(result.message).toContain("shot.png");
    expect(result.message).toContain("what is in this image?");
  });
});

function runTool(name: string, args: Record<string, unknown>, context: ToolExecutionContext) {
  const tool = createPerceptionTools().find((candidate) => candidate.name === name)!;
  const layer = Layer.mergeAll(
    Layer.succeed(LoggerServiceTag, logger),
    Layer.succeed(PresentationServiceTag, makePresentation(true)),
    Layer.succeed(LLMServiceTag, makeLlmService()),
  );
  return Effect.runPromise(
    tool.execute(args, context).pipe(Effect.provide(layer)) as Effect.Effect<
      ToolExecutionResult,
      Error,
      never
    >,
  ) as Promise<ProposalOutcome & { artifacts?: unknown[] }>;
}

describe("generate_media", () => {
  it("offers only models that generate the modality, never the ones that only read it", async () => {
    const outcome = await runTool(
      "generate_media",
      { modality: "image", prompt: "a red circle" },
      makeContext(),
    );

    const result = outcome.result as {
      approvalRequired: boolean;
      executeToolName: string;
      options: { id: string }[];
    };
    expect(result.approvalRequired).toBe(true);
    expect(result.executeToolName).toBe("execute_generate_media");
    expect(result.options.map((option) => option.id)).toEqual(["ollama/draws-things"]);
  });

  it("takes the bound companion instead of asking, so an unattended run can generate", async () => {
    // Asserted through a deliberately broken binding: it proves the bound branch was taken
    // without starting a real companion run.
    const outcome = await runTool(
      "generate_media",
      { modality: "image", prompt: "a red circle" },
      makeContext({
        parentAgent: {
          ...parentAgent,
          config: {
            ...parentAgent.config,
            companions: { "generate:image": "no-provider-here" as `${string}/${string}` },
          },
        },
      }),
    );

    expect(outcome.success).toBe(false);
    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain("is not a valid provider/model id");
  });
});

describe("what a generation companion came back with", () => {
  const artifact = {
    kind: "image" as const,
    path: "/tmp/circle.png",
    mediaType: "image/png",
    tool: "ollama/draws-things",
    source: "model" as const,
  };

  it("reports the file it produced, on the result the run loop reads", () => {
    const outcome = describeGeneratedMedia(
      { content: "Here it is.", artifacts: [artifact] },
      "image",
      "ollama/draws-things",
    );

    expect(outcome.success).toBe(true);
    expect((outcome.result as { paths: string[] }).paths).toEqual(["/tmp/circle.png"]);
    expect(outcome.artifacts).toHaveLength(1);
  });

  it("fails when the companion answered in words instead of producing the media", () => {
    // Reporting this as success hands the parent a promise it repeats to the user.
    const outcome = describeGeneratedMedia(
      { content: "I imagine a red circle on white.", artifacts: [] },
      "image",
      "ollama/draws-things",
    );

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("no image file");
    expect(outcome.error).toContain("I imagine a red circle");
  });

  it("ignores a file of the wrong modality", () => {
    const outcome = describeGeneratedMedia(
      {
        content: "",
        artifacts: [
          { ...artifact, kind: "audio" as const, path: "/tmp/n.mp3", mediaType: "audio/mpeg" },
        ],
      },
      "image",
      "ollama/draws-things",
    );

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("no image file");
  });
});
