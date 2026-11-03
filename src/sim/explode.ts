import * as Fx from '../fx/fx';
import {
  BLAST_HURT_RADIUS,
  BLAST_RADIUS,
  RESPAWN_TICKS,
  FOUNDRY_H,
  FOUNDRY_W,
  GRID_H,
  GRID_W,
} from '../data/config';
import { BLAST_PROOF, CELLS_PER_ITEM, CHUNK_KIND_COUNT, DIGGABLE, MAT, YIELD } from '../data/materials';
import { at, markCell, setCell } from './grid';
import { EK, EV, despawn, pushEvent, type World } from './world';

/** Radius of protected ground around a flag, in cells. */
const FLAG_FOOTING = 14;

/**
 * Terrain-reshaping explosion.
 *
 * This is the mechanic PRD 5.3 calls the interference edge: collapsing someone
 * else's tunnel, flooding their shaft, or blowing their foundry off the hill.
 * Everything about it is integer and order-independent-by-construction, because
 * it runs inside a tick like anything else.
 */
export function explode(w: World, cx: number, cy: number, team: number): void {
  const r = BLAST_RADIUS;
  const rSq = r * r;

  // Flags are indestructible, and so is the ground they stand on. Without this
  // a charge under a flag leaves it hanging in mid air over a crater, and a
  // team can be locked out of its own deposit point.
  const flagX: number[] = [];
  const flagY: number[] = [];
  for (let t = 0; t < w.teamCount; t++) {
    const f = w.teamFlag[t];
    if (f < 0 || w.ents.kind[f] !== EK.FLAG) continue;
    flagX.push(Fx.floor(w.ents.x[f]));
    flagY.push(Fx.floor(w.ents.y[f]) + 12);
  }
  const nearFlag = (x: number, y: number): boolean => {
    for (let i = 0; i < flagX.length; i++) {
      const dx = x - flagX[i];
      const dy = y - flagY[i];
      if (dx * dx + dy * dy < FLAG_FOOTING * FLAG_FOOTING) return true;
    }
    return false;
  };

  // 1. Remove material. Bedrock survives, so the world keeps its floor.
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 1 || y >= GRID_H - 1) continue;
    for (let dx = -r; dx <= r; dx++) {
      const d = dx * dx + dy * dy;
      if (d > rSq) continue;
      const x = cx + dx;
      if (x < 1 || x >= GRID_W - 1) continue;
      const m = at(w, x, y);
      if (m === MAT.SKY || m === MAT.WATER || BLAST_PROOF[m] === 1) continue;
      // The rim is chewed rather than cut, which reads as an explosion instead
      // of a stamped circle.
      if (d > rSq - r * 3 && ((x * 7 + y * 13 + w.tick) & 3) === 0) continue;
      if (nearFlag(x, y)) continue;
      if (DIGGABLE[m] === 1) {
        const yk = YIELD[m];
        if (yk !== 255) w.digRemainder[yk]++;
      }
      setCell(w, x, y, MAT.SKY);
    }
  }

  // Blasted-out veins still pay, at the usual rate.
  for (let k = 0; k < CHUNK_KIND_COUNT; k++) {
    const per = CELLS_PER_ITEM[k];
    if (per <= 0) continue;
    while (w.digRemainder[k] >= per) {
      w.digRemainder[k] -= per;
      const id = spawnBlastChunk(w, cx, cy, k);
      if (id < 0) break;
    }
  }

  // 2. Throw and hurt everything nearby.
  const e = w.ents;
  for (let i = 0; i < w.entCount; i++) {
    const kind = e.kind[i];
    if (kind === EK.NONE || kind === EK.FLAG) continue;
    const ex = Fx.floor(e.x[i]);
    const ey = Fx.floor(e.y[i]);
    const dist = Fx.ilen(ex - cx, ey - cy);
    if (dist > BLAST_HURT_RADIUS) continue;

    if (kind === EK.FOUNDRY || kind === EK.ELEVATOR) {
      if (dist <= r) wreck(w, i);
      continue;
    }

    // Push away from the blast, hardest at the centre.
    const power = BLAST_HURT_RADIUS - dist;
    const dx = ex - cx;
    const dy = ey - cy;
    const len = dist < 1 ? 1 : dist;
    e.vx[i] += Fx.idiv(dx * power * 6553, len * 100);
    e.vy[i] += Fx.idiv((dy - 4) * power * 6553, len * 100);

    if (kind === EK.CLONK) {
      const dmg = Fx.idiv(power * 100, BLAST_HURT_RADIUS);
      hurt(w, i, dmg, team);
    } else if (kind === EK.DYNAMITE) {
      // Chain reaction: a short fuse, not an immediate detonation, so a line of
      // charges goes off as a rippling sequence.
      if (e.aux[i] > 8) e.aux[i] = 8;
    }
  }

  pushEvent(w, EV.EXPLODE, cx, cy, r, team);
}

function spawnBlastChunk(w: World, x: number, y: number, kind: number): number {
  // Local import would be circular; chunk spawning is simple enough to inline.
  const e = w.ents;
  for (let i = 0; i < e.kind.length; i++) {
    if (e.kind[i] !== EK.NONE) continue;
    e.kind[i] = EK.ITEM;
    e.item[i] = kind;
    e.x[i] = Fx.of(x + (w.rng.int(9) - 4));
    e.y[i] = Fx.of(y - 2);
    e.vx[i] = (w.rng.int(4097) - 2048) * 3;
    e.vy[i] = -Fx.of(2) - w.rng.int(65536);
    e.carry[i] = -1;
    e.timer[i] = 0;
    e.flags[i] = 0;
    e.facing[i] = 1;
    e.team[i] = 0;
    e.player[i] = -1;
    e.aux[i] = 0;
    e.hp[i] = 0;
    e.breath[i] = 0;
    if (i >= w.entCount) w.entCount = i + 1;
    return i;
  }
  return -1;
}

/** Destroys a structure, clearing the cells it stamped into the terrain. */
export function wreck(w: World, id: number): void {
  const e = w.ents;
  const kind = e.kind[id];
  const cx = Fx.floor(e.x[id]);
  const cy = Fx.floor(e.y[id]);
  if (kind === EK.FOUNDRY) {
    const hw = FOUNDRY_W >> 1;
    const hh = FOUNDRY_H >> 1;
    for (let y = cy - hh - 1; y <= cy + hh + 1; y++) {
      for (let x = cx - hw - 1; x <= cx + hw + 1; x++) {
        if (at(w, x, y) === MAT.STRUCT) setCell(w, x, y, MAT.SKY);
      }
    }
  }
  pushEvent(w, EV.WRECK, cx, cy, kind, e.team[id]);
  despawn(w, id);
  markCell(w, cx, cy);
}

/** Applies damage to a clonk, killing it if the health runs out. */
export function hurt(w: World, id: number, amount: number, byTeam: number): void {
  const e = w.ents;
  if (e.kind[id] !== EK.CLONK || amount <= 0) return;
  e.hp[id] -= amount;
  pushEvent(w, EV.HURT, Fx.floor(e.x[id]), Fx.floor(e.y[id]), amount, e.team[id]);
  if (e.hp[id] > 0) return;

  // Death: whatever it was carrying is dropped where it fell, which is half the
  // reason blowing up a hauler is worth doing.
  const carried = e.carry[id];
  if (carried >= 0) {
    e.flags[carried] &= ~4;
    e.vy[carried] = -Fx.of(1);
    e.carry[id] = -1;
  }
  // Credit the kill, unless the world did it (drowning, a long fall) or the
  // clonk managed it to itself.
  if (byTeam < w.teamCount && byTeam !== e.team[id]) w.kills[byTeam] += 1;
  const p = e.player[id];
  pushEvent(w, EV.DIE, Fx.floor(e.x[id]), Fx.floor(e.y[id]), e.team[id], byTeam);
  despawn(w, id);
  if (p >= 0) {
    w.playerEnt[p] = -1;
    w.playerAlive[p] = 0;
    w.respawn[p] = RESPAWN_TICKS;
  }
}
