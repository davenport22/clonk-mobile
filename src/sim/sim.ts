import * as Fx from '../fx/fx';
import {
  FOUNDRY_PERIOD,
  GOLD_TO_WIN,
  KILLS_TO_WIN,
  MAX_PLAYERS,
  MODE,
  ROUND_TICKS,
} from '../data/config';
import { CHUNK_KIND } from '../data/materials';
import { botInput } from './bot';
import { HH, resetClonk, stepClonk, stepItem } from './clonk';
import { explode } from './explode';
import { stepLorry } from './lorry';
import { generate, type Spawn } from './gen';
import { markAllChunks, updateMaterial } from './grid';
import { NEUTRAL, copyInput, type InputFrame } from './input';
import { stepLooseBody } from './physics';
import { EK, EV, addStock, createWorld, despawn, pushEvent, spawn, teamStock, type World } from './world';

export interface RoundOpts {
  seed: number;
  playerCount: number;
  teamCount: number;
  goldToWin?: number;
  /** One of MODE. Defaults to Gold Rush. */
  mode?: number;
  killsToWin?: number;
  /** Player slots the simulation drives itself. */
  bots?: boolean[];
}

export interface RoundInfo {
  world: World;
  spawns: Spawn[];
}

export function startRound(opts: RoundOpts): RoundInfo {
  const teamCount = Fx.clamp(opts.teamCount, 1, 4);
  const w = createWorld(opts.seed, opts.playerCount, teamCount);
  w.goldToWin = opts.goldToWin ?? GOLD_TO_WIN;
  w.mode = opts.mode ?? MODE.GOLD;
  w.killsToWin = opts.killsToWin ?? KILLS_TO_WIN;
  if (opts.bots) {
    for (let p = 0; p < opts.playerCount; p++) w.isBot[p] = opts.bots[p] ? 1 : 0;
  }

  const gen = generate(w, teamCount);

  for (let t = 0; t < teamCount; t++) {
    const sp = gen.spawns[t];
    const flag = spawn(w, EK.FLAG);
    w.teamFlag[t] = flag;
    w.ents.team[flag] = t;
    w.ents.x[flag] = Fx.of(sp.x);
    w.ents.y[flag] = Fx.of(sp.y - 13);
  }

  for (let p = 0; p < opts.playerCount; p++) {
    const team = p % teamCount;
    const sp = gen.spawns[team];
    const id = spawn(w, EK.CLONK);
    w.playerEnt[p] = id;
    w.playerTeam[p] = team;
    w.playerAlive[p] = 1;
    w.ents.team[id] = team;
    w.ents.player[id] = p;
    const off = Fx.idiv(p, teamCount) * 9 - 4;
    w.ents.x[id] = Fx.of(sp.x + off);
    w.ents.y[id] = Fx.of(sp.y - HH - 2);
    resetClonk(w, id);
  }

  markAllChunks(w);
  return { world: w, spawns: gen.spawns };
}

/** Advances the world by exactly one tick. The only mutator of world state. */
export function tickWorld(w: World, inputs: InputFrame[]): void {
  w.events.length = 0;
  const e = w.ents;

  // Resolve what each player actually does this tick. A bot's input is
  // computed from world state rather than received, so every client derives the
  // same frame from the same world: bots cost no bandwidth and stay in lockstep
  // for free.
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (p < w.playerCount && w.isBot[p] === 1) botInput(w, p, w.frames[p]);
    else copyInput(inputs[p] ?? NEUTRAL, w.frames[p]);
  }

  if (w.phase === 0) {
    for (let p = 0; p < w.playerCount; p++) {
      const id = w.playerEnt[p];
      if (id < 0 || e.kind[id] !== EK.CLONK) continue;
      stepClonk(w, id, w.frames[p]);
    }

    for (let i = 0; i < w.entCount; i++) {
      if (e.kind[i] === EK.ITEM) stepItem(w, i);
      else if (e.kind[i] === EK.FOUNDRY) stepFoundry(w, i);
      else if (e.kind[i] === EK.DYNAMITE) stepDynamite(w, i);
      else if (e.kind[i] === EK.LORRY) stepLorry(w, i);
    }

    respawnPlayers(w);
  }

  updateMaterial(w);

  if (w.phase === 0) checkRoundEnd(w);

  for (let p = 0; p < MAX_PLAYERS; p++) {
    w.prevBtn[p] = w.frames[p].buttons;
    w.prevDy[p] = w.frames[p].dy;
  }

  w.tick++;
}

/** A lit charge falls, rolls and goes off. */
function stepDynamite(w: World, id: number): void {
  const e = w.ents;
  stepLooseBody(w, id, 2, 3);
  e.aux[id]--;
  if (e.aux[id] > 0) return;
  const x = Fx.floor(e.x[id]);
  const y = Fx.floor(e.y[id]);
  const team = e.team[id];
  despawn(w, id);
  explode(w, x, y, team);
}

/**
 * A dead player gets a new clonk at their flag. Elimination inside a 15 minute
 * round would leave someone watching, which is worse than a short penalty.
 */
function respawnPlayers(w: World): void {
  for (let p = 0; p < w.playerCount; p++) {
    if (w.playerEnt[p] >= 0) continue;
    if (w.respawn[p] > 0) {
      w.respawn[p]--;
      continue;
    }
    const team = w.playerTeam[p];
    const flag = w.teamFlag[team];
    if (flag < 0) continue;
    const id = spawn(w, EK.CLONK);
    if (id < 0) continue;
    w.playerEnt[p] = id;
    w.playerAlive[p] = 1;
    w.ents.team[id] = team;
    w.ents.player[id] = p;
    w.ents.x[id] = w.ents.x[flag];
    w.ents.y[id] = w.ents.y[flag] - Fx.of(2);
    resetClonk(w, id);
    pushEvent(w, EV.SPAWN, Fx.floor(w.ents.x[id]), Fx.floor(w.ents.y[id]), team, p);
  }
}

function stepFoundry(w: World, id: number): void {
  const e = w.ents;
  e.timer[id]++;
  if (e.timer[id] < FOUNDRY_PERIOD) return;
  e.timer[id] = 0;
  const team = e.team[id];
  if (teamStock(w, team, CHUNK_KIND.ORE) < 1 || teamStock(w, team, CHUNK_KIND.COAL) < 1) return;
  addStock(w, team, CHUNK_KIND.ORE, -1);
  addStock(w, team, CHUNK_KIND.COAL, -1);
  addStock(w, team, CHUNK_KIND.METAL, 1);
  pushEvent(w, EV.BUILD, Fx.floor(e.x[id]), Fx.floor(e.y[id]), EK.FOUNDRY, team);
}

/**
 * Ends the round when the mode says so.
 *
 * Both modes also end on the clock with the leader winning, because a fifteen
 * minute round that can run long is not a fifteen minute round (PRD principle
 * 3), and a draw is a better outcome than an open-ended one.
 */
function checkRoundEnd(w: World): void {
  const score = w.mode === MODE.MELEE ? w.kills : w.gold;
  const target = w.mode === MODE.MELEE ? w.killsToWin : w.goldToWin;

  for (let t = 0; t < w.teamCount; t++) {
    if (score[t] >= target) {
      endRound(w, t);
      return;
    }
  }
  if (w.tick + 1 >= ROUND_TICKS) {
    let best = -1;
    let bestScore = -1;
    let tie = false;
    for (let t = 0; t < w.teamCount; t++) {
      if (score[t] > bestScore) {
        bestScore = score[t];
        best = t;
        tie = false;
      } else if (score[t] === bestScore) {
        tie = true;
      }
    }
    endRound(w, tie ? -1 : best);
  }
}

function endRound(w: World, winner: number): void {
  w.phase = 1;
  w.winner = winner;
  pushEvent(w, EV.OVER, 0, 0, winner, 0);
}

export function ticksRemaining(w: World): number {
  return ROUND_TICKS - w.tick > 0 ? ROUND_TICKS - w.tick : 0;
}
