import { Effect } from "effect";
import * as os from "os";
import { type ChatMessage } from "../../services/llm/types";
import { CODER_PROMPT_V1 } from "./prompts/coder/v1";
import { DEFAULT_PROMPT_V2 } from "./prompts/default/v2";
import { GMAIL_PROMPT_V2 } from "./prompts/gmail/v2";

export interface AgentPromptTemplate {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly userPromptTemplate: string;
  readonly toolDescriptions?: Record<string, string>;
}

export interface AgentPromptOptions {
  readonly agentName: string;
  readonly agentDescription: string;
  readonly userInput: string;
  readonly conversationHistory?: ChatMessage[];
  readonly toolNames?: readonly string[];
  readonly availableTools?: Record<string, string>;
}

export class AgentPromptBuilder {
  private templates: Record<string, AgentPromptTemplate>;

  constructor() {
    this.templates = {
      default: {
        name: "Default Agent",
        description: "A general-purpose agent that can assist with various tasks.",
        systemPrompt: DEFAULT_PROMPT_V2,
        userPromptTemplate: "{userInput}",
      },
      gmail: {
        name: "Gmail Agent",
        description: "An agent specialized in handling email-related tasks.",
        systemPrompt: GMAIL_PROMPT_V2,
        userPromptTemplate: "{userInput}",
        toolDescriptions: {
          list_emails: "List the user's emails with optional filtering.",
          get_email: "Get the full content of a specific email by ID.",
          search_emails: "Search for emails matching specific criteria.",
          send_email: "Draft an email on behalf of the user (does not send).",
          trash_email: "Trash an email by ID.",
          batch_modify_emails: "Batch modify emails by ID.",
          delete_email: "Delete an email by ID.",
          delete_label: "Delete a label by ID.",
          add_labels_to_email: "Add labels to an email by ID.",
          remove_labels_from_email: "Remove labels from an email by ID.",
          list_labels: "List the user's labels.",
          create_label: "Create a new label.",
          update_label: "Update a label by ID.",
        },
      },
      coder: {
        name: "Coder Agent",
        description: "An expert software engineer and architect specialized in code analysis, debugging, and implementation with deep context awareness.",
        systemPrompt: CODER_PROMPT_V1,
        userPromptTemplate: "{userInput}",
      },
    };
  }

  /**
   * Get current system information including date and OS details
   */
  private getSystemInfo(): Effect.Effect<
    { currentDate: string; systemInfo: string; userInfo: string; workingDirectory: string },
    never
  > {
    return Effect.sync(() => {
      const currentDate = new Date().toISOString();
      const platform = os.platform();
      const arch = os.arch();
      const release = os.release();
      const username = os.userInfo().username;
      const shell = process.env["SHELL"] || "unknown";
      const workingDirectory = process.cwd();

      const systemInfo = `${platform} ${release} (${arch})`;
      const userInfo = `${username} using ${shell.split("/").pop() || "shell"}`;

      return { currentDate, systemInfo, userInfo, workingDirectory };
    });
  }

  /**
   * Get a prompt template by name
   */
  getTemplate(name: string): Effect.Effect<AgentPromptTemplate, Error> {
    return Effect.try({
      try: () => {
        const template = this.templates[name];
        if (!template) {
          throw new Error(`Prompt template not found: ${name}`);
        }
        return template;
      },
      catch: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    });
  }

  /**
   * List available prompt templates
   */
  listTemplates(): Effect.Effect<readonly string[], never> {
    return Effect.succeed(Object.keys(this.templates));
  }

  /**
   * Build a system prompt from a template and options
   */
  buildSystemPrompt(
    templateName: string,
    options: AgentPromptOptions,
  ): Effect.Effect<string, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        const template = yield* this.getTemplate(templateName);
        const { currentDate, systemInfo, userInfo, workingDirectory } = yield* this.getSystemInfo();

        // Replace placeholders in system prompt
        const systemPrompt = template.systemPrompt
          .replace("{agentName}", options.agentName)
          .replace("{agentDescription}", options.agentDescription)
          .replace("{currentDate}", currentDate)
          .replace("{systemInfo}", systemInfo)
          .replace("{userInfo}", userInfo)
          .replace("{workingDirectory}", workingDirectory);

        return systemPrompt;
      }.bind(this),
    );
  }

  /**
   * Build a user prompt from a template and options
   */
  buildUserPrompt(templateName: string, options: AgentPromptOptions): Effect.Effect<string, Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        const template = yield* this.getTemplate(templateName);

        return template.userPromptTemplate.replace("{userInput}", options.userInput);
      }.bind(this),
    );
  }

  /**
   * Build complete messages for an agent, including system prompt and conversation history
   */
  buildAgentMessages(
    templateName: string,
    options: AgentPromptOptions,
  ): Effect.Effect<ChatMessage[], Error> {
    return Effect.gen(
      function* (this: AgentPromptBuilder) {
        const systemPrompt = yield* this.buildSystemPrompt(templateName, options);
        const userPrompt = yield* this.buildUserPrompt(templateName, options);

        const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

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

        // Final safety check: ensure we never return an empty messages array
        if (messages.length === 0) {
          throw new Error(
            `Cannot create empty messages array - at least system message should be present. Template: ${templateName}, userInput: "${options.userInput}", userPrompt: "${userPrompt}"`,
          );
        }

        return messages;
      }.bind(this),
    );
  }
}

export const agentPromptBuilder = new AgentPromptBuilder();
