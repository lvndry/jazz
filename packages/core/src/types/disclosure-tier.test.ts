import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ToolRegistryTag, type Tool, type ToolRegistry } from "@/core/interfaces/tool-registry";
import { ToolNotFoundError } from "@/core/types/errors";
import {
  allowedToolsForTier,
  DISCLOSURE_TIERS,
  isDisclosureTier,
  type DisclosureTier,
  type TierCandidateTool,
} from "./disclosure-tier";
import { resolveToolAllowlist } from "./resolve-tool-allowlist";

/** A slice of the real registry: one tool per interesting combination. */
const TOOLS: readonly TierCandidateTool[] = [
  { name: "get_time", riskLevel: "read-only", disclosure: "internal", egress: false },
  { name: "web_search", riskLevel: "read-only", disclosure: "public", egress: true },
  { name: "ls", riskLevel: "read-only", disclosure: "internal", egress: false },
  { name: "read_file", riskLevel: "read-only", disclosure: "private", egress: false },
  { name: "view_memory", riskLevel: "read-only", disclosure: "private", egress: false },
  { name: "write_file", riskLevel: "high-risk", disclosure: "public", egress: false },
  { name: "execute_command", riskLevel: "unknown", disclosure: "private", egress: false },
  { name: "manage_memory", riskLevel: "low-risk", disclosure: "private", egress: false },
];

function allowed(tier: string, allow: readonly string[] = []): readonly string[] {
  return [...allowedToolsForTier(tier, allow, TOOLS)].sort();
}

describe("what a tier permits among read-only tools", () => {
  it("gives a revoked caller nothing at all", () => {
    expect(allowed("none")).toEqual([]);
  });

  it("gives public only answers that are not about the operator", () => {
    expect(allowed("public")).toEqual([]);
  });

  it("adds the shape of the machine at internal, but not its contents", () => {
    expect(allowed("internal")).toEqual(["get_time", "ls"]);
    expect(allowed("internal")).not.toContain("read_file");
    expect(allowed("internal")).not.toContain("view_memory");
  });

  it("adds the operator's own material only at private", () => {
    expect(allowed("private")).toContain("read_file");
    expect(allowed("private")).toContain("view_memory");
  });

  it("is monotonic — a higher tier never permits less among read-only tools", () => {
    for (let index = 1; index < DISCLOSURE_TIERS.length; index++) {
      const narrower = new Set(allowed(DISCLOSURE_TIERS[index - 1]!));
      for (const tool of narrower) {
        expect(allowed(DISCLOSURE_TIERS[index]!)).toContain(tool);
      }
    }
  });

  it("fails closed on a tier nobody defined, rather than throwing", () => {
    // A typo in a config file reaches this as a plain string. Indexing the tier table with it
    // would take the whole door down; the safe reading of an unintelligible grant is none.
    expect(isDisclosureTier("intrenal")).toBe(false);
    expect(allowed("intrenal")).toEqual([]);
    expect(allowed("", ["write_file"])).toEqual([]);
  });
});

describe("what a tier permits among outbound tools", () => {
  it("requires an explicit grant even when the response is public", () => {
    expect(allowed("private")).not.toContain("web_search");
    expect(allowed("public", ["web_search"])).toContain("web_search");
  });
});

describe("what a tier permits among riskier-than-read-only tools", () => {
  it("never permits an action absent an explicit grant, whatever the tier", () => {
    const actions = ["write_file", "execute_command", "manage_memory"];
    for (const tier of DISCLOSURE_TIERS) {
      for (const action of actions) {
        expect(allowed(tier)).not.toContain(action);
      }
    }
  });

  it("is capability, not disclosure, that gates a riskier tool: an explicit grant admits it regardless of tier", () => {
    // Even the narrowest non-revoked tier (public) gets a granted action — disclosure has
    // nothing to say about a tool that can act but reveals nothing.
    expect(allowed("public", ["write_file"])).toContain("write_file");
  });

  it("still withholds an ungranted action at the top tier", () => {
    expect(allowed("private", ["write_file"])).not.toContain("execute_command");
  });

  it("a revoked caller gets nothing, even with a standing grant", () => {
    // `none` means no relationship at all — the peer door refuses before this function is
    // ever consulted, but the function itself must not quietly admit a grant for a caller
    // with no tier.
    expect(allowed("none", ["write_file"])).toEqual([]);
  });
});

function registryOf(tools: readonly TierCandidateTool[], unhandable: readonly string[] = []) {
  return {
    listTools: () => Effect.succeed([...tools.map((tool) => tool.name), ...unhandable]),
    getTool: (name: string) => {
      const found = tools.find((tool) => tool.name === name);
      return found === undefined
        ? Effect.fail(new ToolNotFoundError({ toolName: name }))
        : Effect.succeed(found as unknown as Tool);
    },
  } as unknown as ToolRegistry;
}

function resolve(
  tier: DisclosureTier,
  unhandable: readonly string[] = [],
): Promise<readonly string[]> {
  return Effect.runPromise(
    resolveToolAllowlist(tier, []).pipe(
      Effect.provideService(ToolRegistryTag, registryOf(TOOLS, unhandable)),
    ),
  );
}

describe("resolving an allowlist against the live registry", () => {
  it("describes every registered tool and applies the tier to it", async () => {
    expect([...(await resolve("internal"))].sort()).toEqual(["get_time", "ls"]);
  });

  it("leaves out a listed name the registry will not hand over", async () => {
    // A tool that cannot be described cannot be reasoned about, so admitting it unexamined
    // would be admitting an unknown risk level and an unknown disclosure.
    expect(await resolve("private", ["ghost"])).not.toContain("ghost");
  });
});
