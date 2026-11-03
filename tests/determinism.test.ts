import { describe, expect, it } from 'vitest';
import { runHeadless, scriptedInputs } from '../src/sim/headless';
import { stateHash } from '../src/sim/hash';
import { startRound, tickWorld } from '../src/sim/sim';
import { serialize, deserialize } from '../src/sim/snapshot';

/**
 * The full 10 000 tick, two-process version of this lives in
 * scripts/determinism.mjs and runs in CI. These are the fast in-process checks
 * that catch the common causes: state leaking between worlds, iteration order,
 * and snapshot round-trips changing state.
 */
describe('determinism (PRD 6.3)', () => {
  it('two worlds from the same seed and input log stay bit-identical', () => {
    const a = runHeadless(0x5eed, 4, 2, 1500, 100);
    const b = runHeadless(0x5eed, 4, 2, 1500, 100);
    expect(a.hashes.length).toBeGreaterThan(10);
    expect(a.hashes).toEqual(b.hashes);
  });

  it('different seeds produce different worlds', () => {
    const a = runHeadless(1, 2, 2, 400, 200);
    const b = runHeadless(2, 2, 2, 400, 200);
    expect(a.hashes.at(-1)).not.toEqual(b.hashes.at(-1));
  });

  it('a world resumed from a snapshot continues identically', () => {
    const seed = 0xc0ffee;
    const { world } = startRound({ seed, playerCount: 2, teamCount: 2 });
    const next = scriptedInputs(seed, 2);
    for (let t = 0; t < 600; t++) tickWorld(world, next(t));

    const snap = serialize(world);
    const restored = deserialize(snap);
    expect(stateHash(restored)).toBe(stateHash(world));

    // Both must then evolve identically under identical input.
    const inputsA = scriptedInputs(seed ^ 0x99, 2);
    const inputsB = scriptedInputs(seed ^ 0x99, 2);
    for (let t = 0; t < 300; t++) {
      tickWorld(world, inputsA(t));
      tickWorld(restored, inputsB(t));
    }
    expect(stateHash(restored)).toBe(stateHash(world));
  });

  it('a snapshot survives a full round trip byte for byte', () => {
    const { world } = startRound({ seed: 77, playerCount: 1, teamCount: 1 });
    const next = scriptedInputs(77, 1);
    for (let t = 0; t < 200; t++) tickWorld(world, next(t));
    const first = serialize(world);
    const second = serialize(deserialize(first));
    expect(second.length).toBe(first.length);
    expect(Array.from(second)).toEqual(Array.from(first));
  });
});
