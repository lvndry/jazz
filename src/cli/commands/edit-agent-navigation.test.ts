import { describe, expect, it } from "bun:test";
import { isEditAgentMenuExit, shouldReturnToEditAgentMenu } from "./edit-agent-navigation";

describe("edit-agent navigation", () => {
  it("stays on the edit-agent menu after a successful field update", () => {
    expect(shouldReturnToEditAgentMenu("updated")).toBe(true);
  });

  it("stays on the edit-agent menu when a field edit is cancelled", () => {
    expect(shouldReturnToEditAgentMenu("cancelled")).toBe(true);
  });

  it("leaves the edit-agent menu only when the user is done", () => {
    expect(shouldReturnToEditAgentMenu("done")).toBe(false);
  });

  it("treats Esc, empty, and Done as the path back to the main wizard menu", () => {
    expect(isEditAgentMenuExit(undefined)).toBe(true);
    expect(isEditAgentMenuExit("")).toBe(true);
    expect(isEditAgentMenuExit("done")).toBe(true);
    expect(isEditAgentMenuExit("name")).toBe(false);
    expect(isEditAgentMenuExit("llmModel")).toBe(false);
  });
});
