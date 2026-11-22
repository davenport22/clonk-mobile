import { describe, expect, it } from 'vitest';
import { GRID_H, GRID_W } from '../src/data/config';
import { MAT } from '../src/data/materials';
import { at, markAllChunks, setCell, updateMaterial } from '../src/sim/grid';
import { stateHash } from '../src/sim/hash';
import { createWorld, type World } from '../src/sim/world';

function emptyWorld(seed = 1): World {
  const w = createWorld(seed, 0, 1);
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

function count(w: World, m: number, x0 = 0, x1 = GRID_W): number {
  let n = 0;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = x0; x < x1; x++) if (w.mat[y * GRID_W + x] === m) n++;
  }
  return n;
}

/** A granite basin from x0 to x1, its floor at the bottom of the world. */
function basin(w: World, x0: number, x1: number, height: number): void {
  for (let y = GRID_H - height; y < GRID_H - 1; y++) {
    setCell(w, x0, y, MAT.GRANITE);
    setCell(w, x1, y, MAT.GRANITE);
  }
}

function fill(w: World, x0: number, x1: number, y0: number, y1: number, m: number): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setCell(w, x, y, m);
}

describe('materials and physics', () => {
  it('oil floats to the top of water', () => {
    const w = emptyWorld();
    basin(w, 100, 121, 40);
    // Oil poured in first, water on top of it.
    fill(w, 101, 121, GRID_H - 10, GRID_H - 1, MAT.OIL);
    fill(w, 101, 121, GRID_H - 30, GRID_H - 10, MAT.WATER);
    step(w, 1500);
    // The bottom row is water, and oil sits above every water cell.
    for (let x = 101; x < 121; x++) expect(at(w, x, GRID_H - 2)).toBe(MAT.WATER);
    let oilTop = GRID_H;
    let waterTop = GRID_H;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 101; x < 121; x++) {
        const m = at(w, x, y);
        if (m === MAT.OIL && y < oilTop) oilTop = y;
        if (m === MAT.WATER && y < waterTop) waterTop = y;
      }
    }
    expect(oilTop).toBeLessThan(waterTop);
  });

  it('lava that meets water sets into rock and boils the water off', () => {
    const w = emptyWorld();
    basin(w, 200, 241, 40);
    fill(w, 201, 241, GRID_H - 8, GRID_H - 1, MAT.WATER);
    fill(w, 215, 226, GRID_H - 30, GRID_H - 24, MAT.LAVA);
    const water = count(w, MAT.WATER);
    step(w, 900);
    expect(count(w, MAT.ROCK, 200, 242)).toBeGreaterThan(0);
    expect(count(w, MAT.WATER, 200, 242)).toBeLessThan(water);
  });

  it('lava flows, but more slowly than water', () => {
    const run = (m: number): number => {
      const w = emptyWorld();
      fill(w, 500, 506, GRID_H - 12, GRID_H - 2, m);
      step(w, 60);
      let span = 0;
      for (let x = 0; x < GRID_W; x++) if (at(w, x, GRID_H - 2) === m) span++;
      return span;
    };
    expect(run(MAT.LAVA)).toBeLessThan(run(MAT.WATER));
  });

  it('fire spreads through wood and burns it away', () => {
    const w = emptyWorld();
    fill(w, 300, 330, GRID_H - 20, GRID_H - 1, MAT.WOOD);
    const wood = count(w, MAT.WOOD);
    setCell(w, 300, GRID_H - 21, MAT.FIRE);
    step(w, 2000);
    expect(count(w, MAT.WOOD)).toBeLessThan(wood >> 1);
  });

  it('fire burns out when there is nothing left to burn', () => {
    const w = emptyWorld();
    setCell(w, 400, 200, MAT.FIRE);
    step(w, 300);
    expect(count(w, MAT.FIRE)).toBe(0);
  });

  it('water puts fire out', () => {
    const w = emptyWorld();
    fill(w, 600, 640, GRID_H - 10, GRID_H - 1, MAT.WOOD);
    fill(w, 600, 640, GRID_H - 11, GRID_H - 10, MAT.FIRE);
    fill(w, 600, 640, GRID_H - 40, GRID_H - 30, MAT.WATER);
    step(w, 400);
    expect(count(w, MAT.FIRE)).toBe(0);
    expect(count(w, MAT.WOOD)).toBeGreaterThan(0);
  });

  it('acid eats through earth and is used up doing it', () => {
    const w = emptyWorld();
    fill(w, 700, 760, GRID_H - 40, GRID_H - 1, MAT.EARTH);
    fill(w, 720, 740, GRID_H - 46, GRID_H - 40, MAT.ACID);
    const acid = count(w, MAT.ACID);
    const earth = count(w, MAT.EARTH) + count(w, MAT.EARTH_LOOSE);
    step(w, 1500);
    expect(count(w, MAT.EARTH) + count(w, MAT.EARTH_LOOSE)).toBeLessThan(earth);
    expect(count(w, MAT.ACID)).toBeLessThan(acid);
  });

  it('acid does not eat granite', () => {
    const w = emptyWorld();
    fill(w, 800, 840, GRID_H - 10, GRID_H - 1, MAT.GRANITE);
    fill(w, 810, 830, GRID_H - 14, GRID_H - 10, MAT.ACID);
    const granite = count(w, MAT.GRANITE);
    step(w, 600);
    expect(count(w, MAT.GRANITE)).toBe(granite);
  });

  it('ice and snow melt beside lava', () => {
    const w = emptyWorld();
    fill(w, 900, 910, GRID_H - 10, GRID_H - 1, MAT.ICE);
    fill(w, 910, 920, GRID_H - 10, GRID_H - 1, MAT.SNOW);
    fill(w, 920, 930, GRID_H - 10, GRID_H - 1, MAT.GRANITE);
    fill(w, 909, 912, GRID_H - 14, GRID_H - 10, MAT.LAVA);
    const cold = count(w, MAT.ICE) + count(w, MAT.SNOW);
    step(w, 600);
    expect(count(w, MAT.ICE) + count(w, MAT.SNOW)).toBeLessThan(cold);
  });

  it('is deterministic: the same fire and flood twice gives the same world', () => {
    const run = (): number => {
      const w = emptyWorld(7);
      fill(w, 100, 300, GRID_H - 30, GRID_H - 1, MAT.WOOD);
      fill(w, 300, 360, GRID_H - 30, GRID_H - 1, MAT.OIL);
      fill(w, 380, 400, GRID_H - 60, GRID_H - 40, MAT.LAVA);
      fill(w, 420, 470, GRID_H - 60, GRID_H - 40, MAT.ACID);
      setCell(w, 150, GRID_H - 31, MAT.FIRE);
      step(w, 800);
      return stateHash(w);
    };
    expect(run()).toBe(run());
  });
});
