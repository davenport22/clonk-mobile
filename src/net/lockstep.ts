import { MAX_PLAYERS, TICK_MS } from '../data/config';
import { NEUTRAL, copyInput, makeInput, type InputFrame } from '../sim/input';
import type { Bundle } from './protocol';

/**
 * Deterministic lockstep driver.
 *
 * The relay owns the tick clock and emits one input bundle per tick containing
 * every player's most recent input, filling gaps with their last known input.
 * Because that decision is made in one place, all clients consume identical
 * bundles and determinism survives packet jitter. Clients keep a small jitter
 * buffer and never simulate a tick whose bundle has not arrived.
 *
 * PRD 6.4 asked for client-side input delay; making the relay the sequencer is
 * the same trade with one fewer moving part, and the local responsiveness it
 * costs is bought back by prediction (see game/predict.ts). Documented in
 * ADR-002 in the README.
 */
/** Ticks a single frame may simulate while catching up. */
const MAX_TICKS_PER_FRAME = 40;
/** Backlog beyond which a client resyncs instead of replaying (about 30 s). */
const RESYNC_BACKLOG = 900;

export class Lockstep {
  readonly solo: boolean;
  waiting = false;
  buffered = 0;
  stalls = 0;
  ticksThisFrame = 0;
  /** Bundles dropped because a snapshot already covered them. */
  stale = 0;
  /**
   * Observed this frame: the queue's next bundle is for a later tick than the
   * world is on, so bundles were missed. Applying it anyway would silently
   * shift this client's whole input stream relative to its peers. Recomputed
   * every pump, because a hole can be filled a moment later by bundles the
   * relay is replaying, and only a gap that persists is worth a resync.
   */
  gap = false;

  /**
   * Rolling FNV-1a over every input bundle this client has consumed. When a
   * desync is reported, comparing this across peers separates "we received
   * different input" (a relay or transport problem) from "we simulated the same
   * input differently" (a determinism bug in src/sim). Without it, R3 debugging
   * starts by guessing.
   */
  streamHash = 0x811c9dc5;

  private acc = 0;
  private queue: Bundle[] = [];
  private soloInputs: InputFrame[] = [];
  private sendInput: ((f: InputFrame) => void) | null;

  constructor(playerCount: number, sendInput: ((f: InputFrame) => void) | null) {
    this.solo = sendInput === null;
    this.sendInput = sendInput;
    for (let i = 0; i < Math.max(playerCount, MAX_PLAYERS); i++) this.soloInputs.push(makeInput());
  }

  /** Fraction of the way into the current tick, for render interpolation. */
  get alpha(): number {
    const a = this.acc / TICK_MS;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  /**
   * Inserts a bundle in tick order, ignoring duplicates.
   *
   * Ordering matters because bundles do not only arrive from the live stream:
   * after a resync the relay replays the ticks the client missed, which arrive
   * after newer ones. Appending by arrival would leave a hole the client reads
   * as a permanent gap, and it would resync in a loop. Nothing is ever dropped:
   * discarding a bundle means simulating a different input sequence from every
   * peer, which is a guaranteed desync rather than a dropped frame.
   */
  pushBundle(b: Bundle): void {
    const q = this.queue;
    let i = q.length;
    while (i > 0 && q[i - 1].tick > b.tick) i--;
    if (i > 0 && q[i - 1].tick === b.tick) return;
    if (i === q.length) q.push(b);
    else q.splice(i, 0, b);
  }

  /**
   * True when replaying the backlog is no longer sensible: a locked phone or a
   * backgrounded Safari tab can leave a client a minute behind, and replaying a
   * minute of simulation in one frame is worse than resyncing.
   */
  get needsResync(): boolean {
    return this.queue.length > RESYNC_BACKLOG;
  }

  /** Discards bundles already covered by a snapshot taken at `tick`. */
  dropUntil(tick: number): void {
    while (this.queue.length > 0 && this.queue[0].tick < tick) this.queue.shift();
    this.acc = 0;
    // Every peer resets its stream hash at the same snapshot, so the diagnostic
    // stays comparable across clients afterwards.
    this.streamHash = 0x811c9dc5;
  }

  /**
   * Advances the clock and returns the input sets to simulate this frame, in
   * order. An empty array means "render, do not simulate".
   */
  pump(dtMs: number, local: InputFrame, worldTick: number): InputFrame[][] {
    this.acc += dtMs;
    this.gap = false;
    let scheduled = 0;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      scheduled++;
    }
    // After a backgrounded tab, do not try to replay minutes of simulation.
    if (scheduled > 4) scheduled = 4;

    const out: InputFrame[][] = [];

    if (this.solo) {
      for (let i = 0; i < scheduled; i++) {
        copyInput(local, this.soloInputs[0]);
        out.push(this.soloInputs);
      }
      this.ticksThisFrame = out.length;
      this.buffered = 0;
      this.waiting = false;
      return out;
    }

    for (let i = 0; i < scheduled; i++) this.sendInput?.(local);

    // Catch up when the buffer grows: a jitter spike, a slow frame or a tab
    // that missed a few paints must not leave the client permanently behind.
    // The cap keeps a single frame from blocking for too long.
    let budget = scheduled;
    if (this.queue.length > 4) budget += 2;
    if (this.queue.length > 20) budget += 8;
    if (this.queue.length > 60) budget += 30;
    if (budget > MAX_TICKS_PER_FRAME) budget = MAX_TICKS_PER_FRAME;

    let expect = worldTick;
    while (budget > 0 && this.queue.length > 0) {
      const head = this.queue[0];
      if (head.tick < expect) {
        // Already covered by a snapshot.
        this.queue.shift();
        this.stale++;
        continue;
      }
      if (head.tick > expect) {
        this.gap = true;
        break;
      }
      this.queue.shift();
      this.foldStream(head);
      out.push(head.inputs);
      expect++;
      budget--;
    }

    this.buffered = this.queue.length;
    this.waiting = scheduled > 0 && out.length === 0;
    if (this.waiting) this.stalls++;
    this.ticksThisFrame = out.length;
    return out;
  }

  private foldStream(b: Bundle): void {
    let h = this.streamHash;
    const mix = (v: number) => {
      h = Math.imul(h ^ (v & 0xff), 0x01000193);
    };
    mix(b.tick);
    mix(b.tick >>> 8);
    for (const f of b.inputs) {
      mix(f.dx);
      mix(f.dy);
      mix(f.buttons);
      mix(f.sel);
    }
    this.streamHash = h | 0;
  }

  static neutralSet(playerCount: number): InputFrame[] {
    const a: InputFrame[] = [];
    for (let i = 0; i < playerCount; i++) a.push(NEUTRAL);
    return a;
  }
}
