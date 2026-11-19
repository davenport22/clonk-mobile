import * as Fx from '../fx/fx';
import {
  CHUNK,
  CHUNKS_X,
  CHUNKS_Y,
  CHUNK_BUDGET,
  CHUNK_COUNT,
  GRID_H,
  GRID_W,
} from '../data/config';
import { DENSITY, DISSOLVES, FALLS, FLAMMABLE, LIQUID, MAT, MELTS, SOLID, VISCOSITY } from '../data/materials';
import { EV, pushEvent, type World } from './world';

/** Material at a cell. Out of bounds reads as bedrock, except above the sky. */
export function at(w: World, x: number, y: number): number {
  if (x < 0 || x >= GRID_W || y >= GRID_H) return MAT.GRANITE;
  if (y < 0) return MAT.SKY;
  return w.mat[y * GRID_W + x];
}

export function isSolid(w: World, x: number, y: number): boolean {
  return SOLID[at(w, x, y)] === 1;
}

export function isLiquid(w: World, x: number, y: number): boolean {
  return LIQUID[at(w, x, y)] === 1;
}

export function markChunk(w: World, ci: number): void {
  if (ci < 0 || ci >= CHUNK_COUNT || w.chunkDirty[ci] === 1) return;
  w.chunkDirty[ci] = 1;
  w.dirtyQueue[w.dirtyTail] = ci;
  w.dirtyTail = w.dirtyTail + 1 === w.dirtyQueue.length ? 0 : w.dirtyTail + 1;
}

/** Mark the 3x3 chunk neighbourhood around a cell, so material at chunk seams
 *  is re-evaluated by its neighbours too. */
export function markCell(w: World, x: number, y: number): void {
  const cx = x >> 4;
  const cy = y >> 4;
  for (let j = cy - 1; j <= cy + 1; j++) {
    if (j < 0 || j >= CHUNKS_Y) continue;
    for (let i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || i >= CHUNKS_X) continue;
      markChunk(w, j * CHUNKS_X + i);
    }
  }
}

/** Records that a cell's chunk changed this tick, for the renderer's uploads. */
export function touch(w: World, x: number, y: number): void {
  const ci = (y >> 4) * CHUNKS_X + (x >> 4);
  if (ci >= 0 && ci < CHUNK_COUNT) w.chunkStamp[ci] = w.tick;
}

export function setCell(w: World, x: number, y: number, m: number): void {
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
  const i = y * GRID_W + x;
  if (w.mat[i] === m) return;
  w.mat[i] = m;
  touch(w, x, y);
  markCell(w, x, y);
}

export function markAllChunks(w: World): void {
  for (let i = 0; i < CHUNK_COUNT; i++) markChunk(w, i);
}

function queueLength(w: World): number {
  const d = w.dirtyTail - w.dirtyHead;
  return d < 0 ? d + w.dirtyQueue.length : d;
}

/**
 * A deterministic dice roll for one cell on one tick, 0..255.
 *
 * The material pass needs chance - fire does not spread on a fixed beat, acid
 * does not eat at a constant rate - but it must not touch the world's Rng,
 * whose sequence would then depend on how many cells happened to be awake. A
 * hash of position, tick and a salt is a pure function of simulation state,
 * so every client rolls the same number for the same cell.
 */
export function roll(w: World, x: number, y: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(w.tick, 1274126177) ^ Math.imul(salt, 1911520717);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return (h ^ (h >>> 16)) & 255;
}

/** Lava or fire beside the cell, on one of its four sides. */
function nearHeat(w: World, x: number, y: number): boolean {
  const a = at(w, x, y - 1);
  const b = at(w, x, y + 1);
  const c = at(w, x - 1, y);
  const d = at(w, x + 1, y);
  return (
    a === MAT.LAVA || a === MAT.FIRE || b === MAT.LAVA || b === MAT.FIRE ||
    c === MAT.LAVA || c === MAT.FIRE || d === MAT.LAVA || d === MAT.FIRE
  );
}

/** The four sides, then the four corners: a fixed order, so spreading is deterministic. */
const NX = [0, -1, 1, 0, -1, 1, -1, 1];
const NY = [-1, 0, 0, 1, -1, -1, 1, 1];

/**
 * Falling material, liquids, fire, acid and structural collapse, budgeted per
 * tick.
 *
 * Determinism: the dirty queue is a FIFO ring, cells are swept bottom-to-top,
 * the horizontal sweep direction is a function of tick parity only, and every
 * chance is a roll() of position and tick. The whole pass depends on nothing
 * but simulation state.
 *
 * A chunk stays in the queue for as long as any cell in it changed or still
 * has something to do - a fire burning, lava waiting for its next slow step -
 * and drops out once everything in it is at rest.
 */
export function updateMaterial(w: World): void {
  const mat = w.mat;
  const rightward = (w.tick & 1) === 0;
  let budget = CHUNK_BUDGET;
  let pending = queueLength(w);

  while (budget > 0 && pending > 0) {
    budget--;
    pending--;
    const ci = w.dirtyQueue[w.dirtyHead];
    w.dirtyHead = w.dirtyHead + 1 === w.dirtyQueue.length ? 0 : w.dirtyHead + 1;
    w.chunkDirty[ci] = 0;

    const cx0 = (ci % CHUNKS_X) * CHUNK;
    const cy0 = Fx.idiv(ci, CHUNKS_X) * CHUNK;
    let changed = false;

    for (let y = cy0 + CHUNK - 1; y >= cy0; y--) {
      for (let k = 0; k < CHUNK; k++) {
        const x = rightward ? cx0 + k : cx0 + CHUNK - 1 - k;
        const m = mat[y * GRID_W + x];
        if (m === MAT.SKY || m === MAT.GRANITE || m === MAT.STRUCT) continue;

        if (m === MAT.FIRE) {
          burn(w, x, y);
          changed = true;
          continue;
        }

        if (LIQUID[m] === 1) {
          if (flowLiquid(w, x, y, m, rightward)) changed = true;
          continue;
        }

        if (MELTS[m] === 1 && nearHeat(w, x, y)) {
          if (roll(w, x, y, 3) < 40) setCell(w, x, y, MAT.WATER);
          changed = true;
          continue;
        }

        if (FALLS[m] === 1) {
          if (fall(w, x, y, rightward)) changed = true;
          continue;
        }

        if (m === MAT.EARTH) {
          const below = at(w, x, y + 1);
          if (below === MAT.SKY || LIQUID[below] === 1) {
            let support = 0;
            if (isSolid(w, x - 1, y)) support++;
            if (isSolid(w, x + 1, y)) support++;
            if (isSolid(w, x, y - 1)) support++;
            if (support <= 1) {
              setCell(w, x, y, MAT.EARTH_LOOSE);
              changed = true;
            }
          }
        }
      }
    }

    if (changed) markChunk(w, ci);
  }
}

function swap(w: World, x0: number, y0: number, x1: number, y1: number): void {
  const a = w.mat[y0 * GRID_W + x0];
  const b = w.mat[y1 * GRID_W + x1];
  w.mat[y0 * GRID_W + x0] = b;
  w.mat[y1 * GRID_W + x1] = a;
  touch(w, x0, y0);
  touch(w, x1, y1);
  markCell(w, x0, y0);
  markCell(w, x1, y1);
}

/** Loose solids drop through air and sink through any liquid. */
function fall(w: World, x: number, y: number, rightward: boolean): boolean {
  const below = at(w, x, y + 1);
  if (below === MAT.SKY || LIQUID[below] === 1) {
    swap(w, x, y, x, y + 1);
    return true;
  }
  const d1 = rightward ? 1 : -1;
  if (at(w, x + d1, y + 1) === MAT.SKY && at(w, x + d1, y) === MAT.SKY) {
    swap(w, x, y, x + d1, y + 1);
    return true;
  }
  if (at(w, x - d1, y + 1) === MAT.SKY && at(w, x - d1, y) === MAT.SKY) {
    swap(w, x, y, x - d1, y + 1);
    return true;
  }
  // Material that cannot move any more is inert.
  return false;
}

/** Whether liquid m may move down into a cell holding t. */
function sinksInto(m: number, t: number): boolean {
  return t === MAT.SKY || (LIQUID[t] === 1 && DENSITY[t] < DENSITY[m]);
}

/**
 * Reactions a liquid has with what touches it, before it moves. Returns true
 * if the cell is still busy, whether or not anything changed this tick.
 */
function react(w: World, x: number, y: number, m: number): boolean {
  if (m === MAT.LAVA) {
    let busy = false;
    for (let i = 0; i < 4; i++) {
      const nx = x + NX[i];
      const ny = y + NY[i];
      const n = at(w, nx, ny);
      if (n === MAT.WATER) {
        // Quenched: the lava sets into rock and the water flashes to steam.
        setCell(w, x, y, MAT.ROCK);
        setCell(w, nx, ny, MAT.SKY);
        if (roll(w, x, y, 11) < 64) pushEvent(w, EV.STEAM, x, y, 0, 0);
        return true;
      }
      const f = FLAMMABLE[n];
      if (f > 0) {
        busy = true;
        if (roll(w, nx, ny, 5) < (f < 64 ? f * 4 : 255)) setCell(w, nx, ny, MAT.FIRE);
      } else if (MELTS[n] === 1) {
        busy = true;
      }
    }
    return busy;
  }
  if (m === MAT.ACID) {
    let busy = false;
    for (let i = 0; i < 4; i++) {
      const nx = x + NX[3 - i];
      const ny = y + NY[3 - i];
      const d = DISSOLVES[at(w, nx, ny)];
      if (d === 0) continue;
      busy = true;
      if (roll(w, nx, ny, 7) < d) {
        setCell(w, nx, ny, MAT.SKY);
        if (roll(w, x, y, 13) < 24) pushEvent(w, EV.FIZZ, nx, ny, 0, 0);
        // Acid is spent by what it eats, so a pool digs a pit, not a shaft.
        if (roll(w, x, y, 9) < 110) {
          setCell(w, x, y, MAT.SKY);
          return true;
        }
      }
    }
    return busy;
  }
  return false;
}

/**
 * Flow for every liquid. Down first, then diagonally down, then sideways under
 * pressure. A denser liquid displaces a lighter one below it, which is the
 * whole of buoyancy: oil comes up through water because water sinks through
 * oil.
 */
function flowLiquid(w: World, x: number, y: number, m: number, rightward: boolean): boolean {
  const busy = react(w, x, y, m);
  if (w.mat[y * GRID_W + x] !== m) return true;

  const d1 = rightward ? 1 : -1;
  let tx = 0;
  let ty = 0;
  let found = false;
  if (sinksInto(m, at(w, x, y + 1))) {
    tx = x; ty = y + 1; found = true;
  } else if (at(w, x + d1, y + 1) === MAT.SKY && at(w, x + d1, y) === MAT.SKY) {
    tx = x + d1; ty = y + 1; found = true;
  } else if (at(w, x - d1, y + 1) === MAT.SKY && at(w, x - d1, y) === MAT.SKY) {
    tx = x - d1; ty = y + 1; found = true;
  } else {
    // Lateral spread only under pressure: liquid above, or liquid pushing from
    // the opposite side. Without this a single cell oscillates forever and the
    // chunk never goes quiet.
    const pressured = LIQUID[at(w, x, y - 1)] === 1 || at(w, x - d1, y) === m;
    if (pressured && at(w, x + d1, y) === MAT.SKY) {
      tx = x + d1; ty = y; found = true;
    }
  }
  if (!found) return busy;

  // A viscous liquid wants to move but only gets to on some ticks. It stays
  // awake in between, or it would freeze mid-slope.
  const visc = VISCOSITY[m];
  if (visc > 1 && (roll(w, x, y, 1) & (visc - 1)) !== 0) return true;
  swap(w, x, y, tx, ty);
  return true;
}

/**
 * One burning cell. Fire spreads to what it touches, climbs into the air above
 * it, and dies out - fast in open air, slowly while it still has fuel. Water
 * puts it out.
 */
function burn(w: World, x: number, y: number): void {
  let fuel = 0;
  for (let i = 0; i < 8; i++) {
    const nx = x + NX[i];
    const ny = y + NY[i];
    const n = at(w, nx, ny);
    if (n === MAT.WATER || n === MAT.SNOW || n === MAT.ICE) {
      setCell(w, x, y, MAT.SKY);
      if (roll(w, x, y, 17) < 96) pushEvent(w, EV.STEAM, x, y, 0, 0);
      return;
    }
    const f = FLAMMABLE[n];
    if (f > 0) {
      fuel++;
      if (roll(w, nx, ny, 19 + i) < f) setCell(w, nx, ny, MAT.FIRE);
    }
  }
  const r = roll(w, x, y, 23);
  if (r < (fuel > 0 ? 10 : 70)) {
    setCell(w, x, y, MAT.SKY);
    return;
  }
  // Flames lick upwards.
  if (r > 225 && at(w, x, y - 1) === MAT.SKY) swap(w, x, y, x, y - 1);
}

/** Sets a cell alight if it is open air or will burn. For dynamite, lava and torches. */
export function ignite(w: World, x: number, y: number): void {
  const m = at(w, x, y);
  if (m === MAT.SKY || FLAMMABLE[m] > 0) setCell(w, x, y, MAT.FIRE);
}
