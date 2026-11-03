import { describe, expect, it } from 'vitest';
import * as Fx from '../src/fx/fx';
import {
  BLAST_RADIUS,
  CLONK_HP,
  FUSE_TICKS,
  GRID_W,
  MAX_BREATH,
  RESPAWN_TICKS,
} from '../src/data/config';
import { CHUNK_KIND, MAT } from '../src/data/materials';
import { DYNAMITE_COST, FOUNDRY_COST, canAfford, placeFoundry } from '../src/sim/build';
import { explode, hurt } from '../src/sim/explode';
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

function count(w: World, m: number): number {
  let n = 0;
  for (let i = 0; i < w.mat.length; i++) if (w.mat[i] === m) n++;
  return n;
}

function ents(w: World, kind: number): number {
  let n = 0;
  for (let i = 0; i < w.entCount; i++) if (w.ents.kind[i] === kind) n++;
  return n;
}

describe('forest and wood', () => {
  it('grows trees with trunks and canopies on the island', () => {
    const { world } = startRound({ seed: 4242, playerCount: 1, teamCount: 1 });
    expect(count(world, MAT.WOOD)).toBeGreaterThan(600);
    expect(count(world, MAT.LEAVES)).toBeGreaterThan(2000);
  });

  it('puts a tree within sight of every spawn, because the first build needs wood', () => {
    for (const seed of [1, 2, 77, 20260909]) {
      const { world, spawns } = startRound({ seed, playerCount: 2, teamCount: 2 });
      for (const sp of spawns) {
        let wood = 0;
        for (let y = sp.y - 60; y < sp.y; y++) {
          for (let x = sp.x - 44; x <= sp.x + 44; x++) {
            if (y < 0) continue;
            if (at(world, x, y) === MAT.WOOD) wood++;
          }
        }
        expect(wood, `seed ${seed} spawn ${sp.x}`).toBeGreaterThan(20);
      }
    }
  });

  it('canopies are walk-through, trunks are not', () => {
    const { world } = startRound({ seed: 9, playerCount: 1, teamCount: 1 });
    // Leaves must never block movement, or a forest becomes a wall.
    expect(count(world, MAT.LEAVES)).toBeGreaterThan(0);
    const id = world.playerEnt[0];
    const y = Fx.floor(world.ents.y[id]);
    setCell(world, Fx.floor(world.ents.x[id]) + 6, y, MAT.LEAVES);
    const before = Fx.floor(world.ents.x[id]);
    run(world, 20, input({ dx: 64 }));
    expect(Fx.floor(world.ents.x[id])).toBeGreaterThan(before);
  });

  it('chopping a trunk yields wood chunks', () => {
    const { world } = startRound({ seed: 12, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    const cx = Fx.floor(world.ents.x[id]);
    const cy = Fx.floor(world.ents.y[id]);
    for (let y = cy - 6; y < cy + 8; y++) {
      for (let x = cx + 6; x <= cx + 26; x++) setCell(world, x, y, MAT.WOOD);
    }
    run(world, 200, input({ dx: 64, buttons: BTN.ACTION }));
    // Chopping next to your own flag banks the wood immediately, so count the
    // stock as well as anything still lying about or in hand.
    let wood = teamStock(world, 0, CHUNK_KIND.WOOD);
    for (let i = 0; i < world.entCount; i++) {
      if (world.ents.kind[i] === EK.ITEM && world.ents.item[i] === CHUNK_KIND.WOOD) wood++;
    }
    const carried = world.ents.carry[id];
    if (carried >= 0 && world.ents.item[carried] === CHUNK_KIND.WOOD) wood++;
    expect(wood).toBeGreaterThan(0);
  });

  it('a foundry costs wood, so the forest is on the critical path', () => {
    const { world } = startRound({ seed: 13, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    expect(FOUNDRY_COST[0].kind).toBe(CHUNK_KIND.WOOD);
    expect(placeFoundry(world, id)).toBe(false);
    addStock(world, 0, CHUNK_KIND.WOOD, 4);
    expect(placeFoundry(world, id)).toBe(true);
  });
});

describe('dynamite', () => {
  it('needs no building, so sabotage is available from the first minute', () => {
    const { world } = startRound({ seed: 21, playerCount: 1, teamCount: 1 });
    expect(canAfford(world, 0, DYNAMITE_COST)).toBe(false);
    addStock(world, 0, CHUNK_KIND.COAL, 1);
    addStock(world, 0, CHUNK_KIND.WOOD, 1);
    expect(canAfford(world, 0, DYNAMITE_COST)).toBe(true);
  });

  it('lights a fuse, then reshapes the terrain', () => {
    const { world } = startRound({ seed: 22, playerCount: 1, teamCount: 1 });
    addStock(world, 0, CHUNK_KIND.COAL, 1);
    addStock(world, 0, CHUNK_KIND.WOOD, 1);
    // Away from the flag: the ground under a flag is deliberately blast-proof.
    const me = world.playerEnt[0];
    world.ents.x[me] = Fx.of(Fx.floor(world.ents.x[world.teamFlag[0]]) + 180);
    run(world, 2, input({ sel: TOOL.DYNAMITE, buttons: BTN.ACTION }));
    expect(ents(world, EK.DYNAMITE)).toBe(1);
    // Paid for.
    expect(world.stock[CHUNK_KIND.COAL]).toBe(0);

    const skyBefore = count(world, MAT.SKY);
    run(world, FUSE_TICKS + 10, input({ sel: TOOL.DYNAMITE }));
    expect(ents(world, EK.DYNAMITE)).toBe(0);
    expect(count(world, MAT.SKY)).toBeGreaterThan(skyBefore + 300);
  });

  it('never breaches bedrock, so the world keeps its floor', () => {
    const { world } = startRound({ seed: 23, playerCount: 1, teamCount: 1 });
    const granite = count(world, MAT.GRANITE);
    explode(world, 500, world.mat.length / GRID_W - 3, 0);
    expect(count(world, MAT.GRANITE)).toBe(granite);
  });

  it('hurts and throws a clonk standing in the blast', () => {
    const { world } = startRound({ seed: 24, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    const x = Fx.floor(world.ents.x[id]);
    const y = Fx.floor(world.ents.y[id]);
    expect(world.ents.hp[id]).toBe(CLONK_HP);
    explode(world, x + 6, y, 1);
    expect(world.ents.hp[id]).toBeLessThan(CLONK_HP);
    expect(world.ents.vx[id]).not.toBe(0);
  });

  it('destroys a foundry caught in the blast', () => {
    const { world } = startRound({ seed: 25, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    addStock(world, 0, CHUNK_KIND.WOOD, 4);
    placeFoundry(world, id);
    expect(ents(world, EK.FOUNDRY)).toBe(1);
    const structBefore = count(world, MAT.STRUCT);
    expect(structBefore).toBeGreaterThan(0);
    explode(world, Fx.floor(world.ents.x[id]), Fx.floor(world.ents.y[id]), 1);
    expect(ents(world, EK.FOUNDRY)).toBe(0);
    expect(count(world, MAT.STRUCT)).toBe(0);
  });

  it('chains: a charge in the blast gets a short fuse instead of surviving', () => {
    const { world } = startRound({ seed: 26, playerCount: 1, teamCount: 1 });
    addStock(world, 0, CHUNK_KIND.COAL, 1);
    addStock(world, 0, CHUNK_KIND.WOOD, 1);
    run(world, 2, input({ sel: TOOL.DYNAMITE, buttons: BTN.ACTION }));
    let dyn = -1;
    for (let i = 0; i < world.entCount; i++) if (world.ents.kind[i] === EK.DYNAMITE) dyn = i;
    expect(dyn).toBeGreaterThanOrEqual(0);
    expect(world.ents.aux[dyn]).toBeGreaterThan(50);
    explode(world, Fx.floor(world.ents.x[dyn]), Fx.floor(world.ents.y[dyn]), 0);
    expect(world.ents.aux[dyn]).toBeLessThanOrEqual(8);
  });

  it('blast radius stays inside its stated size', () => {
    const { world } = startRound({ seed: 27, playerCount: 1, teamCount: 1 });
    const cx = 500;
    const cy = 400;
    for (let y = cy - 40; y <= cy + 40; y++) {
      for (let x = cx - 40; x <= cx + 40; x++) setCell(world, x, y, MAT.ROCK);
    }
    explode(world, cx, cy, 0);
    // Well outside the radius must be untouched.
    expect(at(world, cx + BLAST_RADIUS + 6, cy)).toBe(MAT.ROCK);
    expect(at(world, cx, cy)).toBe(MAT.SKY);
  });
});

describe('aiming (desktop)', () => {
  it('digs where the aim points, not where the stick pushes', () => {
    const { world } = startRound({ seed: 41, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    const cx = Fx.floor(world.ents.x[id]);
    const cy = Fx.floor(world.ents.y[id]);
    // Solid ground both left and right of the clonk.
    for (let y = cy - 8; y < cy + 8; y++) {
      for (let x = cx - 30; x <= cx + 30; x++) {
        if (x > cx - 6 && x < cx + 6) continue;
        setCell(world, x, y, MAT.ROCK);
      }
    }
    // Walk right, aim left: the hole must appear on the left.
    run(world, 90, input({ dx: 64, ax: -64, buttons: BTN.ACTION }));
    let leftHoles = 0;
    let rightHoles = 0;
    for (let y = cy - 8; y < cy + 8; y++) {
      for (let x = cx - 30; x <= cx - 8; x++) if (at(world, x, y) === MAT.SKY) leftHoles++;
      for (let x = cx + 8; x <= cx + 30; x++) if (at(world, x, y) === MAT.SKY) rightHoles++;
    }
    expect(leftHoles).toBeGreaterThan(20);
    expect(leftHoles).toBeGreaterThan(rightHoles);
  });

  it('turns the clonk to face the aim', () => {
    const { world } = startRound({ seed: 42, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    run(world, 4, input({ dx: 64, ax: -64 }));
    expect(world.ents.facing[id]).toBe(-1);
    run(world, 4, input({ dx: -64, ax: 64 }));
    expect(world.ents.facing[id]).toBe(1);
  });

  it('falls back to the stick when nobody is aiming', () => {
    const { world } = startRound({ seed: 43, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    run(world, 4, input({ dx: -64 }));
    expect(world.ents.facing[id]).toBe(-1);
  });

  it('throws on the explicit throw button even with something to dig', () => {
    const { world } = startRound({ seed: 44, playerCount: 1, teamCount: 1, goldToWin: 99 });
    const id = world.playerEnt[0];
    const e = world.ents;
    // Carry a chunk, standing away from the flag so it is not banked.
    e.x[id] = Fx.of(Fx.floor(e.x[world.teamFlag[0]]) + 200);
    let item = -1;
    for (let i = 0; i < e.kind.length; i++) if (e.kind[i] === EK.NONE) { item = i; break; }
    e.kind[item] = EK.ITEM;
    e.item[item] = CHUNK_KIND.COAL;
    e.flags[item] = 4;
    e.carry[id] = item;
    if (item >= world.entCount) world.entCount = item + 1;

    run(world, 2, input({ buttons: BTN.THROW }));
    expect(e.carry[id]).toBe(-1);
    expect(e.flags[item] & 4).toBe(0);
  });
});

describe('life and death', () => {
  it('drowns a clonk held under water, then gives the player a new one', () => {
    const { world } = startRound({ seed: 31, playerCount: 1, teamCount: 1, goldToWin: 99 });
    const id = world.playerEnt[0];
    const cx = Fx.floor(world.ents.x[id]);
    const cy = Fx.floor(world.ents.y[id]);
    // Flood the spawn.
    for (let y = cy - 30; y < cy + 6; y++) {
      for (let x = cx - 20; x <= cx + 20; x++) {
        if (at(world, x, y) === MAT.SKY) setCell(world, x, y, MAT.WATER);
      }
    }
    expect(world.ents.breath[id]).toBe(MAX_BREATH);
    run(world, MAX_BREATH + 40);
    expect(world.ents.breath[world.playerEnt[0]] ?? 0).toBeLessThan(MAX_BREATH);

    // Force the ending rather than waiting out the full drown.
    hurt(world, world.playerEnt[0], CLONK_HP, 255);
    expect(world.playerEnt[0]).toBe(-1);
    expect(world.respawn[0]).toBe(RESPAWN_TICKS);
    run(world, RESPAWN_TICKS + 3);
    expect(world.playerEnt[0]).toBeGreaterThanOrEqual(0);
    expect(world.ents.hp[world.playerEnt[0]]).toBe(CLONK_HP);
  });

  it('drops what it was carrying when it dies', () => {
    const { world } = startRound({ seed: 32, playerCount: 1, teamCount: 1, goldToWin: 99 });
    const id = world.playerEnt[0];
    // Give it something to carry that is not inside the flag radius.
    const e = world.ents;
    const item = (() => {
      for (let i = 0; i < e.kind.length; i++) if (e.kind[i] === EK.NONE) return i;
      return -1;
    })();
    e.kind[item] = EK.ITEM;
    e.item[item] = CHUNK_KIND.GOLD;
    e.flags[item] = 4;
    e.carry[id] = item;
    if (item >= world.entCount) world.entCount = item + 1;

    hurt(world, id, CLONK_HP, 1);
    expect(e.kind[item]).toBe(EK.ITEM);
    expect(e.flags[item] & 4).toBe(0);
  });

  it('hurts a clonk that lands from a great height', () => {
    const { world } = startRound({ seed: 33, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    const e = world.ents;
    // Drop it down a deep shaft.
    const cx = Fx.floor(e.x[id]);
    const cy = Fx.floor(e.y[id]);
    for (let y = cy; y < cy + 160; y++) {
      for (let x = cx - 8; x <= cx + 8; x++) setCell(world, x, y, MAT.SKY);
    }
    for (let x = cx - 8; x <= cx + 8; x++) setCell(world, x, cy + 160, MAT.GRANITE);
    run(world, 200);
    expect(e.hp[world.playerEnt[0]] ?? 0).toBeLessThan(CLONK_HP);
  });

  it('does not hurt a clonk for ordinary jumping', () => {
    const { world } = startRound({ seed: 34, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    for (let i = 0; i < 6; i++) {
      run(world, 4, input({ dy: -64 }));
      run(world, 26);
    }
    expect(world.ents.hp[id]).toBe(CLONK_HP);
  });
});
