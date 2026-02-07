import { describe, expect, it } from "bun:test";
import type { GrooveMetadata } from "./groove-service";
import { groupGrooves, formatGroove } from "./utils";

describe("Groove Utilities", () => {
  const cwd = process.cwd();
  const homeDir = process.env["HOME"] || "/tmp";

  const mockGrooves: GrooveMetadata[] = [
    {
      name: "local-groove",
      description: "Local description",
      path: `${cwd}/grooves/local/GROOVE.md`,
    },
    {
      name: "global-groove",
      description: "Global description",
      path: `${homeDir}/.jazz/grooves/global/GROOVE.md`,
    },
    {
      name: "builtin-groove",
      description: "Built-in description",
      path: "/usr/local/lib/jazz/grooves/builtin/GROOVE.md",
    },
  ];

  describe("groupGrooves", () => {
    it("should correctly group grooves by location", () => {
      const { local, global, builtin } = groupGrooves(mockGrooves);
      expect(local.length).toBe(1);
      expect(local[0]?.name).toBe("local-groove");
      expect(global.length).toBe(1);
      expect(global[0]?.name).toBe("global-groove");
      expect(builtin.length).toBe(1);
      expect(builtin[0]?.name).toBe("builtin-groove");
    });
  });

  describe("formatGroove", () => {
    it("should format a groove without status badge", () => {
      const groove = mockGrooves[0]!;
      const result = formatGroove(groove);
      expect(result).toContain("local-groove");
      expect(result).toContain("Local description");
    });

    it("should format a groove with status badge", () => {
      const groove = mockGrooves[0]!;
      const result = formatGroove(groove, { statusBadge: " [ACTIVE]" });
      expect(result).toContain("local-groove [ACTIVE]");
      expect(result).toContain("Local description");
    });

    it("should include schedule and agent info if present", () => {
      const groove: GrooveMetadata = {
        name: "scheduled-groove",
        description: "Scheduled description",
        path: "/path/to/groove",
        schedule: "0 9 * * *",
        agent: "test-agent",
      };
      const result = formatGroove(groove);
      expect(result).toContain("scheduled-groove");
      expect(result).toContain("At 09:00 AM");
      expect(result).toContain("agent: test-agent");
    });
  });
});
