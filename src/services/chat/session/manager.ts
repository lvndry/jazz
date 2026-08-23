import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { Agent } from "@/core/types";
import type { ChatMessage } from "@/core/types/message";
import { getLogsDirectory } from "../../logger";

/**
 * Initialize a chat session by setting up the file system context.
 */
export function initializeSession(
  agent: Agent,
  conversationId: string,
): Effect.Effect<
  void,
  never,
  FileSystemContextService | LoggerService | FileSystem.FileSystem | typeof AgentConfigServiceTag
> {
  return Effect.gen(function* () {
    const agentKey = { agentId: agent.id, conversationId };
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const logger = yield* LoggerServiceTag;
    yield* fileSystemContext
      .setCwd(agentKey, process.cwd())
      .pipe(Effect.catchAll(() => Effect.void));
    yield* logger.info(`Initialized agent working directory to: ${process.cwd()}`);
  });
}

/**
 * Update the working directory in the UI via the provided setter.
 */
export function updateWorkingDirectoryInStore(
  agentId: string,
  conversationId: string | undefined,
  fileSystemContext: FileSystemContextService,
  setWorkingDirectory?: (cwd: string) => void,
): void {
  Effect.gen(function* () {
    const cwd = yield* fileSystemContext.getCwd(
      conversationId ? { agentId, conversationId } : { agentId },
    );
    if (setWorkingDirectory) {
      setWorkingDirectory(cwd);
    }
  }).pipe(Effect.runSync);
}

/**
 * Log a chat message to the session log file.
 */
export function logMessageToSession(
  conversationId: string,
  message: ChatMessage,
): Effect.Effect<void, never, never> {
  return Effect.tryPromise({
    try: async () => {
      const logsDir = getLogsDirectory();
      await mkdir(logsDir, { recursive: true });
      const logFilePath = path.join(logsDir, `${conversationId}.log`);
      const timestamp = new Date().toISOString();
      const role = message.role.toUpperCase();
      const content = message.content || "";
      const line = `[${timestamp}] [${role}] ${content}\n`;
      await appendFile(logFilePath, line, { encoding: "utf8" });
    },
    catch: () => undefined, // Silently fail - logging should not break the chat session
  }).pipe(Effect.catchAll(() => Effect.void));
}
