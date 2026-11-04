import {
  CHUNK_COUNT,
  GRID_H,
  GRID_W,
  GOLD_TO_WIN,
  MAX_ENTITIES,
  MAX_PLAYERS,
  MAX_TEAMS,
} from '../data/config';
import { CHUNK_KIND_COUNT } from '../data/materials';
import { makeInput, type InputFrame } from './input';
import { Rng } from './rng';

export const EK = {
  NONE: 0,
  CLONK: 1,
  ITEM: 2,
  FLAG: 3,
  FOUNDRY: 4,
  ELEVATOR: 5,
  DYNAMITE: 6,
  LORRY: 7,
} as const;

export const EF = {
  GROUNDED: 1,
  IN_WATER: 2,
  CARRIED: 4,
  DIGGING: 8,
  CLIMBING: 16,
  IN_LIFT: 32,
  /** A chunk in flight from a throw; its thrower is in aux2, plus one. */
  THROWN: 64,
};

/** Render-side effect events. Deterministically produced, drained every tick. */
export const EV = {
  DIG: 1,
  DEPOSIT: 2,
  BUILD: 3,
  SPLASH: 4,
  PICKUP: 5,
  DROP: 6,
  DENY: 7,
  OVER: 8,
  EXPLODE: 9,
  HURT: 10,
  DIE: 11,
  SPAWN: 12,
  FUSE: 13,
  WRECK: 14,
  LOAD: 15,
  UNLOAD: 16,
  HIT: 17,
  PLACE: 18,
};

export interface Entities {
  kind: Uint8Array;
  x: Int32Array; // Fx pixels
  y: Int32Array; // Fx pixels
  vx: Int32Array;
  vy: Int32Array;
  team: Uint8Array;
  player: Int8Array;
  item: Uint8Array; // chunk kind for ITEM
  carry: Int32Array; // entity id being carried, or -1
  timer: Int32Array;
  aux: Int32Array; // dig progress, foundry cycle, elevator top (Fx)
  /** Second scratch slot: a bot's current job, mostly. */
  aux2: Int32Array;
  facing: Int8Array;
  flags: Uint8Array;
  hp: Int32Array;
  breath: Int32Array;
}

export interface World {
  mat: Uint8Array;
  chunkDirty: Uint8Array;
  /** Tick a chunk's material last changed. Read by the renderer to decide which
   *  texture regions to re-upload; never read by the simulation. */
  chunkStamp: Int32Array;
  dirtyQueue: Int32Array;
  dirtyHead: number;
  dirtyTail: number;

  rng: Rng;
  seed: number;
  tick: number;
  /** 0 = playing, 1 = round over. */
  phase: number;
  winner: number;

  playerCount: number;
  teamCount: number;
  playerEnt: Int32Array;
  playerTeam: Uint8Array;
  playerAlive: Uint8Array;
  /** Ticks until a dead player's next clonk appears, or 0. */
  respawn: Int32Array;
  /** Previous frame's buttons / stick-Y per player, for edge detection. */
  prevBtn: Uint8Array;
  prevDy: Int8Array;

  teamFlag: Int32Array;
  stock: Int32Array;
  gold: Int32Array;
  /** Kills per team, which is the score in Melee. */
  kills: Int32Array;
  /** One of MODE. Decides what ends the round. */
  mode: number;
  killsToWin: number;
  /** Per lorry, how many chunks of each kind it holds. */
  lorryStore: Int32Array;
  /** Players driven by the simulation itself rather than by a person. */
  isBot: Uint8Array;
  goldToWin: number;
  digRemainder: Int32Array;

  ents: Entities;
  entCount: number;

  events: number[];
  /** Set while the client predicts local movement: suppresses render events.
   *  Never true during a real tick, so it stays out of the state hash. */
  silent: boolean;
  /**
   * Scratch: the input frame actually applied to each player this tick, which
   * is the received frame for a person and a computed one for a bot. Rewritten
   * every tick before it is read, so it carries no state between ticks and
   * stays out of the hash.
   */
  frames: InputFrame[];
}

function makeEntities(): Entities {
  return {
    kind: new Uint8Array(MAX_ENTITIES),
    x: new Int32Array(MAX_ENTITIES),
    y: new Int32Array(MAX_ENTITIES),
    vx: new Int32Array(MAX_ENTITIES),
    vy: new Int32Array(MAX_ENTITIES),
    team: new Uint8Array(MAX_ENTITIES),
    player: new Int8Array(MAX_ENTITIES),
    item: new Uint8Array(MAX_ENTITIES),
    carry: new Int32Array(MAX_ENTITIES).fill(-1),
    timer: new Int32Array(MAX_ENTITIES),
    aux: new Int32Array(MAX_ENTITIES),
    aux2: new Int32Array(MAX_ENTITIES),
    facing: new Int8Array(MAX_ENTITIES).fill(1),
    flags: new Uint8Array(MAX_ENTITIES),
    hp: new Int32Array(MAX_ENTITIES),
    breath: new Int32Array(MAX_ENTITIES),
  };
}

export function createWorld(seed: number, playerCount: number, teamCount: number): World {
  const w: World = {
    mat: new Uint8Array(GRID_W * GRID_H),
    chunkDirty: new Uint8Array(CHUNK_COUNT),
    chunkStamp: new Int32Array(CHUNK_COUNT).fill(-1),
    dirtyQueue: new Int32Array(CHUNK_COUNT + 1),
    dirtyHead: 0,
    dirtyTail: 0,

    rng: new Rng(seed),
    seed: seed | 0,
    tick: 0,
    phase: 0,
    winner: -1,

    playerCount,
    teamCount,
    playerEnt: new Int32Array(MAX_PLAYERS).fill(-1),
    playerTeam: new Uint8Array(MAX_PLAYERS),
    playerAlive: new Uint8Array(MAX_PLAYERS),
    respawn: new Int32Array(MAX_PLAYERS),
    prevBtn: new Uint8Array(MAX_PLAYERS),
    prevDy: new Int8Array(MAX_PLAYERS),

    teamFlag: new Int32Array(MAX_TEAMS).fill(-1),
    stock: new Int32Array(MAX_TEAMS * CHUNK_KIND_COUNT),
    gold: new Int32Array(MAX_TEAMS),
    kills: new Int32Array(MAX_TEAMS),
    mode: 0,
    killsToWin: 12,
    lorryStore: new Int32Array(MAX_ENTITIES * CHUNK_KIND_COUNT),
    isBot: new Uint8Array(MAX_PLAYERS),
    goldToWin: GOLD_TO_WIN,
    digRemainder: new Int32Array(CHUNK_KIND_COUNT),

    ents: makeEntities(),
    entCount: 0,

    events: [],
    silent: false,
    frames: [],
  };
  for (let p = 0; p < MAX_PLAYERS; p++) w.frames.push(makeInput());
  return w;
}

/** Allocate an entity slot. Lowest free id wins, so allocation order is a pure
 *  function of simulation history (PRD 6.3 rule 4). */
export function spawn(w: World, kind: number): number {
  const k = w.ents.kind;
  for (let i = 0; i < MAX_ENTITIES; i++) {
    if (k[i] === EK.NONE) {
      const e = w.ents;
      k[i] = kind;
      e.x[i] = 0;
      e.y[i] = 0;
      e.vx[i] = 0;
      e.vy[i] = 0;
      e.team[i] = 0;
      e.player[i] = -1;
      e.item[i] = 0;
      e.carry[i] = -1;
      e.timer[i] = 0;
      e.aux[i] = 0;
      e.aux2[i] = 0;
      e.facing[i] = 1;
      e.flags[i] = 0;
      e.hp[i] = 0;
      e.breath[i] = 0;
      for (let k = 0; k < CHUNK_KIND_COUNT; k++) w.lorryStore[i * CHUNK_KIND_COUNT + k] = 0;
      if (i >= w.entCount) w.entCount = i + 1;
      return i;
    }
  }
  return -1;
}

export function despawn(w: World, id: number): void {
  if (id < 0) return;
  w.ents.kind[id] = EK.NONE;
  w.ents.carry[id] = -1;
  while (w.entCount > 0 && w.ents.kind[w.entCount - 1] === EK.NONE) w.entCount--;
}

export function pushEvent(w: World, type: number, x: number, y: number, a: number, b: number): void {
  if (w.silent || w.events.length > 512) return;
  w.events.push(type, x, y, a, b);
}

export function teamStock(w: World, team: number, kind: number): number {
  return w.stock[team * CHUNK_KIND_COUNT + kind];
}

export function addStock(w: World, team: number, kind: number, n: number): void {
  w.stock[team * CHUNK_KIND_COUNT + kind] += n;
}

/** How much a lorry is carrying, in total. */
export function lorryLoad(w: World, id: number): number {
  let n = 0;
  for (let k = 0; k < CHUNK_KIND_COUNT; k++) n += w.lorryStore[id * CHUNK_KIND_COUNT + k];
  return n;
}
