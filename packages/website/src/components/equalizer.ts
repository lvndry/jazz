/**
 * The equalizer room: quantized cell columns on canvas, cyan on near-black.
 * Columns oscillate on the product's coprime lane periods; the cursor (or a
 * touch) excites nearby columns. Cells are drawn as exact rectangles —
 * "drawn, not pictured", the way terminals render block elements.
 */
import { GLYPHS } from "../generated/tokens";

const CELL = 16;
const GAP = 3;
const ALPHAS = [0.1, 0.22, 0.45, 0.95] as const;
const ACCENT = "0,215,255";
const PEAK = "232,235,239";

export function startEqualizer(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let width = 0;
  let height = 0;
  let columns: Array<{ f1: number; f2: number; phase: number; boost: number }> = [];
  let pointerX = -1;
  let pointerHeat = 0;

  const size = (): void => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.ceil(width / CELL);
    const periods = GLYPHS.lanePeriods;
    columns = Array.from({ length: count }, (_, index) => ({
      f1: (periods[index % periods.length] ?? 3) * 0.09,
      f2: (periods[(index * 3 + 1) % periods.length] ?? 5) * 0.041,
      phase: ((index * 2654435761) % 1000) / 159,
      boost: 0,
    }));
  };
  size();
  window.addEventListener("resize", size);

  const excite = (clientX: number): void => {
    const rect = canvas.getBoundingClientRect();
    pointerX = clientX - rect.left;
    pointerHeat = 1;
  };
  window.addEventListener("mousemove", (event) => excite(event.clientX), { passive: true });
  window.addEventListener(
    "touchmove",
    (event) => {
      const touch = event.touches[0];
      if (touch) excite(touch.clientX);
    },
    { passive: true },
  );

  let time = 0;
  const draw = (): void => {
    time += reduced ? 0.003 : 0.016;
    pointerHeat *= 0.97;
    context.clearRect(0, 0, width, height);
    const maxBars = (height / CELL) * 0.55;
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index]!;
      const wave =
        Math.abs(Math.sin(time * column.f1 + column.phase)) * 0.55 +
        Math.abs(Math.sin(time * column.f2 + column.phase * 1.7)) * 0.45;
      let near = 0;
      if (pointerX >= 0) {
        const dx = index * CELL + CELL / 2 - pointerX;
        near = Math.exp(-(dx * dx) / (2 * 90 * 90)) * pointerHeat;
      }
      column.boost += (near - column.boost) * 0.12;
      const bars = Math.round((wave * 0.32 + column.boost * 0.55 + 0.03) * maxBars);
      for (let bar = 0; bar < bars; bar++) {
        const y = height - (bar + 1) * CELL;
        const fraction = bar / Math.max(bars - 1, 1);
        const band = fraction > 0.92 ? 3 : fraction > 0.6 ? 2 : fraction > 0.3 ? 1 : 0;
        context.fillStyle =
          band === 3 && column.boost > 0.25
            ? `rgba(${PEAK},${ALPHAS[3]})`
            : `rgba(${ACCENT},${ALPHAS[band]})`;
        context.fillRect(index * CELL, y + GAP / 2, CELL - GAP, CELL - GAP);
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}
