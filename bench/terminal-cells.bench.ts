// Grapheme-aware width measurement — the innermost leaf under every wrap. The
// cost profile differs by an order of magnitude across script classes, so each
// class gets its own row.
import { bench, report } from "./harness";
import { terminalCellWidth, wrapTerminalCells } from "../src/cli/ui/fullscreen/terminal-cells";

const ascii = "The quick brown fox jumps over the lazy dog, twice around the block. ".repeat(20);
const cjk = "混合宽度的中文文本会让每个字符占用两个终端单元格进行渲染测量。".repeat(20);
const emoji = "👨‍👩‍👧‍👦 families 🎷 with 🧑🏽‍💻 modifiers and 🇫🇷 flags mixed into prose. ".repeat(20);
const combining = "élève côté naïve façade ".repeat(40);

const results = [
  bench("terminalCellWidth ascii ~1.4KB", () => {
    terminalCellWidth(ascii);
  }),
  bench("terminalCellWidth cjk ~1.8KB", () => {
    terminalCellWidth(cjk);
  }),
  bench("terminalCellWidth emoji/zwj ~2.5KB", () => {
    terminalCellWidth(emoji);
  }),
  bench("terminalCellWidth combining ~1.3KB", () => {
    terminalCellWidth(combining);
  }),
  bench("wrapTerminalCells ascii at 80", () => {
    wrapTerminalCells(ascii, 80);
  }),
  bench("wrapTerminalCells emoji at 80", () => {
    wrapTerminalCells(emoji, 80);
  }),
];

report("terminal-cells", results);
