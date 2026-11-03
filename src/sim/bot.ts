import * as Fx from '../fx/fx';
import { BOT_THINK, FLAG_RADIUS, GRID_H, GRID_W, MODE } from '../data/config';
import { CHUNK_KIND, DIGGABLE, MAT } from '../data/materials';
import { at } from './grid';
import { BTN, TOOL, type InputFrame } from './input';
import { EF, EK, type World } from './world';

/**
 * Bots.
 *
 * PRD C4 lists bot fill as a could-have and R9 names the reason it matters: a
 * multiplayer-only game with nobody online is unplayable, including for the
 * person who wrote it. A round you can always start is worth more than a
 * clever opponent, so this aims at competent rather than good.
 *
 * Everything here runs inside the tick and reads only world state, so bots are
 * as deterministic as any other input and travel through lockstep identically
 * on every client. They are not sent over the wire at all - each client
 * computes the same bot input from the same world.
 */

/** What a bot is currently trying to do. Stored in the clonk's aux2 slot. */
const JOB = {
  SEEK: 0,
  HAUL: 1,
  FIGHT: 2,
};

const REACH = 220;

function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** Nearest cell of a wanted material within a box, or -1. */
function findMaterial(w: World, cx: number, cy: number, want: number, radius: number): number {
  let best = -1;
  let bestD = radius * radius;
  const x0 = cx - radius < 1 ? 1 : cx - radius;
  const x1 = cx + radius >= GRID_W - 1 ? GRID_W - 2 : cx + radius;
  const y0 = cy - 20 < 1 ? 1 : cy - 20;
  const y1 = cy + radius >= GRID_H - 1 ? GRID_H - 2 : cy + radius;
  // Coarse scan: bots do not need the exact nearest cell, only a direction.
  for (let y = y0; y <= y1; y += 3) {
    for (let x = x0; x <= x1; x += 3) {
      if (w.mat[y * GRID_W + x] !== want) continue;
      const dx = x - cx;
      const dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = y * GRID_W + x;
      }
    }
  }
  return best;
}

function nearestEnemy(w: World, id: number): number {
  const e = w.ents;
  const team = e.team[id];
  const cx = Fx.floor(e.x[id]);
  const cy = Fx.floor(e.y[id]);
  let best = -1;
  let bestD = REACH * REACH;
  for (let i = 0; i < w.entCount; i++) {
    if (i === id || e.kind[i] !== EK.CLONK || e.team[i] === team) continue;
    const dx = Fx.floor(e.x[i]) - cx;
    const dy = Fx.floor(e.y[i]) - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Produces one bot's input for this tick.
 *
 * Deliberately written as "steer towards a target and hold dig": a bot that
 * paths properly would be a much larger piece of code and would still lose to
 * a person, while this one digs, hauls, banks gold and swings back when hit,
 * which is enough to make a round feel populated.
 */
export function botInput(w: World, player: number, out: InputFrame): InputFrame {
  out.dx = 0;
  out.dy = 0;
  out.ax = 0;
  out.ay = 0;
  out.buttons = 0;
  out.sel = TOOL.SHOVEL;

  const id = w.playerEnt[player];
  if (id < 0 || w.ents.kind[id] !== EK.CLONK) return out;

  const e = w.ents;
  const cx = Fx.floor(e.x[id]);
  const cy = Fx.floor(e.y[id]);
  const team = e.team[id];
  const flag = w.teamFlag[team];

  // Re-plan on a slow cadence, offset per player so four bots do not all think
  // on the same tick.
  const think = (w.tick + player * 5) % BOT_THINK === 0;
  let job = e.aux2[id];

  const enemy = nearestEnemy(w, id);
  const carrying = e.carry[id] >= 0;

  if (think) {
    if (w.mode === MODE.MELEE) {
      job = enemy >= 0 ? JOB.FIGHT : JOB.SEEK;
    } else if (carrying) {
      job = JOB.HAUL;
    } else if (enemy >= 0 && w.rng.chance(1, 6)) {
      job = JOB.FIGHT;
    } else {
      job = JOB.SEEK;
    }
    e.aux2[id] = job;
  }

  let tx = cx;
  let ty = cy;
  let dig = false;

  if (job === JOB.FIGHT && enemy >= 0) {
    tx = Fx.floor(e.x[enemy]);
    ty = Fx.floor(e.y[enemy]);
    // Close the distance, then hold the action down: in reach that is a swing,
    // out of reach it is digging through whatever is in the way.
    dig = true;
  } else if (job === JOB.HAUL && flag >= 0) {
    tx = Fx.floor(e.x[flag]);
    ty = Fx.floor(e.y[flag]);
    const dist = Fx.ilen(tx - cx, ty - cy);
    dig = dist > FLAG_RADIUS;
  } else {
    // Look for something worth digging, nearest first.
    let cell = findMaterial(w, cx, cy, MAT.GOLD, 150);
    if (cell < 0) cell = findMaterial(w, cx, cy, MAT.COAL, 120);
    if (cell < 0) cell = findMaterial(w, cx, cy, MAT.ORE, 120);
    if (cell < 0) cell = findMaterial(w, cx, cy, MAT.WOOD, 100);
    if (cell >= 0) {
      tx = cell % GRID_W;
      ty = Fx.idiv(cell, GRID_W);
      dig = true;
    } else {
      // Nothing in sight: dig downward and sideways to open new ground.
      tx = cx + (((w.tick + player * 97) >> 7) & 1 ? 40 : -40);
      ty = cy + 30;
      dig = true;
    }
  }

  const dx = tx - cx;
  const dy = ty - cy;

  out.dx = sign(dx) * 64;
  // Only steer vertically when it matters, or the bot refuses to walk along
  // level ground towards something slightly above it.
  if (dy > 6 || dy < -6) out.dy = sign(dy) * 64;
  // Aim at the target, which is what actually points the shovel.
  if (dx !== 0 || dy !== 0) {
    const len = Fx.ilen(dx, dy);
    if (len > 0) {
      out.ax = Fx.clamp(Fx.idiv(dx * 64, len), -64, 64);
      out.ay = Fx.clamp(Fx.idiv(dy * 64, len), -64, 64);
    }
  }

  // Jump at a wall it cannot climb, so it does not grind against cliffs.
  const ahead = cx + sign(dx) * 6;
  if (sign(dx) !== 0 && (e.flags[id] & EF.GROUNDED) !== 0) {
    const blocked = DIGGABLE[at(w, ahead, cy)] === 0 && at(w, ahead, cy) !== MAT.SKY;
    if (blocked || (dy < -10 && w.rng.chance(1, 4))) out.buttons |= BTN.JUMP;
  }

  if (dig) out.buttons |= BTN.ACTION;

  // Spend loam on a gap it is about to walk into, which is most of what makes
  // a bot look like it understands the terrain.
  if (
    w.mode !== MODE.MELEE &&
    w.stock[team * 6 + CHUNK_KIND.LOAM] > 0 &&
    (e.flags[id] & EF.GROUNDED) !== 0 &&
    at(w, ahead + sign(dx) * 6, cy + 8) === MAT.SKY &&
    at(w, ahead + sign(dx) * 6, cy + 14) === MAT.SKY
  ) {
    out.sel = TOOL.LOAM;
    out.buttons |= BTN.ACTION;
  }

  return out;
}
