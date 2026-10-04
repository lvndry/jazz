/**
 * Writes the static logo files that live outside the website (the README renders them from
 * `.github/assets/`), from the same geometry the site renders. Rerun after changing `src/lib/logo.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRAND_CYAN,
  BRAND_CYAN_DEEP,
  BRAND_INK,
  BRAND_SNOW,
  iconSvg,
  lockupSvg,
} from "../src/lib/logo";

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDirectory = join(websiteRoot, "..", "..", ".github", "assets");
mkdirSync(assetsDirectory, { recursive: true });

const files: Record<string, string> = {
  "jazz-logo-on-dark.svg": lockupSvg({ foreground: BRAND_SNOW, accent: BRAND_CYAN }),
  "jazz-logo-on-light.svg": lockupSvg({ foreground: BRAND_INK, accent: BRAND_CYAN_DEEP }),
  "jazz-icon.svg": iconSvg(),
};

for (const [name, svg] of Object.entries(files)) {
  writeFileSync(join(assetsDirectory, name), `${svg}\n`);
  console.log(`wrote .github/assets/${name}`);
}
