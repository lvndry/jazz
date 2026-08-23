import { GLYPHS, MOTION } from "../generated/tokens";

export function startLanes(element: HTMLElement): void {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frame = 0;

  const render = (): void => {
    element.innerHTML = GLYPHS.lanePeriods
      .map((period) => {
        const phase = frame % period;
        return phase < GLYPHS.laneBurst.length
          ? `<span class="on">${GLYPHS.laneBurst[phase]}</span>`
          : `<span class="off">${GLYPHS.laneRest}</span>`;
      })
      .join("");
  };

  render();
  if (!reduced) {
    setInterval(() => {
      frame++;
      render();
    }, MOTION.indicator);
  }
}
