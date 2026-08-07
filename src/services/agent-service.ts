import { Effect, Layer } from "effect";
import shortuuid from "short-uuid";
import { validateCustomToolDefinitionShape } from "@/core/agent/tools/custom-tool-validation";
import { normalizeToolConfig } from "@/core/agent/utils/tool-config";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { StorageServiceTag, type StorageService } from "@/core/interfaces/storage";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "@/core/types/errors";
import { type Agent, type AgentConfig, type CustomToolDefinition } from "@/core/types/index";
import { CommonSuggestions } from "@/core/utils/error-handler";
import { parseProviderModel } from "@/core/utils/provider-model";

const MAX_WHEN_TO_USE_LENGTH = 200;

export class AgentServiceImpl implements AgentService {
  constructor(private readonly storage: StorageService) {}

  createAgent(
    name: string,
    description: string | undefined,
    config: Partial<AgentConfig> = {},
  ): Effect.Effect<
    Agent,
    StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError
  > {
    return Effect.gen(
      function* (this: AgentServiceImpl) {
        yield* validateAgentName(name);
        if (description !== undefined) {
          yield* validateAgentDescription(description);
        }

        const id = shortuuid.generate();

        // Create default agent configuration
        const defaultConfig: AgentConfig = {
          persona: "default",
          llmProvider: "openai",
          llmModel: "gpt-4o",
        };

        const normalizedTools = normalizeToolConfig(config.tools, { agentId: id });

        const baseConfig: AgentConfig = {
          ...defaultConfig,
          ...config,
        };

        const agentConfig: AgentConfig =
          normalizedTools.length > 0 ? { ...baseConfig, tools: normalizedTools } : baseConfig;

        // Validate the complete agent configuration
        yield* this.validateAgentConfig(agentConfig);

        // Check if agent with same name already exists
        const existingAgents = yield* this.storage.listAgents();
        const nameExists = existingAgents.some((agent: Agent) => agent.name === name);

        if (nameExists) {
          return yield* Effect.fail(
            new AgentAlreadyExistsError({
              agentId: name,
              suggestion: CommonSuggestions.checkAgentExists(name),
            }),
          );
        }

        // Create the agent
        const now = new Date();
        const agent: Agent = {
          id,
          name,
          ...(description !== undefined && { description }),
          model: `${agentConfig.llmProvider}/${agentConfig.llmModel}`,
          config: agentConfig,
          createdAt: now,
          updatedAt: now,
        };

        // Save the agent
        yield* this.storage.saveAgent(agent);

        return agent;
      }.bind(this),
    );
  }

  getAgent(id: string): Effect.Effect<Agent, StorageError | StorageNotFoundError> {
    return this.storage.getAgent(id);
  }

  listAgents(): Effect.Effect<readonly Agent[], StorageError> {
    return this.storage.listAgents();
  }

  updateAgent(
    id: string,
    updates: Partial<Agent>,
  ): Effect.Effect<
    Agent,
    | StorageError
    | StorageNotFoundError
    | AgentConfigurationError
    | AgentAlreadyExistsError
    | ValidationError
  > {
    return Effect.gen(
      function* (this: AgentServiceImpl) {
        const existingAgent = yield* this.storage.getAgent(id);

        if (updates.name && updates.name !== existingAgent.name) {
          yield* validateAgentName(updates.name);

          const agents = yield* this.storage.listAgents();
          const duplicateExists = agents.some(
            (agent) => agent.name === updates.name && agent.id !== existingAgent.id,
          );

          if (duplicateExists) {
            return yield* Effect.fail(
              new AgentAlreadyExistsError({
                agentId: updates.name,
                suggestion: CommonSuggestions.checkAgentExists(updates.name),
              }),
            );
          }
        }

        const mergedConfig: AgentConfig = {
          ...existingAgent.config,
          ...updates.config,
        };

        const normalizedTools = normalizeToolConfig(mergedConfig.tools, {
          agentId: existingAgent.id,
        });

        const { tools: _existingTools, ...configWithoutTools } = mergedConfig;
        void _existingTools;

        const baseConfig: AgentConfig = configWithoutTools;
        const updatedConfig: AgentConfig =
          normalizedTools.length > 0 ? { ...baseConfig, tools: normalizedTools } : baseConfig;

        const updatedAgent: Agent = {
          ...existingAgent,
          ...updates,
          id: existingAgent.id, // Ensure ID cannot be changed
          createdAt: existingAgent.createdAt, // Ensure createdAt cannot be changed
          updatedAt: new Date(),
          model: `${updatedConfig.llmProvider}/${updatedConfig.llmModel}`,
          config: updatedConfig,
        };

        yield* this.validateAgentConfig(updatedAgent.config);

        yield* this.storage.saveAgent(updatedAgent);
        return updatedAgent;
      }.bind(this),
    );
  }

  deleteAgent(id: string): Effect.Effect<void, StorageError | StorageNotFoundError> {
    return this.storage.deleteAgent(id);
  }

  validateAgentConfig(config: AgentConfig): Effect.Effect<void, AgentConfigurationError> {
    return Effect.gen(function* (this: AgentServiceImpl) {
      if (config.llmApiKeys) {
        for (const [provider, apiKey] of Object.entries(config.llmApiKeys)) {
          if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: `config.llmApiKeys.${provider}`,
                message: "LLM API key overrides must be non-empty strings",
                suggestion: "Set a valid API key string or remove the provider override.",
              }),
            );
          }
        }
      }

      const summarizerModel: unknown = config.summarizerModel;
      if (summarizerModel !== undefined && summarizerModel !== null) {
        if (typeof summarizerModel !== "string" || parseProviderModel(summarizerModel) === null) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.summarizerModel",
              message: `Invalid summarizerModel ${JSON.stringify(summarizerModel)}`,
              suggestion:
                'Use "provider/model" with a known provider, e.g. "anthropic/claude-3-5-haiku-latest", or remove the field to use the agent\'s own model.',
            }),
          );
        }
      }

      // Validate envAllowlist
      if (config.envAllowlist) {
        if (!Array.isArray(config.envAllowlist)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.envAllowlist",
              message: "envAllowlist must be provided as an array of env var names",
              suggestion: 'Supply an array of uppercase env var names, e.g. ["MY_TOKEN"].',
            }),
          );
        }

        // `Array.isArray` narrows to `any[]`, discarding the `readonly string[]`
        // element type, so re-assert it explicitly before using the value.
        const envAllowlist = config.envAllowlist as readonly string[];

        if (envAllowlist.length > 32) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.envAllowlist",
              message: `envAllowlist cannot contain more than 32 names (${envAllowlist.length} provided)`,
              suggestion: "Remove unused entries so at most 32 names remain.",
            }),
          );
        }

        for (const name of envAllowlist) {
          if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.envAllowlist",
                message: `Invalid env var name "${name}" in envAllowlist`,
                suggestion:
                  "Use uppercase letters, digits, and underscores only, starting with a letter, up to 64 characters (e.g. MY_TOKEN).",
              }),
            );
          }
        }
      }

      // Validate customTools
      if (config.customTools) {
        if (!Array.isArray(config.customTools)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.customTools",
              message: "customTools must be provided as an array of tool definitions",
              suggestion: "Supply an array of custom tool definitions.",
            }),
          );
        }

        // `Array.isArray` narrows to `any[]`, discarding the `readonly
        // CustomToolDefinition[]` element type, so re-assert it explicitly.
        const customTools = config.customTools as readonly CustomToolDefinition[];

        if (customTools.length > 16) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.customTools",
              message: `customTools cannot contain more than 16 entries (${customTools.length} provided)`,
              suggestion: "Remove unused entries so at most 16 custom tools remain.",
            }),
          );
        }

        const seenNames = new Set<string>();

        for (const customTool of customTools) {
          const { name } = customTool;

          const shapeIssue = validateCustomToolDefinitionShape(customTool);
          if (shapeIssue) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.customTools",
                message: shapeIssue.message,
                suggestion: shapeIssue.suggestion,
              }),
            );
          }

          if (seenNames.has(name)) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.customTools",
                message: `Duplicate custom tool name "${name}"`,
                suggestion: "Ensure every custom tool has a unique name.",
              }),
            );
          }
          seenNames.add(name);
        }
      }

      // Validate tools
      if (config.tools) {
        if (!Array.isArray(config.tools)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.tools",
              message: "Tools must be provided as an array of tool names",
              suggestion: "Select tools using the CLI or supply an array of tool identifiers.",
            }),
          );
        }

        for (const tool of config.tools) {
          if (typeof tool !== "string" || tool.trim().length === 0) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.tools",
                message: "Each tool entry must be a non-empty string",
              }),
            );
          }
        }
      }

      if (config.delegatable !== undefined && typeof config.delegatable !== "boolean") {
        return yield* Effect.fail(
          new AgentConfigurationError({
            agentId: "unknown",
            field: "config.delegatable",
            message: "delegatable must be a boolean",
            suggestion:
              "Set true to let other agents delegate to this one via spawn_subagent, or remove the field.",
          }),
        );
      }

      if (config.whenToUse !== undefined) {
        // Bounded because this string is rendered into the system prompt of
        // every delegating agent, on every turn.
        if (typeof config.whenToUse !== "string" || config.whenToUse.trim().length === 0) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.whenToUse",
              message: "whenToUse must be a non-empty string",
              suggestion:
                'Describe when to delegate to this agent, e.g. "use for tracing call sites; reads only".',
            }),
          );
        }

        if (config.whenToUse.length > MAX_WHEN_TO_USE_LENGTH) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.whenToUse",
              message: `whenToUse cannot exceed ${MAX_WHEN_TO_USE_LENGTH} characters (${config.whenToUse.length} provided)`,
              suggestion:
                "Keep it to a single routing line — it is re-sent in every delegating agent's system prompt.",
            }),
          );
        }
      }
    });
  }
}

function validateAgentName(name: string): Effect.Effect<void, ValidationError> {
  if (!name || name.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name cannot be empty",
        value: name,
        suggestion:
          "Provide a descriptive name for your agent, e.g., 'email-processor' or 'data-backup'",
      }),
    );
  }

  if (name.length > 100) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name cannot exceed 100 characters",
        value: name,
        suggestion: `Use a shorter name (${name.length}/100 characters). Consider using abbreviations or removing unnecessary words`,
      }),
    );
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name can only contain letters, numbers, underscores, and hyphens",
        value: name,
        suggestion:
          "Use only letters (a-z, A-Z), numbers (0-9), underscores (_), and hyphens (-). Example: 'my-agent-1'",
      }),
    );
  }

  return Effect.void;
}

function validateAgentDescription(description: string): Effect.Effect<void, ValidationError> {
  if (!description || description.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "description",
        message: "Agent description cannot be empty",
        value: description,
        suggestion:
          "Provide a clear description of what this agent does, e.g., 'Processes incoming emails and categorizes them'",
      }),
    );
  }

  if (description.length > 500) {
    return Effect.fail(
      new ValidationError({
        field: "description",
        message: "Agent description cannot exceed 500 characters",
        value: description,
        suggestion: `Use a shorter description (${description.length}/500 characters). Focus on the main purpose and key functionality`,
      }),
    );
  }

  return Effect.void;
}

export function createAgentServiceLayer(): Layer.Layer<AgentService, never, StorageService> {
  return Layer.effect(
    AgentServiceTag,
    Effect.map(StorageServiceTag, (storage) => new AgentServiceImpl(storage)),
  );
}
