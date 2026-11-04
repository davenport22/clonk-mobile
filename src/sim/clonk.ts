import * as Fx from '../fx/fx';
import {
  CLONK_H,
  CLONK_W,
  CLONK_HP,
  LOAM_SPAN,
  LOAM_THICK,
  SHOVEL_COOLDOWN,
  SHOVEL_DAMAGE,
  SHOVEL_REACH,
  THROWN_DAMAGE,
  ELEVATOR_LEN,
  ELEVATOR_SPEED,
  FALL_HURT_SPEED,
  FLAG_RADIUS,
  FUSE_TICKS,
  MAX_BREATH,
} from '../data/config';
import {
  CELLS_PER_ITEM,
  CHUNK_KIND,
  CHUNK_KIND_COUNT,
  DIGGABLE,
  DIG_COST,
  MAT,
  SOLID,
  YIELD,
} from '../data/materials';
import { at, setCell } from './grid';
import { BTN, TOOL, type InputFrame } from './input';
import { columnSolid, grounded, inWater, moveX, moveY, setFlag, stepLooseBody } from './physics';
import {
  DYNAMITE_COST,
  canAfford,
  elevatorAt,
  payCost,
  placeElevator,
  placeFoundry,
  placeLorry,
} from './build';
import { hurt } from './explode';
import { lorryAt, push } from './lorry';
import { EF, EK, EV, addStock, despawn, pushEvent, spawn, type World } from './world';

export const HW = CLONK_W >> 1;
export const HH = CLONK_H >> 1;

const WALK = Fx.ratio(13, 10);
const AIR = Fx.ratio(11, 10);
const SWIM_X = Fx.ratio(9, 10);
const GRAV = Fx.ratio(22, 100);
const MAX_FALL = Fx.of(6);
const JUMP = Fx.ratio(-38, 10);
const CLIMB = Fx.ratio(-10, 10);
const SWIM_UP = Fx.ratio(-11, 10);
const WATER_GRAV = Fx.ratio(6, 100);
const MAX_SINK = Fx.of(1);

const DIG_RATE = 3;
/** Brush radius. Must exceed the clonk's half-extents or a dug shaft is too
 *  narrow to fall into and a dug tunnel is too low to walk through. */
const DIG_RADIUS = 6;
const DIG_RADIUS_SQ = DIG_RADIUS * DIG_RADIUS + 2;
const DIG_PROBE = 10;
/** Work units per unit of material hardness. Set so that digging through earth
 *  advances at roughly walking speed. */
const DIG_MULT = 8;

const STICK_DEAD = 20;

/** Ticks an untouched chunk survives on the ground (90 s). */
const ITEM_LIFETIME = 2700;

function stickDir(v: number): number {
  return v > STICK_DEAD ? 1 : v < -STICK_DEAD ? -1 : 0;
}

/**
 * Movement half of a clonk tick. Mutates only the clonk entity, never the
 * world, so the client-side predictor can replay it against the confirmed
 * world state without side effects (see game/predict.ts).
 */
export function moveClonk(w: World, id: number, inp: InputFrame): void {
  const e = w.ents;
  const p = e.player[id];
  const prevBtn = p >= 0 ? w.prevBtn[p] : 0;
  const prevDy = p >= 0 ? w.prevDy[p] : 0;

  const sx = stickDir(inp.dx);
  const sy = stickDir(inp.dy);
  // A player who is aiming faces where they aim; otherwise they face the way
  // they walk. Digging reads the same rule, so the shovel lands where the
  // crosshair is rather than where the legs are going.
  const aimX = stickDir(inp.ax);
  if (aimX !== 0) e.facing[id] = aimX;
  else if (sx !== 0) e.facing[id] = sx;

  const px = Fx.floor(e.x[id]);
  const py = Fx.floor(e.y[id]);

  const wet = inWater(w, id);
  const wasWet = (e.flags[id] & EF.IN_WATER) !== 0;
  if (wet !== wasWet) pushEvent(w, EV.SPLASH, px, py, wet ? 1 : 0, 0);
  setFlag(w, id, EF.IN_WATER, wet);

  // Breath. Submerged means the head is under, not the feet, so a clonk can
  // wade through a puddle without drowning.
  const headUnder = at(w, px, py - HH + 1) === MAT.WATER;
  if (headUnder) {
    if (e.breath[id] > 0) e.breath[id]--;
    else if ((w.tick & 7) === 0) hurt(w, id, 4, 255);
  } else if (e.breath[id] < MAX_BREATH) {
    e.breath[id] += 3;
    if (e.breath[id] > MAX_BREATH) e.breath[id] = MAX_BREATH;
  }
  if (e.kind[id] !== EK.CLONK) return;

  const lift = elevatorAt(w, px, py);
  let onGround = grounded(w, id, HW, HH);
  let climbing = false;

  if (lift >= 0 && !wet) {
    setFlag(w, id, EF.IN_LIFT, true);
    const top = Fx.floor(e.y[lift]);
    e.vx[id] = sx * (WALK >> 1);
    e.vy[id] = sy * ELEVATOR_SPEED * 3;
    if (py <= top && e.vy[id] < 0) e.vy[id] = 0;
    if (py >= top + ELEVATOR_LEN && e.vy[id] > 0) e.vy[id] = 0;
  } else if (wet) {
    setFlag(w, id, EF.IN_LIFT, false);
    e.vx[id] = sx * SWIM_X;
    e.vy[id] += WATER_GRAV;
    if (sy < 0) e.vy[id] = SWIM_UP;
    else if (sy > 0) e.vy[id] += WATER_GRAV * 2;
    if (e.vy[id] > MAX_SINK) e.vy[id] = MAX_SINK;
  } else {
    setFlag(w, id, EF.IN_LIFT, false);
    const wall = sx !== 0 && sx === e.facing[id] && columnSolid(w, px + sx * (HW + 1), py - HH + 1, py + HH - 1);

    if (sx !== 0) e.vx[id] = sx * (onGround ? WALK : AIR);
    else if (onGround) e.vx[id] = 0;

    // Shoving a lorry: no button, you just lean on it.
    if (sx !== 0 && onGround) {
      const lorry = lorryAt(w, px, py, HW, HH);
      if (lorry >= 0 && (Fx.floor(e.x[lorry]) - px) * sx > 0) {
        push(w, lorry, sx);
        e.vx[id] = Fx.mul(e.vx[id], Fx.ratio(62, 100));
      }
    }

    if (wall && sy < 0 && !onGround) {
      climbing = true;
      e.vy[id] = CLIMB;
    } else {
      e.vy[id] += GRAV;
      if (e.vy[id] > MAX_FALL) e.vy[id] = MAX_FALL;
    }

    const jumpEdge =
      (sy < 0 && prevDy > -STICK_DEAD) ||
      ((inp.buttons & BTN.JUMP) !== 0 && (prevBtn & BTN.JUMP) === 0);
    if (onGround && jumpEdge) {
      e.vy[id] = JUMP;
      onGround = false;
    }
  }
  setFlag(w, id, EF.CLIMBING, climbing);

  moveX(w, id, HW, HH, onGround ? 2 : 0);
  const impact = e.vy[id];
  const hitY = moveY(w, id, HW, HH);
  onGround = grounded(w, id, HW, HH);
  setFlag(w, id, EF.GROUNDED, onGround);

  // Landing hard hurts, which is what makes a deep shaft worth an elevator.
  if (hitY === 1 && impact > FALL_HURT_SPEED && !wet) {
    hurt(w, id, Fx.idiv((impact - FALL_HURT_SPEED) * 5, 65536), 255);
  }
}

/** One full clonk tick: movement, then the contextual action. */
export function stepClonk(w: World, id: number, inp: InputFrame): void {
  const e = w.ents;
  moveClonk(w, id, inp);

  const sx = stickDir(inp.dx);
  const sy = stickDir(inp.dy);
  const prevBtn = e.player[id] >= 0 ? w.prevBtn[e.player[id]] : 0;

  const actionHeld = (inp.buttons & BTN.ACTION) !== 0;
  const actionEdge = actionHeld && (prevBtn & BTN.ACTION) === 0;
  const throwEdge = (inp.buttons & BTN.THROW) !== 0 && (prevBtn & BTN.THROW) === 0;
  if (throwEdge) throwCarried(w, id, sx, sy);

  if (e.timer[id] > 0) e.timer[id]--;

  if (inp.sel === TOOL.SHOVEL) {
    if (actionHeld) {
      // Contextual, in order: hit whoever is in reach, dig what is in front,
      // and failing both, throw what is being carried.
      if (!swing(w, id, sx, sy, inp) && !dig(w, id, sx, sy, inp) && actionEdge) {
        throwCarried(w, id, sx, sy);
      }
    } else {
      e.aux[id] = 0;
      setFlag(w, id, EF.DIGGING, false);
    }
  } else {
    e.aux[id] = 0;
    setFlag(w, id, EF.DIGGING, false);
    if (actionEdge) {
      if (inp.sel === TOOL.FOUNDRY) placeFoundry(w, id);
      else if (inp.sel === TOOL.ELEVATOR) placeElevator(w, id);
      else if (inp.sel === TOOL.DYNAMITE) placeDynamite(w, id);
      else if (inp.sel === TOOL.LORRY) placeLorry(w, id);
      else if (inp.sel === TOOL.LOAM) placeLoam(w, id, sx, sy);
    }
  }

  pickup(w, id);
  deposit(w, id);
  carryFollow(w, id);
}

/** Returns true when there was something to dig. */
function dig(w: World, id: number, sx: number, sy: number, inp: InputFrame): boolean {
  const e = w.ents;
  const ax = stickDir(inp.ax);
  const ay = stickDir(inp.ay);
  // Aim first, stick second, facing last.
  let dx = ax !== 0 || ay !== 0 ? ax : sx;
  let dy = ax !== 0 || ay !== 0 ? ay : sy;
  if (dx === 0 && dy === 0) {
    dx = e.facing[id];
    dy = 0;
  }

  const cx = Fx.floor(e.x[id]);
  const cy = Fx.floor(e.y[id]);
  const ox = cx + dx * HW;
  const oy = cy + dy * HH;

  let tx = -1;
  let ty = -1;
  let tm: number = MAT.SKY;
  for (let r = 1; r <= DIG_PROBE; r++) {
    const qx = ox + dx * r;
    const qy = oy + dy * r;
    const m = at(w, qx, qy);
    if (DIGGABLE[m] === 1) {
      tx = qx;
      ty = qy;
      tm = m;
      break;
    }
  }
  if (tx < 0) {
    e.aux[id] = 0;
    setFlag(w, id, EF.DIGGING, false);
    return false;
  }

  setFlag(w, id, EF.DIGGING, true);
  e.aux[id] += DIG_RATE;
  if (e.aux[id] < DIG_COST[tm] * DIG_MULT) return true;
  e.aux[id] = 0;
  carve(w, id, tx, ty, tm);
  return true;
}

/**
 * A shovel in the face.
 *
 * Melee needs no weapon of its own: every clonk is already holding a tool with
 * a steel blade, and swinging it at whoever is in front is the oldest move in
 * Clonk. It takes priority over digging, so a fight does not turn into both
 * players quietly excavating past each other.
 */
function swing(w: World, id: number, sx: number, sy: number, inp: InputFrame): boolean {
  const e = w.ents;
  if (e.timer[id] > 0) return false;
  const ax = stickDir(inp.ax);
  const ay = stickDir(inp.ay);
  let dx = ax !== 0 || ay !== 0 ? ax : sx;
  let dy = ax !== 0 || ay !== 0 ? ay : sy;
  if (dx === 0 && dy === 0) {
    dx = e.facing[id];
    dy = 0;
  }
  const cx = Fx.floor(e.x[id]);
  const cy = Fx.floor(e.y[id]);
  const team = e.team[id];

  for (let i = 0; i < w.entCount; i++) {
    if (i === id || e.kind[i] !== EK.CLONK || e.team[i] === team) continue;
    const ox = Fx.floor(e.x[i]) - cx;
    const oy = Fx.floor(e.y[i]) - cy;
    if (Fx.ilen(ox, oy) > SHOVEL_REACH) continue;
    // Only what the swing is actually aimed at.
    if (dx !== 0 && ox * dx < -2) continue;
    if (dx === 0 && dy !== 0 && oy * dy < -2) continue;

    e.timer[id] = SHOVEL_COOLDOWN;
    setFlag(w, id, EF.DIGGING, true);
    e.vx[i] += dx * Fx.of(2);
    e.vy[i] -= Fx.of(1);
    pushEvent(w, EV.HIT, Fx.floor(e.x[i]), Fx.floor(e.y[i]), SHOVEL_DAMAGE, team);
    hurt(w, i, SHOVEL_DAMAGE, team);
    return true;
  }
  return false;
}

/**
 * Lays a loam bridge out in front of the clonk.
 *
 * Loam is what Clonk players reach for when the ground runs out: a chasm you
 * cannot jump, a shaft you need to cross, a waterfall you want to dam. It is
 * the one building material that goes exactly where you point it, and it turns
 * the landscape from an obstacle into something you negotiate with.
 */
function placeLoam(w: World, id: number, sx: number, sy: number): void {
  const e = w.ents;
  const team = e.team[id];
  if (w.stock[team * CHUNK_KIND_COUNT + CHUNK_KIND.LOAM] < 1) {
    pushEvent(w, EV.DENY, Fx.floor(e.x[id]), Fx.floor(e.y[id]), 0, 0);
    return;
  }
  let dx = sx;
  let dy = sy;
  if (dx === 0 && dy === 0) {
    dx = e.facing[id];
    dy = 0;
  }
  const cx = Fx.floor(e.x[id]) + dx * (HW + 2);
  const cy = Fx.floor(e.y[id]) + dy * (HH + 2) + (dy === 0 ? HH : 0);

  let placed = 0;
  for (let step = 0; step < LOAM_SPAN; step++) {
    const bx = cx + dx * step;
    const by = cy + dy * step;
    for (let t = 0; t < LOAM_THICK; t++) {
      // Thickness is laid across the direction of travel.
      const ox = dx === 0 ? t - (LOAM_THICK >> 1) : 0;
      const oy = dx === 0 ? 0 : t - (LOAM_THICK >> 1);
      const x = bx + ox;
      const y = by + oy;
      if (SOLID[at(w, x, y)] === 1) continue;
      setCell(w, x, y, MAT.LOAM);
      placed++;
    }
  }
  if (placed === 0) {
    pushEvent(w, EV.DENY, Fx.floor(e.x[id]), Fx.floor(e.y[id]), 1, 0);
    return;
  }
  addStock(w, team, CHUNK_KIND.LOAM, -1);
  pushEvent(w, EV.PLACE, cx, cy, CHUNK_KIND.LOAM, team);
}

function placeDynamite(w: World, id: number): void {
  const e = w.ents;
  const team = e.team[id];
  if (!canAfford(w, team, DYNAMITE_COST)) {
    pushEvent(w, EV.DENY, Fx.floor(e.x[id]), Fx.floor(e.y[id]), 0, 0);
    return;
  }
  payCost(w, team, DYNAMITE_COST);
  const d = spawn(w, EK.DYNAMITE);
  if (d < 0) return;
  e.team[d] = team;
  e.x[d] = e.x[id] + e.facing[id] * Fx.of(5);
  e.y[d] = e.y[id];
  e.vx[d] = e.facing[id] * Fx.ratio(6, 10);
  e.vy[d] = -Fx.ratio(4, 10);
  e.aux[d] = FUSE_TICKS;
  pushEvent(w, EV.FUSE, Fx.floor(e.x[d]), Fx.floor(e.y[d]), FUSE_TICKS, team);
}

function carve(w: World, id: number, tx: number, ty: number, material: number): void {
  for (let dy = -DIG_RADIUS; dy <= DIG_RADIUS; dy++) {
    for (let dx = -DIG_RADIUS; dx <= DIG_RADIUS; dx++) {
      if (dx * dx + dy * dy > DIG_RADIUS_SQ) continue;
      const x = tx + dx;
      const y = ty + dy;
      const m = at(w, x, y);
      if (DIGGABLE[m] !== 1) continue;
      setCell(w, x, y, MAT.SKY);
      const yk = YIELD[m];
      if (yk !== 255) w.digRemainder[yk]++;
    }
  }
  for (let k = 0; k < CHUNK_KIND_COUNT; k++) {
    const per = CELLS_PER_ITEM[k];
    if (per <= 0) continue;
    while (w.digRemainder[k] >= per) {
      w.digRemainder[k] -= per;
      spawnChunk(w, tx, ty, k);
    }
  }
  pushEvent(w, EV.DIG, tx, ty, material, w.ents.team[id]);
}

export function spawnChunk(w: World, x: number, y: number, kind: number): number {
  const id = spawn(w, EK.ITEM);
  if (id < 0) return -1;
  const e = w.ents;
  e.item[id] = kind;
  e.x[id] = Fx.of(x);
  e.y[id] = Fx.of(y);
  e.vx[id] = (w.rng.int(2049) - 1024) * 2;
  e.vy[id] = -Fx.ratio(8, 10);
  return id;
}

function pickup(w: World, id: number): void {
  const e = w.ents;
  if (e.carry[id] >= 0) return;
  const cx = Fx.floor(e.x[id]);
  const cy = Fx.floor(e.y[id]);
  for (let i = 0; i < w.entCount; i++) {
    if (e.kind[i] !== EK.ITEM) continue;
    // Nor a chunk still in flight: the thrower would catch its own throw
    // before it left arm's reach, and the target would catch it instead of
    // being hit by it.
    if ((e.flags[i] & (EF.CARRIED | EF.THROWN)) !== 0) continue;
    const dx = Fx.floor(e.x[i]) - cx;
    const dy = Fx.floor(e.y[i]) - cy;
    if (dx > 9 || dx < -9 || dy > 11 || dy < -11) continue;
    e.carry[id] = i;
    setFlag(w, i, EF.CARRIED, true);
    e.vx[i] = 0;
    e.vy[i] = 0;
    pushEvent(w, EV.PICKUP, cx, cy, e.item[i], e.team[id]);
    return;
  }
}

function deposit(w: World, id: number): void {
  const e = w.ents;
  const item = e.carry[id];
  if (item < 0) return;
  const team = e.team[id];
  const flag = w.teamFlag[team];
  if (flag < 0) return;
  const dx = Fx.floor(e.x[id]) - Fx.floor(e.x[flag]);
  const dy = Fx.floor(e.y[id]) - Fx.floor(e.y[flag]);
  if (Fx.ilen(dx, dy) > FLAG_RADIUS) return;

  const kind = e.item[item];
  if (kind === CHUNK_KIND.GOLD) w.gold[team] += 1;
  addStock(w, team, kind, 1);
  pushEvent(w, EV.DEPOSIT, Fx.floor(e.x[flag]), Fx.floor(e.y[flag]), kind, team);
  despawn(w, item);
  e.carry[id] = -1;
}

function throwCarried(w: World, id: number, sx: number, sy: number): void {
  const e = w.ents;
  const item = e.carry[id];
  if (item < 0) return;
  setFlag(w, item, EF.CARRIED, false);
  setFlag(w, item, EF.THROWN, true);
  e.aux2[item] = id + 1;
  const dir = sx !== 0 ? sx : e.facing[id];
  e.vx[item] = dir * Fx.of(3);
  e.vy[item] = sy > 0 ? Fx.of(1) : -Fx.of(2);
  e.carry[id] = -1;
  pushEvent(w, EV.DROP, Fx.floor(e.x[item]), Fx.floor(e.y[item]), e.item[item], e.team[id]);
}

/** Full health and lungs. Used at round start and on respawn. */
export function resetClonk(w: World, id: number): void {
  w.ents.hp[id] = CLONK_HP;
  w.ents.breath[id] = MAX_BREATH;
}

function carryFollow(w: World, id: number): void {
  const e = w.ents;
  const item = e.carry[id];
  if (item < 0) return;
  e.x[item] = e.x[id] + e.facing[id] * Fx.of(2);
  e.y[item] = e.y[id] - Fx.of(HH + 3);
  e.vx[item] = 0;
  e.vy[item] = 0;
}

/**
 * A chunk moving fast enough hurts whoever it lands on.
 *
 * Throwing a rock at someone is not a designed weapon so much as a consequence
 * of having rocks and arms, which is exactly why it belongs: half of Clonk's
 * fights are improvised out of whatever was being carried at the time.
 */
function thrownImpact(w: World, id: number): void {
  const e = w.ents;
  // Only a throw makes a projectile. Any chunk moving fast used to count, and
  // the fastest chunks in the game are the ones a clonk has just dug, falling
  // straight back down its own shaft - so digging through a seam killed the
  // digger with its own spoil.
  if ((e.flags[id] & EF.THROWN) === 0) return;
  const speed = Fx.abs(e.vx[id]) + Fx.abs(e.vy[id]);
  if (speed < Fx.of(2)) {
    setFlag(w, id, EF.THROWN, false);
    return;
  }
  const thrower = e.aux2[id] - 1;
  const x = Fx.floor(e.x[id]);
  const y = Fx.floor(e.y[id]);
  for (let i = 0; i < w.entCount; i++) {
    if (e.kind[i] !== EK.CLONK || i === thrower) continue;
    const dx = Fx.floor(e.x[i]) - x;
    const dy = Fx.floor(e.y[i]) - y;
    if (Fx.ilen(dx, dy) > 6) continue;
    let dmg = Fx.idiv(THROWN_DAMAGE * speed, Fx.of(5));
    if (dmg > THROWN_DAMAGE) dmg = THROWN_DAMAGE;
    e.vx[id] = Fx.mul(e.vx[id], -Fx.ratio(30, 100));
    e.vy[id] = -Fx.of(1);
    pushEvent(w, EV.HIT, Fx.floor(e.x[i]), Fx.floor(e.y[i]), dmg, 255);
    hurt(w, i, dmg, 255);
    setFlag(w, id, EF.THROWN, false);
    return;
  }
}

/** Loose chunk items lying in the world. */
export function stepItem(w: World, id: number): void {
  const e = w.ents;
  if ((e.flags[id] & EF.CARRIED) !== 0) {
    e.timer[id] = 0;
    return;
  }
  thrownImpact(w, id);
  // Abandoned chunks rot away, otherwise a long dig-heavy round exhausts the
  // entity pool and digging silently stops yielding.
  e.timer[id]++;
  if (e.timer[id] > ITEM_LIFETIME) {
    despawn(w, id);
    return;
  }
  stepLooseBody(w, id, 2, 2);
}
