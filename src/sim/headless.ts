import { HASH_PERIOD } from '../data/config';
import { stateHash } from './hash';
import { BTN, TOOL, makeInput, type InputFrame } from './input';
import { Rng } from './rng';
import { startRound, tickWorld } from './sim';
import { CHUNK_KIND } from '../data/materials';
import { addStock } from './world';

/**
 * Scripted input log. Generated from the seed alone so two independent
 * processes produce byte-identical input without exchanging anything.
 * Deliberately dig-heavy: the material grid is where divergence hides.
 */
export function scriptedInputs(seed: number, playerCount: number): (tick: number) => InputFrame[] {
  const rng = new Rng(seed ^ 0x1d872b41);
  const frames: InputFrame[] = [];
  for (let p = 0; p < playerCount; p++) frames.push({ ...makeInput(), sel: TOOL.SHOVEL });

  return (tick: number) => {
    for (let p = 0; p < playerCount; p++) {
      const f = frames[p];
      if (rng.chance(1, 14)) f.dx = rng.range(-64, 64);
      if (rng.chance(1, 20)) f.dy = rng.range(-64, 64);
      if (rng.chance(1, 10)) f.buttons = rng.chance(3, 4) ? BTN.ACTION : 0;
      if (rng.chance(1, 300)) f.sel = rng.int(4);
      if ((tick & 255) === 0) f.sel = TOOL.SHOVEL;
      // Give everyone the means to blast, so the harness covers explosions,
      // deaths and respawns rather than only digging.
      if ((tick & 511) === 0) f.sel = TOOL.DYNAMITE;
    }
    return frames;
  };
}

export interface HeadlessResult {
  hashes: number[];
  finalTick: number;
  goldTotal: number;
  entCount: number;
}

export function runHeadless(
  seed: number,
  playerCount: number,
  teamCount: number,
  ticks: number,
  hashEvery: number = HASH_PERIOD,
): HeadlessResult {
  const { world } = startRound({ seed, playerCount, teamCount });
  // Stocked up front, otherwise the scripted inputs can never afford dynamite
  // and the blast paths stay untested.
  for (let t = 0; t < teamCount; t++) {
    addStock(world, t, CHUNK_KIND.COAL, 40);
    addStock(world, t, CHUNK_KIND.WOOD, 40);
  }
  const next = scriptedInputs(seed, playerCount);
  const hashes: number[] = [stateHash(world)];
  for (let t = 0; t < ticks; t++) {
    tickWorld(world, next(t));
    if (world.tick % hashEvery === 0) hashes.push(stateHash(world));
  }
  let goldTotal = 0;
  for (let t = 0; t < teamCount; t++) goldTotal += world.gold[t];
  return { hashes, finalTick: world.tick, goldTotal, entCount: world.entCount };
}
