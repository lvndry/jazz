import { describe, expect, it } from "bun:test";
import { nameFromPrompt } from "./loop-names";

describe("nameFromPrompt", () => {
  it("takes the first meaningful words of the prompt", () => {
    expect(nameFromPrompt("Check whether the deploy finished and tell me")).toBe(
      "check deploy finished",
    );
    expect(nameFromPrompt("Read status.txt in the current directory")).toBe("read status txt");
  });

  it("is empty when the prompt has only filler words", () => {
    expect(nameFromPrompt("if it is the")).toBe("");
  });
});
