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
import { FALLS, MAT, SOLID } from '../data/materials';
import type { World } from './world';

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
  return at(w, x, y) === MAT.WATER;
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
 * Falling material, liquid flow and structural collapse, budgeted per tick.
 *
 * Determinism: the dirty queue is a FIFO ring, cells are swept bottom-to-top and
 * the horizontal sweep direction is a function of tick parity only, so the whole
 * pass depends on nothing but simulation state.
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
        const idx = y * GRID_W + x;
        const m = mat[idx];
        if (m === MAT.SKY || m === MAT.GRANITE || m === MAT.STRUCT) continue;

        if (m === MAT.WATER) {
          if (flowWater(w, x, y, rightward)) changed = true;
          continue;
        }

        if (FALLS[m] === 1) {
          if (fall(w, x, y, rightward)) changed = true;
          continue;
        }

        if (m === MAT.EARTH) {
          const below = at(w, x, y + 1);
          if (below === MAT.SKY || below === MAT.WATER) {
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

function fall(w: World, x: number, y: number, rightward: boolean): boolean {
  const below = at(w, x, y + 1);
  if (below === MAT.SKY || below === MAT.WATER) {
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

function flowWater(w: World, x: number, y: number, rightward: boolean): boolean {
  if (at(w, x, y + 1) === MAT.SKY) {
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
  // Lateral spread only under pressure: water above, or water pushing from the
  // opposite side. Without this a single cell oscillates forever and the chunk
  // never goes quiet.
  const pressured = at(w, x, y - 1) === MAT.WATER || at(w, x - d1, y) === MAT.WATER;
  if (!pressured) return false;
  if (at(w, x + d1, y) === MAT.SKY) {
    swap(w, x, y, x + d1, y);
    return true;
  }
  return false;
}
