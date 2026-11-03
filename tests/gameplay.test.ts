import { describe, expect, it } from 'vitest';
import * as Fx from '../src/fx/fx';
import { FOUNDRY_PERIOD, GRID_H, GRID_W, ROUND_TICKS } from '../src/data/config';
import { CHUNK_KIND, MAT } from '../src/data/materials';
import { spawnChunk } from '../src/sim/clonk';
import { placeElevator, placeFoundry } from '../src/sim/build';
import { at, setCell } from '../src/sim/grid';
import { BTN, TOOL, makeInput, type InputFrame } from '../src/sim/input';
import { startRound, tickWorld } from '../src/sim/sim';
import { EK, addStock, teamStock, type World } from '../src/sim/world';

function input(over: Partial<InputFrame> = {}): InputFrame[] {
  return [{ ...makeInput(), sel: TOOL.SHOVEL, ...over }];
}

function run(w: World, ticks: number, frames = input()): void {
  for (let i = 0; i < ticks; i++) tickWorld(w, frames);
}

function countMat(w: World, m: number): number {
  let n = 0;
  for (let i = 0; i < w.mat.length; i++) if (w.mat[i] === m) n++;
  return n;
}

describe('the core loop', () => {
  it('spawns a clonk on dry ground with a flag nearby', () => {
    const { world, spawns } = startRound({ seed: 4242, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    expect(id).toBeGreaterThanOrEqual(0);
    expect(world.ents.kind[id]).toBe(EK.CLONK);
    const flag = world.teamFlag[0];
    expect(flag).toBeGreaterThanOrEqual(0);
    const dx = Fx.floor(world.ents.x[id]) - Fx.floor(world.ents.x[flag]);
    expect(Math.abs(dx)).toBeLessThan(40);
    expect(spawns[0].y).toBeGreaterThan(20);
  });

  it('does not leave the clonk buried or falling through the world', () => {
    const { world } = startRound({ seed: 913, playerCount: 4, teamCount: 2 });
    run(world, 90);
    for (let p = 0; p < 4; p++) {
      const id = world.playerEnt[p];
      const y = Fx.floor(world.ents.y[id]);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(GRID_H);
      // Standing, not sunk into rock.
      expect(at(world, Fx.floor(world.ents.x[id]), y)).not.toBe(MAT.ROCK);
    }
  });

  it('digging removes material and sinks the clonk into its own shaft', () => {
    const { world } = startRound({ seed: 20260909, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    const y0 = Fx.floor(world.ents.y[id]);
    const before = countMat(world, MAT.SKY);
    run(world, 300, input({ dy: 64, buttons: BTN.ACTION }));
    expect(countMat(world, MAT.SKY)).toBeGreaterThan(before + 200);
    // The dug shaft has to be wide enough for the clonk to descend into it.
    expect(Fx.floor(world.ents.y[id])).toBeGreaterThan(y0 + 30);
  });

  it('digging through a vein yields a carryable chunk', () => {
    const { world } = startRound({ seed: 31, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    const cx = Fx.floor(world.ents.x[id]);
    const cy = Fx.floor(world.ents.y[id]);
    for (let y = cy + 8; y < cy + 40; y++) {
      for (let x = cx - 14; x <= cx + 14; x++) setCell(world, x, y, MAT.GOLD);
    }
    run(world, 240, input({ dy: 64, buttons: BTN.ACTION }));
    let items = 0;
    for (let i = 0; i < world.entCount; i++) if (world.ents.kind[i] === EK.ITEM) items++;
    const carried = world.ents.carry[id] >= 0 ? 1 : 0;
    expect(items + carried).toBeGreaterThan(0);
  });

  it('a starter gold vein sits within a few seconds of digging (PRD 5.4)', () => {
    for (const seed of [1, 2, 3, 77, 20260909]) {
      const { world, spawns } = startRound({ seed, playerCount: 1, teamCount: 1 });
      const sp = spawns[0];
      let gold = 0;
      for (let y = sp.y; y < sp.y + 34; y++) {
        for (let x = sp.x - 12; x <= sp.x + 12; x++) {
          if (at(world, x, y) === MAT.GOLD) gold++;
        }
      }
      expect(gold, `seed ${seed}`).toBeGreaterThan(20);
    }
  });

  it('picks up a chunk and banks it at the flag', () => {
    const { world } = startRound({ seed: 5, playerCount: 1, teamCount: 1, goldToWin: 99 });
    const id = world.playerEnt[0];
    spawnChunk(world, Fx.floor(world.ents.x[id]), Fx.floor(world.ents.y[id]), CHUNK_KIND.GOLD);
    expect(world.gold[0]).toBe(0);
    run(world, 5);
    expect(world.gold[0]).toBe(1);
    expect(world.ents.carry[id]).toBe(-1);
  });

  it('ends the round when a team banks the gold target', () => {
    const { world } = startRound({ seed: 6, playerCount: 1, teamCount: 1, goldToWin: 2 });
    const id = world.playerEnt[0];
    const x = Fx.floor(world.ents.x[id]);
    const y = Fx.floor(world.ents.y[id]);
    spawnChunk(world, x, y, CHUNK_KIND.GOLD);
    run(world, 4);
    expect(world.phase).toBe(0);
    spawnChunk(world, x, y, CHUNK_KIND.GOLD);
    run(world, 4);
    expect(world.phase).toBe(1);
    expect(world.winner).toBe(0);
  });

  it('ends on the timer with the gold leader winning', () => {
    const { world } = startRound({ seed: 7, playerCount: 2, teamCount: 2, goldToWin: 999 });
    world.gold[1] = 3;
    world.tick = ROUND_TICKS - 2;
    run(world, 3);
    expect(world.phase).toBe(1);
    expect(world.winner).toBe(1);
  });

  it('a foundry smelts ore plus coal into metal', () => {
    const { world } = startRound({ seed: 8, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    addStock(world, 0, CHUNK_KIND.WOOD, 4);
    addStock(world, 0, CHUNK_KIND.COAL, 2);
    addStock(world, 0, CHUNK_KIND.ORE, 2);
    expect(placeFoundry(world, id)).toBe(true);
    // The build consumed the wood, not the ingredients.
    expect(teamStock(world, 0, CHUNK_KIND.WOOD)).toBe(0);
    expect(teamStock(world, 0, CHUNK_KIND.METAL)).toBe(0);
    run(world, FOUNDRY_PERIOD + 2);
    expect(teamStock(world, 0, CHUNK_KIND.METAL)).toBe(1);
    expect(teamStock(world, 0, CHUNK_KIND.COAL)).toBe(1);
  });

  it('refuses to build without material and says so', () => {
    const { world } = startRound({ seed: 9, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    expect(placeFoundry(world, id)).toBe(false);
    expect(placeElevator(world, id)).toBe(false);
  });

  it('stamps a built foundry into the terrain so physics sees it', () => {
    const { world } = startRound({ seed: 10, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    addStock(world, 0, CHUNK_KIND.WOOD, 4);
    placeFoundry(world, id);
    expect(countMat(world, MAT.STRUCT)).toBeGreaterThan(20);
  });

  it('generates an island inside the 500 ms budget (PRD M7)', () => {
    // Warm up first: the point of the budget is steady-state generation cost,
    // not the cost of JIT-compiling the generator on its first ever call.
    startRound({ seed: 1, playerCount: 1, teamCount: 1 });
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      startRound({ seed: 1234 + i, playerCount: 4, teamCount: 2 });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(500);
  });

  it('produces a playable island: land, ocean and every material', () => {
    const { world } = startRound({ seed: 999, playerCount: 4, teamCount: 4 });
    expect(countMat(world, MAT.WATER)).toBeGreaterThan(1000);
    expect(countMat(world, MAT.EARTH)).toBeGreaterThan(10000);
    expect(countMat(world, MAT.ROCK)).toBeGreaterThan(10000);
    expect(countMat(world, MAT.GOLD)).toBeGreaterThan(100);
    expect(countMat(world, MAT.COAL)).toBeGreaterThan(100);
    expect(countMat(world, MAT.ORE)).toBeGreaterThan(100);
    // Bedrock floor, so nothing falls out of the world.
    for (let x = 0; x < GRID_W; x += 37) {
      expect(world.mat[(GRID_H - 1) * GRID_W + x]).toBe(MAT.GRANITE);
    }
  });
});
