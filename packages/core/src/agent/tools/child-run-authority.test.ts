import { describe, expect, it } from "bun:test";
import { createEgressTaint } from "@/core/agent/execution/egress-taint";
import type { AutoApprovePolicy } from "@/core/types/tools";
import { childRunAuthority } from "./child-run-authority";

const base = { agentId: "a", conversationId: "c" };

describe("childRunAuthority", () => {
  it("hands down no policy when the parent has none, so the child stays strict", () => {
    const authority = childRunAuthority({ ...base, effectiveToolNames: new Set(["read_file"]) });
    expect(authority.autoApprovePolicy).toBeUndefined();
  });

  it("hands down the parent's live policy getter, so a later mode switch reaches the child", () => {
    let policy: AutoApprovePolicy = "read-only";
    const authority = childRunAuthority({ ...base, getAutoApprovePolicy: () => policy });
    const getter = authority.autoApprovePolicy;
    if (typeof getter !== "function") throw new Error("expected a getter");
    expect(getter()).toBe("read-only");
    policy = false;
    expect(getter()).toBe(false);
  });

  it("shares the parent's allowlists by reference", () => {
    const commands = ["git status"];
    const tools = ["read_file"];
    const authority = childRunAuthority({
      ...base,
      autoApprovedCommands: commands,
      autoApprovedTools: tools,
    });
    expect(authority.autoApprovedCommands).toBe(commands);
    expect(authority.autoApprovedTools).toBe(tools);
  });

  it("caps the child at the parent's tools, and at none when those are unknown", () => {
    expect(
      childRunAuthority({ ...base, effectiveToolNames: new Set(["read_file", "grep"]) })
        .toolAllowlist,
    ).toEqual(["read_file", "grep"]);
    expect(childRunAuthority(base).toolAllowlist).toEqual([]);
    expect(childRunAuthority({ ...base, unrestrictedTools: true }).toolAllowlist).toBeUndefined();
  });
  it("shares the parent's egress taint, so untrusted content the parent read still gates the child", () => {
    const egressTaint = createEgressTaint();
    expect(childRunAuthority({ ...base, egressTaint }).egressTaint).toBe(egressTaint);
    expect(childRunAuthority(base).egressTaint).toBeUndefined();
  });
});
