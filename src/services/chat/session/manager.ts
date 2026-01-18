import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import short from "short-uuid";
import { store } from "@/cli/ui/App";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import {
    FileSystemContextServiceTag,
    type FileSystemContextService,
} from "@/core/interfaces/fs";
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
 * Update the working directory in the UI store.
 */
export function updateWorkingDirectoryInStore(
  agentId: string,
  conversationId: string | undefined,
  fileSystemContext: FileSystemContextService,
): void {
  Effect.gen(function* () {
    const cwd = yield* fileSystemContext.getCwd(
      conversationId ? { agentId, conversationId } : { agentId },
    );
    store.setWorkingDirectory(cwd);
  }).pipe(Effect.runSync);
}

/**
 * Log a chat message to the session log file.
 */
export function logMessageToSession(
  sessionId: string,
  message: ChatMessage,
): Effect.Effect<void, never, never> {
  return Effect.tryPromise({
    try: async () => {
      const logsDir = getLogsDirectory();
      await mkdir(logsDir, { recursive: true });
      const logFilePath = path.join(logsDir, `${sessionId}.log`);
      const timestamp = new Date().toISOString();
      const role = message.role.toUpperCase();
      const content = message.content || "";
      const line = `[${timestamp}] [${role}] ${content}\n`;
      await appendFile(logFilePath, line, { encoding: "utf8" });
    },
    catch: () => undefined, // Silently fail - logging should not break the chat session
  }).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Generate a session ID in the format: {agentName}-YYYYMMDD-HHmmss
 */
export function generateSessionId(agentName: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${agentName}-${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Generate a unique conversation ID.
 */
export function generateConversationId(): string {
  return short.generate();
}
