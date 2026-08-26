import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  extractServerNamesFromToolNames,
  isAuthenticationRequired,
  parseServerNameFromToolName,
} from "./mcp";

const SERVERS = ["railway", "notion", "atlas-local", "my_server"];

async function parse(toolName: string, servers: readonly string[] = SERVERS) {
  return Effect.runPromise(
    parseServerNameFromToolName(toolName, servers).pipe(
      Effect.map((name) => name as string | null),
      Effect.catchAll(() => Effect.succeed(null)),
    ),
  );
}

describe("parseServerNameFromToolName", () => {
  test("resolves a tool whose own name contains underscores", async () => {
    // Splitting on the last underscore read this as server "railway_list",
    // which matched nothing and silently dropped the tool.
    expect(await parse("mcp_railway_list_projects")).toBe("railway");
    expect(await parse("mcp_railway_get_service_config")).toBe("railway");
  });

  test("resolves a server whose own name contains underscores or dashes", async () => {
    expect(await parse("mcp_my_server_do_thing")).toBe("my_server");
    expect(await parse("mcp_atlas-local_connect")).toBe("atlas-local");
  });

  test("prefers the longest matching server name", async () => {
    const servers = ["railway", "railway_staging"];
    expect(await parse("mcp_railway_staging_deploy", servers)).toBe("railway_staging");
    expect(await parse("mcp_railway_deploy", servers)).toBe("railway");
  });

  test("rejects a name without the mcp_ prefix", async () => {
    expect(await parse("read_file")).toBeNull();
  });

  test("rejects a tool from a server that is no longer configured", async () => {
    expect(await parse("mcp_removed_tool", SERVERS)).toBeNull();
  });
});

describe("extractServerNamesFromToolNames", () => {
  test("collects the distinct servers a tool list references", async () => {
    const names = await Effect.runPromise(
      extractServerNamesFromToolNames(
        ["mcp_railway_list_projects", "mcp_railway_deploy", "mcp_notion_search"],
        SERVERS,
      ),
    );

    expect([...names].sort()).toEqual(["notion", "railway"]);
  });

  test("skips unmatched tools rather than failing the whole list", async () => {
    // An agent saved against a server the user later removed must still open.
    const names = await Effect.runPromise(
      extractServerNamesFromToolNames(["mcp_gone_tool", "mcp_notion_search"], SERVERS),
    );

    expect([...names]).toEqual(["notion"]);
  });
});

describe("isAuthenticationRequired", () => {
  test("recognises real credential failures", () => {
    expect(isAuthenticationRequired(new Error("HTTP 401 Unauthorized"))).toBe(true);
    expect(isAuthenticationRequired("Request failed with status 403")).toBe(true);
    expect(isAuthenticationRequired(new Error("invalid api key"))).toBe(true);
    expect(isAuthenticationRequired(new Error("authentication required"))).toBe(true);
  });

  test("does not claim ordinary failures are credential problems", () => {
    // The old heuristic matched any message containing "invalid" and sent
    // people off to check credentials that were fine.
    expect(isAuthenticationRequired(new Error("invalid schema for tool search"))).toBe(false);
    expect(isAuthenticationRequired(new Error("Invalid argument: limit"))).toBe(false);
    expect(isAuthenticationRequired(new Error("ECONNREFUSED 127.0.0.1:9000"))).toBe(false);
    expect(isAuthenticationRequired(new Error("spawn npx ENOENT"))).toBe(false);
  });

  test("handles empty input", () => {
    expect(isAuthenticationRequired(null)).toBe(false);
    expect(isAuthenticationRequired(undefined)).toBe(false);
  });
});
