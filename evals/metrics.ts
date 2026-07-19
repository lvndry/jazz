export function passAt1(samples: boolean[]): number {
  if (samples.length === 0) return 0;
  return samples.filter(Boolean).length / samples.length;
}

export function passAtK(samples: boolean[]): number {
  return samples.some(Boolean) ? 1 : 0;
}

export function passHatK(samples: boolean[]): number {
  return samples.length > 0 && samples.every(Boolean) ? 1 : 0;
}

export function costNormalized(passRate: number, totalCostUSD: number): number {
  return totalCostUSD > 0 ? passRate / totalCostUSD : 0;
}

export function abDelta(aPassAt1: number, bPassAt1: number): { delta: number; improved: boolean } {
  const delta = bPassAt1 - aPassAt1;
  return { delta, improved: delta > 0 };
}

/**
 * Bootstrap 95% CI over per-task pass@1 means. Deterministic: caller passes a
 * seeded RNG so runs are reproducible (jazz forbids Math.random in some paths;
 * use a simple seeded LCG here).
 */
export function bootstrapCI(
  perTaskMeans: number[],
  rng: () => number,
  iters = 1000,
): { lo: number; hi: number; mean: number } {
  const n = perTaskMeans.length;
  const mean = n ? perTaskMeans.reduce((a, b) => a + b, 0) / n : 0;
  if (n === 0) return { lo: 0, hi: 0, mean: 0 };
  const resampleMeans: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += perTaskMeans[Math.floor(rng() * n)]!;
    resampleMeans.push(sum / n);
  }
  resampleMeans.sort((a, b) => a - b);
  return {
    mean,
    lo: resampleMeans[Math.floor(0.025 * iters)]!,
    hi: resampleMeans[Math.floor(0.975 * iters)]!,
  };
}

/** Seeded LCG so bootstrap is reproducible without Math.random. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
