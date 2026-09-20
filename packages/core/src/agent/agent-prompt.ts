/**
 * Assembles the system prompt and message list sent to the LLM for an agent turn:
 * persona instructions, environment facts, project instructions, tool guidance, and
 * the resolved user-input attachments for the current message.
 */

import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { AttachmentKind, MessageAttachment } from "@/core/types/attachment";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import { systemInfo } from "@/core/utils/system-info";
import { renderProjectInstructions, type ProjectInstructionFile } from "./project-instructions";
import { renderPromptLayers, type PromptSection } from "./prompts/layers";
import { ENVIRONMENT_TEMPLATE, renderHarnessPrompt } from "./prompts/shared";
import { collectUserInputAttachments } from "./user-input-attachments";

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
  readonly tone?: string;
  readonly style?: string;
}

export interface AgentPromptOptions {
  readonly agentName: string;
  readonly agentDescription: string;
  readonly userInput: string;
  /** Continuing a parked run: keep the transcript as-is and add no user message. */
  readonly isResume?: boolean;
  readonly conversationHistory?: ChatMessage[];
  readonly toolNames?: readonly string[];
  readonly availableTools?: Record<string, string>;
  /**
   * All skills available to the agent. Rendered as a compact index
   * (one line per skill) in the system prompt — the full `description` is shown
   * per skill, and the skill body is loaded JIT via `find_skills`.
   */
  readonly knownSkills?: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
  }[];
  /**
   * `deferred`-tier tools (see `ToolCategory.loadTier`) available to this run but not sent as
   * full schemas — rendered as a compact index so the model knows they exist and can fetch one
   * via `search_tools`, without paying every schema's token cost every turn.
   */
  readonly deferredTools?: readonly { readonly name: string; readonly summary: string }[];
  /**
   * Preferences that apply to every task, injected so the model acts on them
   * without having to remember to look them up.
   *
   * Only the request-independent ones belong here. A preference selected
   * because of what this turn is about would rewrite the prompt's tail every
   * turn and throw away the prefix cache, so those travel in the message
   * stream instead.
   */
  readonly standingPreferences?: readonly { readonly summary: string }[];
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
  /**
   * Surface this run is replying on. When set to a chat/CI surface (not "cli"), the prompt
   * gains a line telling the model it isn't in a terminal, so it doesn't suggest CLI-only
   * commands or frame a reply as if there were an interactive shell behind it.
   *
   * "cli" names a capability class, not a terminal emulator: Warp/Ghostty/iTerm/Terminal.app
   * all give the model the same thing (a human at a real shell who can run any command
   * suggested and reply interactively), so there is no guidance text that would ever differ
   * between them and no reason to enumerate them here. telegram/discord/github each get their
   * own value because the model's actual behavior must change per surface — whether it can
   * suggest a shell command, whether anyone will reply this turn, whether it's posting a
   * standalone comment. If the terminal itself ever needs to change what the model says,
   */
  /**
   * Attachments placed directly by the caller (model-companion delegation), merged onto
   * this run's first user message. Kinds the model cannot ingest are dropped with an
   * explanatory note; they are already resolved, so no path scanning touches them.
   */
  readonly initialAttachments?: readonly MessageAttachment[];
  /**
   * True when `userInput` carries a literal task contract (exact output format, step
   * ordering) rather than an ordinary conversational turn — e.g. a workflow's prompt.
   * The initial user message it becomes is tagged `kind: "task"` so compaction pins
   * it instead of summarizing it away, which an LLM-generated summary is not obliged
   * to preserve verbatim.
   */
  readonly pinInitialMessage?: boolean;
}

/**
 * Pick the line shown in the system-prompt skill index.
 *
 * Mirrors `getSkillIndexLine` in skill-service but operates on the inline
 * `knownSkills` shape used by the prompt builder (no `source` required).
 * Returns the full `description`.
 */
function getSkillIndexLineFromOption(s: {
  readonly name: string;
  readonly description: string;
}): string {
  const desc = s.description.trim();
  if (desc.length === 0) return s.name;
  return desc;
}

export class AgentPromptBuilder {
  private systemPromptCache = new Map<string, string>();

  /**
   * Get current system information including date and OS details.
   *
   * The facts themselves come from `systemInfo()` so the prompt and the
   * wizard's environment display can never drift apart.
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
      const { cwd: _cwd, ...facts } = systemInfo();
      return facts;
    });
  }

  /**
   * Compute a cache key for system prompt based on inputs that affect the output.
   * Includes the persona's system prompt content so edits to custom personas
   * are reflected immediately without waiting for a restart.
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
      const skillFingerprints = options.knownSkills.map(
        (s) => `${s.name}|${s.description}|${s.path}`,
      );
      hash.update(JSON.stringify(skillFingerprints.sort()));
    }
    // The full tool set shapes the prompt: tool-gated instruction blocks
    // (memory, task state, questions) and the per-tool notes both key off it.
    if (options.toolNames && options.toolNames.length > 0) {
      hash.update(`tools:${[...options.toolNames].sort().join(",")}`);
    }
    if (options.deferredTools && options.deferredTools.length > 0) {
      const deferredFingerprints = options.deferredTools.map((t) => `${t.name}|${t.summary}`);
      hash.update(`deferredTools:${JSON.stringify(deferredFingerprints.sort())}`);
    }
    // Content, not paths: amending a preference must take effect on the next
    // turn rather than serving a stale copy from the cache.
    if (options.standingPreferences && options.standingPreferences.length > 0) {
      hash.update(
        `standingPreferences:${options.standingPreferences.map((entry) => entry.summary).join("|")}`,
      );
    }
    // Content, not just paths: editing an AGENTS.md must take effect on the
    // next turn rather than waiting for a process restart.
    if (options.projectInstructions && options.projectInstructions.length > 0) {
      for (const file of options.projectInstructions) {
        hash.update(`agentsmd:${file.path}:${file.content}`);
      }
    }
    hash.update(`canGenerateMedia:${options.canGenerateMedia ?? true}`);
    // Invalidate daily since prompts include current date
    hash.update(new Date().toDateString());
    return hash.digest("hex");
  }

  /**
   * Resolve a persona by name via PersonaService (built-in and custom).
   * Built-in personas ship in the package under personas/<name>/PERSONA.md;
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
                `with the package under personas/<name>/PERSONA.md.`,
            ),
          );
        }

        return {
          name: persona.name,
          description: persona.description,
          systemPrompt: persona.systemPrompt,
          userPromptTemplate: "{userInput}",
          ...(persona.tone !== undefined && { tone: persona.tone }),
          ...(persona.style !== undefined && { style: persona.style }),
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

        let personaPrompt = persona.systemPrompt
          .replace("{agentName}", options.agentName)
          .replace("{agentDescription}", options.agentDescription);

        const core: PromptSection[] = [];
        const scope: PromptSection[] = [];
        const live: PromptSection[] = [];

        if (personaName !== "summarizer") {
          const envBlock = fillEnvironment(ENVIRONMENT_TEMPLATE);
          const usesIndividualEnvironmentFields = [
            "{currentDate}",
            "{osInfo}",
            "{hardware}",
            "{shell}",
            "{homeDirectory}",
            "{hostname}",
            "{username}",
            "{tty}",
          ].some((placeholder) => personaPrompt.includes(placeholder));
          personaPrompt = fillEnvironment(personaPrompt);
          if (personaPrompt.includes("{environment}")) {
            personaPrompt = personaPrompt.replace("{environment}", envBlock);
          } else if (!usesIndividualEnvironmentFields) {
            live.push({ id: "environment", content: envBlock });
          }
        }

        core.push({ id: "persona", content: personaPrompt });

        if (personaName !== "summarizer") {
          const skillsIndex = options.knownSkills
            ?.map((skill) => `- ${skill.name}: ${getSkillIndexLineFromOption(skill)}`)
            .join("\n");
          const deferredToolsIndex = options.deferredTools
            ?.map((tool) => `- ${tool.name}: ${tool.summary}`)
            .join("\n");
          const media =
            options.canGenerateMedia === false
              ? options.toolNames?.includes("generate_media") === true
                ? "delegated"
                : "unavailable"
              : undefined;

          core.push({
            id: "harness",
            content: renderHarnessPrompt({
              hasTools: (options.toolNames?.length ?? 0) > 0,
              hasShell: options.toolNames?.includes("execute_command") === true,
              hasSubagents: options.toolNames?.includes("spawn_subagent") === true,
              hasToolResultRetrieval: options.toolNames?.includes("retrieve_tool_result") === true,
              ...(skillsIndex ? { skillsIndex } : {}),
              ...(deferredToolsIndex ? { deferredToolsIndex } : {}),
              ...(media ? { media } : {}),
            }),
          });

          if (options.projectInstructions && options.projectInstructions.length > 0) {
            scope.push({
              id: "project-instructions",
              content: renderProjectInstructions(options.projectInstructions),
            });
          }

          if (options.standingPreferences && options.standingPreferences.length > 0) {
            live.push({
              id: "standing-preferences",
              content: [
                "## Standing preferences",
                "How this user wants things done, on every task. Follow them without being asked.",
                ...options.standingPreferences.map((entry) => `- ${entry.summary}`),
              ].join("\n"),
            });
          }
        }

        const systemPrompt = renderPromptLayers({ core, scope, live });

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

        // A resumed run continues a transcript that already ends mid-turn, on an assistant
        // message holding the tool call somebody just approved. There is no new user input
        // to add, and appending one would sit between that call and its result.
        if (options.isResume === true) {
          return messages;
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

          // Caller-placed attachments (companion delegation) ride outside path scanning.
          // The same modality gate applies: a kind this model cannot ingest is dropped
          // with a note, because a provider would reject it outright.
          const callerAttachments: MessageAttachment[] = [];
          for (const attachment of options.initialAttachments ?? []) {
            if (
              options.supportedAttachmentKinds === undefined ||
              options.supportedAttachmentKinds.includes(attachment.kind)
            ) {
              callerAttachments.push(attachment);
              continue;
            }
            ingested.notes.push(
              `[${attachment.path} is a ${attachment.kind} file and this model has no ${attachment.kind} input, so its contents were not sent. Say it could not be read rather than guessing at it.]`,
            );
          }

          const attachments = [...ingested.attachments, ...callerAttachments];
          messages.push({
            role: "user",
            content:
              ingested.notes.length > 0
                ? `${effectiveUserContent}\n\n${ingested.notes.join("\n")}`
                : effectiveUserContent,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(options.pinInitialMessage === true ? { kind: "task" } : {}),
          });
        }

        return messages;
      }.bind(this),
    );
  }
}

export const agentPromptBuilder = new AgentPromptBuilder();
