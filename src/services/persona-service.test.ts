import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { BUILTIN_PERSONA_NAMES, PersonaServiceImpl } from "./persona-service";
import { PersonaServiceTag } from "../core/interfaces/persona-service";
import {
  PersonaAlreadyExistsError,
  PersonaNotFoundError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "../core/types/errors";

const tempDir = mkdtempSync(join(tmpdir(), "jazz-persona-test-"));

describe("PersonaService", () => {
  const layer = Layer.succeed(PersonaServiceTag, new PersonaServiceImpl({ baseDataPath: tempDir }));
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A, E, never>);

  const runExit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(
      Effect.exit(Effect.provide(effect, layer)) as Effect.Effect<Exit.Exit<A, E>, never, never>,
    );

  beforeEach(() => {
    const personasDir = join(tempDir, "personas");
    try {
      for (const f of readdirSync(personasDir)) {
        if (f.endsWith(".json")) unlinkSync(join(personasDir, f));
      }
    } catch {
      // Dir may not exist yet
    }
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const validInput = {
    name: "pirate",
    description: "A friendly pirate who explains things in nautical terms.",
    systemPrompt: "You are a jovial pirate assistant. Use nautical vocabulary.",
  };

  describe("createPersona", () => {
    it("should create a persona with valid input", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.createPersona(validInput);
      });

      const result = await run(program);

      expect(result.name).toBe("pirate");
      expect(result.description).toBe(validInput.description);
      expect(result.systemPrompt).toBe(validInput.systemPrompt);
      expect(result.id).toBeDefined();
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it("should fail with ValidationError for empty name", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.createPersona({
          ...validInput,
          name: "",
        });
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(exit.cause._tag).toBe("Fail");
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe("name");
      }
    });

    it("should fail with ValidationError for name with invalid characters", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.createPersona({
          ...validInput,
          name: "invalid name!",
        });
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe("name");
      }
    });

    it("should fail with ValidationError for empty description", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.createPersona({
          ...validInput,
          description: "",
        });
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe("description");
      }
    });

    it("should fail with ValidationError for empty systemPrompt", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.createPersona({
          ...validInput,
          systemPrompt: "",
        });
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe("systemPrompt");
      }
    });

    it("should fail with ValidationError for description exceeding 500 chars", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.createPersona({
          ...validInput,
          description: "a".repeat(501),
        });
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe("description");
      }
    });

    it("should fail with PersonaAlreadyExistsError for built-in persona name", async () => {
      for (const builtinName of BUILTIN_PERSONA_NAMES) {
        const program = Effect.gen(function* () {
          const service = yield* PersonaServiceTag;
          return yield* service.createPersona({
            ...validInput,
            name: builtinName,
          });
        });

        const exit = await runExit(program);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const err = (exit.cause as { error: unknown }).error;
          expect(err).toBeInstanceOf(PersonaAlreadyExistsError);
          expect((err as PersonaAlreadyExistsError).personaName).toBe(builtinName);
        }
      }
    });

    it("should fail with PersonaAlreadyExistsError for duplicate name", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        const _created = yield* service.createPersona(validInput);
        // Try to create another with same name (case-insensitive)
        return yield* service.createPersona({
          ...validInput,
          name: validInput.name.toUpperCase(),
        });
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(PersonaAlreadyExistsError);
      }
    });
  });

  describe("getPersona", () => {
    it("should return built-in persona by ID", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.getPersona("builtin-default");
      });

      const result = await run(program);
      expect(result.name).toBe("default");
      expect(result.id).toBe("builtin-default");
    });

    it("should return custom persona by ID after create", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        const created = yield* service.createPersona({
          ...validInput,
          name: "hacker",
        });
        return yield* service.getPersona(created.id);
      });

      const result = await run(program);
      expect(result.name).toBe("hacker");
      expect(result.id).toBeDefined();
    });

    it("should fail with StorageNotFoundError for non-existent custom ID", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.getPersona("nonexistent-id-xyz");
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(StorageNotFoundError);
      }
    });
  });

  describe("getPersonaByName", () => {
    it("should return built-in persona by name", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.getPersonaByName("coder");
      });

      const result = await run(program);
      expect(result.name).toBe("coder");
    });

    it("should fail with PersonaNotFoundError for unknown name", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.getPersonaByName("nonexistent-persona-xyz");
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(PersonaNotFoundError);
      }
    });
  });

  describe("listPersonas", () => {
    it("should include built-in personas and custom personas", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        yield* service.createPersona({ ...validInput, name: "tutor" });
        return yield* service.listPersonas();
      });

      const result = await run(program);
      const names = result.map((p) => p.name);
      expect(names).toContain("default");
      expect(names).toContain("coder");
      expect(names).toContain("researcher");
      expect(names).toContain("tutor");
    });
  });

  describe("updatePersona", () => {
    it("should update name, description, and systemPrompt", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        const created = yield* service.createPersona({
          ...validInput,
          name: "original",
        });
        return yield* service.updatePersona(created.id, {
          name: "updated",
          description: "Updated description",
          systemPrompt: "Updated prompt",
        });
      });

      const result = await run(program);
      expect(result.name).toBe("updated");
      expect(result.description).toBe("Updated description");
      expect(result.systemPrompt).toBe("Updated prompt");
    });

    it("should fail when updating built-in persona", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.updatePersona("builtin-default", { name: "new-name" });
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(StorageError);
        expect((err as StorageError).reason).toContain("Built-in personas cannot be edited");
      }
    });

    it("should fail with PersonaAlreadyExistsError when updating to duplicate name", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        const p1 = yield* service.createPersona({ ...validInput, name: "persona-a" });
        yield* service.createPersona({ ...validInput, name: "persona-b" });
        return yield* service.updatePersona(p1.id, { name: "persona-b" });
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(PersonaAlreadyExistsError);
      }
    });
  });

  describe("deletePersona", () => {
    it("should delete a custom persona", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        const created = yield* service.createPersona({
          ...validInput,
          name: "to-delete",
        });
        yield* service.deletePersona(created.id);
        return yield* service.getPersona(created.id);
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect((exit.cause as { error: unknown }).error).toBeDefined();
      }
    });

    it("should fail when deleting built-in persona", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.deletePersona("builtin-default");
      });

      const exit = await runExit(program);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const err = (exit.cause as { error: unknown }).error;
        expect(err).toBeInstanceOf(StorageError);
        expect((err as StorageError).reason).toContain("Built-in personas cannot be deleted");
      }
    });
  });

  describe("getPersonaByIdentifier", () => {
    it("should resolve by name (built-in)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        return yield* service.getPersonaByIdentifier("researcher");
      });

      const result = await run(program);
      expect(result.name).toBe("researcher");
    });

    it("should resolve by ID (custom)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        const created = yield* service.createPersona({
          ...validInput,
          name: "lookup-test",
        });
        return yield* service.getPersonaByIdentifier(created.id);
      });

      const result = await run(program);
      expect(result.name).toBe("lookup-test");
    });

    it("should resolve by name (custom)", async () => {
      const program = Effect.gen(function* () {
        const service = yield* PersonaServiceTag;
        yield* service.createPersona({
          ...validInput,
          name: "by-name",
        });
        return yield* service.getPersonaByIdentifier("by-name");
      });

      const result = await run(program);
      expect(result.name).toBe("by-name");
    });
  });
});
