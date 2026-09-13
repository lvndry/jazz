import { describe, expect, test } from "bun:test";
import { renderPromptLayers, type PromptLayers } from "./layers";

describe("renderPromptLayers", () => {
  test("renders Core, Scope, and Live in precedence order", () => {
    const layers: PromptLayers = {
      core: [
        { id: "persona", content: "Persona" },
        { id: "harness", content: "Harness" },
      ],
      scope: [{ id: "project", content: "Project" }],
      live: [{ id: "environment", content: "Environment" }],
    };

    expect(renderPromptLayers(layers)).toBe("Persona\n\nHarness\n\nProject\n\nEnvironment");
  });

  test("omits empty sections without disturbing layer order", () => {
    const layers: PromptLayers = {
      core: [{ id: "persona", content: " Persona " }],
      scope: [{ id: "empty", content: "  " }],
      live: [],
    };

    expect(renderPromptLayers(layers)).toBe("Persona");
  });
});
