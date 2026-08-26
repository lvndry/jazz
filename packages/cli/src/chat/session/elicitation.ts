/**
 * Handles MCP "elicitation": an MCP server pausing mid-tool-call to ask the
 * user a structured question (text/number/enum/boolean fields) it needs an
 * answer to before it can continue.
 */

import type { LoggerService } from "@jazz/core/interfaces/logger";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import type { MCPServerManager } from "@jazz/core/interfaces/mcp-server";
import { MCPServerManagerTag } from "@jazz/core/interfaces/mcp-server";
import type { PresentationService } from "@jazz/core/interfaces/presentation";
import { PresentationServiceTag } from "@jazz/core/interfaces/presentation";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import type {
  MCPElicitationField,
  MCPElicitationRequest,
  MCPElicitationResponse,
} from "@jazz/core/types/mcp";
import { toPascalCase } from "@jazz/core/utils/string";
import { Effect } from "effect";

/** Label to show for a field, preferring the server's own wording. */
function fieldLabel(field: MCPElicitationField): string {
  const base = field.title ?? field.name;
  return field.required ? `${base} (required)` : `${base} (optional, blank to skip)`;
}

/** Ask for one field's value using whichever prompt fits its type. */
function askField(
  terminal: TerminalService,
  field: MCPElicitationField,
): Effect.Effect<string | number | boolean | readonly string[] | undefined, never> {
  return Effect.gen(function* () {
    const label = fieldLabel(field);

    if (field.type === "boolean") {
      return yield* terminal.confirm(label, field.default === true);
    }

    if (field.type === "multi-enum") {
      const options = field.options ?? [];
      if (options.length === 0) return undefined;
      const chosen = yield* terminal.checkbox<string>(label, {
        choices: options.map((option) => ({ name: option.label, value: option.value })),
        ...(Array.isArray(field.default) ? { default: field.default as readonly string[] } : {}),
      });
      return chosen.length > 0 ? chosen : undefined;
    }

    if (field.type === "enum") {
      const options = field.options ?? [];
      if (options.length === 0) return undefined;
      return yield* terminal.select<string>(label, {
        choices: options.map((option) => ({ name: option.label, value: option.value })),
      });
    }

    const answer = yield* terminal.ask(label, {
      ...(field.default !== undefined ? { defaultValue: String(field.default) } : {}),
      validate: (input: string) => {
        const trimmed = input.trim();
        if (trimmed === "") {
          return field.required ? `${field.title ?? field.name} is required` : true;
        }
        if (field.type === "number" || field.type === "integer") {
          if (Number.isNaN(Number(trimmed))) return "Enter a number";
          if (field.type === "integer" && !Number.isInteger(Number(trimmed))) {
            return "Enter a whole number";
          }
        }
        return true;
      },
    });

    const trimmed = (answer ?? "").trim();
    if (trimmed === "") return undefined;
    return field.type === "number" || field.type === "integer" ? Number(trimmed) : trimmed;
  });
}

/**
 * Ask the user a server's elicitation question and return its answer.
 *
 * A server asking for something it cannot get on its own is the point of the
 * primitive, but it is still a server driving a prompt in the user's terminal:
 * which server is asking is stated up front, and declining is always one
 * keypress away.
 */
export function runElicitation(
  terminal: TerminalService,
  request: MCPElicitationRequest,
): Effect.Effect<MCPElicitationResponse, never> {
  return Effect.gen(function* () {
    yield* terminal.log("");
    yield* terminal.warn(`${toPascalCase(request.serverName)} MCP server is asking for input:`);
    if (request.message !== "") {
      yield* terminal.log(request.message);
    }

    const proceed = yield* terminal.confirm("Answer it?", true);
    if (!proceed) {
      return { action: "decline" as const };
    }

    const content: Record<string, string | number | boolean | readonly string[]> = {};

    for (const field of request.fields) {
      if (field.description) {
        yield* terminal.info(field.description);
      }

      const value = yield* askField(terminal, field);

      if (value === undefined) {
        if (field.required) {
          // A required field left empty means the answer cannot be completed,
          // which is a cancel rather than a considered decline.
          yield* terminal.warn("Required field skipped — cancelling this request.");
          return { action: "cancel" as const };
        }
        continue;
      }

      content[field.name] = value;
    }

    return { action: "accept" as const, content };
  });
}

/**
 * Register the elicitation handler for surfaces that can reach a person.
 *
 * Deliberately a no-op where they cannot: on a bridge or a scheduled run there
 * is nobody to ask, and the manager's default of declining is what keeps an
 * unattended job moving instead of blocking on a dialog no one will see.
 */
export function registerElicitationHandler(): Effect.Effect<
  void,
  never,
  MCPServerManager | TerminalService | PresentationService | LoggerService
> {
  return Effect.gen(function* () {
    const presentation = yield* PresentationServiceTag;
    const logger = yield* LoggerServiceTag;

    if (presentation.canPromptForApproval?.() !== true) {
      yield* logger.debug("Skipping MCP elicitation handler: this surface cannot prompt the user");
      return;
    }

    const mcpManager = yield* MCPServerManagerTag;
    const terminal = yield* TerminalServiceTag;

    yield* mcpManager.onElicitation((request) =>
      Effect.runPromise(runElicitation(terminal, request)),
    );

    yield* logger.debug("MCP elicitation handler registered");
  });
}
