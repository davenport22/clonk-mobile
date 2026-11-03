import * as Fx from '../fx/fx';
import { MAT } from '../data/materials';
import { at, isSolid } from './grid';
import { EF, type World } from './world';

export function columnSolid(w: World, x: number, yTop: number, yBot: number): boolean {
  for (let y = yTop; y <= yBot; y++) if (isSolid(w, x, y)) return true;
  return false;
}

export function rowSolid(w: World, xLeft: number, xRight: number, y: number): boolean {
  for (let x = xLeft; x <= xRight; x++) if (isSolid(w, x, y)) return true;
  return false;
}

export function boxSolid(w: World, cx: number, cy: number, hw: number, hh: number): boolean {
  const x0 = cx - hw;
  const x1 = cx + hw;
  for (let y = cy - hh; y <= cy + hh; y++) if (rowSolid(w, x0, x1, y)) return true;
  return false;
}

/** Horizontal movement with optional automatic step-up over small ledges. */
export function moveX(w: World, id: number, hw: number, hh: number, stepUp: number): boolean {
  const e = w.ents;
  const target = e.x[id] + e.vx[id];
  let curPx = Fx.floor(e.x[id]);
  const tgtPx = Fx.floor(target);
  if (curPx === tgtPx) {
    e.x[id] = target;
    return false;
  }
  const dir = tgtPx > curPx ? 1 : -1;
  let blocked = false;

  while (curPx !== tgtPx) {
    const nx = curPx + dir;
    const edge = dir > 0 ? nx + hw : nx - hw;
    const yc = Fx.floor(e.y[id]);
    if (columnSolid(w, edge, yc - hh, yc + hh)) {
      let stepped = false;
      for (let s = 1; s <= stepUp; s++) {
        if (
          !columnSolid(w, edge, yc - hh - s, yc + hh - s) &&
          !rowSolid(w, nx - hw, nx + hw, yc - hh - s)
        ) {
          e.y[id] -= Fx.of(s);
          stepped = true;
          break;
        }
      }
      if (!stepped) {
        blocked = true;
        break;
      }
    }
    curPx = nx;
  }

  if (blocked) {
    e.x[id] = Fx.of(curPx);
    e.vx[id] = 0;
  } else {
    e.x[id] = target;
  }
  return blocked;
}

/** Vertical movement. Returns 1 when a floor was hit, -1 for a ceiling, 0 otherwise. */
export function moveY(w: World, id: number, hw: number, hh: number): number {
  const e = w.ents;
  const target = e.y[id] + e.vy[id];
  let curPx = Fx.floor(e.y[id]);
  const tgtPx = Fx.floor(target);
  if (curPx === tgtPx) {
    e.y[id] = target;
    return 0;
  }
  const dir = tgtPx > curPx ? 1 : -1;
  let hit = 0;

  while (curPx !== tgtPx) {
    const ny = curPx + dir;
    const edge = dir > 0 ? ny + hh : ny - hh;
    const xc = Fx.floor(e.x[id]);
    if (rowSolid(w, xc - hw, xc + hw, edge)) {
      hit = dir;
      break;
    }
    curPx = ny;
  }

  if (hit !== 0) {
    e.y[id] = Fx.of(curPx);
    e.vy[id] = 0;
  } else {
    e.y[id] = target;
  }
  return hit;
}

export function grounded(w: World, id: number, hw: number, hh: number): boolean {
  const e = w.ents;
  const xc = Fx.floor(e.x[id]);
  const yc = Fx.floor(e.y[id]);
  return rowSolid(w, xc - hw, xc + hw, yc + hh + 1);
}

export function inWater(w: World, id: number): boolean {
  const e = w.ents;
  return at(w, Fx.floor(e.x[id]), Fx.floor(e.y[id])) === MAT.WATER;
}

export function setFlag(w: World, id: number, bit: number, on: boolean): void {
  if (on) w.ents.flags[id] |= bit;
  else w.ents.flags[id] &= ~bit;
}

export function hasFlag(w: World, id: number, bit: number): boolean {
  return (w.ents.flags[id] & bit) !== 0;
}

/** Simple ballistic body used by carryable chunks. */
export function stepLooseBody(w: World, id: number, hw: number, hh: number): void {
  const e = w.ents;
  const wet = inWater(w, id);
  setFlag(w, id, EF.IN_WATER, wet);
  e.vy[id] += wet ? Fx.ratio(5, 100) : Fx.ratio(22, 100);
  const maxFall = wet ? Fx.of(1) : Fx.of(6);
  if (e.vy[id] > maxFall) e.vy[id] = maxFall;
  e.vx[id] = Fx.mul(e.vx[id], wet ? Fx.ratio(80, 100) : Fx.ratio(94, 100));
  if (Fx.abs(e.vx[id]) < 1024) e.vx[id] = 0;
  moveX(w, id, hw, hh, 0);
  const hitY = moveY(w, id, hw, hh);
  if (hitY === 1) e.vx[id] = Fx.mul(e.vx[id], Fx.ratio(50, 100));
}
