import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import type { MCPServerConfigStdio } from "@jazz/core/interfaces/mcp-server";
import { describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Fiber } from "effect";
import { MCPServerManagerImpl } from "./mcp-server-manager";

function fakeLogger(): LoggerService {
  const noop = () => Effect.void;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    writeToFile: noop,
  } as unknown as LoggerService;
}

const STDIO_CONFIG: MCPServerConfigStdio = {
  name: "test-server",
  command: "fake-command",
};

interface FakeClient {
  connect: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  getServerCapabilities: ReturnType<typeof mock>;
  getProtocolEra: ReturnType<typeof mock>;
  listTools: ReturnType<typeof mock>;
  setRequestHandler: ReturnType<typeof mock>;
}

function fakeClient(connect: () => Promise<void>): FakeClient {
  return {
    connect: mock(connect),
    close: mock(() => Promise.resolve()),
    getServerCapabilities: mock(() => undefined),
    getProtocolEra: mock(() => "test-era"),
    listTools: mock(() => Promise.resolve({ tools: [] })),
    setRequestHandler: mock(() => undefined),
  };
}

/** Wires fake transport/client builders onto a manager, one client per call. */
function wireFakeClients(manager: MCPServerManagerImpl, clients: readonly FakeClient[]) {
  let index = 0;
  const transports = clients.map((_, transportIndex) => ({ id: transportIndex }));
  (manager as unknown as { buildTransport: (config: unknown) => unknown }).buildTransport = () => {
    const transport = transports[Math.min(index, transports.length - 1)];
    return { transport, transportType: "stdio" as const };
  };
  (manager as unknown as { buildClient: (config: unknown) => unknown }).buildClient = () => {
    const client = clients[Math.min(index, clients.length - 1)];
    index += 1;
    return client;
  };
}

function runEffect<A, E>(effect: Effect.Effect<A, E, LoggerService>, logger: LoggerService) {
  return Effect.runPromise(effect.pipe(Effect.provideService(LoggerServiceTag, logger)));
}

function runEffectExit<A, E>(effect: Effect.Effect<A, E, LoggerService>, logger: LoggerService) {
  return Effect.runPromiseExit(effect.pipe(Effect.provideService(LoggerServiceTag, logger)));
}

describe("connectServer", () => {
  it("gives every retry a fresh client instead of reusing the failed attempt's", async () => {
    const logger = fakeLogger();
    const manager = new MCPServerManagerImpl(logger);

    const firstAttempt = fakeClient(() => Promise.reject(new Error("ECONNREFUSED")));
    const secondAttempt = fakeClient(() => Promise.resolve());
    wireFakeClients(manager, [firstAttempt, secondAttempt]);

    await runEffect(manager.connectServer(STDIO_CONFIG), logger);

    // Two distinct clients were built — the retry did not reuse the first attempt's
    // half-initialized client.
    expect(firstAttempt.connect).toHaveBeenCalledTimes(1);
    expect(secondAttempt.connect).toHaveBeenCalledTimes(1);

    // The failed attempt's client was closed as part of cleanup; the client that went
    // on to become the live connection was not closed by that same cleanup path.
    expect(firstAttempt.close).toHaveBeenCalledTimes(1);
    expect(secondAttempt.close).not.toHaveBeenCalled();

    expect(await Effect.runPromise(manager.isConnected(STDIO_CONFIG.name))).toBe(true);
  });

  it("closes the failing attempt's client without masking the connection error", async () => {
    const logger = fakeLogger();
    const manager = new MCPServerManagerImpl(logger);

    // Not a transient-looking error, so the retry predicate gives up after one attempt.
    const attempt = fakeClient(() => Promise.reject(new Error("ENOENT: no such file")));
    wireFakeClients(manager, [attempt]);

    const exit = await runEffectExit(manager.connectServer(STDIO_CONFIG), logger);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value.reason).toContain("ENOENT");
      }
    }
    expect(attempt.close).toHaveBeenCalledTimes(1);
    expect(await Effect.runPromise(manager.isConnected(STDIO_CONFIG.name))).toBe(false);
  });

  /** Exercises the same abandon-this-attempt cleanup a real timeout would trigger. */
  it("cleans up an attempt whose handshake never answers when interrupted", async () => {
    const logger = fakeLogger();
    const manager = new MCPServerManagerImpl(logger);

    const attempt = fakeClient(() => new Promise<void>(() => {}));
    wireFakeClients(manager, [attempt]);

    const fiber = Effect.runFork(
      manager.connectServer(STDIO_CONFIG).pipe(Effect.provideService(LoggerServiceTag, logger)),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(attempt.close).toHaveBeenCalledTimes(1);
    expect(await Effect.runPromise(manager.isConnected(STDIO_CONFIG.name))).toBe(false);
  });
});

describe("discoverTools", () => {
  it("releases a connection it opened itself when tool listing fails", async () => {
    const logger = fakeLogger();
    const manager = new MCPServerManagerImpl(logger);

    const attempt = fakeClient(() => Promise.resolve());
    attempt.listTools = mock(() => Promise.reject(new Error("boom")));
    wireFakeClients(manager, [attempt]);

    const exit = await runEffectExit(manager.discoverTools(STDIO_CONFIG), logger);

    expect(exit._tag).toBe("Failure");
    // Discovery opened this connection itself, so a failed listing must not leave it
    // dangling.
    expect(await Effect.runPromise(manager.isConnected(STDIO_CONFIG.name))).toBe(false);
    expect(attempt.close).toHaveBeenCalledTimes(1);
  });

  it("never disconnects a connection that already existed before discovery", async () => {
    const logger = fakeLogger();
    const manager = new MCPServerManagerImpl(logger);

    const attempt = fakeClient(() => Promise.resolve());
    wireFakeClients(manager, [attempt]);
    await runEffect(manager.connectServer(STDIO_CONFIG), logger);
    expect(attempt.close).not.toHaveBeenCalled();

    attempt.listTools = mock(() => Promise.reject(new Error("boom")));
    const exit = await runEffectExit(manager.discoverTools(STDIO_CONFIG), logger);

    expect(exit._tag).toBe("Failure");
    // The connection predates discovery, so a failed listing must leave it exactly as
    // it was — still connected, never closed on discovery's behalf.
    expect(await Effect.runPromise(manager.isConnected(STDIO_CONFIG.name))).toBe(true);
    expect(attempt.close).not.toHaveBeenCalled();
  });

  it("still releases a connection it opened when tool listing succeeds", async () => {
    const logger = fakeLogger();
    const manager = new MCPServerManagerImpl(logger);

    const attempt = fakeClient(() => Promise.resolve());
    wireFakeClients(manager, [attempt]);

    const tools = await runEffect(manager.discoverTools(STDIO_CONFIG), logger);

    expect(tools).toEqual([]);
    expect(await Effect.runPromise(manager.isConnected(STDIO_CONFIG.name))).toBe(false);
  });
});
