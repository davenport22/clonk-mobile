import * as Fx from '../fx/fx';
import { moveClonk } from '../sim/clonk';
import type { InputFrame } from '../sim/input';
import { EK, type World } from '../sim/world';

/**
 * ADR-002: local movement prediction without world rollback.
 *
 * The confirmed simulation runs on relayed input, which is one network trip
 * behind the player's thumb. Rolling the whole world back is not an option: the
 * material grid is half a megabyte and snapshotting it per tick would cost more
 * than the entire frame budget. So only the local clonk's kinematics are
 * replayed forward against the confirmed world: the same movement code, the same
 * fixed-point math, run on a saved-and-restored copy of the entity.
 *
 * Consequence: walking, jumping and climbing feel immediate, while the world's
 * response to digging arrives one trip later. That is the honest trade for a
 * mutable-terrain lockstep game, and it is why the dig brush is generous.
 */
export interface Predicted {
  x: number;
  y: number;
  valid: boolean;
}

const saved = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  flags: 0,
  facing: 0,
  prevBtn: 0,
  prevDy: 0,
};

export function predictLocal(
  w: World,
  id: number,
  inp: InputFrame,
  ticks: number,
  out: Predicted,
): Predicted {
  out.valid = false;
  if (id < 0 || w.ents.kind[id] !== EK.CLONK || w.phase !== 0) return out;

  const e = w.ents;
  const p = e.player[id];
  saved.x = e.x[id];
  saved.y = e.y[id];
  saved.vx = e.vx[id];
  saved.vy = e.vy[id];
  saved.flags = e.flags[id];
  saved.facing = e.facing[id];
  saved.prevBtn = p >= 0 ? w.prevBtn[p] : 0;
  saved.prevDy = p >= 0 ? w.prevDy[p] : 0;

  const wasSilent = w.silent;
  w.silent = true;
  const n = ticks < 0 ? 0 : ticks > 8 ? 8 : ticks;
  for (let i = 0; i < n; i++) {
    moveClonk(w, id, inp);
    // Edge-triggered inputs must not re-fire on every replayed tick.
    if (p >= 0) {
      w.prevBtn[p] = inp.buttons;
      w.prevDy[p] = inp.dy;
    }
  }
  const px = Fx.floor(e.x[id]) + Fx.frac(e.x[id]) / Fx.ONE;
  const py = Fx.floor(e.y[id]) + Fx.frac(e.y[id]) / Fx.ONE;
  w.silent = wasSilent;

  e.x[id] = saved.x;
  e.y[id] = saved.y;
  e.vx[id] = saved.vx;
  e.vy[id] = saved.vy;
  e.flags[id] = saved.flags;
  e.facing[id] = saved.facing;
  if (p >= 0) {
    w.prevBtn[p] = saved.prevBtn;
    w.prevDy[p] = saved.prevDy;
  }

  out.x = px;
  out.y = py;
  out.valid = n > 0;
  return out;
}
