import { Context, Effect } from "effect";
import type {
  PersonaAlreadyExistsError,
  PersonaNotFoundError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "@/core/types/errors";
import type { CreatePersonaInput, Persona } from "@/core/types/persona";

/**
 * Persona service interface for managing reusable agent identities
 *
 * Provides methods for creating, retrieving, updating, deleting, and listing personas.
 * Personas are stored as persona.md files in ~/.jazz/personas/<name>/ and can be applied to any agent.
 */
export interface PersonaService {
  /**
   * Create a new persona
   *
   * @param input - The persona creation input (name, description, systemPrompt, etc.)
   * @returns An Effect that resolves to the created Persona
   */
  readonly createPersona: (
    input: CreatePersonaInput,
  ) => Effect.Effect<Persona, StorageError | PersonaAlreadyExistsError | ValidationError>;

  /**
   * Retrieve a persona by ID
   *
   * @param id - The unique identifier of the persona
   * @returns An Effect that resolves to the Persona
   */
  readonly getPersona: (id: string) => Effect.Effect<Persona, StorageError | StorageNotFoundError>;

  /**
   * Retrieve a persona by name
   *
   * @param name - The name of the persona
   * @returns An Effect that resolves to the Persona
   */
  readonly getPersonaByName: (
    name: string,
  ) => Effect.Effect<Persona, StorageError | PersonaNotFoundError>;

  /**
   * List all available personas
   *
   * @returns An Effect that resolves to an array of all personas
   */
  readonly listPersonas: () => Effect.Effect<readonly Persona[], StorageError>;

  /**
   * Update an existing persona
   *
   * @param id - The unique identifier of the persona to update
   * @param updates - Partial persona data containing the fields to update
   * @returns An Effect that resolves to the updated Persona
   */
  readonly updatePersona: (
    id: string,
    updates: Partial<CreatePersonaInput>,
  ) => Effect.Effect<
    Persona,
    StorageError | StorageNotFoundError | PersonaAlreadyExistsError | ValidationError
  >;

  /**
   * Delete a persona by ID
   *
   * @param id - The unique identifier of the persona to delete
   * @returns An Effect that resolves when the persona is deleted
   */
  readonly deletePersona: (id: string) => Effect.Effect<void, StorageError | StorageNotFoundError>;

  /**
   * Resolve a persona by identifier (ID or name)
   *
   * @param identifier - The persona ID or name
   * @returns An Effect that resolves to the Persona
   */
  readonly getPersonaByIdentifier: (
    identifier: string,
  ) => Effect.Effect<Persona, StorageError | PersonaNotFoundError | StorageNotFoundError>;
}

export const PersonaServiceTag = Context.GenericTag<PersonaService>("PersonaService");
