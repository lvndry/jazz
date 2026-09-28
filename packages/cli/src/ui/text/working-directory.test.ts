import { describe, expect, it } from "bun:test";
import { compactWorkingDirectory } from "./working-directory";

describe("compactWorkingDirectory", () => {
  it("reads the home prefix as ~ and leaves other paths alone", () => {
    expect(compactWorkingDirectory("/home/ada/work", "/home/ada")).toBe("~/work");
    expect(compactWorkingDirectory("/home/ada", "/home/ada")).toBe("~");
    expect(compactWorkingDirectory("/home/adam/work", "/home/ada")).toBe("/home/adam/work");
    expect(compactWorkingDirectory("/srv/jazz", undefined)).toBe("/srv/jazz");
  });
});
