import * as Fx from '../fx/fx';
import {
  CLONK_H,
  ELEVATOR_LEN,
  ELEVATOR_W,
  FOUNDRY_H,
  FOUNDRY_W,
  GRID_H,
  GRID_W,
  LORRY_H,
  LORRY_W,
} from '../data/config';
import { CHUNK_KIND, MAT, SOLID } from '../data/materials';
import { at, setCell } from './grid';
import { EK, EV, addStock, pushEvent, spawn, teamStock, type World } from './world';

export interface Cost {
  kind: number;
  n: number;
}

/**
 * The whole tech ramp, Clonk-shaped: chop wood for a foundry, mine ore and coal
 * to smelt metal, spend metal on an elevator to reach the deep gold. Dynamite
 * needs no building at all, so sabotage is available from the first minute -
 * which is the point of PRD 5.3.
 */
export const FOUNDRY_COST: Cost[] = [{ kind: CHUNK_KIND.WOOD, n: 4 }];
export const ELEVATOR_COST: Cost[] = [
  { kind: CHUNK_KIND.METAL, n: 2 },
  { kind: CHUNK_KIND.WOOD, n: 2 },
];
export const DYNAMITE_COST: Cost[] = [
  { kind: CHUNK_KIND.COAL, n: 1 },
  { kind: CHUNK_KIND.WOOD, n: 1 },
];
export const LORRY_COST: Cost[] = [
  { kind: CHUNK_KIND.METAL, n: 1 },
  { kind: CHUNK_KIND.WOOD, n: 2 },
];

export function canAfford(w: World, team: number, cost: Cost[]): boolean {
  for (let i = 0; i < cost.length; i++) {
    if (teamStock(w, team, cost[i].kind) < cost[i].n) return false;
  }
  return true;
}

export function payCost(w: World, team: number, cost: Cost[]): void {
  for (let i = 0; i < cost.length; i++) addStock(w, team, cost[i].kind, -cost[i].n);
}

function areaClear(w: World, x0: number, y0: number, x1: number, y1: number): boolean {
  if (x0 < 1 || y0 < 1 || x1 >= GRID_W - 1 || y1 >= GRID_H - 1) return false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const m = at(w, x, y);
      if (SOLID[m] === 1) return false;
    }
  }
  return true;
}

/** Places a foundry standing on the ground under the clonk's feet. */
export function placeFoundry(w: World, clonk: number): boolean {
  const e = w.ents;
  const team = e.team[clonk];
  if (!canAfford(w, team, FOUNDRY_COST)) {
    pushEvent(w, EV.DENY, Fx.floor(e.x[clonk]), Fx.floor(e.y[clonk]), 0, 0);
    return false;
  }
  const cx = Fx.floor(e.x[clonk]);
  const feet = Fx.floor(e.y[clonk]) + (CLONK_H >> 1) + 1;
  const hw = FOUNDRY_W >> 1;
  const x0 = cx - hw;
  const x1 = cx + hw;
  const y1 = feet;
  const y0 = y1 - FOUNDRY_H + 1;
  if (!areaClear(w, x0, y0, x1, y1)) {
    pushEvent(w, EV.DENY, cx, feet, 1, 0);
    return false;
  }
  // Needs ground under most of the footprint.
  let support = 0;
  for (let x = x0; x <= x1; x++) if (SOLID[at(w, x, y1 + 1)] === 1) support++;
  if (support * 10 < FOUNDRY_W * 6) {
    pushEvent(w, EV.DENY, cx, feet, 2, 0);
    return false;
  }

  payCost(w, team, FOUNDRY_COST);
  // Building clears any foliage standing in the hut's footprint.
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (at(w, x, y) === MAT.LEAVES) setCell(w, x, y, MAT.SKY);
    }
  }
  const id = spawn(w, EK.FOUNDRY);
  if (id < 0) return false;
  e.team[id] = team;
  e.x[id] = Fx.of(cx);
  e.y[id] = Fx.of((y0 + y1) >> 1);
  e.timer[id] = 0;
  // Structures are stamped into the grid so the existing physics and support
  // rules treat them as terrain for free.
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (y === y0 || y === y1 || x === x0 || x === x1) setCell(w, x, y, MAT.STRUCT);
    }
  }
  pushEvent(w, EV.BUILD, cx, Fx.floor(e.y[id]), EK.FOUNDRY, team);
  return true;
}

/** Places an elevator shaft going down from the clonk's position. */
export function placeElevator(w: World, clonk: number): boolean {
  const e = w.ents;
  const team = e.team[clonk];
  if (!canAfford(w, team, ELEVATOR_COST)) {
    pushEvent(w, EV.DENY, Fx.floor(e.x[clonk]), Fx.floor(e.y[clonk]), 0, 0);
    return false;
  }
  const cx = Fx.floor(e.x[clonk]);
  const top = Fx.floor(e.y[clonk]) - (CLONK_H >> 1);
  const hw = ELEVATOR_W >> 1;
  let free = 0;
  for (let y = top; y < top + ELEVATOR_LEN; y++) {
    if (y >= GRID_H - 1) break;
    let rowFree = true;
    for (let x = cx - hw; x <= cx + hw; x++) if (SOLID[at(w, x, y)] === 1) rowFree = false;
    if (rowFree) free++;
  }
  if (free * 10 < ELEVATOR_LEN * 7) {
    pushEvent(w, EV.DENY, cx, top, 3, 0);
    return false;
  }

  payCost(w, team, ELEVATOR_COST);
  const id = spawn(w, EK.ELEVATOR);
  if (id < 0) return false;
  e.team[id] = team;
  e.x[id] = Fx.of(cx);
  e.y[id] = Fx.of(top);
  e.aux[id] = Fx.of(top); // platform position
  pushEvent(w, EV.BUILD, cx, top, EK.ELEVATOR, team);
  return true;
}

/**
 * Builds a lorry at the clonk's feet.
 *
 * Unlike the buildings it needs no footprint check beyond standing room: a
 * lorry that ends up somewhere awkward can simply be pushed out of it, which
 * is a better failure than a refusal the player has to decode.
 */
export function placeLorry(w: World, clonk: number): boolean {
  const e = w.ents;
  const team = e.team[clonk];
  if (!canAfford(w, team, LORRY_COST)) {
    pushEvent(w, EV.DENY, Fx.floor(e.x[clonk]), Fx.floor(e.y[clonk]), 0, 0);
    return false;
  }
  const cx = Fx.floor(e.x[clonk]) + e.facing[clonk] * 12;
  const cy = Fx.floor(e.y[clonk]);
  if (!areaClear(w, cx - (LORRY_W >> 1), cy - (LORRY_H >> 1), cx + (LORRY_W >> 1), cy + (LORRY_H >> 1))) {
    pushEvent(w, EV.DENY, cx, cy, 1, 0);
    return false;
  }

  payCost(w, team, LORRY_COST);
  const id = spawn(w, EK.LORRY);
  if (id < 0) return false;
  e.team[id] = team;
  e.x[id] = Fx.of(cx);
  e.y[id] = Fx.of(cy);
  pushEvent(w, EV.BUILD, cx, cy, EK.LORRY, team);
  return true;
}

/** Elevator shaft hit test, in integer pixels. */
export function elevatorAt(w: World, px: number, py: number): number {
  const e = w.ents;
  for (let i = 0; i < w.entCount; i++) {
    if (e.kind[i] !== EK.ELEVATOR) continue;
    const cx = Fx.floor(e.x[i]);
    const top = Fx.floor(e.y[i]);
    if (px >= cx - ELEVATOR_W && px <= cx + ELEVATOR_W && py >= top - 4 && py <= top + ELEVATOR_LEN) {
      return i;
    }
  }
  return -1;
}
