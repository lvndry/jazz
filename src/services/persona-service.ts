import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import shortuuid from "short-uuid";
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
 * File-based PersonaService implementation
 *
 * Stores personas as JSON files in .jazz/personas/<id>.json
 */
export class PersonaServiceImpl implements PersonaService {
  private getPersonasDir(): string {
    return path.join(getUserDataDirectory(), "personas");
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

        // Check for duplicate name
        const existing = yield* this.listPersonas();
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

  getPersona(id: string): Effect.Effect<Persona, StorageError | StorageNotFoundError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        const filePath = this.getPersonaPath(id);

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
                suggestion: `Persona with ID "${id}" not found. Use 'jazz persona list' to see available personas.`,
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
          try: () => JSON.parse(content) as Persona & { createdAt: string; updatedAt: string },
          catch: (error) =>
            new StorageError({
              operation: "read",
              path: filePath,
              reason: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        return {
          ...raw,
          createdAt: new Date(raw.createdAt),
          updatedAt: new Date(raw.updatedAt),
        } as Persona;
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

  listPersonas(): Effect.Effect<readonly Persona[], StorageError> {
    return Effect.gen(
      function* (this: PersonaServiceImpl) {
        yield* Effect.tryPromise({
          try: () => this.ensureDir(),
          catch: (error) =>
            new StorageError({
              operation: "mkdir",
              path: this.getPersonasDir(),
              reason: `Failed to create personas directory: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const files = yield* Effect.tryPromise({
          try: () => fs.readdir(this.getPersonasDir()),
          catch: (error) =>
            new StorageError({
              operation: "list",
              path: this.getPersonasDir(),
              reason: `Failed to list personas: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });

        const jsonFiles = files.filter((f) => f.endsWith(".json"));
        const personas: Persona[] = [];

        for (const file of jsonFiles) {
          const id = file.replace(".json", "");
          const persona = yield* this.getPersona(id).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (persona) {
            personas.push(persona);
          }
        }

        return personas;
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
        const existing = yield* this.getPersona(id);

        if (updates.name && updates.name !== existing.name) {
          yield* validatePersonaName(updates.name);
          const all = yield* this.listPersonas();
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
        if (updates.description) {
          yield* validatePersonaDescription(updates.description);
        }
        if (updates.systemPrompt) {
          yield* validatePersonaSystemPrompt(updates.systemPrompt);
        }

        const updated: Persona = {
          ...existing,
          ...(updates.name && { name: updates.name }),
          ...(updates.description && { description: updates.description }),
          ...(updates.systemPrompt && { systemPrompt: updates.systemPrompt }),
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
        // Try by ID first
        const byId = yield* this.getPersona(identifier).pipe(
          Effect.catchTag("StorageNotFoundError", () => Effect.succeed(null)),
        );
        if (byId) return byId;

        // Fall back to name lookup
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
