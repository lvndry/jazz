import { createHash } from "node:crypto";
import * as os from "os";
import { Effect } from "effect";
import type { PersonaService } from "@/core/interfaces/persona-service";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import { CODER_PROMPT } from "./prompts/coder/system";
import { DEFAULT_PROMPT } from "./prompts/default/system";
import { RESEARCHER_PROMPT } from "./prompts/researcher/system";
import { SKILLS_INSTRUCTIONS } from "./prompts/shared";
import { SUMMARIZER_PROMPT } from "./prompts/summarizer/system";

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
  readonly knownSkills?: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
  }[];
}

/**
 * Built-in personas with hardcoded system prompts.
 * Custom personas are resolved via PersonaService at runtime.
 */
const BUILTIN_PERSONAS: Record<string, AgentPersona> = {
  default: {
    name: "Default Agent",
    description: "A general-purpose agent that can assist with various tasks.",
    systemPrompt: DEFAULT_PROMPT,
    userPromptTemplate: "{userInput}",
  },
  coder: {
    name: "Coder Agent",
    description:
      "An expert software engineer and architect specialized in code analysis, debugging, and implementation with deep context awareness.",
    systemPrompt: CODER_PROMPT,
    userPromptTemplate: "{userInput}",
  },
  researcher: {
    name: "Researcher Agent",
    description:
      "A meticulous researcher and scientist specialized in deep exploration, source synthesis, and evidence-backed conclusions.",
    systemPrompt: RESEARCHER_PROMPT,
    userPromptTemplate: "{userInput}",
  },
  summarizer: {
    name: "Summarizer Agent",
    description:
      "An agent specialized in compressing conversation history while maintaining semantic fidelity.",
    systemPrompt: SUMMARIZER_PROMPT,
    userPromptTemplate: "{userInput}",
  },
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
      const currentDate = now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
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
   * Includes date string to invalidate daily (since prompts include current date).
   */
  private computeSystemPromptCacheKey(personaName: string, options: AgentPromptOptions): string {
    const hash = createHash("md5");
    hash.update(personaName);
    hash.update(options.agentName);
    hash.update(options.agentDescription);
    if (options.knownSkills && options.knownSkills.length > 0) {
      hash.update(JSON.stringify(options.knownSkills.map((s) => s.name).sort()));
    }
    // Invalidate daily since prompts include current date
    hash.update(new Date().toDateString());
    return hash.digest("hex");
  }

  /**
   * Resolve a persona by name. Checks built-in personas first, then falls back
   * to loading a custom persona from PersonaService (if provided).
   *
   * For custom personas, a wrapper AgentPersona is created using the stored
   * system prompt from .jazz/personas/.
   */
  resolvePersona(
    name: string,
    personaService?: PersonaService,
  ): Effect.Effect<AgentPersona, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        // Check built-in personas first
        const builtin = BUILTIN_PERSONAS[name];
        if (builtin) return builtin;

        // Try to load custom persona from PersonaService
        if (personaService) {
          const customPersona = yield* personaService
            .getPersonaByIdentifier(name)
            .pipe(Effect.catchAll(() => Effect.succeed(null)));

          if (customPersona && customPersona.systemPrompt) {
            return {
              name: customPersona.name,
              description: customPersona.description,
              systemPrompt: customPersona.systemPrompt,
              userPromptTemplate: "{userInput}",
            } satisfies AgentPersona;
          }
        }

        // Fall back to default persona
        return BUILTIN_PERSONAS["default"]!;
      }.bind(this),
    );
  }

  /**
   * Get a persona by name (built-in only, for backward compatibility).
   * For full resolution including custom personas, use resolvePersona().
   */
  getPersona(name: string): Effect.Effect<AgentPersona, Error> {
    return this.resolvePersona(name);
  }

  /**
   * List available built-in persona names.
   * Does NOT include custom personas or the internal "summarizer".
   */
  listBuiltinPersonas(): Effect.Effect<readonly string[], never> {
    return Effect.succeed(Object.keys(BUILTIN_PERSONAS).filter((name) => name !== "summarizer"));
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
        // Check cache first
        const cacheKey = this.computeSystemPromptCacheKey(personaName, options);
        const cached = this.systemPromptCache.get(cacheKey);
        if (cached) return cached;

        const persona = yield* this.resolvePersona(personaName, personaService);
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
          const skillsXml = options.knownSkills
            .map(
              (s) =>
                `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`,
            )
            .join("\n");

          const skillsSection = `
${SKILLS_INSTRUCTIONS}
<available_skills>
${skillsXml}
</available_skills>
`;
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
