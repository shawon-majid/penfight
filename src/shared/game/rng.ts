/**
 * A small seeded random number generator.
 *
 * The physics is deliberately free of randomness so that a shot plays out the
 * same everywhere. Where we *do* want variety — a bot's aim wobble, a table
 * code — it comes from here, seeded explicitly, so it can be replayed.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform in [-spread, +spread]. */
  jitter(spread: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, and good enough for aim wobble. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    jitter: (spread) => (next() * 2 - 1) * spread,
    pick: (items) => items[Math.floor(next() * items.length) % items.length],
  };
}

/** Turn any string into a seed, so a table code can drive a repeatable match. */
export function seedFromString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
