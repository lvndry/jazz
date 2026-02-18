import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Option } from "effect";
import shortuuid from "short-uuid";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PersonaServiceTag, type PersonaService } from "@/core/interfaces/persona-service";
import {
  PersonaAlreadyExistsError,
  PersonaNotFoundError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "@/core/types/errors";
import type { CreatePersonaInput, Persona } from "@/core/types/persona";
import { getUserDataDirectory } from "@/core/utils/runtime-detection";

/**
 * Names reserved for built-in personas.
 * Users cannot create custom personas with these names.
 */
export const BUILTIN_PERSONA_NAMES = ["default", "coder", "researcher"] as const;

/**
 * The summarizer persona is internal-only (used by the context summarization system).
 * It is never listed or selectable by users but can be resolved by name.
 */
const INTERNAL_PERSONA_NAMES = ["summarizer"] as const;

/**
 * Built-in persona metadata. System prompts are NOT stored here -- they live in
 * the prompt files (prompts/default/system.ts etc.) and are resolved by
 * AgentPromptBuilder. The PersonaService only needs metadata for listing/display.
 */
const BUILTIN_PERSONAS: readonly Persona[] = [
  {
    id: "builtin-default",
    name: "default",
    description: "A general-purpose assistant that can help with various tasks.",
    systemPrompt: "", // Resolved at runtime by AgentPromptBuilder
    tone: "helpful",
    style: "balanced",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "builtin-coder",
    name: "coder",
    description:
      "An expert software engineer specialized in code analysis, debugging, and implementation.",
    systemPrompt: "", // Resolved at runtime by AgentPromptBuilder
    tone: "technical",
    style: "precise",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
  {
    id: "builtin-researcher",
    name: "researcher",
    description:
      "A meticulous researcher specialized in deep exploration, source synthesis, and evidence-backed conclusions.",
    systemPrompt: "", // Resolved at runtime by AgentPromptBuilder
    tone: "analytical",
    style: "thorough",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  },
];

/**
 * Check if a persona name is a built-in or internal persona.
 */
export function isBuiltinPersona(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (BUILTIN_PERSONA_NAMES as readonly string[]).includes(lower) ||
    (INTERNAL_PERSONA_NAMES as readonly string[]).includes(lower)
  );
}

/**
 * Check if a persona ID belongs to a built-in persona.
 */
export function isBuiltinPersonaId(id: string): boolean {
  return id.startsWith("builtin-");
}

/**
 * Options for PersonaServiceImpl construction.
 * @internal Used for testing; production uses default from getUserDataDirectory().
 */
export interface PersonaServiceImplOptions {
  /** Override base data directory (for tests). Default: getUserDataDirectory(). */
  readonly baseDataPath?: string;
}

/**
 * File-based PersonaService implementation
 *
 * Stores custom personas as JSON files in .jazz/personas/<id>.json.
 * Also surfaces built-in personas (default, coder, researcher) for listing.
 * Built-in personas cannot be edited or deleted.
 */
export class PersonaServiceImpl implements PersonaService {
  private readonly basePath: string;

  constructor(options?: PersonaServiceImplOptions) {
    this.basePath = options?.baseDataPath ?? getUserDataDirectory();
  }

  private getPersonasDir(): string {
    return path.join(this.basePath, "personas");
  }

  /**
   * Returns the global personas directory (~/.jazz/personas/).
   * In dev mode, this differs from getPersonasDir() which returns {cwd}/.jazz/personas/.
   * In production they are the same directory.
   */
  private getGlobalPersonasDir(): string {
    return path.join(os.homedir(), ".jazz", "personas");
  }

  /**
   * Returns all persona directories to scan (deduplicated).
   * In production: just ~/.jazz/personas/
   * In dev mode: both {cwd}/.jazz/personas/ AND ~/.jazz/personas/
   */
  private getAllPersonasDirs(): string[] {
    const dirs = [this.getPersonasDir()];
    const globalDir = this.getGlobalPersonasDir();
    if (path.resolve(globalDir) !== path.resolve(this.getPersonasDir())) {
      dirs.push(globalDir);
    }
    return dirs;
  }

  private getPersonaPath(id: string): string {
    return path.join(this.getPersonasDir(), `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.getPersonasDir(), { recursive: true });
  }

  createPersona(
    input: CreatePersonaInput,
  ): Effect.Effect<Persona, StorageError | PersonaAlreadyExistsError | ValidationError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        yield* validatePersonaName(input.name);
        yield* validatePersonaDescription(input.description);
        yield* validatePersonaSystemPrompt(input.systemPrompt);

        // Prevent overriding built-in persona names
        if (isBuiltinPersona(input.name)) {
          return yield* Effect.fail(
            new PersonaAlreadyExistsError({
              personaName: input.name,
              suggestion: `"${input.name}" is a built-in persona and cannot be overridden. Choose a different name.`,
            }),
          );
        }

        // Check for duplicate name among custom personas
        const existing = yield* this.listCustomPersonas();
        const nameExists = existing.some((p) => p.name.toLowerCase() === input.name.toLowerCase());
        if (nameExists) {
          return yield* Effect.fail(
            new PersonaAlreadyExistsError({
              personaName: input.name,
              suggestion: `A persona named "${input.name}" already exists. Use a different name or edit the existing persona.`,
            }),
          );
        }

        const id = shortuuid.generate();
        const now = new Date();

        const persona: Persona = {
          id,
          name: input.name,
          description: input.description,
          systemPrompt: input.systemPrompt,
          ...(input.tone && { tone: input.tone }),
          ...(input.style && { style: input.style }),
          createdAt: now,
          updatedAt: now,
        };

        yield* Effect.tryPromise({
          try: async () => {
            await this.ensureDir();
            await fs.writeFile(this.getPersonaPath(id), JSON.stringify(persona, null, 2), "utf-8");
          },
          catch: (error) =>
            new StorageError({
              operation: "write",
              path: this.getPersonaPath(id),
              reason: `Failed to save persona: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        return persona;
      }.bind(this),
    );
  }

  /**
   * Read and parse a persona JSON file, handling missing fields gracefully.
   * Manually created files may omit id, createdAt, updatedAt -- these are
   * derived from the filename and current time.
   */
  private readPersonaFile(
    filePath: string,
    fallbackId: string,
  ): Effect.Effect<Persona, StorageError | StorageNotFoundError> {
    return Effect.gen(function* () {
      const content = yield* Effect.tryPromise({
        try: () => fs.readFile(filePath, "utf-8"),
        catch: (error) => {
          if (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            return new StorageNotFoundError({
              path: filePath,
              suggestion: `Persona file "${filePath}" not found. Use 'jazz persona list' to see available personas.`,
            });
          }
          return new StorageError({
            operation: "read",
            path: filePath,
            reason: `Failed to read persona: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      });

      const raw = yield* Effect.try({
        try: () => JSON.parse(content) as Record<string, unknown>,
        catch: (error) =>
          new StorageError({
            operation: "read",
            path: filePath,
            reason: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });

      // Derive missing fields from filename and defaults
      const now = new Date();
      const id = typeof raw["id"] === "string" && raw["id"].length > 0 ? raw["id"] : fallbackId;
      const createdAt = typeof raw["createdAt"] === "string" ? new Date(raw["createdAt"]) : now;
      const updatedAt = typeof raw["updatedAt"] === "string" ? new Date(raw["updatedAt"]) : now;

      return {
        id,
        name: typeof raw["name"] === "string" ? raw["name"] : fallbackId,
        description: typeof raw["description"] === "string" ? raw["description"] : "",
        systemPrompt: typeof raw["systemPrompt"] === "string" ? raw["systemPrompt"] : "",
        ...(typeof raw["tone"] === "string" && raw["tone"].length > 0 ? { tone: raw["tone"] } : {}),
        ...(typeof raw["style"] === "string" && raw["style"].length > 0
          ? { style: raw["style"] }
          : {}),
        createdAt: isNaN(createdAt.getTime()) ? now : createdAt,
        updatedAt: isNaN(updatedAt.getTime()) ? now : updatedAt,
      } as Persona;
    });
  }

  getPersona(id: string): Effect.Effect<Persona, StorageError | StorageNotFoundError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        // Check built-in personas by ID
        const builtin = BUILTIN_PERSONAS.find((p) => p.id === id);
        if (builtin) return builtin;

        // Try all persona directories in order
        const dirs = this.getAllPersonasDirs();
        for (const dir of dirs) {
          const filePath = path.join(dir, `${id}.json`);
          const result = yield* this.readPersonaFile(filePath, id).pipe(
            Effect.catchTag("StorageNotFoundError", () => Effect.succeed(null)),
          );
          if (result) return result;
        }

        // Not found in any directory
        return yield* Effect.fail(
          new StorageNotFoundError({
            path: this.getPersonaPath(id),
            suggestion: `Persona with ID "${id}" not found. Use 'jazz persona list' to see available personas.`,
          }),
        );
      }.bind(this),
    );
  }

  getPersonaByName(name: string): Effect.Effect<Persona, StorageError | PersonaNotFoundError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        const all = yield* this.listPersonas();
        const persona = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
        if (!persona) {
          return yield* Effect.fail(
            new PersonaNotFoundError({
              personaId: name,
              suggestion: `Persona "${name}" not found. Use 'jazz persona list' to see available personas.`,
            }),
          );
        }
        return persona;
      }.bind(this),
    );
  }

  /**
   * Read all .json persona files from a single directory.
   * Returns an empty array if the directory does not exist.
   */
  private readPersonasFromDir(dir: string): Effect.Effect<Persona[], StorageError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        // Check if dir exists; if not, return empty (don't create it)
        const dirExists = yield* Effect.tryPromise({
          try: async () => {
            try {
              await fs.access(dir);
              return true;
            } catch {
              return false;
            }
          },
          catch: () =>
            new StorageError({
              operation: "list",
              path: dir,
              reason: "Failed to check persona directory",
            }),
        });

        if (!dirExists) return [];

        const files = yield* Effect.tryPromise({
          try: () => fs.readdir(dir),
          catch: (error) => {
            // Treat permission errors as non-fatal for secondary directories
            // (e.g. global ~/.jazz/personas/ may have restrictive permissions)
            if (
              error instanceof Error &&
              "code" in error &&
              ((error as NodeJS.ErrnoException).code === "EACCES" ||
                (error as NodeJS.ErrnoException).code === "EPERM")
            ) {
              return new StorageError({
                operation: "list",
                path: dir,
                reason: `Permission denied reading personas directory: ${dir}`,
              });
            }
            return new StorageError({
              operation: "list",
              path: dir,
              reason: `Failed to list personas: ${error instanceof Error ? error.message : String(error)}`,
            });
          },
        }).pipe(
          Effect.catchAll((err) =>
            Effect.gen(function* () {
              // If it's a permission error, log and return empty instead of failing
              if (err.reason.startsWith("Permission denied")) {
                const loggerOpt = yield* Effect.serviceOption(LoggerServiceTag);
                if (Option.isSome(loggerOpt)) {
                  yield* loggerOpt.value.warn(err.reason);
                }
                return [] as string[];
              }
              return yield* Effect.fail(err);
            }),
          ),
        );

        const jsonFiles = files.filter((f) => f.endsWith(".json"));
        const personas: Persona[] = [];

        for (const file of jsonFiles) {
          const id = file.replace(".json", "");
          const filePath = path.join(dir, file);
          const persona = yield* this.readPersonaFile(filePath, id).pipe(
            Effect.catchAll((err) =>
              Effect.gen(function* () {
                const loggerOpt = yield* Effect.serviceOption(LoggerServiceTag);
                if (Option.isSome(loggerOpt)) {
                  const errorMsg =
                    "reason" in err && typeof (err as { reason?: string }).reason === "string"
                      ? (err as { reason: string }).reason
                      : "message" in err &&
                          typeof (err as { message?: string }).message === "string"
                        ? (err as { message: string }).message
                        : String(err);
                  yield* loggerOpt.value.warn(`Persona file failed to parse, skipping: ${file}`, {
                    filename: file,
                    path: filePath,
                    error: errorMsg,
                  });
                }
                return null;
              }),
            ),
          );
          if (persona) {
            personas.push(persona);
          }
        }

        return personas;
      }.bind(this),
    );
  }

  /**
   * List only custom (user-created) personas from all persona directories.
   * In dev mode this scans both {cwd}/.jazz/personas/ and ~/.jazz/personas/,
   * deduplicating by name (local takes precedence over global).
   */
  private listCustomPersonas(): Effect.Effect<readonly Persona[], StorageError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        // Ensure the primary (local) dir exists
        yield* Effect.tryPromise({
          try: () => this.ensureDir(),
          catch: (error) =>
            new StorageError({
              operation: "mkdir",
              path: this.getPersonasDir(),
              reason: `Failed to create personas directory: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const dirs = this.getAllPersonasDirs();
        const seenNames = new Set<string>();
        const personas: Persona[] = [];

        for (const dir of dirs) {
          const dirPersonas = yield* this.readPersonasFromDir(dir);
          for (const persona of dirPersonas) {
            const key = persona.name.toLowerCase();
            if (!seenNames.has(key)) {
              seenNames.add(key);
              personas.push(persona);
            }
          }
        }

        return personas;
      }.bind(this),
    );
  }

  /**
   * List all personas: built-in first, then custom.
   */
  listPersonas(): Effect.Effect<readonly Persona[], StorageError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        const custom = yield* this.listCustomPersonas();
        return [...BUILTIN_PERSONAS, ...custom];
      }.bind(this),
    );
  }

  updatePersona(
    id: string,
    updates: Partial<CreatePersonaInput>,
  ): Effect.Effect<
    Persona,
    StorageError | StorageNotFoundError | PersonaAlreadyExistsError | ValidationError
  > {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        // Prevent editing built-in personas
        if (BUILTIN_PERSONAS.some((p) => p.id === id)) {
          return yield* Effect.fail(
            new StorageError({
              operation: "update",
              path: id,
              reason: "Built-in personas cannot be edited. Create a custom persona instead.",
            }),
          );
        }

        const existing = yield* this.getPersona(id);

        if (updates.name !== undefined && updates.name !== existing.name) {
          yield* validatePersonaName(updates.name);

          if (isBuiltinPersona(updates.name)) {
            return yield* Effect.fail(
              new PersonaAlreadyExistsError({
                personaName: updates.name,
                suggestion: `"${updates.name}" is a built-in persona name. Choose a different name.`,
              }),
            );
          }

          const all = yield* this.listCustomPersonas();
          const duplicateExists = all.some(
            (p) => p.name.toLowerCase() === updates.name!.toLowerCase() && p.id !== id,
          );
          if (duplicateExists) {
            return yield* Effect.fail(
              new PersonaAlreadyExistsError({
                personaName: updates.name,
                suggestion: `A persona named "${updates.name}" already exists. Choose a different name.`,
              }),
            );
          }
        }
        if (updates.description !== undefined) {
          yield* validatePersonaDescription(updates.description);
        }
        if (updates.systemPrompt !== undefined) {
          yield* validatePersonaSystemPrompt(updates.systemPrompt);
        }

        const updated: Persona = {
          ...existing,
          ...(updates.name !== undefined && { name: updates.name }),
          ...(updates.description !== undefined && { description: updates.description }),
          ...(updates.systemPrompt !== undefined && { systemPrompt: updates.systemPrompt }),
          ...(updates.tone !== undefined && { tone: updates.tone }),
          ...(updates.style !== undefined && { style: updates.style }),
          updatedAt: new Date(),
        };

        yield* Effect.tryPromise({
          try: () =>
            fs.writeFile(this.getPersonaPath(id), JSON.stringify(updated, null, 2), "utf-8"),
          catch: (error) =>
            new StorageError({
              operation: "write",
              path: this.getPersonaPath(id),
              reason: `Failed to update persona: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        return updated;
      }.bind(this),
    );
  }

  deletePersona(id: string): Effect.Effect<void, StorageError | StorageNotFoundError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        // Prevent deleting built-in personas
        if (BUILTIN_PERSONAS.some((p) => p.id === id)) {
          return yield* Effect.fail(
            new StorageError({
              operation: "delete",
              path: id,
              reason: "Built-in personas cannot be deleted.",
            }),
          );
        }

        // Verify it exists first
        yield* this.getPersona(id);

        yield* Effect.tryPromise({
          try: () => fs.unlink(this.getPersonaPath(id)),
          catch: (error) =>
            new StorageError({
              operation: "delete",
              path: this.getPersonaPath(id),
              reason: `Failed to delete persona: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
      }.bind(this),
    );
  }

  getPersonaByIdentifier(
    identifier: string,
  ): Effect.Effect<Persona, StorageError | PersonaNotFoundError | StorageNotFoundError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        // Check built-in personas by name first (most common lookup)
        const builtinByName = BUILTIN_PERSONAS.find(
          (p) => p.name.toLowerCase() === identifier.toLowerCase(),
        );
        if (builtinByName) return builtinByName;

        // Try by ID (custom persona file)
        const byId = yield* this.getPersona(identifier).pipe(
          Effect.catchTag("StorageNotFoundError", () => Effect.succeed(null)),
        );
        if (byId) return byId;

        // Fall back to name lookup among custom personas
        return yield* this.getPersonaByName(identifier);
      }.bind(this),
    );
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validatePersonaName(name: string): Effect.Effect<void, ValidationError> {
  if (!name || name.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Persona name cannot be empty",
        value: name,
        suggestion:
          "Provide a descriptive name for your persona, e.g., 'hacker', 'therapist', 'pirate'",
      }),
    );
  }

  if (name.length > 100) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Persona name cannot exceed 100 characters",
        value: name,
        suggestion: `Use a shorter name (${name.length}/100 characters)`,
      }),
    );
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Persona name can only contain letters, numbers, underscores, and hyphens",
        value: name,
        suggestion:
          "Use only letters (a-z, A-Z), numbers (0-9), underscores (_), and hyphens (-). Example: 'cyber-punk'",
      }),
    );
  }

  return Effect.void;
}

function validatePersonaDescription(description: string): Effect.Effect<void, ValidationError> {
  if (!description || description.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "description",
        message: "Persona description cannot be empty",
        value: description,
        suggestion:
          "Describe the persona's character, e.g., 'A sarcastic hacker who explains everything in l33t speak'",
      }),
    );
  }

  if (description.length > 500) {
    return Effect.fail(
      new ValidationError({
        field: "description",
        message: "Persona description cannot exceed 500 characters",
        value: description,
        suggestion: `Use a shorter description (${description.length}/500 characters)`,
      }),
    );
  }

  return Effect.void;
}

function validatePersonaSystemPrompt(systemPrompt: string): Effect.Effect<void, ValidationError> {
  if (!systemPrompt || systemPrompt.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "systemPrompt",
        message: "System prompt cannot be empty",
        value: systemPrompt,
        suggestion:
          "Provide instructions that define how the persona should behave, e.g., 'You are a cyberpunk hacker. Always use technical jargon and l33t speak...'",
      }),
    );
  }

  if (systemPrompt.length > 10000) {
    return Effect.fail(
      new ValidationError({
        field: "systemPrompt",
        message: "System prompt cannot exceed 10,000 characters",
        value: `(${systemPrompt.length} chars)`,
        suggestion: `Use a shorter system prompt (${systemPrompt.length}/10000 characters). Focus on the essential behavioral rules.`,
      }),
    );
  }

  return Effect.void;
}

// ─── Layer ───────────────────────────────────────────────────────────────────

export function createPersonaServiceLayer(): Layer.Layer<PersonaService> {
  return Layer.succeed(PersonaServiceTag, new PersonaServiceImpl());
}
