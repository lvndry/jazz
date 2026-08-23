import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GLYPHS } from "../../src/cli/ui/glyphs";
import { MOTION, PALETTES, type ThemeColors } from "../../src/cli/ui/theme";

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const kebabCase = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const cssBlock = (palette: ThemeColors, indent: string): string =>
  Object.entries(palette)
    .map(([token, value]) => `${indent}--jz-${kebabCase(token)}: ${value};`)
    .join("\n");

const header = `/*
 * GENERATED from src/cli/ui/theme.ts — do not edit by hand.
 * Regenerate with: bun run tokens (from website/).
 *
 * Skins: pages opt in via data-skin on <html>. The default is the light
 * palette, the system dark preference flips it, and an explicit
 * data-skin always wins. Marketing pages pin data-skin="dark".
 */`;

const tokensCss = `${header}

:root {
${cssBlock(PALETTES.light, "  ")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-skin="light"]) {
${cssBlock(PALETTES.dark, "    ")}
  }
}

[data-skin="dark"] {
${cssBlock(PALETTES.dark, "  ")}
}
`;

const tokensTs = `// GENERATED from src/cli/ui/theme.ts and src/cli/ui/glyphs.ts — do not edit by hand.
// Regenerate with: bun run tokens (from website/).

export const PALETTES = ${JSON.stringify(PALETTES, null, 2)} as const;

export const GLYPHS = ${JSON.stringify(GLYPHS.unicode, null, 2)} as const;

export const MOTION = ${JSON.stringify(MOTION, null, 2)} as const;
`;

await mkdir(join(websiteRoot, "src/styles"), { recursive: true });
await mkdir(join(websiteRoot, "src/generated"), { recursive: true });
await Bun.write(join(websiteRoot, "src/styles/tokens.css"), tokensCss);
await Bun.write(join(websiteRoot, "src/generated/tokens.ts"), tokensTs);

console.log("wrote src/styles/tokens.css and src/generated/tokens.ts");
