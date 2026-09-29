import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { AppConfig } from "@/core/types/config";
import { trustableGetHost } from "./egress-taint";
import { rememberTrustedGetHost } from "./trusted-get-hosts";
import { silentLogger } from "../test-logger";

function remember(host: string, saved: readonly string[], runHosts: string[]) {
  const writes: unknown[] = [];
  const config: Partial<AppConfig> = { network: { trustedGetHosts: saved } };
  const configService = {
    appConfig: Effect.succeed(config),
    set: (_key: string, value: unknown) => Effect.sync(() => writes.push(value)),
  } as unknown as AgentConfigService;
  const layer = Layer.mergeAll(
    Layer.succeed(AgentConfigServiceTag, configService),
    Layer.succeed(LoggerServiceTag, silentLogger),
  );
  return Effect.runPromise(
    rememberTrustedGetHost(host, { trustedGetHosts: runHosts }).pipe(Effect.provide(layer)),
  ).then(() => writes);
}

describe("rememberTrustedGetHost", () => {
  it("trusts the host in the running run and saves it to the config", async () => {
    const runHosts: string[] = [];
    const writes = await remember("eutils.ncbi.nlm.nih.gov", ["a.example"], runHosts);
    expect(runHosts).toEqual(["eutils.ncbi.nlm.nih.gov"]);
    expect(writes).toEqual([["a.example", "eutils.ncbi.nlm.nih.gov"]]);
  });

  it("writes nothing when the host is already saved, and ignores an invalid host", async () => {
    expect(await remember("a.example", ["a.example"], [])).toEqual([]);
    const runHosts: string[] = [];
    expect(await remember("10.0.0.1", [], runHosts)).toEqual([]);
    expect(runHosts).toEqual([]);
  });

  it("keeps the run's list without writing when the saved list is full", async () => {
    const full = Array.from({ length: 64 }, (_unused, index) => `h${String(index)}.example`);
    const runHosts: string[] = [];
    expect(await remember("new.example", full, runHosts)).toEqual([]);
    expect(runHosts).toEqual(["new.example"]);
  });
});

describe("trustableGetHost", () => {
  it("names the host of a plain GET or HEAD, query allowed", () => {
    expect(
      trustableGetHost("http_request", {
        method: "GET",
        url: "https://EUtils.example./x",
        query: {},
      }),
    ).toBe("eutils.example");
    expect(trustableGetHost("web_fetch", { url: "http://docs.example/a" })).toBe("docs.example");
  });

  it("names nothing for other methods, bodies, headers, addresses and other schemes", () => {
    expect(trustableGetHost("http_request", { method: "POST", url: "https://a.example" })).toBe(
      undefined,
    );
    expect(
      trustableGetHost("http_request", { method: "GET", url: "https://a.example", body: "x" }),
    ).toBe(undefined);
    expect(
      trustableGetHost("http_request", { method: "GET", url: "https://a.example", headers: {} }),
    ).toBe(undefined);
    expect(trustableGetHost("web_fetch", { url: "http://192.168.1.5/a" })).toBe(undefined);
    expect(trustableGetHost("web_fetch", { url: "ftp://a.example/" })).toBe(undefined);
    expect(trustableGetHost("execute_command", { command: "ls" })).toBe(undefined);
  });
});
