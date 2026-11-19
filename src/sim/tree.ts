import * as Fx from '../fx/fx';
import { TREE_CHOP, TREE_FALL_TICKS, TREE_HEIGHT, TREE_REACH } from '../data/config';
import { CHUNK_KIND, SOLID } from '../data/materials';
import { spawnChunk } from './clonk';
import { at } from './grid';
import { EK, EV, despawn, pushEvent, spawn, type World } from './world';

/**
 * Trees.
 *
 * In Clonk a tree is an object standing on the landscape, not part of it. A
 * clonk walks straight past one; the only thing that interacts with a tree is
 * the axe. The first version stamped trunks and crowns into the material grid,
 * which made every forest a wall to dig through and every crown a ledge to
 * get caught on.
 *
 * Fields: x/y is the foot of the trunk, aux the size (0 to 2), item the
 * variant (0 broadleaf, 1 conifer), hp the chopping left, timer the fall
 * progress (0 while standing) and aux2 the side it falls to.
 */

export function plantTree(w: World, x: number, groundY: number, size: number, variant: number): number {
  const id = spawn(w, EK.TREE);
  if (id < 0) return -1;
  const e = w.ents;
  e.x[id] = Fx.of(x);
  e.y[id] = Fx.of(groundY);
  e.aux[id] = size;
  e.item[id] = variant;
  e.hp[id] = TREE_CHOP * (size + 1);
  e.timer[id] = 0;
  e.team[id] = 255;
  return id;
}

function fall(w: World, id: number, dir: number): void {
  const e = w.ents;
  e.timer[id] = 1;
  e.aux2[id] = dir < 0 ? -1 : 1;
}

/** A tree on its way down, or one whose root has been dug out from under it. */
export function stepTree(w: World, id: number): void {
  const e = w.ents;
  const bx = Fx.floor(e.x[id]);
  const by = Fx.floor(e.y[id]);

  if (e.timer[id] > 0) {
    e.timer[id]++;
    if (e.timer[id] < TREE_FALL_TICKS) return;
    // Down. The trunk breaks into logs where it landed.
    const size = e.aux[id];
    const dir = e.aux2[id];
    const len = TREE_HEIGHT[size];
    const logs = size + 2;
    for (let k = 1; k <= logs; k++) {
      const lx = bx + dir * Fx.idiv(len * k, logs + 1);
      spawnChunk(w, lx, by - 3, CHUNK_KIND.WOOD);
    }
    pushEvent(w, EV.FELL, bx + dir * (len >> 1), by, size, 255);
    despawn(w, id);
    return;
  }

  // Undermined: nothing left to stand on.
  if (SOLID[at(w, bx, by + 1)] === 0 && SOLID[at(w, bx - 2, by + 1)] === 0 && SOLID[at(w, bx + 2, by + 1)] === 0) {
    fall(w, id, (id & 1) === 0 ? 1 : -1);
  }
}

/**
 * Chops at the nearest standing tree in front of a clonk, if there is one.
 *
 * Returns whether it chopped, so the shovel can fall through to digging
 * otherwise. A steep downward aim never chops: someone digging straight down
 * beside a tree means to dig.
 */
export function chopTree(w: World, cx: number, feetY: number, dir: number, aimY: number): boolean {
  if (aimY > 40) return false;
  const e = w.ents;
  let best = -1;
  let bestD = TREE_REACH + 1;
  for (let i = 0; i < w.entCount; i++) {
    if (e.kind[i] !== EK.TREE || e.timer[i] !== 0) continue;
    const dx = (Fx.floor(e.x[i]) - cx) * dir;
    if (dx < -2 || dx > TREE_REACH) continue;
    const dy = Fx.floor(e.y[i]) - feetY;
    if (dy < -6 || dy > 6) continue;
    const d = dx < 0 ? -dx : dx;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return false;

  e.hp[best]--;
  if ((w.tick & 7) === 0) {
    pushEvent(w, EV.CHOP, Fx.floor(e.x[best]), Fx.floor(e.y[best]) - 5, 0, 255);
  }
  // Away from the axe, as a tree cut from one side does.
  if (e.hp[best] <= 0) fall(w, best, dir);
  return true;
}

/** The nearest standing tree, for bots that want wood. */
export function nearestTree(w: World, x: number, y: number, radius: number): number {
  const e = w.ents;
  let best = -1;
  let bestD = radius * radius;
  for (let i = 0; i < w.entCount; i++) {
    if (e.kind[i] !== EK.TREE || e.timer[i] !== 0) continue;
    const dx = Fx.floor(e.x[i]) - x;
    const dy = Fx.floor(e.y[i]) - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
