import * as Fx from '../fx/fx';
import { CREW_MAX, HIRE_COST } from '../data/config';
import { DIGGABLE, MAT } from '../data/materials';
import { HH, resetClonk } from './clonk';
import { at } from './grid';
import { BTN, TOOL, type InputFrame } from './input';
import { EF, EK, EV, atHome, pushEvent, spawn, type World } from './world';

/**
 * The crew.
 *
 * Each player has several workers. One is steered directly, exactly as before,
 * with the stick or the keyboard; the others carry out standing orders on
 * their own. A player switches which worker they steer at any time and can
 * send the rest to a spot: to walk there, to dig through to it, or to haul
 * what lies there back to base. More workers are hired at the base for gold.
 *
 * Commands travel in the input frame (input.ts) and are applied once per
 * sequence number, so they are deterministic and survive the relay repeating
 * frames. Autonomous workers compute their own input from world state every
 * tick, the way bots do, so the crew costs no bandwidth.
 */

export const ORDER = {
  IDLE: 0,
  MOVE: 1,
  DIG: 2,
  HAUL: 3,
  FOLLOW: 4,
};

export const CMD = {
  NONE: 0,
  /** Steer the next worker. */
  NEXT: 1,
  /** Send the selection to (cx, cy): walk, dig or haul, by what is there. */
  ORDER: 2,
  /** The selection follows the steered worker. */
  FOLLOW: 3,
  /** Hire a worker at the base. */
  HIRE: 4,
  /** Set the selection mask to cx. */
  SELECT: 5,
  /** The selection stops what it is doing. */
  STOP: 6,
  /** Steer the cx-th worker. */
  TAKE: 7,
};

/** Fills out with the player's workers, lowest entity id first, and returns how many. */
export function crewOf(w: World, p: number, out: number[]): number {
  out.length = 0;
  const e = w.ents;
  for (let i = 0; i < w.entCount; i++) {
    if (e.kind[i] === EK.CLONK && e.player[i] === p) out.push(i);
  }
  return out.length;
}

const scratch: number[] = [];

/** Whether crew member i (index into crewOf) is in the player's selection. */
function selected(w: World, p: number, index: number, id: number): boolean {
  if (id === w.playerEnt[p]) return false;
  const mask = w.crewSel[p];
  return mask === 0 || (mask & (1 << index)) !== 0;
}

/** Applies a player's crew command, once per sequence number. */
export function applyCommand(w: World, p: number, f: InputFrame): void {
  if (f.seq === w.cmdSeq[p]) return;
  w.cmdSeq[p] = f.seq;
  const e = w.ents;
  const n = crewOf(w, p, scratch);
  const lead = w.playerEnt[p];

  if (f.cmd === CMD.NEXT || f.cmd === CMD.TAKE) {
    if (n === 0) return;
    let k = 0;
    if (f.cmd === CMD.TAKE) {
      k = Fx.clamp(f.cx, 0, n - 1);
    } else {
      const cur = scratch.indexOf(lead);
      k = cur < 0 ? 0 : (cur + 1) % n;
    }
    const next = scratch[k];
    if (next === lead) return;
    // The worker let go keeps doing nothing in particular until told.
    if (lead >= 0) e.order[lead] = ORDER.IDLE;
    w.playerEnt[p] = next;
    e.order[next] = ORDER.IDLE;
    pushEvent(w, EV.TAKE, Fx.floor(e.x[next]), Fx.floor(e.y[next]), e.team[next], p);
    return;
  }
  if (f.cmd === CMD.SELECT) {
    w.crewSel[p] = f.cx & 0xff;
    return;
  }
  if (f.cmd === CMD.HIRE) {
    hire(w, p);
    return;
  }
  if (f.cmd === CMD.ORDER || f.cmd === CMD.FOLLOW || f.cmd === CMD.STOP) {
    const tx = Fx.clamp(f.cx, 0, 1023);
    const ty = Fx.clamp(f.cy, 0, 511);
    const item = f.cmd === CMD.ORDER ? itemNear(w, tx, ty, 10) : -1;
    const m = at(w, tx, ty);
    for (let k = 0; k < n; k++) {
      const id = scratch[k];
      if (!selected(w, p, k, id)) continue;
      e.ordT[id] = -1;
      if (f.cmd === CMD.STOP) {
        e.order[id] = ORDER.IDLE;
      } else if (f.cmd === CMD.FOLLOW) {
        e.order[id] = ORDER.FOLLOW;
      } else if (item >= 0) {
        e.order[id] = ORDER.HAUL;
        e.ordT[id] = item;
      } else if (DIGGABLE[m] === 1) {
        e.order[id] = ORDER.DIG;
      } else {
        e.order[id] = ORDER.MOVE;
      }
      e.ordX[id] = tx;
      e.ordY[id] = ty;
    }
    if (f.cmd === CMD.ORDER) pushEvent(w, EV.ORDER, tx, ty, w.playerTeam[p], p);
  }
}

/** Hires a worker at the team's base, for gold, up to the crew limit. */
export function hire(w: World, p: number): boolean {
  const team = w.playerTeam[p];
  const flag = w.teamFlag[team];
  if (flag < 0) return false;
  if (crewOf(w, p, scratch) >= CREW_MAX || w.gold[team] < HIRE_COST) {
    pushEvent(w, EV.DENY, Fx.floor(w.ents.x[flag]), Fx.floor(w.ents.y[flag]), 0, team);
    return false;
  }
  const id = addWorker(w, p, Fx.floor(w.ents.x[flag]), Fx.floor(w.ents.y[flag]) - 2);
  if (id < 0) return false;
  w.gold[team] -= HIRE_COST;
  pushEvent(w, EV.SPAWN, Fx.floor(w.ents.x[id]), Fx.floor(w.ents.y[id]), team, p);
  return true;
}

/** Puts a new worker for player p into the world, idle. */
export function addWorker(w: World, p: number, x: number, y: number): number {
  const id = spawn(w, EK.CLONK);
  if (id < 0) return -1;
  const e = w.ents;
  e.team[id] = w.playerTeam[p];
  e.player[id] = p;
  e.x[id] = Fx.of(x);
  e.y[id] = Fx.of(y);
  e.order[id] = ORDER.IDLE;
  resetClonk(w, id);
  return id;
}

/** An untouched chunk within r of a point, nearest first, or -1. */
function itemNear(w: World, x: number, y: number, r: number): number {
  const e = w.ents;
  let best = -1;
  let bestD = r * r + 1;
  for (let i = 0; i < w.entCount; i++) {
    if (e.kind[i] !== EK.ITEM || (e.flags[i] & (EF.CARRIED | EF.THROWN)) !== 0) continue;
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

function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/**
 * Steering shared by every order: walk towards a point, climb or jump what is
 * in the way, and optionally hold the shovel aimed at the point, which digs
 * straight through anything diggable between here and there.
 */
function steer(w: World, id: number, tx: number, ty: number, dig: boolean, out: InputFrame): void {
  const e = w.ents;
  const cx = Fx.floor(e.x[id]);
  const cy = Fx.floor(e.y[id]);
  const dx = tx - cx;
  const dy = ty - cy;
  out.dx = sign(dx) * 64;
  if (dy > 6 || dy < -6) out.dy = sign(dy) * 64;
  if (dx !== 0 || dy !== 0) {
    const len = Fx.ilen(dx, dy);
    if (len > 0) {
      out.ax = Fx.clamp(Fx.idiv(dx * 64, len), -64, 64);
      out.ay = Fx.clamp(Fx.idiv(dy * 64, len), -64, 64);
    }
  }
  const ahead = cx + sign(dx) * 6;
  if (sign(dx) !== 0 && (e.flags[id] & EF.GROUNDED) !== 0) {
    const m = at(w, ahead, cy);
    // A wall that cannot be dug: jump it. A diggable one is dug if digging,
    // jumped if only walking.
    if ((m !== MAT.SKY && DIGGABLE[m] === 0) || (!dig && m !== MAT.SKY)) out.buttons |= BTN.JUMP;
  }
  if (dig) out.buttons |= BTN.ACTION;
}

/** Produces the input of a worker nobody steers, from its standing order. */
export function crewInput(w: World, id: number, out: InputFrame): InputFrame {
  out.dx = 0;
  out.dy = 0;
  out.ax = 0;
  out.ay = 0;
  out.buttons = 0;
  out.sel = TOOL.SHOVEL;
  out.cmd = 0;
  out.seq = 0;
  out.cx = 0;
  out.cy = 0;

  const e = w.ents;
  const cx = Fx.floor(e.x[id]);
  const cy = Fx.floor(e.y[id]);
  const p = e.player[id];
  const team = e.team[id];
  const order = e.order[id];

  if (order === ORDER.FOLLOW) {
    const lead = p >= 0 ? w.playerEnt[p] : -1;
    if (lead < 0 || e.kind[lead] !== EK.CLONK) {
      e.order[id] = ORDER.IDLE;
      return out;
    }
    // Trail behind the leader, spaced by id so a crew does not stack up.
    const lx = Fx.floor(e.x[lead]) - e.facing[lead] * (8 + (id & 3) * 5);
    const ly = Fx.floor(e.y[lead]);
    if (Math.abs(lx - cx) > 5 || ly - cy < -14) steer(w, id, lx, ly, false, out);
    return out;
  }

  if (order === ORDER.MOVE) {
    const dx = e.ordX[id] - cx;
    const dy = e.ordY[id] - cy;
    if (dx <= 3 && dx >= -3 && dy <= HH + 6 && dy >= -HH - 10) {
      e.order[id] = ORDER.IDLE;
      return out;
    }
    steer(w, id, e.ordX[id], e.ordY[id], false, out);
    return out;
  }

  if (order === ORDER.DIG) {
    const tx = e.ordX[id];
    const ty = e.ordY[id];
    // Done once the target and the ground right round it are gone.
    let left = 0;
    for (let d = -2; d <= 2; d += 2) {
      if (DIGGABLE[at(w, tx + d, ty)] === 1) left++;
      if (DIGGABLE[at(w, tx, ty + d)] === 1) left++;
    }
    if (left === 0) {
      e.order[id] = ORDER.IDLE;
      return out;
    }
    steer(w, id, tx, ty, true, out);
    return out;
  }

  if (order === ORDER.HAUL) {
    if (e.carry[id] >= 0) {
      // Bring it home; the hut takes it on arrival.
      const flag = w.teamFlag[team];
      if (flag < 0) {
        e.order[id] = ORDER.IDLE;
        return out;
      }
      e.ordT[id] = -2;
      steer(w, id, Fx.floor(e.x[flag]), Fx.floor(e.y[flag]), !atHome(w, team, cx, cy), out);
      return out;
    }
    let item = e.ordT[id];
    if (item < 0 || e.kind[item] !== EK.ITEM || (e.flags[item] & EF.CARRIED) !== 0) {
      // Delivered, or someone else took it: fetch the next chunk lying near
      // the spot, and stop when there are none.
      item = itemNear(w, e.ordX[id], e.ordY[id], 48);
      e.ordT[id] = item;
      if (item < 0) {
        e.order[id] = ORDER.IDLE;
        return out;
      }
    }
    steer(w, id, Fx.floor(e.x[item]), Fx.floor(e.y[item]), false, out);
    return out;
  }

  return out;
}
