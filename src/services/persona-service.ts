import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer, Option } from "effect";
import matter from "gray-matter";
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
import { scanMarkdownIndex } from "@/core/utils/markdown-index";
import { getBuiltinPersonasDirectory } from "@/core/utils/runtime-detection";

const PERSONA_DEFINITION_FILENAME = "persona.md" as const;

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
 * @internal Used for testing; production uses ~/.jazz for personas.
 */
export interface PersonaServiceImplOptions {
  /** Override base data directory (for tests). Default: ~/.jazz. Personas live in {base}/personas/. */
  readonly baseDataPath?: string;
}

/** Metadata from persona.md frontmatter (used for scanning). */
interface PersonaMetadata {
  readonly path: string;
  readonly name: string;
  readonly source: "builtin" | "custom";
}

function parsePersonaFrontmatter(
  data: Record<string, unknown>,
  definitionDir: string,
  source: PersonaMetadata["source"],
): PersonaMetadata | null {
  const name = data["name"];
  const description = data["description"];
  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }
  return { path: definitionDir, name, source };
}

/**
 * File-based PersonaService implementation
 *
 * Scans two directories for persona.md files (like skills and workflows):
 * 1. Built-in: package personas/<name>/persona.md
 * 2. Custom: ~/.jazz/personas/<name>/persona.md
 *
 * Frontmatter: name, description, tone?, style?
 * Body: the system prompt (raw markdown).
 */
export class PersonaServiceImpl implements PersonaService {
  private readonly basePath: string;

  constructor(options?: PersonaServiceImplOptions) {
    this.basePath = options?.baseDataPath ?? path.join(os.homedir(), ".jazz");
  }

  /** Returns the custom personas directory (~/.jazz/personas/). */
  private getCustomPersonasDir(): string {
    return path.join(this.basePath, "personas");
  }

  private getPersonaDir(name: string): string {
    return path.join(this.getCustomPersonasDir(), name);
  }

  private async ensurePersonasDir(): Promise<void> {
    await fs.mkdir(this.getCustomPersonasDir(), { recursive: true });
  }

  /**
   * Load a Persona from a persona.md file.
   */
  private loadPersonaFromFile(
    personaDir: string,
    id: string,
  ): Effect.Effect<Persona, StorageError | StorageNotFoundError> {
    return Effect.gen(function* () {
      const filePath = path.join(personaDir, PERSONA_DEFINITION_FILENAME);
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

      const parsed = matter(content);
      const data = parsed.data as Record<string, unknown>;
      const now = new Date();
      const createdAt = typeof data["createdAt"] === "string" ? new Date(data["createdAt"]) : now;
      const updatedAt = typeof data["updatedAt"] === "string" ? new Date(data["updatedAt"]) : now;

      return {
        id,
        name: typeof data["name"] === "string" ? data["name"] : path.basename(personaDir),
        description: typeof data["description"] === "string" ? data["description"] : "",
        systemPrompt: parsed.content.trim(),
        ...(typeof data["tone"] === "string" && data["tone"].length > 0 && { tone: data["tone"] }),
        ...(typeof data["style"] === "string" &&
          data["style"].length > 0 && { style: data["style"] }),
        createdAt: isNaN(createdAt.getTime()) ? now : createdAt,
        updatedAt: isNaN(updatedAt.getTime()) ? now : updatedAt,
      } as Persona;
    });
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

        const now = new Date();
        const personaDir = this.getPersonaDir(input.name);
        const escapeYaml = (s: string) =>
          s.includes("\n") || s.includes('"') || s.includes(":")
            ? `"${s.replace(/"/g, '\\"')}"`
            : s;
        const frontmatter = `---
name: ${escapeYaml(input.name)}
description: ${escapeYaml(input.description)}
${input.tone ? `tone: ${escapeYaml(input.tone)}` : ""}
${input.style ? `style: ${escapeYaml(input.style)}` : ""}
createdAt: "${now.toISOString()}"
updatedAt: "${now.toISOString()}"
---

`;
        const content = frontmatter + input.systemPrompt;

        yield* Effect.tryPromise({
          try: async () => {
            await this.ensurePersonasDir();
            await fs.mkdir(personaDir, { recursive: true });
            await fs.writeFile(
              path.join(personaDir, PERSONA_DEFINITION_FILENAME),
              content,
              "utf-8",
            );
          },
          catch: (error) =>
            new StorageError({
              operation: "write",
              path: personaDir,
              reason: `Failed to save persona: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        return {
          id: input.name,
          name: input.name,
          description: input.description,
          systemPrompt: input.systemPrompt,
          ...(input.tone && { tone: input.tone }),
          ...(input.style && { style: input.style }),
          createdAt: now,
          updatedAt: now,
        };
      }.bind(this),
    );
  }

  getPersona(id: string): Effect.Effect<Persona, StorageError | StorageNotFoundError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        const builtinName = id.startsWith("builtin-") ? id.slice("builtin-".length) : id;
        const builtinDir = getBuiltinPersonasDirectory();

        // 1. Try built-in: personas/<name>/persona.md
        if (builtinDir) {
          const builtinPath = path.join(builtinDir, builtinName);
          const builtinResult = yield* this.loadPersonaFromFile(
            builtinPath,
            `builtin-${builtinName}`,
          ).pipe(Effect.catchTag("StorageNotFoundError", () => Effect.succeed(null)));
          if (builtinResult) return builtinResult;

          // Scan and match by name (handles id "default" -> builtin-default)
          const builtinMeta = yield* scanMarkdownIndex({
            dir: builtinDir,
            fileName: PERSONA_DEFINITION_FILENAME,
            depth: 2,
            parse: (data, defDir) => parsePersonaFrontmatter(data, defDir, "builtin"),
          }).pipe(
            Effect.mapError(
              (e) =>
                new StorageError({
                  operation: "list",
                  path: builtinDir,
                  reason: e instanceof Error ? e.message : String(e),
                }),
            ),
          );
          for (const meta of builtinMeta) {
            if (meta.name.toLowerCase() === id.toLowerCase()) {
              return yield* this.loadPersonaFromFile(meta.path, `builtin-${meta.name}`);
            }
          }
        }

        // 2. Try custom: ~/.jazz/personas/<id>/persona.md
        const customDir = this.getPersonaDir(id);
        const customResult = yield* this.loadPersonaFromFile(customDir, id).pipe(
          Effect.catchTag("StorageNotFoundError", () => Effect.succeed(null)),
        );
        if (customResult) return customResult;

        return yield* Effect.fail(
          new StorageNotFoundError({
            path: this.getPersonaDir(id),
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
   * List personas from a directory (persona.md files).
   */
  private listPersonasFromDir(
    dir: string,
    source: PersonaMetadata["source"],
    excludeSummarizer: boolean,
  ): Effect.Effect<readonly Persona[], StorageError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        const meta = yield* scanMarkdownIndex({
          dir,
          fileName: PERSONA_DEFINITION_FILENAME,
          depth: 2,
          parse: (data, defDir) => parsePersonaFrontmatter(data, defDir, source),
        }).pipe(
          Effect.catchAll((err: Error) =>
            Effect.gen(function* () {
              const loggerOpt = yield* Effect.serviceOption(LoggerServiceTag);
              if (Option.isSome(loggerOpt)) {
                yield* loggerOpt.value.warn(`Failed to scan personas in ${dir}: ${err.message}`);
              }
              return [] as PersonaMetadata[];
            }),
          ),
        );

        const personas: Persona[] = [];
        for (const m of meta) {
          if (excludeSummarizer && m.name === "summarizer") continue;
          const persona = yield* this.loadPersonaFromFile(
            m.path,
            source === "builtin" ? `builtin-${m.name}` : m.name,
          ).pipe(
            Effect.catchAll((err: StorageError | StorageNotFoundError) =>
              Effect.gen(function* () {
                const loggerOpt = yield* Effect.serviceOption(LoggerServiceTag);
                if (Option.isSome(loggerOpt)) {
                  const msg =
                    "reason" in err && typeof (err as { reason?: string }).reason === "string"
                      ? (err as { reason: string }).reason
                      : String(err);
                  yield* loggerOpt.value.warn(`Persona file failed to load, skipping: ${m.path}`, {
                    path: m.path,
                    error: msg,
                  });
                }
                return null;
              }),
            ),
          );
          if (persona) personas.push(persona);
        }
        return personas;
      }.bind(this),
    );
  }

  private listCustomPersonas(): Effect.Effect<readonly Persona[], StorageError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        yield* Effect.tryPromise({
          try: () => this.ensurePersonasDir(),
          catch: (error) =>
            new StorageError({
              operation: "mkdir",
              path: this.getCustomPersonasDir(),
              reason: `Failed to create personas directory: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const customDir = this.getCustomPersonasDir();
        const dirExists = yield* Effect.tryPromise({
          try: () => fs.access(customDir).then(() => true),
          catch: () => new Error("access failed"),
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (!dirExists) return [];

        return yield* this.listPersonasFromDir(customDir, "custom", false);
      }.bind(this),
    );
  }

  listPersonas(): Effect.Effect<readonly Persona[], StorageError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        const seenNames = new Set<string>();
        const result: Persona[] = [];

        // 1. Built-in personas (excluding summarizer)
        const builtinDir = getBuiltinPersonasDirectory();
        if (builtinDir) {
          const builtinPersonas = yield* this.listPersonasFromDir(builtinDir, "builtin", true);
          for (const p of builtinPersonas) {
            seenNames.add(p.name.toLowerCase());
            result.push(p);
          }
        }

        // 2. Custom personas (override built-in by name)
        const custom = yield* this.listCustomPersonas();
        for (const p of custom) {
          const key = p.name.toLowerCase();
          if (seenNames.has(key)) {
            const idx = result.findIndex((r) => r.name.toLowerCase() === key);
            if (idx >= 0) result[idx] = p;
          } else {
            seenNames.add(key);
            result.push(p);
          }
        }

        return result;
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
        if (isBuiltinPersonaId(id)) {
          return yield* Effect.fail(
            new StorageError({
              operation: "update",
              path: id,
              reason: "Built-in personas cannot be edited. Create a custom persona instead.",
            }),
          );
        }

        const existing = yield* this.getPersona(id);
        const currentDir = this.getPersonaDir(existing.name);

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
          ...(updates.name !== undefined && { name: updates.name, id: updates.name }),
          ...(updates.description !== undefined && { description: updates.description }),
          ...(updates.systemPrompt !== undefined && { systemPrompt: updates.systemPrompt }),
          ...(updates.tone !== undefined && { tone: updates.tone }),
          ...(updates.style !== undefined && { style: updates.style }),
          updatedAt: new Date(),
        };

        const newDir = this.getPersonaDir(updated.name);
        const escapeYaml = (s: string) =>
          s.includes("\n") || s.includes('"') || s.includes(":")
            ? `"${s.replace(/"/g, '\\"')}"`
            : s;
        const frontmatter = `---
name: ${escapeYaml(updated.name)}
description: ${escapeYaml(updated.description)}
${updated.tone ? `tone: ${escapeYaml(updated.tone)}` : ""}
${updated.style ? `style: ${escapeYaml(updated.style)}` : ""}
createdAt: "${updated.createdAt.toISOString()}"
updatedAt: "${updated.updatedAt.toISOString()}"
---

`;
        const content = frontmatter + updated.systemPrompt;

        yield* Effect.tryPromise({
          try: async () => {
            if (newDir !== currentDir) {
              await fs.mkdir(newDir, { recursive: true });
              await fs.writeFile(path.join(newDir, PERSONA_DEFINITION_FILENAME), content, "utf-8");
              await fs.rm(currentDir, { recursive: true });
            } else {
              await fs.writeFile(path.join(newDir, PERSONA_DEFINITION_FILENAME), content, "utf-8");
            }
          },
          catch: (error) =>
            new StorageError({
              operation: "write",
              path: newDir,
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
        if (isBuiltinPersonaId(id)) {
          return yield* Effect.fail(
            new StorageError({
              operation: "delete",
              path: id,
              reason: "Built-in personas cannot be deleted.",
            }),
          );
        }

        const existing = yield* this.getPersona(id);
        const personaDir = this.getPersonaDir(existing.name);

        yield* Effect.tryPromise({
          try: () => fs.rm(personaDir, { recursive: true }),
          catch: (error) =>
            new StorageError({
              operation: "delete",
              path: personaDir,
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
        const byId = yield* this.getPersona(identifier).pipe(
          Effect.catchTag("StorageNotFoundError", () => Effect.succeed(null)),
        );
        if (byId) return byId;

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
