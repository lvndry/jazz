import { describe, expect, it } from "bun:test";
import packageJson from "../package.json";

describe("npm package shape", () => {
  it("does not publish TypeScript declarations", () => {
    expect("types" in packageJson).toBe(false);
    expect(packageJson.files.some((entry) => entry.includes(".d.ts"))).toBe(false);
  });

  it("ships every JS chunk under dist/", () => {
    const coversChunks = packageJson.files.some(
      (entry) =>
        entry === "dist/" || entry === "dist" || entry === "dist/*.js" || entry === "dist/**/*.js",
    );
    expect(coversChunks).toBe(true);
    expect(packageJson.bin.jazz).toBe("./dist/main.js");
    expect(packageJson.main).toBe("dist/main.js");
  });
});
