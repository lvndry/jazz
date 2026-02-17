import chalk from "chalk";
import { Effect } from "effect";
import { PersonaServiceTag, type PersonaService } from "@/core/interfaces/persona-service";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import {
  PersonaAlreadyExistsError,
  PersonaNotFoundError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "@/core/types/errors";
import { isBuiltinPersona } from "@/services/persona-service";

/**
 * CLI commands for managing custom personas
 *
 * Personas define reusable communication styles, tones, and behavioral rules
 * that can be applied to any agent. They are stored in .jazz/personas/.
 */

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Interactive persona creation wizard
 */
export function createPersonaCommand(): Effect.Effect<
  void,
  StorageError | PersonaAlreadyExistsError | ValidationError,
  PersonaService | TerminalService
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const personaService = yield* PersonaServiceTag;

    yield* terminal.heading("Create a new persona");
    yield* terminal.log(
      "A persona defines how an agent communicates — its tone, style, and behavioral rules.",
    );
    yield* terminal.log("You can apply the same persona to different agents and models.");
    yield* terminal.log("");

    // Step 1: Name
    const name = yield* terminal.ask("Persona name (e.g., hacker, therapist, pirate):", {
      validate: (input: string): boolean | string => {
        if (!input || input.trim().length === 0) return "Name cannot be empty";
        if (input.length > 100) return "Name cannot exceed 100 characters";
        if (!/^[a-zA-Z0-9_-]+$/.test(input))
          return "Only letters, numbers, underscores, and hyphens allowed";
        if (isBuiltinPersona(input))
          return `"${input}" is a built-in persona name. Choose a different name.`;
        return true;
      },
      simple: true,
    });

    if (!name || name.trim().length === 0) return;

    // Step 2: Description
    const description = yield* terminal.ask(
      "Brief description (e.g., 'A sarcastic hacker who uses l33t speak'):",
      {
        validate: (input: string): boolean | string => {
          if (!input || input.trim().length === 0) return "Description cannot be empty";
          if (input.length > 500) return "Description cannot exceed 500 characters";
          return true;
        },
        simple: true,
      },
    );

    if (!description || description.trim().length === 0) return;

    // Step 3: System prompt
    yield* terminal.log("");
    yield* terminal.info(
      "Now write the system prompt. This is the core instruction that shapes how the agent behaves.",
    );
    yield* terminal.info(
      "Example: 'You are a cyberpunk hacker named Z3R0. Always use technical jargon, l33t speak, and reference the matrix. Be helpful but edgy.'",
    );
    yield* terminal.log("");

    const systemPrompt = yield* terminal.ask("System prompt:", {
      validate: (input: string): boolean | string => {
        if (!input || input.trim().length === 0) return "System prompt cannot be empty";
        if (input.length > 10000) return "System prompt cannot exceed 10,000 characters";
        return true;
      },
      simple: true,
    });

    if (!systemPrompt || systemPrompt.trim().length === 0) return;

    // Step 4: Optional tone
    const tone = yield* terminal.ask("Tone (optional, e.g., sarcastic, formal, friendly):", {
      simple: true,
    });

    // Step 5: Optional style
    const style = yield* terminal.ask("Style (optional, e.g., concise, verbose, technical):", {
      simple: true,
    });

    // Create the persona
    const persona = yield* personaService.createPersona({
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      ...(tone && tone.trim().length > 0 ? { tone: tone.trim() } : {}),
      ...(style && style.trim().length > 0 ? { style: style.trim() } : {}),
    });

    yield* terminal.log("");
    yield* terminal.success(`Persona "${persona.name}" created successfully!`);
    yield* terminal.log(`   ID: ${persona.id}`);
    yield* terminal.log(`   Name: ${persona.name}`);
    yield* terminal.log(`   Description: ${persona.description}`);
    if (persona.tone) yield* terminal.log(`   Tone: ${persona.tone}`);
    if (persona.style) yield* terminal.log(`   Style: ${persona.style}`);
    yield* terminal.log("");
    yield* terminal.info("Apply this persona when creating an agent:");
    yield* terminal.log(`   jazz agent create  (then select "${persona.name}" as the persona)`);
  });
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * List all personas (built-in + custom)
 */
export function listPersonasCommand(): Effect.Effect<
  void,
  StorageError,
  PersonaService | TerminalService
> {
  return Effect.gen(function* () {
    const personaService = yield* PersonaServiceTag;
    const terminal = yield* TerminalServiceTag;

    const personas = yield* personaService.listPersonas();

    if (personas.length === 0) {
      yield* terminal.info("No personas found. Create one with: jazz persona create");
      return;
    }

    yield* terminal.heading(`Personas (${personas.length})`);
    yield* terminal.log("");

    for (const persona of personas) {
      const isBuiltin = persona.id.startsWith("builtin-");
      const tag = isBuiltin ? chalk.dim(" (built-in)") : chalk.green(" (custom)");
      const nameDisplay = chalk.bold(persona.name) + tag;

      yield* terminal.log(`  ${nameDisplay}`);
      yield* terminal.log(`    ${chalk.dim(persona.description)}`);
      if (persona.tone || persona.style) {
        const meta = [
          persona.tone ? `tone: ${persona.tone}` : "",
          persona.style ? `style: ${persona.style}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        yield* terminal.log(`    ${chalk.dim(meta)}`);
      }
      if (!isBuiltin) {
        yield* terminal.log(`    ${chalk.dim(`id: ${persona.id}`)}`);
      }
      yield* terminal.log("");
    }

    yield* terminal.info("Create a new persona: jazz persona create");
  });
}

// ─── Show ────────────────────────────────────────────────────────────────────

/**
 * Show detailed information about a persona
 */
export function showPersonaCommand(
  identifier: string,
): Effect.Effect<
  void,
  StorageError | PersonaNotFoundError | StorageNotFoundError,
  PersonaService | TerminalService
> {
  return Effect.gen(function* () {
    const personaService = yield* PersonaServiceTag;
    const terminal = yield* TerminalServiceTag;

    const persona = yield* personaService.getPersonaByIdentifier(identifier);

    const isBuiltin = persona.id.startsWith("builtin-");

    yield* terminal.heading(`Persona: ${persona.name}`);
    yield* terminal.log("");
    yield* terminal.log(`   ID:          ${persona.id}`);
    yield* terminal.log(`   Name:        ${persona.name}`);
    yield* terminal.log(`   Type:        ${isBuiltin ? "built-in" : "custom"}`);
    yield* terminal.log(`   Description: ${persona.description}`);
    if (persona.tone) yield* terminal.log(`   Tone:        ${persona.tone}`);
    if (persona.style) yield* terminal.log(`   Style:       ${persona.style}`);
    yield* terminal.log(`   Created:     ${persona.createdAt.toISOString()}`);
    yield* terminal.log(`   Updated:     ${persona.updatedAt.toISOString()}`);

    if (!isBuiltin && persona.systemPrompt) {
      yield* terminal.log("");
      yield* terminal.log(chalk.bold("   System Prompt:"));
      // Show first 500 chars with truncation
      const prompt =
        persona.systemPrompt.length > 500
          ? persona.systemPrompt.substring(0, 500) + "..."
          : persona.systemPrompt;
      for (const line of prompt.split("\n")) {
        yield* terminal.log(`   ${chalk.dim(line)}`);
      }
    }
  });
}

// ─── Edit ────────────────────────────────────────────────────────────────────

/**
 * Edit an existing custom persona
 */
export function editPersonaCommand(
  identifier: string,
): Effect.Effect<
  void,
  | StorageError
  | StorageNotFoundError
  | PersonaNotFoundError
  | PersonaAlreadyExistsError
  | ValidationError,
  PersonaService | TerminalService
> {
  return Effect.gen(function* () {
    const personaService = yield* PersonaServiceTag;
    const terminal = yield* TerminalServiceTag;

    const persona = yield* personaService.getPersonaByIdentifier(identifier);

    if (persona.id.startsWith("builtin-")) {
      yield* terminal.error("Built-in personas cannot be edited. Create a custom persona instead.");
      return;
    }

    yield* terminal.heading(`Edit persona: ${persona.name}`);
    yield* terminal.info("Press Enter to keep the current value, or type a new value.");
    yield* terminal.log("");

    // Select what to edit
    const field = yield* terminal.select<string>("What would you like to edit?", {
      choices: [
        { name: "Name", value: "name" },
        { name: "Description", value: "description" },
        { name: "System Prompt", value: "systemPrompt" },
        { name: "Tone", value: "tone" },
        { name: "Style", value: "style" },
      ],
    });

    if (!field) return;

    let updatedName: string | undefined;
    let updatedDescription: string | undefined;
    let updatedSystemPrompt: string | undefined;
    let updatedTone: string | undefined;
    let updatedStyle: string | undefined;
    let hasChanges = false;

    if (field === "name") {
      const newName = yield* terminal.ask(`New name (current: ${persona.name}):`, {
        defaultValue: persona.name,
        validate: (input: string): boolean | string => {
          if (!input || input.trim().length === 0) return "Name cannot be empty";
          if (!/^[a-zA-Z0-9_-]+$/.test(input))
            return "Only letters, numbers, underscores, and hyphens allowed";
          if (isBuiltinPersona(input) && input.toLowerCase() !== persona.name.toLowerCase())
            return `"${input}" is a built-in persona name`;
          return true;
        },
        simple: true,
      });
      if (newName) {
        updatedName = newName.trim();
        hasChanges = true;
      }
    } else if (field === "description") {
      const newDesc = yield* terminal.ask(`New description (current: ${persona.description}):`, {
        defaultValue: persona.description,
        simple: true,
      });
      if (newDesc) {
        updatedDescription = newDesc.trim();
        hasChanges = true;
      }
    } else if (field === "systemPrompt") {
      yield* terminal.log(chalk.dim("Current system prompt:"));
      const preview =
        persona.systemPrompt.length > 200
          ? persona.systemPrompt.substring(0, 200) + "..."
          : persona.systemPrompt;
      yield* terminal.log(chalk.dim(preview));
      yield* terminal.log("");

      const newPrompt = yield* terminal.ask("New system prompt:", { simple: true });
      if (newPrompt && newPrompt.trim().length > 0) {
        updatedSystemPrompt = newPrompt.trim();
        hasChanges = true;
      }
    } else if (field === "tone") {
      const newTone = yield* terminal.ask(`New tone (current: ${persona.tone || "none"}):`, {
        defaultValue: persona.tone || "",
        simple: true,
      });
      updatedTone = newTone?.trim() || undefined;
      hasChanges = true;
    } else if (field === "style") {
      const newStyle = yield* terminal.ask(`New style (current: ${persona.style || "none"}):`, {
        defaultValue: persona.style || "",
        simple: true,
      });
      updatedStyle = newStyle?.trim() || undefined;
      hasChanges = true;
    }

    if (!hasChanges) {
      yield* terminal.info("No changes made.");
      return;
    }

    const updated = yield* personaService.updatePersona(persona.id, {
      ...(updatedName !== undefined && { name: updatedName }),
      ...(updatedDescription !== undefined && { description: updatedDescription }),
      ...(updatedSystemPrompt !== undefined && { systemPrompt: updatedSystemPrompt }),
      ...(updatedTone !== undefined && { tone: updatedTone }),
      ...(updatedStyle !== undefined && { style: updatedStyle }),
    });
    yield* terminal.success(`Persona "${updated.name}" updated successfully!`);
  });
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a custom persona
 */
export function deletePersonaCommand(
  identifier: string,
): Effect.Effect<
  void,
  StorageError | StorageNotFoundError | PersonaNotFoundError,
  PersonaService | TerminalService
> {
  return Effect.gen(function* () {
    const personaService = yield* PersonaServiceTag;
    const terminal = yield* TerminalServiceTag;

    const persona = yield* personaService.getPersonaByIdentifier(identifier);

    if (persona.id.startsWith("builtin-")) {
      yield* terminal.error("Built-in personas cannot be deleted.");
      return;
    }

    const confirmed = yield* terminal.confirm(
      `Delete persona "${persona.name}"? This cannot be undone.`,
      false,
    );

    if (!confirmed) {
      yield* terminal.info("Deletion cancelled.");
      return;
    }

    yield* personaService.deletePersona(persona.id);
    yield* terminal.success(`Persona "${persona.name}" deleted.`);
  });
}
