import { describe, expect, it } from 'vitest';
import { GRID_H, GRID_W } from '../src/data/config';
import { MAT } from '../src/data/materials';
import { at, markAllChunks, setCell, updateMaterial } from '../src/sim/grid';
import { createWorld, type World } from '../src/sim/world';

function emptyWorld(): World {
  const w = createWorld(1, 0, 1);
  w.mat.fill(MAT.SKY);
  for (let x = 0; x < GRID_W; x++) w.mat[(GRID_H - 1) * GRID_W + x] = MAT.GRANITE;
  markAllChunks(w);
  return w;
}

function step(w: World, n: number): void {
  for (let i = 0; i < n; i++) {
    updateMaterial(w);
    w.tick++;
  }
}

function count(w: World, m: number): number {
  let n = 0;
  for (let i = 0; i < w.mat.length; i++) if (w.mat[i] === m) n++;
  return n;
}

describe('material grid (PRD M1)', () => {
  it('sand falls until it rests on something solid', () => {
    const w = emptyWorld();
    setCell(w, 100, 100, MAT.SAND);
    step(w, 500);
    expect(at(w, 100, 100)).toBe(MAT.SKY);
    expect(at(w, 100, GRID_H - 2)).toBe(MAT.SAND);
  });

  it('conserves water: cells move, they never appear or vanish', () => {
    const w = emptyWorld();
    for (let x = 200; x < 240; x++) {
      for (let y = 100; y < 120; y++) setCell(w, x, y, MAT.WATER);
    }
    const before = count(w, MAT.WATER);
    step(w, 400);
    expect(count(w, MAT.WATER)).toBe(before);
  });

  it('water settles instead of oscillating forever', () => {
    const w = emptyWorld();
    // A bowl, so the water has somewhere to come to rest.
    for (let y = GRID_H - 30; y < GRID_H - 1; y++) {
      setCell(w, 300, y, MAT.GRANITE);
      setCell(w, 360, y, MAT.GRANITE);
    }
    for (let x = 320; x < 340; x++) {
      for (let y = 100; y < 110; y++) setCell(w, x, y, MAT.WATER);
    }
    step(w, 1200);
    const before = w.mat.slice();
    step(w, 60);
    let moved = 0;
    for (let i = 0; i < w.mat.length; i++) if (w.mat[i] !== before[i]) moved++;
    expect(moved).toBe(0);
  });

  it('unsupported earth collapses, supported earth does not', () => {
    const w = emptyWorld();
    // A wide slab resting on two pillars: the middle must hold.
    for (let x = 400; x < 460; x++) setCell(w, x, 300, MAT.EARTH);
    for (let y = 301; y < GRID_H - 1; y++) {
      setCell(w, 400, y, MAT.GRANITE);
      setCell(w, 459, y, MAT.GRANITE);
    }
    step(w, 200);
    expect(at(w, 430, 300)).toBe(MAT.EARTH);

    // A lone overhanging tip must not.
    setCell(w, 500, 200, MAT.EARTH);
    step(w, 400);
    expect(at(w, 500, 200)).toBe(MAT.SKY);
  });

  it('sand displaces water rather than deleting it', () => {
    const w = emptyWorld();
    for (let y = GRID_H - 20; y < GRID_H - 1; y++) setCell(w, 600, y, MAT.WATER);
    const water = count(w, MAT.WATER);
    setCell(w, 600, 100, MAT.SAND);
    step(w, 600);
    expect(count(w, MAT.WATER)).toBe(water);
    expect(count(w, MAT.SAND)).toBe(1);
  });

  it('goes quiet once nothing is moving, so chunks stop being processed', () => {
    const w = emptyWorld();
    setCell(w, 700, 100, MAT.SAND);
    step(w, 800);
    const queued = (w.dirtyTail - w.dirtyHead + w.dirtyQueue.length) % w.dirtyQueue.length;
    expect(queued).toBeLessThan(40);
  });
});
