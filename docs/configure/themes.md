---
description: "Choose a built-in CLI theme, switch dark or light variants, or supply your own theme file."
---

# CLI themes

Run `/theme` inside Jazz to list available themes. Run `/theme <name> dark` or
`/theme <name> light` to select a variant and save it. You can also set
`ui.theme` in `~/.jazz/config.json` (for example, `"tokyo-night:dark"`) or set
`JAZZ_THEME=rose-pine:light` for a session; the environment variable wins.
`system` remains the default and uses your terminal's colors.

Jazz includes both dark and light variants of these themes:

| Theme name    | Palette              |
| ------------- | -------------------- |
| `jazz`        | Jazz's house palette |
| `catppuccin`  | Catppuccin-inspired  |
| `tokyo-night` | Tokyo Night          |
| `kanagawa`    | Kanagawa             |
| `rose-pine`   | Rosé Pine            |
| `gruvbox`     | Gruvbox              |
| `nord`        | Nord                 |
| `everforest`  | Everforest           |
| `poimandres`  | Poimandres           |
| `everblush`   | Everblush            |

Poimandres and Everblush only publish dark palettes upstream. Their light
variants are Jazz adaptations, not official upstream color schemes. Some
accents in other themes are adjusted for readable text and distinct semantic
roles in Jazz's UI.

For a custom palette, place a theme JSON file in `~/.jazz/themes` and select
its name with `/theme` or `ui.theme`. Built-in names are reserved; a custom file
cannot replace them. See the [configuration reference](./config-reference.md)
for the `ui.theme` setting and [environment variables](./environment-variables.md)
for `JAZZ_THEME`.
