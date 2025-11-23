/**
 * Agent types
 */

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly model: `${string}/${string}`;
  readonly config: AgentConfig;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentConfig {
  readonly environment?: Record<string, string>;
  readonly agentType: string;
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly tools?: readonly string[];
}
