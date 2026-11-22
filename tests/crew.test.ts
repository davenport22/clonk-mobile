import { describe, expect, it } from 'vitest';
import * as Fx from '../src/fx/fx';
import { CREW_MAX, CREW_START, HIRE_COST } from '../src/data/config';
import { CHUNK_KIND, MAT } from '../src/data/materials';
import { spawnChunk } from '../src/sim/clonk';
import { CMD, ORDER, crewOf } from '../src/sim/crew';
import { hurt } from '../src/sim/explode';
import { at, setCell } from '../src/sim/grid';
import { stateHash } from '../src/sim/hash';
import { makeInput, type InputFrame } from '../src/sim/input';
import { startRound, tickWorld } from '../src/sim/sim';
import { deserialize, serialize } from '../src/sim/snapshot';
import { teamStock, type World } from '../src/sim/world';

function cmd(c: number, seq: number, cx = 0, cy = 0): InputFrame {
  return { ...makeInput(), cmd: c, seq, cx, cy };
}

function run(w: World, ticks: number, frame: InputFrame = makeInput()): void {
  for (let i = 0; i < ticks; i++) tickWorld(w, [frame]);
}

function solo(seed = 5): World {
  return startRound({ seed, playerCount: 1, teamCount: 1, goldToWin: 99 }).world;
}

describe('crew', () => {
  it('starts every player with a crew', () => {
    const w = solo();
    expect(crewOf(w, 0, [])).toBe(CREW_START);
  });

  it('switches the steered worker once per command, however often the frame repeats', () => {
    const w = solo();
    const crew: number[] = [];
    crewOf(w, 0, crew);
    const first = w.playerEnt[0];
    const f = cmd(CMD.NEXT, 1);
    // The relay repeats a late player's last frame; the command must not
    // re-fire on each repeat.
    run(w, 5, f);
    expect(w.playerEnt[0]).not.toBe(first);
    expect(crew).toContain(w.playerEnt[0]);
    const second = w.playerEnt[0];
    run(w, 3, cmd(CMD.NEXT, 2));
    expect(w.playerEnt[0]).not.toBe(second);
  });

  it('sends a worker to dig through to a spot', () => {
    const w = solo(7);
    const crew: number[] = [];
    crewOf(w, 0, crew);
    const worker = crew.find((id) => id !== w.playerEnt[0])!;
    const e = w.ents;
    const tx = Fx.floor(e.x[worker]) + 4;
    const ty = Fx.floor(e.y[worker]) + 26;
    // Make sure there is earth to dig at the target.
    for (let y = ty - 3; y <= ty + 3; y++) for (let x = tx - 3; x <= tx + 3; x++) setCell(w, x, y, MAT.EARTH);
    run(w, 1, cmd(CMD.ORDER, 1, tx, ty));
    expect(e.order[worker]).toBe(ORDER.DIG);
    run(w, 400, cmd(CMD.ORDER, 1, tx, ty));
    expect(at(w, tx, ty)).not.toBe(MAT.EARTH);
  });

  it('sends a worker to walk to open ground', () => {
    const w = solo(7);
    const crew: number[] = [];
    crewOf(w, 0, crew);
    const worker = crew.find((id) => id !== w.playerEnt[0])!;
    const e = w.ents;
    const tx = Fx.floor(e.x[worker]);
    const ty = Fx.floor(e.y[worker]) - 30;
    run(w, 1, cmd(CMD.ORDER, 1, tx, ty));
    expect(e.order[worker]).toBe(ORDER.MOVE);
  });

  it('hauls a chunk home and banks it', () => {
    const w = solo(9);
    const crew: number[] = [];
    crewOf(w, 0, crew);
    const worker = crew.find((id) => id !== w.playerEnt[0])!;
    const e = w.ents;
    const x = Fx.floor(e.x[worker]) + 30;
    const y = Fx.floor(e.y[worker]);
    // A flat, open run beside the base for the chunk to lie on.
    for (let xx = x - 40; xx <= x + 10; xx++) {
      for (let yy = y - 12; yy <= y + 4; yy++) setCell(w, xx, yy, MAT.SKY);
      for (let yy = y + 5; yy <= y + 8; yy++) setCell(w, xx, yy, MAT.EARTH);
    }
    const chunk = spawnChunk(w, x, y, CHUNK_KIND.COAL);
    expect(chunk).toBeGreaterThanOrEqual(0);
    run(w, 30);
    const before = teamStock(w, 0, CHUNK_KIND.COAL);
    run(w, 1, cmd(CMD.ORDER, 1, Fx.floor(e.x[chunk]), Fx.floor(e.y[chunk])));
    expect(e.order[worker]).toBe(ORDER.HAUL);
    run(w, 600, cmd(CMD.ORDER, 1, x, y));
    expect(teamStock(w, 0, CHUNK_KIND.COAL)).toBeGreaterThan(before);
  });

  it('hires a worker for gold, and refuses without it', () => {
    const w = solo();
    run(w, 1, cmd(CMD.HIRE, 1));
    expect(crewOf(w, 0, [])).toBe(CREW_START);
    w.gold[0] = HIRE_COST * 2;
    run(w, 1, cmd(CMD.HIRE, 2));
    expect(crewOf(w, 0, [])).toBe(CREW_START + 1);
    expect(w.gold[0]).toBe(HIRE_COST);
  });

  it('never hires past the crew limit', () => {
    const w = solo();
    w.gold[0] = 99;
    for (let s = 1; s <= CREW_MAX + 3; s++) run(w, 1, cmd(CMD.HIRE, s));
    expect(crewOf(w, 0, [])).toBe(CREW_MAX);
  });

  it('hands control to a survivor when the steered worker dies', () => {
    const w = solo();
    const first = w.playerEnt[0];
    hurt(w, first, 1000, 255);
    expect(w.playerEnt[0]).toBeGreaterThanOrEqual(0);
    expect(w.playerEnt[0]).not.toBe(first);
    expect(w.respawn[0]).toBe(0);
  });

  it('stays deterministic through commands and a snapshot', () => {
    const play = (w: World): number => {
      run(w, 20, cmd(CMD.FOLLOW, 1));
      run(w, 40, cmd(CMD.ORDER, 2, Fx.floor(w.ents.x[w.playerEnt[0]]) + 20, Fx.floor(w.ents.y[w.playerEnt[0]]) + 20));
      run(w, 20, cmd(CMD.NEXT, 3));
      return stateHash(w);
    };
    const a = startRound({ seed: 21, playerCount: 2, teamCount: 2, bots: [false, true] }).world;
    const b = startRound({ seed: 21, playerCount: 2, teamCount: 2, bots: [false, true] }).world;
    expect(play(a)).toBe(play(b));
    const c = deserialize(serialize(a));
    expect(stateHash(c)).toBe(stateHash(a));
    run(a, 50);
    run(c, 50);
    expect(stateHash(c)).toBe(stateHash(a));
  });
});
