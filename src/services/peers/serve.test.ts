import { describe, expect, it } from "bun:test";
import type { ToolDisclosure } from "@/core/interfaces/tool-registry";
import type { PeerTier } from "@/core/types/peer";
import { allowedToolsForTier } from "./serve";

/** A slice of the real registry: one tool per interesting combination. */
const TOOLS: readonly {
  name: string;
  riskLevel: string;
  disclosure: ToolDisclosure;
}[] = [
  { name: "get_time", riskLevel: "read-only", disclosure: "internal" },
  { name: "web_search", riskLevel: "read-only", disclosure: "public" },
  { name: "ls", riskLevel: "read-only", disclosure: "internal" },
  { name: "read_file", riskLevel: "read-only", disclosure: "private" },
  { name: "view_memory", riskLevel: "read-only", disclosure: "private" },
  { name: "write_file", riskLevel: "high-risk", disclosure: "public" },
  { name: "execute_command", riskLevel: "unknown", disclosure: "private" },
  { name: "manage_memory", riskLevel: "low-risk", disclosure: "private" },
  { name: "ask_user_question", riskLevel: "read-only", disclosure: "private" },
  { name: "ask_file_picker", riskLevel: "read-only", disclosure: "private" },
];

function allowed(tier: PeerTier): readonly string[] {
  return [...allowedToolsForTier(tier, TOOLS)].sort();
}

describe("what a tier permits", () => {
  it("gives a suspended peer nothing at all", () => {
    expect(allowed("none")).toEqual([]);
  });

  it("gives public only answers that are not about the operator", () => {
    expect(allowed("public")).toEqual(["web_search"]);
  });

  it("adds the shape of the machine at about-me, but not its contents", () => {
    expect(allowed("about-me")).toEqual(["get_time", "ls", "web_search"]);
    expect(allowed("about-me")).not.toContain("read_file");
    expect(allowed("about-me")).not.toContain("view_memory");
  });

  it("adds the operator's own material only at ask-me-anything", () => {
    expect(allowed("ask-me-anything")).toContain("read_file");
    expect(allowed("ask-me-anything")).toContain("view_memory");
  });

  it("never permits an action, at any tier", () => {
    // The line the design draws: no tier lets a stranger's agent change anything. Checked
    // for every tier rather than the top one, so widening a tier later cannot slip past.
    const actions = ["write_file", "execute_command", "manage_memory"];
    for (const tier of ["none", "public", "about-me", "ask-me-anything"] as const) {
      for (const action of actions) {
        expect(allowed(tier)).not.toContain(action);
      }
    }
  });

  it("never lets a peer make the agent interrupt its owner", () => {
    // ask_user_question and ask_file_picker are read-only and personal, so the top tier
    // would otherwise admit them — and a stranger able to pop a prompt in front of somebody
    // as though their own agent were asking is a channel that should not exist.
    for (const tier of ["public", "about-me", "ask-me-anything"] as const) {
      expect(allowed(tier)).not.toContain("ask_user_question");
      expect(allowed(tier)).not.toContain("ask_file_picker");
    }
  });

  it("excludes a tool that writes even if its disclosure says none", () => {
    // Belt and braces: `write_file` discloses nothing, so a disclosure-only filter would
    // admit it. The risk filter is what keeps it out.
    expect(allowed("ask-me-anything")).not.toContain("write_file");
  });

  it("is monotonic — a higher tier never permits less", () => {
    const order: readonly PeerTier[] = ["none", "public", "about-me", "ask-me-anything"];
    for (let index = 1; index < order.length; index++) {
      const narrower = new Set(allowed(order[index - 1]!));
      for (const tool of narrower) {
        expect(allowed(order[index]!)).toContain(tool);
      }
    }
  });
});
