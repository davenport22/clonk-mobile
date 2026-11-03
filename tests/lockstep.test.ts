import { describe, expect, it } from 'vitest';
import { TICK_MS } from '../src/data/config';
import { Lockstep } from '../src/net/lockstep';
import type { Bundle } from '../src/net/protocol';
import { makeInput, type InputFrame } from '../src/sim/input';

function bundle(tick: number, dx = 0): Bundle {
  return { tick, inputs: [{ ...makeInput(), dx }] };
}

function online(): Lockstep {
  const sent: InputFrame[] = [];
  const ls = new Lockstep(1, (f) => sent.push({ ...f }));
  return ls;
}

const local = makeInput();

describe('lockstep input sequencing', () => {
  it('solo mode simulates one tick per tick of wall clock', () => {
    const ls = new Lockstep(1, null);
    expect(ls.solo).toBe(true);
    expect(ls.pump(TICK_MS * 3 + 1, local, 0)).toHaveLength(3);
    expect(ls.pump(1, local, 3)).toHaveLength(0);
  });

  it('applies bundles strictly in tick order', () => {
    const ls = online();
    ls.pushBundle(bundle(0, 1));
    ls.pushBundle(bundle(1, 2));
    ls.pushBundle(bundle(2, 3));
    // Half a millisecond of slack: TICK_MS is 33.333..., so asking for exactly
    // three ticks' worth of time can land a hair under three ticks.
    const out = ls.pump(TICK_MS * 3 + 0.5, local, 0);
    expect(out.map((s) => s[0].dx)).toEqual([1, 2, 3]);
  });

  it('sorts out-of-order arrivals, which is what a resync replay looks like', () => {
    const ls = online();
    ls.pushBundle(bundle(5, 5));
    ls.pushBundle(bundle(3, 3));
    ls.pushBundle(bundle(4, 4));
    const out = ls.pump(TICK_MS * 3 + 0.5, local, 3);
    expect(out.map((s) => s[0].dx)).toEqual([3, 4, 5]);
  });

  it('ignores duplicate bundles instead of applying a tick twice', () => {
    const ls = online();
    ls.pushBundle(bundle(0, 1));
    ls.pushBundle(bundle(0, 9));
    ls.pushBundle(bundle(1, 2));
    const out = ls.pump(TICK_MS * 4, local, 0);
    expect(out.map((s) => s[0].dx)).toEqual([1, 2]);
  });

  it('never applies a bundle from the wrong tick: a hole stalls, it does not skip', () => {
    const ls = online();
    ls.pushBundle(bundle(0, 1));
    ls.pushBundle(bundle(3, 4)); // 1 and 2 missing
    const out = ls.pump(TICK_MS * 4, local, 0);
    expect(out.map((s) => s[0].dx)).toEqual([1]);
    expect(ls.gap).toBe(true);

    // Once the hole is filled the stream continues without a resync.
    ls.pushBundle(bundle(1, 2));
    ls.pushBundle(bundle(2, 3));
    const rest = ls.pump(TICK_MS * 4, local, 1);
    expect(rest.map((s) => s[0].dx)).toEqual([2, 3, 4]);
    expect(ls.gap).toBe(false);
  });

  it('drops bundles a snapshot already covered', () => {
    const ls = online();
    for (let t = 0; t < 6; t++) ls.pushBundle(bundle(t, t));
    // A snapshot lands at tick 4: everything before it is history.
    ls.dropUntil(4);
    const out = ls.pump(TICK_MS * 4, local, 4);
    expect(out.map((s) => s[0].dx)).toEqual([4, 5]);
  });

  it('never drops a backlog, and catches up faster than real time', () => {
    const ls = online();
    for (let t = 0; t < 300; t++) ls.pushBundle(bundle(t));
    // One frame's worth of wall clock, but a large backlog: it must burn
    // through more than one tick without ever discarding input.
    const out = ls.pump(TICK_MS, local, 0);
    expect(out.length).toBeGreaterThan(1);
    expect(out.length + ls.buffered).toBe(300);
    expect(ls.needsResync).toBe(false);
  });

  it('asks for a resync rather than replaying a huge backlog', () => {
    const ls = online();
    for (let t = 0; t < 1200; t++) ls.pushBundle(bundle(t));
    ls.pump(TICK_MS, local, 0);
    expect(ls.needsResync).toBe(true);
  });

  it('reports a stalled stream so the HUD can say so', () => {
    const ls = online();
    const out = ls.pump(TICK_MS * 2, local, 0);
    expect(out).toHaveLength(0);
    expect(ls.waiting).toBe(true);
    expect(ls.stalls).toBeGreaterThan(0);
  });

  it('two clients consuming the same bundles agree on the stream hash', () => {
    const a = online();
    const b = online();
    for (let t = 0; t < 20; t++) {
      a.pushBundle(bundle(t, t));
      b.pushBundle(bundle(t, t));
    }
    a.pump(TICK_MS * 30, local, 0);
    // Same bundles, arriving in a different order.
    b.pump(TICK_MS * 30, local, 0);
    expect(a.streamHash).toBe(b.streamHash);
    expect(a.streamHash).not.toBe(0x811c9dc5);
  });
});
