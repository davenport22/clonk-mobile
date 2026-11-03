/** Seeded xorshift32. The only source of randomness in the simulation
 *  (PRD 6.3 rule 1). Advanced exclusively from inside a tick or world setup. */
export class Rng {
  s: number;

  constructor(seed: number) {
    this.s = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  u32(): number {
    let x = this.s | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x | 0;
    return x >>> 0;
  }

  /** Uniform-ish integer in [0, n). Modulo bias is irrelevant at our scale. */
  int(n: number): number {
    if (n <= 1) return 0;
    return this.u32() % n;
  }

  /** Integer in [lo, hi], inclusive. */
  range(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + this.int(hi - lo + 1);
  }

  /** True with probability num/den. */
  chance(num: number, den: number): boolean {
    return this.int(den) < num;
  }
}

/** Deterministic 32-bit integer hash of a lattice coordinate. */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
