import { createHash } from "node:crypto";
import * as os from "os";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { AttachmentKind, MessageAttachment } from "@/core/types/attachment";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import { renderProjectInstructions, type ProjectInstructionFile } from "./project-instructions";
import {
  COMPLETION_INSTRUCTIONS,
  ENVIRONMENT_TEMPLATE,
  INTERACTIVE_QUESTIONS_GUIDELINES,
  MEDIA_GENERATION_UNAVAILABLE,
  MEMORY_INSTRUCTIONS,
  SKILLS_INSTRUCTIONS,
  TASK_STATE_INSTRUCTIONS,
  TOOL_SELECTION_INSTRUCTIONS,
} from "./prompts/shared";
import { collectUserInputAttachments } from "./user-input-attachments";

function formatUtcOffsetLabel(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) {
    return "UTC";
  }
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  if (minutes === 0) {
    return `UTC${sign}${hours}`;
  }
  return `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Attachments and user-facing notes for the current turn's user message.
 *
 * Split out of `buildMessages` because the interesting part is the filtering: an attachment the
 * active model cannot read is dropped and *announced*, never silently omitted. A model promised
 * a screenshot and handed nothing will describe one it never saw.
 */
function resolveUserInputAttachments(
  options: AgentPromptOptions,
): Effect.Effect<{ attachments: MessageAttachment[]; notes: string[] }, never> {
  if (options.workingDirectory === undefined) {
    return Effect.succeed({ attachments: [], notes: [] });
  }
  return Effect.tryPromise({
    try: () =>
      collectUserInputAttachments(
        options.userInput,
        options.workingDirectory as string,
        options.attachmentsAreLocal ?? false,
      ),
    catch: (error) => error,
  }).pipe(
    Effect.map((collected) => {
      const supported = options.supportedAttachmentKinds ?? [];
      const attachments: MessageAttachment[] = [];
      const notes: string[] = [...collected.warnings];

      for (const attachment of collected.attachments) {
        if (supported.includes(attachment.kind)) {
          attachments.push(attachment);
          continue;
        }
        notes.push(
          `[${attachment.path} is a ${attachment.kind} file and this model has no ${attachment.kind} input, so its contents were not sent. Say it could not be read rather than guessing at it.]`,
        );
      }
      return { attachments, notes };
    }),
    // Ingestion is best-effort: a probe or stat failure must not stop the turn.
    Effect.catchAll(() => Effect.succeed({ attachments: [], notes: [] })),
  );
}

export interface AgentPersona {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly userPromptTemplate: string;
}

export interface AgentPromptOptions {
  readonly agentName: string;
  readonly agentDescription: string;
  readonly userInput: string;
  readonly conversationHistory?: ChatMessage[];
  readonly toolNames?: readonly string[];
  readonly availableTools?: Record<string, string>;
  /**
   * All skills available to the agent. Rendered as a compact index
   * (one line per skill) in the system prompt — full descriptions are loaded
   * JIT via `find_skills` or auto-injected when a trigger matches the user
   * message. Each entry can optionally provide a curated `tagline`; if absent
   * the system falls back to a truncated description.
   */
  readonly knownSkills?: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly tagline?: string;
    readonly triggers?: readonly string[];
  }[];
  /**
   * Names of skills whose triggers matched the current user input. The full
   * descriptions for these are inlined into the system prompt to bias the
   * model toward loading them, even on small models that wouldn't think to
   * call `find_skills` first. Subset of `knownSkills` by name.
   */
  readonly triggeredSkillNames?: readonly string[];
  /**
   * AGENTS.md files discovered for the working directory, outermost first.
   * Rendered verbatim into the system prompt so project conventions reach the
   * model without the user restating them every session.
   */
  readonly projectInstructions?: readonly ProjectInstructionFile[];
  /**
   * Directory that relative attachment paths in `userInput` resolve against.
   *
   * When omitted, path-based attachment ingestion is skipped entirely rather than guessed at:
   * resolving against `process.cwd()` would silently attach the wrong file in any context that
   * runs an agent from somewhere other than the user's shell.
   */
  readonly workingDirectory?: string;
  /**
   * Attachment modalities the target model accepts. Attachments of other kinds are dropped with
   * an explanatory note rather than sent, since a provider rejects them outright.
   */
  readonly supportedAttachmentKinds?: readonly AttachmentKind[];
  /** Whether the target model runs locally, which relaxes attachment size limits. */
  readonly attachmentsAreLocal?: boolean;
  /**
   * Whether this model can produce media itself. When it cannot, the prompt gains a line telling
   * the agent how to point the user at an agent that can, instead of dead-ending on "I can't".
   */
  readonly canGenerateMedia?: boolean;
}

/**
 * Pick the line shown in the system-prompt skill index.
 *
 * Mirrors `getSkillIndexLine` in skill-service but operates on the inline
 * `knownSkills` shape used by the prompt builder (no `source` required).
 * Prefers `tagline`; otherwise truncates `description` to one sentence or
 * 80 chars so legacy skills without a tagline still render compactly.
 */
function getSkillIndexLineFromOption(s: {
  readonly name: string;
  readonly description: string;
  readonly tagline?: string;
}): string {
  if (s.tagline && s.tagline.trim().length > 0) return s.tagline.trim();
  const desc = s.description.trim();
  if (desc.length === 0) return s.name;
  const firstSentence = desc.match(/^[^.!?]{1,80}[.!?]/);
  if (firstSentence) return firstSentence[0];
  return desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
}

export class AgentPromptBuilder {
  private systemPromptCache = new Map<string, string>();

  /**
   * Get current system information including date and OS details
   */
  private getSystemInfo(): Effect.Effect<
    {
      currentDate: string;
      osInfo: string;
      hardware: string;
      shell: string;
      hostname: string;
      username: string;
      homeDirectory: string;
      tty: string;
    },
    never
  > {
    return Effect.sync(() => {
      const now = new Date();
      const calendarDate = now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const timeZoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const currentDate = `${calendarDate} (${formatUtcOffsetLabel(now)}, ${timeZoneId})`;
      const platform = os.platform();
      const release = os.release();
      const machine = os.machine();
      const username = os.userInfo().username;
      const shell = process.env["SHELL"] || "unknown";
      const hostname = os.hostname();
      const homeDirectory = os.homedir();

      const osInfo = `${platform} ${release} (${machine})`;
      const cpuModel = os.cpus()[0]?.model ?? "unknown CPU";
      const coreCount = os.cpus().length;
      const totalMemoryGb = Math.round(os.totalmem() / 1024 ** 3);
      const hardware = `${cpuModel} · ${coreCount} cores · ${totalMemoryGb} GB RAM`;
      const tty = process.stdout.isTTY === true ? "yes" : "no";

      return { currentDate, osInfo, hardware, shell, hostname, username, homeDirectory, tty };
    });
  }

  /**
   * Compute a cache key for system prompt based on inputs that affect the output.
   * Includes the persona's system prompt content so edits to custom personas
   * are reflected immediately without waiting for a process restart.
   * Includes date string to invalidate daily (since prompts include current date).
   */
  private computeSystemPromptCacheKey(
    personaName: string,
    options: AgentPromptOptions,
    personaSystemPrompt: string,
  ): string {
    const hash = createHash("md5");
    hash.update(personaName);
    hash.update(personaSystemPrompt);
    hash.update(options.agentName);
    hash.update(options.agentDescription);
    if (options.knownSkills && options.knownSkills.length > 0) {
      hash.update(JSON.stringify(options.knownSkills.map((s) => s.name).sort()));
    }
    // Triggered-skill set varies per turn; mix it into the cache key so the
    // injected detail block is rebuilt whenever the trigger match changes.
    if (options.triggeredSkillNames && options.triggeredSkillNames.length > 0) {
      hash.update(`triggered:${[...options.triggeredSkillNames].sort().join(",")}`);
    }
    // The full tool set shapes the prompt: tool-gated instruction blocks
    // (memory, task state, questions) and the per-tool notes both key off it.
    if (options.toolNames && options.toolNames.length > 0) {
      hash.update(`tools:${[...options.toolNames].sort().join(",")}`);
    }
    // Content, not just paths: editing an AGENTS.md must take effect on the
    // next turn rather than waiting for a process restart.
    if (options.projectInstructions && options.projectInstructions.length > 0) {
      for (const file of options.projectInstructions) {
        hash.update(`agentsmd:${file.path}:${file.content}`);
      }
    }
    // Invalidate daily since prompts include current date
    hash.update(new Date().toDateString());
    return hash.digest("hex");
  }

  /**
   * Resolve a persona by name via PersonaService (built-in and custom).
   * Built-in personas ship in the package under personas/<name>/persona.md;
   * custom personas live in ~/.jazz/personas/.
   *
   * There is no built-in fallback prompt. A persona that cannot be resolved is
   * a hard error, not a recoverable condition: for a built-in persona (e.g.
   * "default") it means the packaged personas/ directory is missing or
   * unreadable — a broken install — and for a custom persona it means the agent
   * references one that does not exist. Both must surface rather than be
   * silently masked by a generic prompt.
   */
  resolvePersona(
    name: string,
    personaService?: PersonaService,
  ): Effect.Effect<AgentPersona, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        if (!personaService) {
          return yield* Effect.fail(
            new Error(
              `Cannot resolve persona "${name}": PersonaService is not available. ` +
                `The persona service layer must be provided to build a system prompt.`,
            ),
          );
        }

        const persona = yield* personaService.getPersonaByIdentifier(name);

        if (!persona.systemPrompt || persona.systemPrompt.trim().length === 0) {
          return yield* Effect.fail(
            new Error(
              `Persona "${name}" has an empty system prompt. Built-in personas ship ` +
                `with the package under personas/<name>/persona.md.`,
            ),
          );
        }

        return {
          name: persona.name,
          description: persona.description,
          systemPrompt: persona.systemPrompt,
          userPromptTemplate: "{userInput}",
        } satisfies AgentPersona;
      }.bind(this),
    );
  }

  /**
   * List available built-in persona names.
   * Does NOT include custom personas or the internal "summarizer".
   */
  listBuiltinPersonas(): Effect.Effect<readonly string[], never> {
    return Effect.succeed(["default", "coder", "researcher"]);
  }

  /**
   * Build a system prompt from a persona and options
   */
  buildSystemPrompt(
    personaName: string,
    options: AgentPromptOptions,
    personaService?: PersonaService,
  ): Effect.Effect<string, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        // Resolve persona first so its content is included in the cache key.
        // This ensures edits to custom personas invalidate the cache immediately.
        const persona = yield* this.resolvePersona(personaName, personaService);

        const cacheKey = this.computeSystemPromptCacheKey(
          personaName,
          options,
          persona.systemPrompt,
        );
        const cached = this.systemPromptCache.get(cacheKey);
        if (cached) return cached;
        const { currentDate, osInfo, hardware, shell, hostname, username, homeDirectory, tty } =
          yield* this.getSystemInfo();

        const fillEnvironment = (text: string): string =>
          text
            .replace("{currentDate}", currentDate)
            .replace("{osInfo}", osInfo)
            .replace("{hardware}", hardware)
            .replace("{shell}", shell)
            .replace("{homeDirectory}", homeDirectory)
            .replace("{hostname}", hostname)
            .replace("{username}", username)
            .replace("{tty}", tty);

        let systemPrompt = persona.systemPrompt
          .replace("{agentName}", options.agentName)
          .replace("{agentDescription}", options.agentDescription);

        // Machine grounding. Two modes:
        // - A persona that hand-places {currentDate} keeps full control over
        //   where the facts sit; substitute in place and add nothing.
        // - Otherwise append the one canonical block, so custom personas get
        //   grounding for free and the field list has a single source of truth.
        // The summarizer is a pure transcript-compression role with no tools;
        // machine facts are noise for it, so it never gets the block.
        if (systemPrompt.includes("{currentDate}")) {
          systemPrompt = fillEnvironment(systemPrompt);
        } else if (personaName !== "summarizer") {
          systemPrompt = `${systemPrompt}\n${fillEnvironment(ENVIRONMENT_TEMPLATE)}`;
        }

        // Only for models that cannot generate media, and never for the summarizer, which has no
        // user to advise.
        if (personaName !== "summarizer" && options.canGenerateMedia === false) {
          systemPrompt = `${systemPrompt}\n${MEDIA_GENERATION_UNAVAILABLE}`;
        }

        // Every acting persona gets the completion contract. The summarizer is
        // a pure transcript-compression role with no tools — "finish the job"
        // framing is noise for it.
        if (personaName !== "summarizer") {
          systemPrompt = systemPrompt + COMPLETION_INSTRUCTIONS;
        }

        if (options.toolNames && options.toolNames.length > 0) {
          systemPrompt = systemPrompt + TOOL_SELECTION_INSTRUCTIONS;
        }

        if (options.toolNames?.includes("ask_user_question")) {
          systemPrompt = systemPrompt + INTERACTIVE_QUESTIONS_GUIDELINES;
        }

        if (options.knownSkills && options.knownSkills.length > 0) {
          // Compact index — one line per skill. Full descriptions are loaded
          // JIT via the `find_skills` tool. This keeps system-prompt overhead
          // bounded as the skill catalog grows.
          const indexLines = options.knownSkills
            .map((s) => `- ${s.name}: ${getSkillIndexLineFromOption(s)}`)
            .join("\n");

          // Triggered skills get their full description inlined so the model
          // is biased toward loading them on this turn. Filtered to skills
          // that are actually in `knownSkills`.
          const triggeredSet = new Set(options.triggeredSkillNames ?? []);
          const triggeredDetailXml = options.knownSkills
            .filter((s) => triggeredSet.has(s.name))
            .map(
              (s) =>
                `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`,
            )
            .join("\n");

          const triggeredBlock =
            triggeredDetailXml.length > 0
              ? `
<likely_relevant_skills>
${triggeredDetailXml}
</likely_relevant_skills>
`
              : "";

          const skillsSection = `
${SKILLS_INSTRUCTIONS}
<available_skills>
${indexLines}
</available_skills>
${triggeredBlock}`;
          systemPrompt = systemPrompt + skillsSection;
        }

        if (options.toolNames?.includes("view_memory")) {
          systemPrompt = systemPrompt + MEMORY_INSTRUCTIONS;
        }

        if (options.toolNames?.includes("update_task_state")) {
          systemPrompt = systemPrompt + TASK_STATE_INSTRUCTIONS;
        }

        // Last, so project rules read as the most recent instruction the model
        // has before the conversation itself.
        if (options.projectInstructions && options.projectInstructions.length > 0) {
          systemPrompt = systemPrompt + renderProjectInstructions(options.projectInstructions);
        }

        // Cache the result
        this.systemPromptCache.set(cacheKey, systemPrompt);
        return systemPrompt;
      }.bind(this),
    );
  }

  /**
   * Build a user prompt from a persona and options
   */
  buildUserPrompt(
    personaName: string,
    options: AgentPromptOptions,
    personaService?: PersonaService,
  ): Effect.Effect<string, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        const persona = yield* this.resolvePersona(personaName, personaService);
        return persona.userPromptTemplate.replace("{userInput}", options.userInput);
      }.bind(this),
    );
  }

  /**
   * Build complete messages for an agent, including system prompt and conversation history
   */
  buildAgentMessages(
    personaName: string,
    options: AgentPromptOptions,
    personaService?: PersonaService,
  ): Effect.Effect<ConversationMessages, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        const systemPrompt = yield* this.buildSystemPrompt(personaName, options, personaService);
        const userPrompt = yield* this.buildUserPrompt(personaName, options, personaService);

        const messages: ConversationMessages = [{ role: "system", content: systemPrompt }];

        // Add conversation history if available
        if (options.conversationHistory && options.conversationHistory.length > 0) {
          // Filter out system messages from history
          const filteredHistory = options.conversationHistory.filter(
            (msg) => msg.role !== "system",
          );

          messages.push(...filteredHistory);
        }

        // Add the current user input if not already in history.
        const lastHistoryMsg =
          options.conversationHistory?.[options.conversationHistory.length - 1];
        const effectiveUserContent =
          userPrompt && userPrompt.trim().length > 0 ? userPrompt : options.userInput;
        const alreadyInHistory =
          lastHistoryMsg?.role === "user" && lastHistoryMsg.content === effectiveUserContent;

        if (!alreadyInHistory && effectiveUserContent && effectiveUserContent.trim().length > 0) {
          // Media paths the user typed (or dropped into the terminal) become attachments on
          // this message, so the model receives the file itself rather than its name.
          const ingested = yield* resolveUserInputAttachments(options);
          messages.push({
            role: "user",
            content:
              ingested.notes.length > 0
                ? `${effectiveUserContent}\n\n${ingested.notes.join("\n")}`
                : effectiveUserContent,
            ...(ingested.attachments.length > 0 ? { attachments: ingested.attachments } : {}),
          });
        }

        return messages;
      }.bind(this),
    );
  }
}

export const agentPromptBuilder = new AgentPromptBuilder();
