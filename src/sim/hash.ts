import type { World } from './world';

const FNV_PRIME = 0x01000193;
export const FNV_OFFSET = 0x811c9dc5;

export function hashBytes(h: number, bytes: Uint8Array): number {
  let x = h | 0;
  for (let i = 0; i < bytes.length; i++) {
    x = Math.imul(x ^ bytes[i], FNV_PRIME);
  }
  return x | 0;
}

export function hashU32(h: number, v: number): number {
  let x = h | 0;
  x = Math.imul(x ^ (v & 0xff), FNV_PRIME);
  x = Math.imul(x ^ ((v >>> 8) & 0xff), FNV_PRIME);
  x = Math.imul(x ^ ((v >>> 16) & 0xff), FNV_PRIME);
  x = Math.imul(x ^ ((v >>> 24) & 0xff), FNV_PRIME);
  return x | 0;
}

function bytesOf(a: ArrayBufferView): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

/**
 * FNV-1a over the full simulation state. Compared across clients every
 * HASH_PERIOD ticks (PRD 6.4) and every 100 ticks in the CI harness (PRD 6.3).
 */
export function stateHash(w: World): number {
  let h = FNV_OFFSET;
  h = hashU32(h, w.tick);
  h = hashU32(h, w.rng.s);
  h = hashU32(h, w.phase);
  h = hashU32(h, w.winner);
  h = hashU32(h, w.entCount);
  h = hashU32(h, w.dirtyHead);
  h = hashU32(h, w.dirtyTail);

  h = hashBytes(h, w.mat);
  // Pending material work is hashed too: identical material with a different
  // work queue is a divergence waiting to happen, and the snapshot carries the
  // queue precisely so a resync lands on the same scheduling.
  h = hashBytes(h, w.chunkDirty);
  h = hashBytes(h, bytesOf(w.dirtyQueue));

  h = hashBytes(h, bytesOf(w.gold));
  h = hashBytes(h, bytesOf(w.kills));
  h = hashBytes(h, bytesOf(w.lorryStore));
  h = hashBytes(h, w.isBot);
  h = hashU32(h, w.mode);
  h = hashU32(h, w.killsToWin);
  h = hashBytes(h, bytesOf(w.stock));
  h = hashBytes(h, bytesOf(w.digRemainder));
  h = hashBytes(h, bytesOf(w.teamFlag));
  h = hashBytes(h, bytesOf(w.playerEnt));
  h = hashBytes(h, w.playerTeam);
  h = hashBytes(h, w.playerAlive);
  h = hashBytes(h, bytesOf(w.respawn));
  h = hashBytes(h, w.prevBtn);
  h = hashBytes(h, bytesOf(w.prevDy));

  const e = w.ents;
  h = hashBytes(h, e.kind);
  h = hashBytes(h, bytesOf(e.x));
  h = hashBytes(h, bytesOf(e.y));
  h = hashBytes(h, bytesOf(e.vx));
  h = hashBytes(h, bytesOf(e.vy));
  h = hashBytes(h, e.team);
  h = hashBytes(h, bytesOf(e.player));
  h = hashBytes(h, e.item);
  h = hashBytes(h, bytesOf(e.carry));
  h = hashBytes(h, bytesOf(e.timer));
  h = hashBytes(h, bytesOf(e.aux));
  h = hashBytes(h, bytesOf(e.aux2));
  h = hashBytes(h, bytesOf(e.facing));
  h = hashBytes(h, e.flags);
  h = hashBytes(h, bytesOf(e.hp));
  h = hashBytes(h, bytesOf(e.breath));

  return h | 0;
}
