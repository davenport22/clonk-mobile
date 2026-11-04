import { describe, expect, it } from 'vitest';
import * as Fx from '../src/fx/fx';
import {
  CLONK_HP,
  GOLD_TO_WIN_SOLO,
  KILLS_TO_WIN,
  LORRY_CAPACITY,
  MODE,
  ROUND_TICKS,
  SHOVEL_DAMAGE,
} from '../src/data/config';
import { CHUNK_KIND, MAT } from '../src/data/materials';
import { LORRY_COST, placeLorry } from '../src/sim/build';
import { spawnChunk } from '../src/sim/clonk';
import { hurt } from '../src/sim/explode';
import { at, setCell } from '../src/sim/grid';
import { BTN, TOOL, makeInput, type InputFrame } from '../src/sim/input';
import { load, lorryAt } from '../src/sim/lorry';
import { startRound, tickWorld } from '../src/sim/sim';
import { EF, EK, addStock, lorryLoad, type World } from '../src/sim/world';

function input(over: Partial<InputFrame> = {}): InputFrame[] {
  return [{ ...makeInput(), sel: TOOL.SHOVEL, ...over }];
}

function run(w: World, ticks: number, frames = input()): void {
  for (let i = 0; i < ticks; i++) tickWorld(w, frames);
}

function ents(w: World, kind: number): number {
  let n = 0;
  for (let i = 0; i < w.entCount; i++) if (w.ents.kind[i] === kind) n++;
  return n;
}

describe('the lorry', () => {
  it('costs metal and wood, and refuses without them', () => {
    const { world } = startRound({ seed: 61, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    expect(placeLorry(world, id)).toBe(false);
    for (const c of LORRY_COST) addStock(world, 0, c.kind, c.n);
    expect(placeLorry(world, id)).toBe(true);
    expect(ents(world, EK.LORRY)).toBe(1);
  });

  it('swallows loose chunks it is standing over', () => {
    const { world } = startRound({ seed: 62, playerCount: 1, teamCount: 1, goldToWin: 99 });
    const id = world.playerEnt[0];
    for (const c of LORRY_COST) addStock(world, 0, c.kind, c.n);
    placeLorry(world, id);
    let lorry = -1;
    for (let i = 0; i < world.entCount; i++) if (world.ents.kind[i] === EK.LORRY) lorry = i;
    expect(lorry).toBeGreaterThanOrEqual(0);

    // Move the clonk away first: a clonk standing over a chunk picks it up
    // before the lorry ever sees it, which is the correct precedence. Move the
    // lorry out of the flag ring too, or it unloads what it picks up in the
    // same breath.
    world.ents.x[id] = world.ents.x[id] - Fx.of(90);
    world.ents.x[lorry] = world.ents.x[lorry] + Fx.of(140);
    spawnChunk(world, Fx.floor(world.ents.x[lorry]), Fx.floor(world.ents.y[lorry]) - 2, CHUNK_KIND.COAL);
    run(world, 10);
    expect(lorryLoad(world, lorry)).toBeGreaterThan(0);
  });

  it('empties itself into the team stock when parked at the flag', () => {
    const { world } = startRound({ seed: 63, playerCount: 1, teamCount: 1, goldToWin: 99 });
    const id = world.playerEnt[0];
    for (const c of LORRY_COST) addStock(world, 0, c.kind, c.n);
    placeLorry(world, id);
    let lorry = -1;
    for (let i = 0; i < world.entCount; i++) if (world.ents.kind[i] === EK.LORRY) lorry = i;
    load(world, lorry, CHUNK_KIND.GOLD);
    load(world, lorry, CHUNK_KIND.GOLD);
    expect(lorryLoad(world, lorry)).toBe(2);
    // It was built next to the flag, so it is already in the ring.
    run(world, 40);
    expect(lorryLoad(world, lorry)).toBe(0);
    expect(world.gold[0]).toBe(2);
  });

  it('holds a bounded amount', () => {
    const { world } = startRound({ seed: 64, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    for (const c of LORRY_COST) addStock(world, 0, c.kind, c.n);
    placeLorry(world, id);
    let lorry = -1;
    for (let i = 0; i < world.entCount; i++) if (world.ents.kind[i] === EK.LORRY) lorry = i;
    for (let i = 0; i < LORRY_CAPACITY + 6; i++) load(world, lorry, CHUNK_KIND.COAL);
    expect(lorryLoad(world, lorry)).toBe(LORRY_CAPACITY);
  });

  it('is found by a clonk standing next to it', () => {
    const { world } = startRound({ seed: 65, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    for (const c of LORRY_COST) addStock(world, 0, c.kind, c.n);
    placeLorry(world, id);
    const cx = Fx.floor(world.ents.x[id]);
    const cy = Fx.floor(world.ents.y[id]);
    expect(lorryAt(world, cx, cy, 3, 5)).toBeGreaterThanOrEqual(0);
    expect(lorryAt(world, cx + 300, cy, 3, 5)).toBe(-1);
  });
});

describe('loam', () => {
  it('occurs in the world and yields a carryable chunk', () => {
    const { world } = startRound({ seed: 71, playerCount: 1, teamCount: 1 });
    let loam = 0;
    for (let i = 0; i < world.mat.length; i++) if (world.mat[i] === MAT.LOAM) loam++;
    expect(loam).toBeGreaterThan(500);
  });

  it('bridges a gap in front of the clonk', () => {
    const { world } = startRound({ seed: 72, playerCount: 1, teamCount: 1 });
    const id = world.playerEnt[0];
    const cx = Fx.floor(world.ents.x[id]);
    const cy = Fx.floor(world.ents.y[id]);
    // Open a chasm to the right.
    for (let y = cy - 20; y < cy + 60; y++) {
      for (let x = cx + 6; x < cx + 40; x++) setCell(world, x, y, MAT.SKY);
    }
    addStock(world, 0, CHUNK_KIND.LOAM, 1);
    world.ents.facing[id] = 1;
    run(world, 2, input({ sel: TOOL.LOAM, buttons: BTN.ACTION }));

    let bridge = 0;
    for (let y = cy; y < cy + 20; y++) {
      for (let x = cx + 6; x < cx + 40; x++) if (at(world, x, y) === MAT.LOAM) bridge++;
    }
    expect(bridge).toBeGreaterThan(40);
    expect(world.stock[CHUNK_KIND.LOAM]).toBe(0);
  });

  it('refuses when there is no loam to spend', () => {
    const { world } = startRound({ seed: 73, playerCount: 1, teamCount: 1 });
    expect(world.stock[CHUNK_KIND.LOAM]).toBe(0);
    const before = world.mat.reduce((a, v) => a + (v === MAT.LOAM ? 1 : 0), 0);
    run(world, 2, input({ sel: TOOL.LOAM, buttons: BTN.ACTION }));
    const after = world.mat.reduce((a, v) => a + (v === MAT.LOAM ? 1 : 0), 0);
    expect(after).toBe(before);
  });
});

describe('fighting', () => {
  it('a shovel swing hurts an enemy in reach but not a team mate', () => {
    const { world } = startRound({ seed: 81, playerCount: 2, teamCount: 2 });
    const me = world.playerEnt[0];
    const foe = world.playerEnt[1];
    const e = world.ents;
    // Stand them next to each other.
    e.x[foe] = e.x[me] + Fx.of(5);
    e.y[foe] = e.y[me];
    e.facing[me] = 1;
    const before = e.hp[foe];
    tickWorld(world, [
      { ...makeInput(), sel: TOOL.SHOVEL, buttons: BTN.ACTION, ax: 64 },
      makeInput(),
    ]);
    expect(e.hp[foe]).toBe(before - SHOVEL_DAMAGE);

    // Same geometry, same team: nothing happens.
    const { world: w2 } = startRound({ seed: 81, playerCount: 2, teamCount: 1 });
    const a = w2.playerEnt[0];
    const b = w2.playerEnt[1];
    w2.ents.x[b] = w2.ents.x[a] + Fx.of(5);
    w2.ents.y[b] = w2.ents.y[a];
    const hp = w2.ents.hp[b];
    tickWorld(w2, [{ ...makeInput(), sel: TOOL.SHOVEL, buttons: BTN.ACTION, ax: 64 }, makeInput()]);
    expect(w2.ents.hp[b]).toBe(hp);
  });

  it('a thrown chunk hurts whoever it hits, but never its thrower', () => {
    const { world } = startRound({ seed: 81, playerCount: 2, teamCount: 2 });
    const me = world.playerEnt[0];
    const foe = world.playerEnt[1];
    const e = world.ents;
    e.x[foe] = e.x[me] + Fx.of(10);
    e.y[foe] = e.y[me];
    const rock = spawnChunk(world, Fx.floor(e.x[me]), Fx.floor(e.y[me]), CHUNK_KIND.ORE);
    e.flags[rock] |= EF.CARRIED;
    e.carry[me] = rock;
    const mine = e.hp[me];
    const theirs = e.hp[foe];
    tickWorld(world, [{ ...makeInput(), buttons: BTN.THROW, dx: 64 }, makeInput()]);
    // The throw marks the chunk as a projectile and remembers who threw it.
    expect(e.flags[rock] & EF.THROWN).not.toBe(0);
    expect(e.aux2[rock]).toBe(me + 1);

    // In flight and arriving at the foe: it lands.
    e.x[rock] = e.x[foe] - Fx.of(3);
    e.y[rock] = e.y[foe];
    e.vx[rock] = Fx.of(3);
    tickWorld(world, [makeInput(), makeInput()]);
    expect(e.hp[foe]).toBeLessThan(theirs);

    // The same throw arriving back at the thrower does nothing.
    e.flags[rock] |= EF.THROWN;
    e.x[rock] = e.x[me] - Fx.of(3);
    e.y[rock] = e.y[me];
    e.vx[rock] = Fx.of(3);
    tickWorld(world, [makeInput(), makeInput()]);
    expect(e.hp[me]).toBe(mine);
  });

  it('a dug chunk falling down a shaft does not hurt the digger', () => {
    // Digging straight down through a seam drops the chunks it digs out back
    // onto the digger at speed. That is spoil, not a weapon.
    const { world } = startRound({ seed: 81, playerCount: 1, teamCount: 1 });
    const me = world.playerEnt[0];
    const e = world.ents;
    const hp = e.hp[me];
    const rock = spawnChunk(world, Fx.floor(e.x[me]), Fx.floor(e.y[me]) - 4, CHUNK_KIND.COAL);
    e.vy[rock] = Fx.of(4);
    run(world, 6, [makeInput()]);
    expect(e.hp[me]).toBe(hp);
  });

  it('credits a kill to the team that caused it, not to the world', () => {
    const { world } = startRound({ seed: 82, playerCount: 2, teamCount: 2, mode: MODE.MELEE });
    const foe = world.playerEnt[1];
    expect(world.kills[0]).toBe(0);
    hurt(world, foe, CLONK_HP, 0);
    expect(world.kills[0]).toBe(1);

    // Drowning credits nobody.
    const { world: w2 } = startRound({ seed: 82, playerCount: 2, teamCount: 2, mode: MODE.MELEE });
    hurt(w2, w2.playerEnt[1], CLONK_HP, 255);
    expect(w2.kills[0]).toBe(0);
    expect(w2.kills[1]).toBe(0);
  });

  it('melee ends on the kill target, gold rush ignores kills', () => {
    const { world } = startRound({
      seed: 83,
      playerCount: 2,
      teamCount: 2,
      mode: MODE.MELEE,
      killsToWin: 2,
    });
    world.kills[1] = 2;
    run(world, 2, [makeInput(), makeInput()]);
    expect(world.phase).toBe(1);
    expect(world.winner).toBe(1);

    const { world: gold } = startRound({ seed: 83, playerCount: 2, teamCount: 2 });
    gold.kills[1] = KILLS_TO_WIN + 5;
    run(gold, 4, [makeInput(), makeInput()]);
    expect(gold.phase).toBe(0);
  });

  it('melee still ends on the clock, with the leader winning', () => {
    const { world } = startRound({
      seed: 84,
      playerCount: 2,
      teamCount: 2,
      mode: MODE.MELEE,
      killsToWin: 99,
    });
    world.kills[0] = 3;
    world.kills[1] = 1;
    world.tick = ROUND_TICKS - 2;
    run(world, 3, [makeInput(), makeInput()]);
    expect(world.phase).toBe(1);
    expect(world.winner).toBe(0);
  });
});

describe('bots', () => {
  it('play without any input being supplied for them', () => {
    const { world } = startRound({
      seed: 91,
      playerCount: 4,
      teamCount: 2,
      bots: [true, true, true, true],
    });
    const startX: number[] = [];
    const startY: number[] = [];
    for (let p = 0; p < 4; p++) {
      startX.push(Fx.floor(world.ents.x[world.playerEnt[p]]));
      startY.push(Fx.floor(world.ents.y[world.playerEnt[p]]));
    }

    // No inputs at all: everything these clonks do comes from the simulation.
    for (let i = 0; i < 400; i++) tickWorld(world, []);

    // Movement in any direction counts. A bot that found gold directly below
    // it and is digging straight down has not stood still.
    let moved = 0;
    for (let p = 0; p < 4; p++) {
      const id = world.playerEnt[p];
      if (id < 0) {
        moved++;
        continue;
      }
      const dx = Math.abs(Fx.floor(world.ents.x[id]) - startX[p]);
      const dy = Math.abs(Fx.floor(world.ents.y[id]) - startY[p]);
      if (dx + dy > 8) moved++;
    }
    expect(moved).toBeGreaterThan(2);
  });

  it('dig: the world has visibly changed after a minute of bots', () => {
    // What this guards is bots that stand still, not a dig rate: how much a
    // bot digs in a minute depends on what is under its spawn, and across
    // seeds that ranges from about eleven hundred cells to four thousand. One
    // seed against one threshold was a coin toss; several seeds against a
    // floor well above zero is the actual claim.
    for (const seed of [92, 13, 61]) {
      const { world } = startRound({
        seed,
        playerCount: 4,
        teamCount: 2,
        bots: [true, true, true, true],
      });
      const before = world.mat.reduce((a, v) => a + (v === MAT.SKY ? 1 : 0), 0);
      for (let i = 0; i < 1800; i++) tickWorld(world, []);
      const after = world.mat.reduce((a, v) => a + (v === MAT.SKY ? 1 : 0), 0);
      expect(after - before, `seed ${seed}`).toBeGreaterThan(800);
    }
  });

  it('do not win a solo round in its opening minute', () => {
    // Anything dug inside the flag ring banks on the spot, so the size of the
    // starter vein under each flag is very nearly a number of free gold. When
    // it grew past the target, a team of bots won every solo round in under
    // two seconds.
    for (const seed of [11, 33]) {
      const { world } = startRound({
        seed,
        playerCount: 4,
        teamCount: 2,
        bots: [false, true, true, true],
        goldToWin: GOLD_TO_WIN_SOLO,
      });
      run(world, 1800, [makeInput(), makeInput(), makeInput(), makeInput()]);
      expect(world.phase, `seed ${seed}`).toBe(0);
    }
  });

  it('are deterministic: same seed, same bots, same world', () => {
    const run2 = (seed: number) => {
      const { world } = startRound({
        seed,
        playerCount: 4,
        teamCount: 2,
        bots: [true, true, true, true],
      });
      for (let i = 0; i < 600; i++) tickWorld(world, []);
      return world;
    };
    const a = run2(93);
    const b = run2(93);
    for (let p = 0; p < 4; p++) {
      expect(a.playerEnt[p]).toBe(b.playerEnt[p]);
      if (a.playerEnt[p] < 0) continue;
      expect(a.ents.x[a.playerEnt[p]]).toBe(b.ents.x[b.playerEnt[p]]);
      expect(a.ents.y[a.playerEnt[p]]).toBe(b.ents.y[b.playerEnt[p]]);
    }
  });
});
