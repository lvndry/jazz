import { Effect } from "effect";
import { type AgentConfigService } from "@/core/interfaces/agent-config";
import { type TerminalService } from "@/core/interfaces/terminal";

export const DEFAULT_LLAMACPP_HOST = "localhost";
export const DEFAULT_LLAMACPP_PORT = 8080;

async function ping(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface LlamaCppServerAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * If the llama-server host/port haven't been configured yet, prompt the user
 * to set them (defaults: localhost:8080). Runs once per new installation.
 * Returns the resolved host and port so they can be passed directly to
 * `checkLlamaCppServerRunning` without re-reading config.
 */
export function ensureLlamaCppServerConfig(
  terminal: TerminalService,
  configService: AgentConfigService,
): Effect.Effect<LlamaCppServerAddress, never> {
  return Effect.gen(function* () {
    const hasHost = yield* configService.has("llm.llamacpp.host");
    const hasPort = yield* configService.has("llm.llamacpp.port");

    let host = DEFAULT_LLAMACPP_HOST;
    let port = DEFAULT_LLAMACPP_PORT;

    if (hasHost && hasPort) {
      // Already configured — read current values
      const savedHost = yield* configService
        .get("llm.llamacpp.host")
        .pipe(Effect.catchAll(() => Effect.succeed(DEFAULT_LLAMACPP_HOST as unknown)));
      const savedPortStr = yield* configService
        .get("llm.llamacpp.port")
        .pipe(Effect.catchAll(() => Effect.succeed(String(DEFAULT_LLAMACPP_PORT) as unknown)));
      host = typeof savedHost === "string" ? savedHost : DEFAULT_LLAMACPP_HOST;
      const portStr =
        typeof savedPortStr === "string" ? savedPortStr : String(DEFAULT_LLAMACPP_PORT);
      port = parseInt(portStr, 10) || DEFAULT_LLAMACPP_PORT;
      return { host, port };
    }

    yield* terminal.log("");
    yield* terminal.info(
      `llama-server defaults to http://${DEFAULT_LLAMACPP_HOST}:${DEFAULT_LLAMACPP_PORT}.`,
    );
    yield* terminal.info("Press Enter to keep the defaults or type custom values.");

    if (!hasHost) {
      const input = yield* terminal.ask("Host (default: localhost):", {
        simple: true,
        placeholder: "localhost",
      });
      const v = (input ?? "").trim();
      if (v && v !== DEFAULT_LLAMACPP_HOST) {
        yield* configService.set("llm.llamacpp.host", v);
        host = v;
      }
    }

    if (!hasPort) {
      const input = yield* terminal.ask("Port (default: 8080):", {
        simple: true,
        placeholder: "8080",
      });
      const v = (input ?? "").trim();
      if (v && v !== String(DEFAULT_LLAMACPP_PORT)) {
        const n = parseInt(v, 10);
        if (!isNaN(n)) {
          yield* configService.set("llm.llamacpp.port", v);
          port = n;
        }
      }
    }

    return { host, port };
  });
}

/**
 * Verify llama-server is reachable at the given host:port.
 *
 * If not reachable, prints start instructions and asks whether the server is
 * on a different port. If the user supplies one, saves it and retries once.
 *
 * Returns `true` only when the server is confirmed reachable.
 */
export function checkLlamaCppServerRunning(
  terminal: TerminalService,
  configService: AgentConfigService,
  { host, port }: LlamaCppServerAddress,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    // ── First attempt ───────────────────────────────────────────────────────
    const ok = yield* Effect.promise(() => ping(host, port));
    if (ok) return true;

    // ── Not found — show start command and ask for alternate port ───────────
    yield* terminal.log("");
    yield* terminal.error(`llama-server is not running at ${host}:${port}.`);
    yield* terminal.log("   Start it with:");
    yield* terminal.log("   llama-server -hf <org/model-GGUF>");
    yield* terminal.log("   Example: llama-server -hf ggml-org/gemma-4-E2B-it-GGUF");
    yield* terminal.log("");

    const input = yield* terminal.ask(
      "Is it running on a different port? Enter port number (or press Enter to cancel):",
      { simple: true, placeholder: String(port) },
    );

    const trimmed = (input ?? "").trim();
    if (!trimmed) {
      yield* terminal.log("");
      return false as boolean;
    }

    const newPort = parseInt(trimmed, 10);
    if (isNaN(newPort) || newPort < 1 || newPort > 65535) {
      yield* terminal.error(`"${trimmed}" is not a valid port number.`);
      yield* terminal.log("");
      return false as boolean;
    }

    // ── Retry with user-supplied port ───────────────────────────────────────
    const retryOk = yield* Effect.promise(() => ping(host, newPort));
    if (retryOk) {
      yield* configService.set("llm.llamacpp.port", String(newPort));
      yield* terminal.success(`Connected to llama-server at ${host}:${newPort}. Port saved.`);
      yield* terminal.log("");
      return true as boolean;
    }

    yield* terminal.error(`Still cannot reach llama-server at ${host}:${newPort}.`);
    yield* terminal.log("   Make sure the server is running and try again.");
    yield* terminal.log("");
    return false as boolean;
  });
}
