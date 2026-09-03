import { describe, expect, it } from "bun:test";
import { withoutDeniedTools } from "./agent-tool-resolution";

describe("subtracting denied tools", () => {
  const granted = ["read_file", "write_file", "execute_command", "web_search"];

  it("leaves the set alone when nothing is denied", () => {
    expect(withoutDeniedTools(granted, undefined, undefined)).toEqual(granted);
    expect(withoutDeniedTools(granted, [], [])).toEqual(granted);
  });

  it("removes what the agent denies", () => {
    expect(withoutDeniedTools(granted, undefined, ["execute_command"])).toEqual([
      "read_file",
      "write_file",
      "web_search",
    ]);
  });

  it("removes what the persona denies", () => {
    expect(withoutDeniedTools(granted, ["write_file"], undefined)).toEqual([
      "read_file",
      "execute_command",
      "web_search",
    ]);
  });

  it("applies both lists, not whichever is longer", () => {
    expect(withoutDeniedTools(granted, ["write_file"], ["execute_command"])).toEqual([
      "read_file",
      "web_search",
    ]);
  });

  it("tolerates a tool denied twice", () => {
    expect(withoutDeniedTools(granted, ["web_search"], ["web_search"])).toEqual([
      "read_file",
      "write_file",
      "execute_command",
    ]);
  });

  it("ignores a denial for a tool that was never granted", () => {
    // Denying something the agent could not reach anyway is not an error: a tool can be
    // removed from jazz, or come from an MCP server that is not connected right now, and a
    // stale entry in the list should not change what happens.
    expect(withoutDeniedTools(granted, undefined, ["mcp_gone"])).toEqual(granted);
  });

  it("can deny a tool the agent's own config asked for", () => {
    // `config.tools` adds and `deniedTools` subtracts, and subtraction runs last, so an
    // agent that both requests and denies a tool does not get it. Contradictory config,
    // but it has to resolve one way, and withholding is the safe direction.
    expect(withoutDeniedTools(["mcp_linear"], undefined, ["mcp_linear"])).toEqual([]);
  });
});
