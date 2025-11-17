import { Data } from "effect";

/**
 * Tagged error types for the jazz automation CLI
 * Using Effect's Data.TaggedError for proper error handling
 */

// Agent Errors
export class AgentNotFoundError extends Data.TaggedError("AgentNotFoundError")<{
  readonly agentId: string;
  readonly suggestion?: string;
}> {}

export class AgentAlreadyExistsError extends Data.TaggedError("AgentAlreadyExistsError")<{
  readonly agentId: string;
  readonly suggestion?: string;
}> {}

export class AgentExecutionError extends Data.TaggedError("AgentExecutionError")<{
  readonly agentId: string;
  readonly reason: string;
  readonly cause?: unknown;
  readonly suggestion?: string;
}> {}

export class AgentConfigurationError extends Data.TaggedError("AgentConfigurationError")<{
  readonly agentId: string;
  readonly field: string;
  readonly message: string;
  readonly suggestion?: string;
}> {}

// Task Errors
export class TaskNotFoundError extends Data.TaggedError("TaskNotFoundError")<{
  readonly taskId: string;
  readonly suggestion?: string;
}> {}

export class TaskExecutionError extends Data.TaggedError("TaskExecutionError")<{
  readonly taskId: string;
  readonly reason: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly suggestion?: string;
}> {}

export class TaskTimeoutError extends Data.TaggedError("TaskTimeoutError")<{
  readonly taskId: string;
  readonly timeout: number;
  readonly suggestion?: string;
}> {}

export class TaskDependencyError extends Data.TaggedError("TaskDependencyError")<{
  readonly taskId: string;
  readonly dependencyId: string;
  readonly reason: string;
  readonly suggestion?: string;
}> {}

// Automation Errors
export class AutomationNotFoundError extends Data.TaggedError("AutomationNotFoundError")<{
  readonly automationId: string;
}> {}

export class AutomationExecutionError extends Data.TaggedError("AutomationExecutionError")<{
  readonly automationId: string;
  readonly reason: string;
}> {}

export class TriggerError extends Data.TaggedError("TriggerError")<{
  readonly triggerId: string;
  readonly reason: string;
}> {}

// Configuration Errors
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly field: string;
  readonly message: string;
  readonly value?: unknown;
  readonly suggestion?: string;
}> {}

export class ConfigurationNotFoundError extends Data.TaggedError("ConfigurationNotFoundError")<{
  readonly path: string;
  readonly suggestion?: string;
}> {}

export class ConfigurationValidationError extends Data.TaggedError("ConfigurationValidationError")<{
  readonly field: string;
  readonly expected: string;
  readonly actual: unknown;
  readonly suggestion?: string;
}> {}

// Storage Errors
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: string;
  readonly path: string;
  readonly reason: string;
  readonly suggestion?: string;
}> {}

export class StorageNotFoundError extends Data.TaggedError("StorageNotFoundError")<{
  readonly path: string;
  readonly suggestion?: string;
}> {}

export class StoragePermissionError extends Data.TaggedError("StoragePermissionError")<{
  readonly path: string;
  readonly operation: string;
  readonly suggestion?: string;
}> {}

// CLI Errors
export class CLIError extends Data.TaggedError("CLIError")<{
  readonly command: string;
  readonly message: string;
  readonly suggestion?: string;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string;
  readonly message: string;
  readonly value?: unknown;
  readonly suggestion?: string;
}> {}

// Network Errors
export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly url: string;
  readonly reason: string;
  readonly statusCode?: number;
  readonly suggestion?: string;
}> {}

export class APIError extends Data.TaggedError("APIError")<{
  readonly endpoint: string;
  readonly statusCode: number;
  readonly message: string;
  readonly response?: unknown;
  readonly suggestion?: string;
}> {}

// File System Errors
export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly path: string;
  readonly operation: string;
  readonly reason: string;
  readonly suggestion?: string;
}> {}

export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly path: string;
  readonly suggestion?: string;
}> {}

export class FilePermissionError extends Data.TaggedError("FilePermissionError")<{
  readonly path: string;
  readonly operation: string;
  readonly suggestion?: string;
}> {}

// Generic Errors
export class InternalError extends Data.TaggedError("InternalError")<{
  readonly component: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly suggestion?: string;
}> {}

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly operation: string;
  readonly timeout: number;
  readonly suggestion?: string;
}> {}

export class ResourceExhaustedError extends Data.TaggedError("ResourceExhaustedError")<{
  readonly resource: string;
  readonly limit: number;
  readonly current: number;
  readonly suggestion?: string;
}> {}

// Additional error types from services
export class LLMConfigurationError extends Data.TaggedError("LLMConfigurationError")<{
  readonly provider: string;
  readonly message: string;
  readonly suggestion?: string;
}> {}

export class LLMAuthenticationError extends Data.TaggedError("LLMAuthenticationError")<{
  readonly provider: string;
  readonly message: string;
  readonly suggestion?: string;
}> {}

export class GmailAuthenticationError extends Data.TaggedError("GmailAuthenticationError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {}

export class GmailOperationError extends Data.TaggedError("GmailOperationError")<{
  readonly operation: string;
  readonly message: string;
  readonly suggestion?: string;
}> {}

export class GmailTaskError extends Data.TaggedError("GmailTaskError")<{
  readonly taskId: string;
  readonly operation: string;
  readonly message: string;
  readonly suggestion?: string;
}> {}

// Update Errors
export class UpdateCheckError extends Data.TaggedError("UpdateCheckError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly suggestion?: string;
}> {}

export class UpdateInstallError extends Data.TaggedError("UpdateInstallError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly suggestion?: string;
}> {}

export type JazzError =
  | AgentNotFoundError
  | AgentAlreadyExistsError
  | AgentExecutionError
  | AgentConfigurationError
  | TaskNotFoundError
  | TaskExecutionError
  | TaskTimeoutError
  | TaskDependencyError
  | AutomationNotFoundError
  | AutomationExecutionError
  | TriggerError
  | ConfigurationError
  | ConfigurationNotFoundError
  | ConfigurationValidationError
  | StorageError
  | StorageNotFoundError
  | StoragePermissionError
  | CLIError
  | ValidationError
  | NetworkError
  | APIError
  | FileSystemError
  | FileNotFoundError
  | FilePermissionError
  | InternalError
  | TimeoutError
  | ResourceExhaustedError
  | LLMConfigurationError
  | LLMAuthenticationError
  | GmailAuthenticationError
  | GmailOperationError
  | GmailTaskError
  | UpdateCheckError
  | UpdateInstallError;
