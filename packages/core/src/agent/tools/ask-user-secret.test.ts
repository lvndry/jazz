import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { isRunParkRequested } from "@/core/agent/run/park-signal";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import {
  PresentationServiceTag,
  type SecretInputOutcome,
  type SecretInputRequest,
} from "@/core/interfaces/presentation";
import { ToolRegistryTag, type Tool, type ToolRequirements } from "@/core/interfaces/tool-registry";
import {
  closeUserSecretStore,
  heldUserSecrets,
  openUserSecretStore,
  type UserSecretStore,
} from "@/core/secrets/user-secrets";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { defineApprovalTool, defineTool } from "./base-tool";
import { createReadPdfTool } from "./fs/read-pdf";
import { createWriteFileTools } from "./fs/write";
import { createShellCommandTools } from "./shell";
import { createToolRegistryLayer } from "./tool-registry";
import { toolKnownSecrets } from "./tool-secrets";
import {
  ASK_USER_SECRET_TOOL_NAME,
  INTERACTIVE_TOOL_NAMES,
  userInteractionTools,
} from "./user-interaction";
import { createWebFetchTool } from "./web-fetch";

const SECRET = "tr0ub4dor-and-3";
const askUserSecret = userInteractionTools.find((tool) => tool.name === ASK_USER_SECRET_TOOL_NAME);

const openStores: UserSecretStore[] = [];
function newStore(): UserSecretStore {
  const store = openUserSecretStore();
  openStores.push(store);
  return store;
}
afterEach(() => {
  for (const store of openStores.splice(0)) {
    closeUserSecretStore(store);
  }
});

function presentationAnswering(
  outcome: SecretInputOutcome,
  asked: SecretInputRequest[] = [],
  canPrompt = true,
) {
  return Layer.succeed(PresentationServiceTag, {
    canPromptForApproval: () => canPrompt,
    requestSecretInput: (request: SecretInputRequest) =>
      Effect.sync(() => {
        asked.push(request);
        return outcome;
      }),
  } as never);
}

function runAsk(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  outcome: SecretInputOutcome,
  asked: SecretInputRequest[] = [],
): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    askUserSecret!
      .execute(args, context)
      .pipe(Effect.provide(presentationAnswering(outcome, asked))) as Effect.Effect<
      ToolExecutionResult,
      never,
      never
    >,
  );
}

const logged: string[] = [];
const recordingLogger: LoggerService = {
  debug: (message, metadata) =>
    Effect.sync(() => void logged.push(JSON.stringify({ message, metadata }))),
  info: (message, metadata) =>
    Effect.sync(() => void logged.push(JSON.stringify({ message, metadata }))),
  warn: (message, metadata) =>
    Effect.sync(() => void logged.push(JSON.stringify({ message, metadata }))),
  error: (message, metadata) =>
    Effect.sync(() => void logged.push(JSON.stringify({ message, metadata }))),
  writeToFile: () => Effect.void,
  logToolCall: (name, args) => Effect.sync(() => void logged.push(JSON.stringify({ name, args }))),
  setLogGroup: () => Effect.void,
  clearLogGroup: () => Effect.void,
  pushLogGroup: () => Effect.void,
  popLogGroup: () => Effect.void,
};

const fileSystemContext: FileSystemContextService = {
  getCwd: () => Effect.succeed(process.cwd()),
  setCwd: () => Effect.void,
  resolvePath: (_key, path) =>
    Effect.gen(function* () {
      yield* FileSystem.FileSystem;
      return path.startsWith("/") ? path : `${process.cwd()}/${path}`;
    }),
  findDirectory: () => Effect.succeed({ results: [] as readonly string[] }),
  resolvePathForMkdir: (_key, path) =>
    Effect.gen(function* () {
      yield* FileSystem.FileSystem;
      return path;
    }),
  escapePath: (path) => path,
};

const configWithHeldSecret = {
  appConfig: Effect.succeed({}),
  knownSecrets: Effect.succeed([{ name: "llm.openai.api_key", value: "sk-held-config-value-123" }]),
} as never;

function registryLayer() {
  return Layer.mergeAll(
    createToolRegistryLayer(),
    Layer.provide(
      Layer.succeed(FileSystemContextServiceTag, fileSystemContext),
      NodeFileSystem.layer,
    ),
    NodeFileSystem.layer,
    Layer.succeed(LoggerServiceTag, recordingLogger),
    Layer.succeed(AgentConfigServiceTag, configWithHeldSecret),
  );
}

/** A local reader that takes a password, and echoes it so the test can see what arrived. */
function unlockTool(received: string[]): Tool<ToolRequirements> {
  return defineTool({
    name: "unlock_archive",
    description: "Open an encrypted archive.",
    disclosure: "private",
    userSecretArguments: ["password"],
    parameters: z.object({ path: z.string(), password: z.string() }),
    handler: (args: { path: string; password: string }) =>
      Effect.sync(() => {
        received.push(args.password);
        return { success: true, result: `opened ${args.path} with ${args.password}` };
      }),
  });
}

function executeThroughRegistry(
  tools: readonly Tool<ToolRequirements>[],
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      for (const tool of tools) {
        yield* registry.registerTool(tool);
      }
      return yield* registry.executeTool(name, args, context);
    }).pipe(Effect.provide(registryLayer())) as Effect.Effect<ToolExecutionResult, never, never>,
  );
}

describe("ask_user_secret", () => {
  it("returns a placeholder, never the value, and holds the value as a known secret", async () => {
    const store = newStore();
    const asked: SecretInputRequest[] = [];
    const result = await runAsk(
      { prompt: "Password for invoice.pdf", name: "pdf-password" },
      { agentId: "a", conversationId: "c", userSecrets: store },
      { kind: "provided", value: SECRET },
      asked,
    );

    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.result).toContain("[redacted:pdf-password]");
    expect(asked).toEqual([{ prompt: "Password for invoice.pdf", name: "pdf-password" }]);
    expect(store.valueOf("pdf-password")).toBe(SECRET);
    const known = await Effect.runPromise(toolKnownSecrets());
    expect(known).toContainEqual({ name: "pdf-password", value: SECRET });
  });

  it("names an unnamed secret secret-N, unique within the run", async () => {
    const store = newStore();
    const context = { agentId: "a", conversationId: "c", userSecrets: store };
    await runAsk({ prompt: "Token" }, context, { kind: "provided", value: "first-token-value" });
    const second = await runAsk({ prompt: "Other" }, context, {
      kind: "provided",
      value: "second-token-value",
    });
    expect(second.result).toContain("[redacted:secret-2]");
    expect(store.valueOf("secret-1")).toBe("first-token-value");
  });

  it("stops holding the value once the run's store is closed", async () => {
    const store = openUserSecretStore();
    await runAsk(
      { prompt: "Token", name: "vpn-token" },
      { agentId: "a", conversationId: "c", userSecrets: store },
      { kind: "provided", value: SECRET },
    );
    expect(heldUserSecrets()).toContainEqual({ name: "vpn-token", value: SECRET });
    closeUserSecretStore(store);
    expect(heldUserSecrets().some((secret) => secret.value === SECRET)).toBe(false);
    expect(store.valueOf("vpn-token")).toBeUndefined();
  });

  it("reports Esc as the person declining", async () => {
    const store = newStore();
    const result = await runAsk(
      { prompt: "Password" },
      { agentId: "a", conversationId: "c", userSecrets: store },
      { kind: "declined" },
    );
    expect(result.success).toBe(false);
    expect(result.result).toContain("chose not to type");
    expect(store.knownSecrets()).toEqual([]);
  });

  it("tells the model to move to a private chat when the chat is shared", async () => {
    const result = await runAsk(
      { prompt: "Password" },
      { agentId: "a", conversationId: "c", userSecrets: newStore() },
      { kind: "unavailable", reason: "shared-chat" },
    );
    expect(result.success).toBe(false);
    expect(result.result).toContain("private chat");
  });

  it("parks an unattended run with the prompt and name only", async () => {
    const effect = askUserSecret!.execute(
      { prompt: "Password for invoice.pdf", name: "pdf-password" },
      {
        agentId: "a",
        conversationId: "c",
        toolCallId: "call_1",
        parkWhenUnattended: true,
        userSecrets: newStore(),
      },
    );
    const exit = await Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(presentationAnswering({ kind: "provided", value: SECRET }, [], false)),
      ) as Effect.Effect<unknown, unknown>,
    );
    expect(exit._tag).toBe("Failure");
    const error =
      exit._tag === "Failure" && exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    expect(isRunParkRequested(error)).toBe(true);
    if (isRunParkRequested(error)) {
      expect(error.pending).toEqual({
        kind: "secret",
        toolCallId: "call_1",
        request: { prompt: "Password for invoice.pdf", name: "pdf-password" },
      });
    }
  });

  it("holds a secret typed for the parked call when the run resumes", async () => {
    const store = newStore();
    const result = await runAsk(
      { prompt: "Password", name: "pdf-password" },
      {
        agentId: "a",
        conversationId: "c",
        toolCallId: "call_1",
        userSecrets: store,
        resolvedUserSecrets: new Map([["call_1", { kind: "provided", value: SECRET }]]),
      },
      { kind: "declined" },
    );
    expect(result.success).toBe(true);
    expect(store.valueOf("pdf-password")).toBe(SECRET);
  });

  it("is withheld with the other tools that wait on a person", () => {
    expect(INTERACTIVE_TOOL_NAMES).toContain(ASK_USER_SECRET_TOOL_NAME);
  });
});

describe("typed secrets at the registry", () => {
  it("substitutes the value into a declared argument and redacts it from the result", async () => {
    const store = newStore();
    store.hold("pdf-password", SECRET);
    const received: string[] = [];
    logged.length = 0;
    const result = await executeThroughRegistry(
      [unlockTool(received)],
      "unlock_archive",
      { path: "a.zip", password: "[redacted:pdf-password]" },
      { agentId: "a", conversationId: "c", userSecrets: store },
    );

    expect(received).toEqual([SECRET]);
    expect(result.success).toBe(true);
    expect(result.result).toBe("opened a.zip with [redacted:pdf-password]");
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("never substitutes a held config secret's placeholder", async () => {
    const store = newStore();
    store.hold("pdf-password", SECRET);
    const received: string[] = [];
    await executeThroughRegistry(
      [unlockTool(received)],
      "unlock_archive",
      { path: "a.zip", password: "[redacted:llm.openai.api_key]" },
      { agentId: "a", conversationId: "c", userSecrets: store },
    );
    expect(received).toEqual(["[redacted:llm.openai.api_key]"]);
  });

  it("refuses a typed secret in an argument the tool does not declare", async () => {
    const store = newStore();
    store.hold("pdf-password", SECRET);
    const received: string[] = [];
    const result = await executeThroughRegistry(
      [unlockTool(received)],
      "unlock_archive",
      { path: "[redacted:pdf-password]", password: "[redacted:pdf-password]" },
      { agentId: "a", conversationId: "c", userSecrets: store },
    );
    expect(received).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("takes it only in password");
  });

  it("refuses a typed secret in a PDF URL, where it would leave the machine", async () => {
    const store = newStore();
    store.hold("pdf-password", SECRET);
    const result = await executeThroughRegistry(
      [createReadPdfTool()],
      "read_pdf",
      { url: "https://example.com/[redacted:pdf-password].pdf" },
      { agentId: "a", conversationId: "c", userSecrets: store },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("read_pdf takes it only in password");
  });

  it("refuses write_file and an egress tool", async () => {
    const store = newStore();
    store.hold("pdf-password", SECRET);
    const context = { agentId: "a", conversationId: "c", userSecrets: store };
    const writeTools = createWriteFileTools();
    const tools = [...writeTools.all(), createWebFetchTool(), unlockTool([])];

    const written = await executeThroughRegistry(
      tools,
      "write_file",
      { path: "/tmp/out.txt", content: "password=[redacted:pdf-password]" },
      context,
    );
    const writtenDirectly = await executeThroughRegistry(
      tools,
      "execute_write_file",
      { path: "/tmp/out.txt", content: "password=[redacted:pdf-password]" },
      context,
    );
    const fetched = await executeThroughRegistry(
      tools,
      "web_fetch",
      { url: "https://example.com/?p=[redacted:pdf-password]" },
      context,
    );

    for (const result of [written, writtenDirectly, fetched]) {
      expect(result.success).toBe(false);
      expect(result.error).toContain("stands for a secret the person typed");
      expect(result.error).toContain("unlock_archive (password)");
    }
  });

  it("keeps the placeholder in an approval and puts the value in only when the approved half runs", async () => {
    const store = newStore();
    store.hold("pdf-password", SECRET);
    const received: string[] = [];
    const pair = defineApprovalTool({
      name: "decrypt_disk",
      description: "Decrypt a disk image.",
      disclosure: "private",
      userSecretArguments: ["passphrase"],
      parameters: z.object({ passphrase: z.string() }),
      approvalMessage: (args: { passphrase: string }) =>
        Effect.succeed(`Decrypt with ${args.passphrase}`),
      handler: (args: { passphrase: string }) =>
        Effect.sync(() => {
          received.push(args.passphrase);
          return { success: true, result: "decrypted" };
        }),
    });
    const context = { agentId: "a", conversationId: "c", userSecrets: store };

    const proposal = await executeThroughRegistry(
      pair.all(),
      "decrypt_disk",
      { passphrase: "[redacted:pdf-password]" },
      context,
    );
    const request = proposal.result as { message: string; executeArgs: Record<string, unknown> };
    expect(request.message).toBe("Decrypt with [redacted:pdf-password]");
    expect(request.executeArgs).toEqual({ passphrase: "[redacted:pdf-password]" });
    expect(received).toEqual([]);

    await executeThroughRegistry(pair.all(), "execute_decrypt_disk", request.executeArgs, context);
    expect(received).toEqual([SECRET]);
  });

  it("runs an approved command with the value and asks a person every time", async () => {
    const store = newStore();
    store.hold("pdf-password", SECRET);
    const shell = createShellCommandTools();
    const context = { agentId: "a", conversationId: "c", userSecrets: store };
    const command = "printf '%s' '[redacted:pdf-password]'";
    logged.length = 0;

    const proposal = await executeThroughRegistry(
      shell.all(),
      "execute_command",
      { command, description: "Print it." },
      context,
    );
    const request = proposal.result as { message: string; alwaysAsk?: boolean };
    expect(request.message).toContain("[redacted:pdf-password]");
    expect(request.message).not.toContain(SECRET);
    expect(request.alwaysAsk).toBe(true);

    const ran = await executeThroughRegistry(
      shell.all(),
      "execute_execute_command",
      { command, description: "Print it." },
      context,
    );
    expect(ran.success).toBe(true);
    expect(ran.result).toHaveProperty("stdout", "[redacted:pdf-password]");
    expect(JSON.stringify(ran)).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  }, 15_000);

  it("leaves arguments alone when the run holds no typed secret", async () => {
    const received: string[] = [];
    await executeThroughRegistry(
      [unlockTool(received)],
      "unlock_archive",
      { path: "a.zip", password: "[redacted:pdf-password]" },
      { agentId: "a", conversationId: "c", userSecrets: newStore() },
    );
    expect(received).toEqual(["[redacted:pdf-password]"]);
  });
});

describe("tools that take a typed secret", () => {
  it("are the PDF readers' password and execute_command's command", () => {
    expect(createReadPdfTool().userSecretArguments).toEqual(["password"]);
    expect(createShellCommandTools().execute.userSecretArguments).toEqual(["command"]);
    expect(createWebFetchTool().userSecretArguments).toBeUndefined();
    expect(createWriteFileTools().execute.userSecretArguments).toBeUndefined();
  });
});
