import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import { PresentationServiceTag, type SecretInputOutcome } from "@/core/interfaces/presentation";
import {
  SavedSecretsServiceTag,
  type SavedSecretEntry,
  type SavedSecretsService,
} from "@/core/interfaces/saved-secrets";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import {
  ALLOW_READING_SECRETS_ENV_VAR,
  closeUserSecretStore,
  openUserSecretStore,
  type UserSecretStore,
} from "@/core/secrets/user-secrets";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { createShellCommandTools } from "./shell";
import {
  ASK_USER_SECRET_TOOL_NAME,
  INTERACTIVE_TOOL_NAMES,
  LIST_SAVED_SECRETS_TOOL_NAME,
  USE_SAVED_SECRET_TOOL_NAME,
  userInteractionTools,
} from "./user-interaction";

const SECRET = "cf-token-0123456789abcdef";

function toolNamed(name: string): Tool<ToolRequirements> {
  const tool = userInteractionTools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return tool;
}

class InMemorySavedSecrets implements SavedSecretsService {
  readonly values = new Map<string, string>();
  readonly entries = new Map<string, SavedSecretEntry>();
  reads = 0;

  readonly list = Effect.sync(() => [...this.entries.values()]);
  readonly read = (name: string) =>
    Effect.sync(() => {
      this.reads += 1;
      return this.values.get(name);
    });
  readonly save = (name: string, value: string, description: string) =>
    Effect.sync(() => {
      this.values.set(name, value);
      this.entries.set(name, { name, description, savedAt: "2026-10-04T10:00:00.000Z" });
      return true;
    });
  readonly remove = (name: string) =>
    Effect.sync(() => this.values.delete(name) && this.entries.delete(name));
  readonly storageDescription = Effect.succeed("memory");
}

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
  delete process.env[ALLOW_READING_SECRETS_ENV_VAR];
});

function run(
  tool: Tool<ToolRequirements>,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  saved: SavedSecretsService,
  typed: SecretInputOutcome = { kind: "declined" },
): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    tool.execute(args, context).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SavedSecretsServiceTag, saved),
          Layer.succeed(FileSystemContextServiceTag, {
            getCwd: () => Effect.succeed(process.cwd()),
          } as never),
          Layer.succeed(PresentationServiceTag, {
            canPromptForApproval: () => true,
            requestSecretInput: () => Effect.succeed(typed),
          } as never),
        ),
      ),
    ) as Effect.Effect<ToolExecutionResult, never, never>,
  );
}

function contextWith(store: UserSecretStore): ToolExecutionContext {
  return { agentId: "a", conversationId: "c", userSecrets: store };
}

describe("ask_user_secret saving", () => {
  it("saves a named secret with its prompt as the description", async () => {
    const saved = new InMemorySavedSecrets();
    const result = await run(
      toolNamed(ASK_USER_SECRET_TOOL_NAME),
      { prompt: "Cloudflare API token", name: "cloudflare-token" },
      contextWith(newStore()),
      saved,
      { kind: "provided", value: SECRET },
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain(USE_SAVED_SECRET_TOOL_NAME);
    expect(saved.values.get("cloudflare-token")).toBe(SECRET);
    expect(saved.entries.get("cloudflare-token")?.description).toBe("Cloudflare API token");
  });
});

describe("list_saved_secrets", () => {
  it("lists names and descriptions, never values", async () => {
    const saved = new InMemorySavedSecrets();
    await Effect.runPromise(saved.save("cloudflare-token", SECRET, "Cloudflare API token"));
    const result = await run(
      toolNamed(LIST_SAVED_SECRETS_TOOL_NAME),
      {},
      contextWith(newStore()),
      saved,
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain("cloudflare-token: Cloudflare API token");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(saved.reads).toBe(0);
  });

  it("stays available to runs nobody can answer", () => {
    expect(INTERACTIVE_TOOL_NAMES).not.toContain(LIST_SAVED_SECRETS_TOOL_NAME);
    expect(INTERACTIVE_TOOL_NAMES).not.toContain(USE_SAVED_SECRET_TOOL_NAME);
  });
});

describe("use_saved_secret", () => {
  async function savedHolding(): Promise<InMemorySavedSecrets> {
    const saved = new InMemorySavedSecrets();
    await Effect.runPromise(saved.save("cloudflare-token", SECRET, "Cloudflare API token"));
    return saved;
  }

  it("asks a person under every approval mode before reading the keyring", async () => {
    const saved = await savedHolding();
    const store = newStore();
    const proposal = await run(
      toolNamed(USE_SAVED_SECRET_TOOL_NAME),
      { name: "cloudflare-token" },
      contextWith(store),
      saved,
    );
    const request = proposal.result as {
      approvalRequired: boolean;
      message: string;
      alwaysAsk?: boolean;
    };
    expect(request.approvalRequired).toBe(true);
    expect(request.alwaysAsk).toBe(true);
    expect(request.message).toContain("[redacted:cloudflare-token]");
    expect(request.message).not.toContain(SECRET);
    expect(saved.reads).toBe(0);
    expect(store.valueOf("cloudflare-token")).toBeUndefined();
  });

  it("holds the value for the run once approved", async () => {
    const saved = await savedHolding();
    const store = newStore();
    const result = await run(
      toolNamed(`execute_${USE_SAVED_SECRET_TOOL_NAME}`),
      { name: "cloudflare-token" },
      contextWith(store),
      saved,
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain("[redacted:cloudflare-token]");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(store.valueOf("cloudflare-token")).toBe(SECRET);
  });

  it("loads without asking when the run allows reading secrets", async () => {
    process.env[ALLOW_READING_SECRETS_ENV_VAR] = "1";
    const saved = await savedHolding();
    const store = newStore();
    const result = await run(
      toolNamed(USE_SAVED_SECRET_TOOL_NAME),
      { name: "cloudflare-token" },
      contextWith(store),
      saved,
    );
    expect(result.success).toBe(true);
    expect(store.valueOf("cloudflare-token")).toBe(SECRET);
  });

  it("fails without asking when nothing is saved under the name", async () => {
    const result = await run(
      toolNamed(USE_SAVED_SECRET_TOOL_NAME),
      { name: "github-token" },
      contextWith(newStore()),
      new InMemorySavedSecrets(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("No secret is saved as github-token");
  });

  it("does not ask again for a secret the run already holds", async () => {
    const saved = await savedHolding();
    const store = newStore();
    store.hold("cloudflare-token", SECRET);
    const result = await run(
      toolNamed(USE_SAVED_SECRET_TOOL_NAME),
      { name: "cloudflare-token" },
      contextWith(store),
      saved,
    );
    expect(result.success).toBe(true);
    expect(saved.reads).toBe(0);
  });
});

describe("--dangerously-allow-reading-secrets", () => {
  it("drops the forced approval on a command that uses a secret", async () => {
    const store = newStore();
    store.hold("cloudflare-token", SECRET);
    const shell = createShellCommandTools();
    const proposalFor = () =>
      run(
        shell.approval,
        { command: "echo '[redacted:cloudflare-token]'", description: "Print it." },
        contextWith(store),
        new InMemorySavedSecrets(),
      );

    const guarded = (await proposalFor()).result as { alwaysAsk?: boolean };
    expect(guarded.alwaysAsk).toBe(true);

    process.env[ALLOW_READING_SECRETS_ENV_VAR] = "1";
    const allowed = (await proposalFor()).result as { alwaysAsk?: boolean };
    expect(allowed.alwaysAsk).toBeUndefined();
  });
});
