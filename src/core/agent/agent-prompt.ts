import { createHash } from "node:crypto";
import * as os from "os";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import { DEFAULT_PROMPT } from "./prompts/default/system";
import { SKILLS_INSTRUCTIONS } from "./prompts/shared";

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

/** Fallback when PersonaService is unavailable or persona cannot be resolved. */
const FALLBACK_DEFAULT: AgentPersona = {
  name: "Default Agent",
  description: "A general-purpose agent that can assist with various tasks.",
  systemPrompt: DEFAULT_PROMPT,
  userPromptTemplate: "{userInput}",
};

export class AgentPromptBuilder {
  private systemPromptCache = new Map<string, string>();

  /**
   * Get current system information including date and OS details
   */
  private getSystemInfo(): Effect.Effect<
    {
      currentDate: string;
      osInfo: string;
      shell: string;
      hostname: string;
      username: string;
      homeDirectory: string;
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

      return { currentDate, osInfo, shell, hostname, username, homeDirectory };
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
    // Invalidate daily since prompts include current date
    hash.update(new Date().toDateString());
    return hash.digest("hex");
  }

  /**
   * Resolve a persona by name. Loads from PersonaService (both built-in and custom).
   * Built-in personas live in package personas/; custom in ~/.jazz/personas/.
   */
  resolvePersona(
    name: string,
    personaService?: PersonaService,
  ): Effect.Effect<AgentPersona, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        if (personaService) {
          const persona = yield* personaService
            .getPersonaByIdentifier(name)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));

          if (persona && persona.systemPrompt) {
            return {
              name: persona.name,
              description: persona.description,
              systemPrompt: persona.systemPrompt,
              userPromptTemplate: "{userInput}",
            } satisfies AgentPersona;
          }
        }

        // Fall back to default when PersonaService unavailable or persona not found
        return FALLBACK_DEFAULT;
      }.bind(this),
    );
  }

  /**
   * Get a persona by name. For full resolution including custom personas, use resolvePersona().
   */
  getPersona(name: string): Effect.Effect<AgentPersona, Error> {
    return this.resolvePersona(name);
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
        const { currentDate, osInfo, shell, hostname, username, homeDirectory } =
          yield* this.getSystemInfo();

        // Replace placeholders in system prompt
        let systemPrompt = persona.systemPrompt
          .replace("{agentName}", options.agentName)
          .replace("{agentDescription}", options.agentDescription)
          .replace("{currentDate}", currentDate)
          .replace("{osInfo}", osInfo)
          .replace("{shell}", shell)
          .replace("{homeDirectory}", homeDirectory)
          .replace("{hostname}", hostname)
          .replace("{username}", username);

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
          messages.push({ role: "user", content: effectiveUserContent });
        }

        return messages;
      }.bind(this),
    );
  }
}

export const agentPromptBuilder = new AgentPromptBuilder();
