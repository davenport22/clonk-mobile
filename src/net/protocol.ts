import { INPUT_BYTES, makeInput, readInput, writeInput, type InputFrame } from '../sim/input';

/** Binary message tags. Control traffic is JSON, per-tick traffic is binary. */
export const MSG = {
  INPUT: 1,
  BUNDLE: 2,
  SNAPSHOT: 3,
};

export interface PlayerInfo {
  id: number;
  name: string;
  team: number;
}

export type ServerMsg =
  | { t: 'joined'; room: string; you: number; host: number; players: PlayerInfo[] }
  | { t: 'players'; host: number; players: PlayerInfo[] }
  | {
      t: 'start';
      seed: number;
      teamCount: number;
      players: PlayerInfo[];
      you: number;
      host: number;
      mode: number;
      /** Which slots the simulation drives itself. */
      bots: boolean[];
    }
  | { t: 'desync'; tick: number }
  | { t: 'needSnapshot' }
  | { t: 'ended'; reason: string }
  | { t: 'pong'; ts: number }
  | { t: 'error'; msg: string };

export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; room: string; name: string }
  | { t: 'start'; teamCount: number; mode: number; fillBots: boolean }
  | { t: 'ping'; ts: number }
  | { t: 'resync' }
  | { t: 'hash'; tick: number; hash: number; stream: number };

export function encodeInput(f: InputFrame): ArrayBuffer {
  const buf = new ArrayBuffer(1 + INPUT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUT);
  writeInput(f, v, 1);
  return buf;
}

export function encodeBundle(tick: number, inputs: InputFrame[]): ArrayBuffer {
  const buf = new ArrayBuffer(6 + inputs.length * INPUT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.BUNDLE);
  v.setUint32(1, tick);
  v.setUint8(5, inputs.length);
  for (let i = 0; i < inputs.length; i++) writeInput(inputs[i], v, 6 + i * INPUT_BYTES);
  return buf;
}

export interface Bundle {
  tick: number;
  inputs: InputFrame[];
}

export function decodeBundle(data: ArrayBuffer): Bundle {
  const v = new DataView(data);
  const tick = v.getUint32(1);
  const n = v.getUint8(5);
  const inputs: InputFrame[] = [];
  for (let i = 0; i < n; i++) {
    inputs.push(readInput(v, 6 + i * INPUT_BYTES, makeInput()));
  }
  return { tick, inputs };
}

export function encodeSnapshot(tick: number, payload: Uint8Array): ArrayBuffer {
  const buf = new Uint8Array(5 + payload.length);
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick);
  buf.set(payload, 5);
  return buf.buffer;
}

export function decodeSnapshot(data: ArrayBuffer): { tick: number; payload: Uint8Array } {
  const v = new DataView(data);
  return { tick: v.getUint32(1), payload: new Uint8Array(data, 5) };
}
