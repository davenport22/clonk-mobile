import { CHUNK_COUNT, GRID_H, GRID_W, MAX_ENTITIES, MAX_PLAYERS, MAX_TEAMS } from '../data/config';
import { CHUNK_KIND_COUNT } from '../data/materials';
import { createWorld, type World } from './world';

const MAGIC = 0x554e4431; // "UND1"

/**
 * Full world serialisation, used for the desync resync path (PRD 6.4). The
 * material grid is run-length encoded; everything else is copied raw.
 */
export function serialize(w: World): Uint8Array {
  const runs: number[] = [];
  let cur = w.mat[0];
  let len = 1;
  for (let i = 1; i < w.mat.length; i++) {
    const m = w.mat[i];
    if (m === cur && len < 0xffff) {
      len++;
    } else {
      runs.push(cur, len);
      cur = m;
      len = 1;
    }
  }
  runs.push(cur, len);

  const scalarBytes = 80;
  const arrays =
    MAX_TEAMS * 4 + // gold
    MAX_TEAMS * CHUNK_KIND_COUNT * 4 + // stock
    CHUNK_KIND_COUNT * 4 + // digRemainder
    MAX_TEAMS * 4 + // teamFlag
    MAX_PLAYERS * 4 + // playerEnt
    MAX_PLAYERS * 4 + // playerTeam, playerAlive, prevBtn, prevDy
    MAX_PLAYERS * 4 + // respawn
    MAX_ENTITIES * 46 + // entity SoA
    MAX_TEAMS * 4 + // kills
    MAX_ENTITIES * CHUNK_KIND_COUNT * 4 + // lorry contents
    MAX_PLAYERS + // isBot
    CHUNK_COUNT + // chunkDirty
    (CHUNK_COUNT + 1) * 2; // dirtyQueue as u16
  const runBytes = (runs.length >> 1) * 3;
  const buf = new ArrayBuffer(scalarBytes + arrays + 4 + runBytes);
  const v = new DataView(buf);
  let o = 0;

  v.setUint32(o, MAGIC);
  o += 4;
  v.setUint32(o, w.tick);
  o += 4;
  v.setInt32(o, w.seed);
  o += 4;
  v.setInt32(o, w.rng.s);
  o += 4;
  v.setUint8(o++, w.phase);
  v.setInt8(o++, w.winner);
  v.setUint8(o++, w.playerCount);
  v.setUint8(o++, w.teamCount);
  v.setUint16(o, w.goldToWin);
  o += 2;
  v.setUint8(o++, w.mode);
  v.setUint16(o, w.killsToWin);
  o += 2;
  v.setUint16(o, w.entCount);
  o += 2;
  v.setUint16(o, w.dirtyHead);
  o += 2;
  v.setUint16(o, w.dirtyTail);
  o += 2;
  o = scalarBytes;

  const wi = (a: Int32Array | Uint8Array | Int8Array, bytes: 1 | 4, signed: boolean) => {
    for (let i = 0; i < a.length; i++) {
      if (bytes === 4) v.setInt32(o, a[i]);
      else if (signed) v.setInt8(o, a[i]);
      else v.setUint8(o, a[i]);
      o += bytes;
    }
  };

  wi(w.gold, 4, true);
  wi(w.kills, 4, true);
  wi(w.lorryStore, 4, true);
  wi(w.isBot, 1, false);
  wi(w.stock, 4, true);
  wi(w.digRemainder, 4, true);
  wi(w.teamFlag, 4, true);
  wi(w.playerEnt, 4, true);
  wi(w.respawn, 4, true);
  wi(w.playerTeam, 1, false);
  wi(w.playerAlive, 1, false);
  wi(w.prevBtn, 1, false);
  wi(w.prevDy, 1, true);

  const e = w.ents;
  wi(e.kind, 1, false);
  wi(e.x, 4, true);
  wi(e.y, 4, true);
  wi(e.vx, 4, true);
  wi(e.vy, 4, true);
  wi(e.team, 1, false);
  wi(e.player, 1, true);
  wi(e.item, 1, false);
  wi(e.carry, 4, true);
  wi(e.timer, 4, true);
  wi(e.aux, 4, true);
  wi(e.aux2, 4, true);
  wi(e.facing, 1, true);
  wi(e.flags, 1, false);
  wi(e.hp, 4, true);
  wi(e.breath, 4, true);

  // Pending material work is part of the state: two peers with identical
  // material but different work queues process falling sand in a different
  // order and diverge. A resync has to restore scheduling too.
  wi(w.chunkDirty, 1, false);
  for (let i = 0; i < w.dirtyQueue.length; i++) {
    v.setUint16(o, w.dirtyQueue[i] & 0xffff);
    o += 2;
  }

  v.setUint32(o, runs.length >> 1);
  o += 4;
  for (let i = 0; i < runs.length; i += 2) {
    v.setUint8(o, runs[i]);
    v.setUint16(o + 1, runs[i + 1]);
    o += 3;
  }

  return new Uint8Array(buf, 0, o);
}

export function deserialize(data: Uint8Array): World {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  if (v.getUint32(o) !== MAGIC) throw new Error('bad snapshot');
  o += 4;
  const tick = v.getUint32(o);
  o += 4;
  const seed = v.getInt32(o);
  o += 4;
  const rngState = v.getInt32(o);
  o += 4;
  const phase = v.getUint8(o++);
  const winner = v.getInt8(o++);
  const playerCount = v.getUint8(o++);
  const teamCount = v.getUint8(o++);
  const goldToWin = v.getUint16(o);
  o += 2;
  const mode = v.getUint8(o++);
  const killsToWin = v.getUint16(o);
  o += 2;
  const entCount = v.getUint16(o);
  o += 2;
  const dirtyHead = v.getUint16(o);
  o += 2;
  const dirtyTail = v.getUint16(o);
  o += 2;
  o = 80;

  const w = createWorld(seed, playerCount, teamCount);
  w.tick = tick;
  w.rng.s = rngState;
  w.phase = phase;
  w.winner = winner;
  w.goldToWin = goldToWin;
  w.mode = mode;
  w.killsToWin = killsToWin;
  w.entCount = entCount;
  w.dirtyHead = dirtyHead;
  w.dirtyTail = dirtyTail;

  const ri = (a: Int32Array | Uint8Array | Int8Array, bytes: 1 | 4, signed: boolean) => {
    for (let i = 0; i < a.length; i++) {
      if (bytes === 4) a[i] = v.getInt32(o);
      else a[i] = signed ? v.getInt8(o) : v.getUint8(o);
      o += bytes;
    }
  };

  ri(w.gold, 4, true);
  ri(w.kills, 4, true);
  ri(w.lorryStore, 4, true);
  ri(w.isBot, 1, false);
  ri(w.stock, 4, true);
  ri(w.digRemainder, 4, true);
  ri(w.teamFlag, 4, true);
  ri(w.playerEnt, 4, true);
  ri(w.respawn, 4, true);
  ri(w.playerTeam, 1, false);
  ri(w.playerAlive, 1, false);
  ri(w.prevBtn, 1, false);
  ri(w.prevDy, 1, true);

  const e = w.ents;
  ri(e.kind, 1, false);
  ri(e.x, 4, true);
  ri(e.y, 4, true);
  ri(e.vx, 4, true);
  ri(e.vy, 4, true);
  ri(e.team, 1, false);
  ri(e.player, 1, true);
  ri(e.item, 1, false);
  ri(e.carry, 4, true);
  ri(e.timer, 4, true);
  ri(e.aux, 4, true);
  ri(e.aux2, 4, true);
  ri(e.facing, 1, true);
  ri(e.flags, 1, false);
  ri(e.hp, 4, true);
  ri(e.breath, 4, true);

  ri(w.chunkDirty, 1, false);
  for (let i = 0; i < w.dirtyQueue.length; i++) {
    w.dirtyQueue[i] = v.getUint16(o);
    o += 2;
  }

  const runCount = v.getUint32(o);
  o += 4;
  let p = 0;
  for (let i = 0; i < runCount; i++) {
    const m = v.getUint8(o);
    const len = v.getUint16(o + 1);
    o += 3;
    for (let k = 0; k < len; k++) w.mat[p++] = m;
  }
  if (p !== GRID_W * GRID_H) throw new Error('snapshot grid size mismatch');
  return w;
}
