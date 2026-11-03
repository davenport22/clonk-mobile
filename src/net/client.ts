import type { InputFrame } from '../sim/input';
import {
  MSG,
  decodeBundle,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  type Bundle,
  type ClientMsg,
  type ServerMsg,
} from './protocol';

export interface RelayHandlers {
  onControl: (msg: ServerMsg) => void;
  onBundle: (b: Bundle) => void;
  onSnapshot: (tick: number, payload: Uint8Array) => void;
  onClose: (reason: string) => void;
}

/**
 * Where to find the relay.
 *
 * In order: whatever the player typed into the settings box, then the URL baked
 * in at build time, then the dev server's companion relay, then the page's own
 * host. The build-time value matters because the game and the relay do not live
 * in the same place in production: a static host serves the PWA, and a
 * WebSocket needs a server that stays running.
 */
export function defaultRelayUrl(): string {
  const stored = localStorage.getItem('undermine.relay');
  if (stored) return stored;

  const baked = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (baked) return baked;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return `${proto}//${location.hostname}:8787`;
  }
  return `${proto}//${location.host}/relay`;
}

export class Relay {
  private ws: WebSocket | null = null;
  private h: RelayHandlers;
  readonly url: string;
  connected = false;

  constructor(url: string, handlers: RelayHandlers) {
    this.url = url;
    this.h = handlers;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('relay timeout'));
        }
      }, 8000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(`cannot reach relay at ${this.url}`));
        }
      };
      ws.onclose = () => {
        this.connected = false;
        this.h.onClose('connection closed');
      };
      ws.onmessage = (ev) => this.message(ev);
    });
  }

  private message(ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      try {
        this.h.onControl(JSON.parse(ev.data) as ServerMsg);
      } catch {
        // Ignore malformed control traffic rather than killing the round.
      }
      return;
    }
    const buf = ev.data as ArrayBuffer;
    const tag = new DataView(buf).getUint8(0);
    if (tag === MSG.BUNDLE) this.h.onBundle(decodeBundle(buf));
    else if (tag === MSG.SNAPSHOT) {
      const s = decodeSnapshot(buf);
      this.h.onSnapshot(s.tick, s.payload);
    }
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendInput(f: InputFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeInput(f));
  }

  sendSnapshot(tick: number, payload: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeSnapshot(tick, payload));
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
