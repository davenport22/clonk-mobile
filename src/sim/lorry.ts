import * as Fx from '../fx/fx';
import {
  FLAG_RADIUS,
  LORRY_CAPACITY,
  LORRY_H,
  LORRY_PUSH,
  LORRY_W,
} from '../data/config';
import { CHUNK_KIND, CHUNK_KIND_COUNT } from '../data/materials';
import { stepLooseBody } from './physics';
import { EF, EK, EV, addStock, despawn, lorryLoad, pushEvent, type World } from './world';

export const LORRY_HW = LORRY_W >> 1;
export const LORRY_HH = LORRY_H >> 1;

/**
 * The lorry.
 *
 * Carrying one chunk at a time is the right constraint for the first minute and
 * the wrong one for the tenth: once a seam is open, the walk back is the whole
 * game and it is not interesting. The lorry is Clonk's answer - a heavy box you
 * shove along a tunnel, fill as you dig, and park in your flag ring, where it
 * empties itself.
 */
export function stepLorry(w: World, id: number): void {
  const e = w.ents;

  // Heavy: it keeps rolling, but not for long.
  e.vx[id] = Fx.mul(e.vx[id], Fx.ratio(88, 100));
  if (Fx.abs(e.vx[id]) < 1200) e.vx[id] = 0;
  stepLooseBody(w, id, LORRY_HW, LORRY_HH);

  // Swallow loose chunks it is sitting on. Digging beside a parked lorry
  // therefore fills it without a single button press.
  if (lorryLoad(w, id) < LORRY_CAPACITY) {
    const lx = Fx.floor(e.x[id]);
    const ly = Fx.floor(e.y[id]);
    for (let i = 0; i < w.entCount; i++) {
      if (e.kind[i] !== EK.ITEM || (e.flags[i] & EF.CARRIED) !== 0) continue;
      const dx = Fx.floor(e.x[i]) - lx;
      const dy = Fx.floor(e.y[i]) - ly;
      if (dx > LORRY_HW + 2 || dx < -LORRY_HW - 2) continue;
      if (dy > LORRY_HH + 4 || dy < -LORRY_HH - 6) continue;
      load(w, id, e.item[i]);
      despawn(w, i);
      if (lorryLoad(w, id) >= LORRY_CAPACITY) break;
    }
  }

  // Parked in a flag ring: unload into that team's stock, one chunk at a time
  // so it reads as unloading rather than teleporting.
  if ((w.tick & 7) !== 0) return;
  for (let t = 0; t < w.teamCount; t++) {
    const flag = w.teamFlag[t];
    if (flag < 0 || e.kind[flag] !== EK.FLAG) continue;
    const dx = Fx.floor(e.x[id]) - Fx.floor(e.x[flag]);
    const dy = Fx.floor(e.y[id]) - Fx.floor(e.y[flag]);
    if (Fx.ilen(dx, dy) > FLAG_RADIUS) continue;
    for (let k = 0; k < CHUNK_KIND_COUNT; k++) {
      if (w.lorryStore[id * CHUNK_KIND_COUNT + k] <= 0) continue;
      w.lorryStore[id * CHUNK_KIND_COUNT + k]--;
      if (k === CHUNK_KIND.GOLD) w.gold[t] += 1;
      addStock(w, t, k, 1);
      pushEvent(w, EV.UNLOAD, Fx.floor(e.x[flag]), Fx.floor(e.y[flag]), k, t);
      return;
    }
  }
}

export function load(w: World, id: number, kind: number): boolean {
  if (lorryLoad(w, id) >= LORRY_CAPACITY) return false;
  w.lorryStore[id * CHUNK_KIND_COUNT + kind]++;
  pushEvent(w, EV.LOAD, Fx.floor(w.ents.x[id]), Fx.floor(w.ents.y[id]), kind, w.ents.team[id]);
  return true;
}

/** The lorry a clonk is touching, or -1. */
export function lorryAt(w: World, px: number, py: number, hw: number, hh: number): number {
  const e = w.ents;
  for (let i = 0; i < w.entCount; i++) {
    if (e.kind[i] !== EK.LORRY) continue;
    const dx = Fx.floor(e.x[i]) - px;
    const dy = Fx.floor(e.y[i]) - py;
    if (dx > LORRY_HW + hw + 2 || dx < -LORRY_HW - hw - 2) continue;
    if (dy > LORRY_HH + hh + 2 || dy < -LORRY_HH - hh - 2) continue;
    return i;
  }
  return -1;
}

/** A clonk leaning into a lorry shoves it along. */
export function push(w: World, lorry: number, dir: number): void {
  w.ents.vx[lorry] += dir * LORRY_PUSH;
  const cap = Fx.of(2);
  if (w.ents.vx[lorry] > cap) w.ents.vx[lorry] = cap;
  if (w.ents.vx[lorry] < -cap) w.ents.vx[lorry] = -cap;
}
