import { ChatServiceTag, type ChatService } from "@jazz/core/interfaces/chat-service";
import { Effect, Layer } from "effect";

/**
 * The chat service layer. The chat implementation, with the daemon client, deliveries and UI
 * store it pulls in, loads only when a session starts, so commands that never chat skip it.
 * The config path is kept for the detached reflection a session launches when it closes.
 */
export function createChatServiceLayer(configPath?: string): Layer.Layer<ChatService> {
  return Layer.succeed(ChatServiceTag, {
    startChatSession: (agent, options) =>
      Effect.promise(() => import("./chat-service")).pipe(
        Effect.flatMap((chat) =>
          new chat.ChatServiceImpl(configPath).startChatSession(agent, options),
        ),
      ),
  });
}
