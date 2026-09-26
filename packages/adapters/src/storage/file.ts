/**
 * Implements `StorageService`: agents persisted as one JSON file per agent on the local
 * filesystem.
 */

import { FileSystem } from "@effect/platform";
import { normalizeToolConfig } from "@jazz/core/agent/utils/tool-config";
import { StorageServiceTag, type StorageService } from "@jazz/core/interfaces/storage";
import {
  AgentConfigurationError,
  StorageError,
  StorageNotFoundError,
} from "@jazz/core/types/errors";
import type { Agent, AgentConfig } from "@jazz/core/types/index";
import { parseJson } from "@jazz/core/utils/json";
import { migrateAgentProviderName } from "@jazz/core/utils/provider-migration";
import { writeFileStringAtomic } from "@jazz/core/utils/storage";
import { Effect, Layer, Option } from "effect";

/**
 * Agent JSON may omit its timestamps: a hand-written or repo-template agent has no reason to
 * carry them. A missing or invalid one falls back to the file's own times, so an agent keeps
 * the same dates on every read instead of looking newly created each time it is loaded.
 */
function resolveAgentFileTimestamps(
  raw: { readonly createdAt?: unknown; readonly updatedAt?: unknown },
  file: { readonly createdAt: Date; readonly updatedAt: Date },
): { readonly createdAt: Date; readonly updatedAt: Date } {
  const parse = (value: unknown): Date | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  };
  const createdAt = parse(raw.createdAt) ?? file.createdAt;
  return { createdAt, updatedAt: parse(raw.updatedAt) ?? file.updatedAt };
}

export class FileStorageService implements StorageService {
  constructor(
    private readonly basePath: string,
    private readonly fs: FileSystem.FileSystem,
  ) {}

  private isNotFoundError(error: unknown): boolean {
    if (error && typeof error === "object") {
      const tag = (error as { _tag?: string })._tag;
      if (tag === "NotFound") {
        return true;
      }

      const code = (error as { code?: string }).code;
      if (code === "ENOENT") {
        return true;
      }

      const causeCode = (error as { cause?: { code?: string } }).cause?.code;
      if (causeCode === "ENOENT") {
        return true;
      }

      const message = (error as { message?: string }).message;
      if (typeof message === "string" && message.includes("ENOENT")) {
        return true;
      }
    }

    return false;
  }

  private mapReadError(path: string, error: unknown): StorageError | StorageNotFoundError {
    if (this.isNotFoundError(error)) {
      return new StorageNotFoundError({
        path,
        suggestion: "Verify the requested resource exists or create it first.",
      });
    }

    const reason =
      error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

    return new StorageError({
      operation: "read",
      path,
      reason: `Failed to read file: ${reason}`,
    });
  }

  private getAgentsDir(): string {
    return `${this.basePath}/agents`;
  }

  private getAgentPath(id: string): string {
    return `${this.getAgentsDir()}/${id}.json`;
  }

  private ensureDirectoryExists(path: string): Effect.Effect<void, StorageError> {
    return Effect.gen(
      function* (this: FileStorageService) {
        yield* this.fs.makeDirectory(path, { recursive: true }).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                operation: "mkdir",
                path,
                reason: `Failed to create directory: ${String(error)}`,
              }),
          ),
          Effect.catchAll(() => Effect.void), // Ignore if directory already exists
        );
      }.bind(this),
    );
  }

  private readAgentFile(path: string): Effect.Effect<Agent, StorageError | StorageNotFoundError> {
    return Effect.gen(
      function* (this: FileStorageService) {
        const content = yield* this.fs
          .readFileString(path)
          .pipe(Effect.mapError((error) => this.mapReadError(path, error)));

        const parsed = yield* parseJson<unknown>(content).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                operation: "read",
                path,
                reason: `Invalid JSON format: ${error.message}`,
              }),
          ),
        );

        // Rewrite the legacy "google" provider name in place. Doing this on read
        // rather than as a one-shot startup pass also repairs agent files that
        // show up later, from a backup or a synced machine.
        const migration = migrateAgentProviderName(parsed);
        if (migration.changed) {
          yield* this.writeJsonFile(path, migration.record).pipe(
            Effect.catchAll(() => Effect.void),
          );
        }

        const rawData = migration.record as Omit<Agent, "createdAt" | "updatedAt"> & {
          readonly createdAt?: string;
          readonly updatedAt?: string;
        };

        let normalizedTools: readonly string[];
        try {
          normalizedTools = normalizeToolConfig(rawData.config?.tools, {
            agentId: rawData.id,
          });
        } catch (error) {
          if (error instanceof AgentConfigurationError) {
            return yield* Effect.fail(
              new StorageError({
                operation: "read",
                path,
                reason: `Invalid tool configuration: ${error.message}`,
              }),
            );
          }
          throw error;
        }

        const { tools: _existingTools, ...configWithoutTools } = rawData.config;
        void _existingTools;

        const rawConfig = configWithoutTools as Record<string, unknown>;
        if (!rawConfig["persona"]) {
          rawConfig["persona"] = rawConfig["agentType"] || "default";
        }

        const baseConfig = rawConfig as unknown as AgentConfig;
        const configWithNormalizedTools: AgentConfig =
          normalizedTools.length > 0 ? { ...baseConfig, tools: normalizedTools } : baseConfig;

        const info = yield* this.fs.stat(path).pipe(Effect.option);
        const modified = Option.flatMap(info, (stat) => stat.mtime);
        const fileTimes = {
          createdAt: Option.getOrElse(
            Option.orElse(
              Option.flatMap(info, (stat) => stat.birthtime),
              () => modified,
            ),
            () => new Date(),
          ),
          updatedAt: Option.getOrElse(modified, () => new Date()),
        };
        const { createdAt, updatedAt } = resolveAgentFileTimestamps(rawData, fileTimes);

        const agent: Agent = {
          ...rawData,
          config: configWithNormalizedTools,
          createdAt,
          updatedAt,
        };

        return agent;
      }.bind(this),
    );
  }

  private writeJsonFile<T>(path: string, data: T): Effect.Effect<void, StorageError> {
    return Effect.gen(
      function* (this: FileStorageService) {
        const content = JSON.stringify(data, null, 2);
        yield* writeFileStringAtomic(this.fs, path, content, { tempPrefix: "agent" }).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                operation: "write",
                path,
                reason: `Failed to write file: ${String(error)}`,
              }),
          ),
        );
      }.bind(this),
    );
  }

  private listJsonFiles(dir: string): Effect.Effect<readonly string[], StorageError> {
    return Effect.gen(
      function* (this: FileStorageService) {
        yield* this.ensureDirectoryExists(dir);
        const files = yield* this.fs.readDirectory(dir).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                operation: "list",
                path: dir,
                reason: `Failed to list directory: ${String(error)}`,
              }),
          ),
        );
        return files.filter((file: string) => file.endsWith(".json"));
      }.bind(this),
    );
  }

  saveAgent(agent: Agent): Effect.Effect<void, StorageError> {
    return Effect.gen(
      function* (this: FileStorageService) {
        const dir = this.getAgentsDir();
        yield* this.ensureDirectoryExists(dir);
        const path = this.getAgentPath(agent.id);
        yield* this.writeJsonFile(path, agent);
      }.bind(this),
    );
  }

  getAgent(id: string): Effect.Effect<Agent, StorageError | StorageNotFoundError> {
    const path = this.getAgentPath(id);
    return this.readAgentFile(path);
  }

  listAgents(): Effect.Effect<readonly Agent[], StorageError> {
    return Effect.gen(
      function* (this: FileStorageService) {
        const dir = this.getAgentsDir();
        const files = yield* this.listJsonFiles(dir);

        const agents: Agent[] = [];
        for (const file of files) {
          const path = `${dir}/${file}`;
          const agent = yield* this.readAgentFile(path).pipe(
            Effect.catchAll(() => Effect.void), // Skip corrupted files
          );
          if (agent) {
            agents.push(agent);
          }
        }

        return agents;
      }.bind(this),
    );
  }

  deleteAgent(id: string): Effect.Effect<void, StorageError | StorageNotFoundError> {
    return Effect.gen(
      function* (this: FileStorageService) {
        const path = this.getAgentPath(id);
        yield* this.fs.remove(path).pipe(
          Effect.mapError((error) => {
            if (
              error instanceof Error &&
              (error as unknown as { cause: { code: string } }).cause.code.includes("ENOENT")
            ) {
              return new StorageNotFoundError({ path });
            }

            return new StorageError({
              operation: "delete",
              path,
              reason: `Failed to delete file: ${String(error)}`,
            });
          }),
        );
      }.bind(this),
    );
  }
}

export function createFileStorageLayer(
  basePath: string,
): Layer.Layer<StorageService, never, FileSystem.FileSystem> {
  return Layer.effect(
    StorageServiceTag,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return new FileStorageService(basePath, fs);
    }),
  );
}
