/**
 * Deterministic PRNG for report sample data.
 *
 * Seeding from a report's own slug is what makes a mock report show the same
 * numbers on every render, so these three functions are arithmetic with no view
 * layer at all. They used to sit in `pages/reports/_shared.tsx` next to the
 * report widgets; they live here so a report's data module can reach them
 * without reaching into a page.
 */

export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rangeRnd = (rng: () => number, min: number, max: number) => min + (max - min) * rng();
