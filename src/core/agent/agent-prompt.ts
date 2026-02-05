import { createHash } from "node:crypto";
import * as os from "os";
import { Effect } from "effect";
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
  readonly knownSkills?: readonly { readonly name: string; readonly description: string; readonly path: string }[];
}

export class AgentPromptBuilder {
  private personas: Record<string, AgentPersona>;
  private systemPromptCache = new Map<string, string>();

  constructor() {
    this.personas = {
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
  }

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
      workingDirectory: string;
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
      const arch = os.arch();
      const release = os.release();
      const username = os.userInfo().username;
      const shell = process.env["SHELL"] || "unknown";
      const hostname = os.hostname();
      const workingDirectory = process.cwd();

      const osInfo = `${platform} ${release} (${arch})`;

      return { currentDate, osInfo, shell, hostname, username, workingDirectory };
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
      hash.update(JSON.stringify(options.knownSkills.map(s => s.name).sort()));
    }
    // Invalidate daily since prompts include current date
    hash.update(new Date().toDateString());
    return hash.digest("hex");
  }

  /**
   * Get a persona by name
   */
  getPersona(name: string): Effect.Effect<AgentPersona, Error> {
    return Effect.try({
      try: () => {
        const persona = this.personas[name];
        if (!persona) {
          throw new Error(`Persona not found: ${name}`);
        }
        return persona;
      },
      catch: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  /**
   * List available personas
   */
  listPersonas(): Effect.Effect<readonly string[], never> {
    return Effect.succeed(Object.keys(this.personas));
  }

  /**
   * Build a system prompt from a persona and options
   */
  buildSystemPrompt(
    personaName: string,
    options: AgentPromptOptions,
  ): Effect.Effect<string, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        // Check cache first
        const cacheKey = this.computeSystemPromptCacheKey(personaName, options);
        const cached = this.systemPromptCache.get(cacheKey);
        if (cached) return cached;

        const persona = yield* this.getPersona(personaName);
        const { currentDate, osInfo, shell, hostname, username } = yield* this.getSystemInfo();

        // Replace placeholders in system prompt
        let systemPrompt = persona.systemPrompt
          .replace("{agentName}", options.agentName)
          .replace("{agentDescription}", options.agentDescription)
          .replace("{currentDate}", currentDate)
          .replace("{osInfo}", osInfo)
          .replace("{shell}", shell)
          .replace("{hostname}", hostname)
          .replace("{username}", username);

        if (options.knownSkills && options.knownSkills.length > 0) {
          const skillsXml = options.knownSkills
            .map(s => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`)
            .join("\n");

          // Append available skills to system prompt
          /*
          <available_skills>
            <skill>
              <name>pdf-processing</name>
              <description>Extracts text and tables from PDF files, fills forms, merges documents.</description>
            </skill>
          </available_skills>
           */
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
  buildUserPrompt(personaName: string, options: AgentPromptOptions): Effect.Effect<string, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        const persona = yield* this.getPersona(personaName);

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
  ): Effect.Effect<ConversationMessages, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        const systemPrompt = yield* this.buildSystemPrompt(personaName, options);
        const userPrompt = yield* this.buildUserPrompt(personaName, options);

        const messages: ConversationMessages = [{ role: "system", content: systemPrompt }];

        // Add conversation history if available
        if (options.conversationHistory && options.conversationHistory.length > 0) {
          // Filter out system messages from history
          const filteredHistory = options.conversationHistory.filter(
            (msg) => msg.role !== "system",
          );

          messages.push(...filteredHistory);
        }

        // Add the current user input if not already in history
        if (
          !options.conversationHistory ||
          options.conversationHistory[options.conversationHistory.length - 1]?.role !== "user"
        ) {
          // Safety check: ensure userPrompt is not empty
          if (userPrompt && userPrompt.trim().length > 0) {
            messages.push({ role: "user", content: userPrompt });
          } else {
            // If userPrompt is empty, use the original userInput
            if (options.userInput && options.userInput.trim().length > 0) {
              messages.push({ role: "user", content: options.userInput });
            }
          }
        }

        return messages;
      }.bind(this),
    );
  }
}

export const agentPromptBuilder = new AgentPromptBuilder();
