/**
 * Q16.16 fixed-point arithmetic. Every gameplay value that is not a plain
 * integer lives in this representation. See PRD 6.3 rule 2: no floats in
 * simulation code, ever.
 *
 * Only Math.floor / Math.imul / Math.abs / Math.min / Math.max are used, all of
 * which are exact integer operations on the ranges we care about, so results are
 * bit-identical across engines.
 */

export const SHIFT = 16;
export const ONE = 65536;
export const HALF = 32768;

/** Integer -> Fx. */
export function of(n: number): number {
  return (n * ONE) | 0;
}

/** Fx -> integer, rounding toward negative infinity. */
export function floor(a: number): number {
  return a >> SHIFT;
}

/** Fx -> nearest integer. */
export function round(a: number): number {
  return (a + HALF) >> SHIFT;
}

/** Fractional part of an Fx value, always in [0, ONE). */
export function frac(a: number): number {
  return a & (ONE - 1);
}

/** Fx * Fx -> Fx. 48-bit intermediate emulated with 16-bit limbs. */
export function mul(a: number, b: number): number {
  const ah = a >> SHIFT;
  const al = a & 0xffff;
  const bh = b >> SHIFT;
  const bl = b & 0xffff;
  return (
    (Math.imul(ah, bh) << SHIFT) +
    Math.imul(ah, bl) +
    Math.imul(al, bh) +
    ((Math.imul(al, bl) >>> SHIFT) | 0)
  ) | 0;
}

/** Fx / Fx -> Fx. */
export function div(a: number, b: number): number {
  if (b === 0) return a < 0 ? -0x7fffffff : 0x7fffffff;
  return Math.floor((a * ONE) / b) | 0;
}

/** Exact integer division, floored. Use this instead of `/` inside src/sim. */
export function idiv(a: number, b: number): number {
  return Math.floor(a / b) | 0;
}

/** Fx scaled by the integer ratio num/den. */
export function ratio(num: number, den: number): number {
  return Math.floor((num * ONE) / den) | 0;
}

export function abs(a: number): number {
  return a < 0 ? -a : a;
}

export function sign(a: number): number {
  return a < 0 ? -1 : a > 0 ? 1 : 0;
}

export function clamp(a: number, lo: number, hi: number): number {
  return a < lo ? lo : a > hi ? hi : a;
}

export function min(a: number, b: number): number {
  return a < b ? a : b;
}

export function max(a: number, b: number): number {
  return a > b ? a : b;
}

/** Integer square root, floored. Exact for n < 2^53. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  if (n < 4) return 1;
  let x = Math.floor(n * 0.5) + 1;
  let y = Math.floor((x + Math.floor(n / x)) * 0.5);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) * 0.5);
  }
  return x;
}

/** sqrt of an Fx value -> Fx. */
export function sqrt(a: number): number {
  if (a <= 0) return 0;
  return isqrt(a * ONE) | 0;
}

/** Length of an integer-pixel vector, in integer pixels. */
export function ilen(dx: number, dy: number): number {
  return isqrt(Math.imul(dx, dx) + Math.imul(dy, dy));
}

/** Linear interpolation with an Fx weight t in [0, ONE]. */
export function lerp(a: number, b: number, t: number): number {
  return (a + mul(b - a, t)) | 0;
}

/** Integer smoothstep weight: t in [0, ONE] -> [0, ONE]. 3t^2 - 2t^3. */
export function smooth(t: number): number {
  const t2 = mul(t, t);
  return (mul(of(3), t2) - mul(of(2), mul(t2, t))) | 0;
}
