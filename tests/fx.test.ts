import { describe, expect, it } from 'vitest';
import * as Fx from '../src/fx/fx';

describe('Q16.16 fixed point', () => {
  it('round-trips integers', () => {
    for (const n of [0, 1, -1, 7, -7, 1000, -1000, 32767, -32767]) {
      expect(Fx.floor(Fx.of(n))).toBe(n);
    }
  });

  it('multiplies without drifting from the rational result', () => {
    const cases: Array<[number, number]> = [
      [1, 1],
      [2, 3],
      [-4, 5],
      [-6, -7],
      [123, 45],
    ];
    for (const [a, b] of cases) {
      expect(Fx.mul(Fx.of(a), Fx.of(b))).toBe(Fx.of(a * b));
    }
  });

  it('multiplies fractions correctly', () => {
    const half = Fx.ratio(1, 2);
    const quarter = Fx.ratio(1, 4);
    expect(Fx.mul(half, half)).toBe(quarter);
    expect(Fx.mul(-half, half)).toBe(-quarter);
  });

  it('divides consistently with multiply', () => {
    for (let n = 1; n < 40; n++) {
      const q = Fx.div(Fx.of(n), Fx.of(7));
      // Within one ulp of the exact value.
      expect(Math.abs(q - Fx.ratio(n, 7))).toBeLessThanOrEqual(1);
    }
  });

  it('floors toward negative infinity', () => {
    expect(Fx.floor(Fx.ratio(-1, 2))).toBe(-1);
    expect(Fx.floor(Fx.ratio(1, 2))).toBe(0);
    expect(Fx.frac(Fx.ratio(-1, 2))).toBe(Fx.HALF);
  });

  it('integer square root is exact', () => {
    for (const n of [0, 1, 2, 3, 4, 15, 16, 17, 99, 100, 101, 1 << 20]) {
      expect(Fx.isqrt(n)).toBe(Math.floor(Math.sqrt(n)));
    }
  });

  it('vector length matches Euclidean distance, floored', () => {
    expect(Fx.ilen(3, 4)).toBe(5);
    expect(Fx.ilen(-3, -4)).toBe(5);
    expect(Fx.ilen(1, 1)).toBe(1);
  });

  it('smoothstep stays inside the unit range and is monotonic', () => {
    let prev = -1;
    for (let i = 0; i <= 16; i++) {
      const v = Fx.smooth(Fx.ratio(i, 16));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(Fx.ONE);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(Fx.smooth(0)).toBe(0);
    expect(Fx.smooth(Fx.ONE)).toBe(Fx.ONE);
  });

  it('idiv floors like the grid indexing code expects', () => {
    expect(Fx.idiv(7, 2)).toBe(3);
    expect(Fx.idiv(-7, 2)).toBe(-4);
    expect(Fx.idiv(1024 * 5 + 3, 1024)).toBe(5);
  });
});
