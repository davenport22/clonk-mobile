import * as Fx from '../fx/fx';
import { Sfx } from '../audio/audio';
import {
  CLONK_HP,
  GRID_H,
  GRID_W,
  HASH_PERIOD,
  MAX_BREATH,
  MODE,
  TICK_HZ,
  TICK_MS,
} from '../data/config';
import { CHUNK_KIND, CHUNK_KIND_COUNT, MAT } from '../data/materials';
import { Controls } from '../input/controls';
import type { Relay } from '../net/client';
import { Lockstep } from '../net/lockstep';
import type { Bundle, ServerMsg } from '../net/protocol';
import {
  DYNAMITE_COST,
  ELEVATOR_COST,
  FOUNDRY_COST,
  LORRY_COST,
  canAfford,
} from '../sim/build';
import { TEAM_COLORS } from '../render/atlas';
import { stateHash } from '../sim/hash';
import { startRound, tickWorld, ticksRemaining } from '../sim/sim';
import { deserialize, serialize } from '../sim/snapshot';
import { EV, type World } from '../sim/world';
import { Renderer } from '../render/renderer';
import type { GameOverlay } from '../ui/gameui';
import { predictLocal, type Predicted } from './predict';

export interface GameOpts {
  seed: number;
  you: number;
  playerCount: number;
  teamCount: number;
  goldToWin?: number;
  mode?: number;
  bots?: boolean[];
  relay: Relay | null;
  isHost: boolean;
  onExit: () => void;
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

/**
 * Recomputes a per-column ground height for the terrain shader, which uses it
 * to decide where daylight stops and cave darkness begins.
 *
 * Only ground counts. Tree canopies and trunks sit above the ground, and
 * treating them as the surface would put every tree in its own pool of
 * darkness. Only needed on round start and after a resync.
 */
function isGround(m: number): boolean {
  return m !== MAT.SKY && m !== MAT.WATER && m !== MAT.LEAVES && m !== MAT.WOOD;
}

function surfaceFrom(w: World): Int32Array {
  const out = new Int32Array(GRID_W);
  for (let x = 0; x < GRID_W; x++) {
    let y = 0;
    for (; y < GRID_H; y++) {
      if (isGround(w.mat[y * GRID_W + x])) break;
    }
    out[x] = y;
  }
  return out;
}

function denyReason(code: number): string {
  if (code === 0) return 'Not enough material — chop wood, mine coal';
  if (code === 1) return 'No room here';
  if (code === 2) return 'Needs solid ground';
  return 'Shaft is blocked';
}

export class Game {
  private world: World;
  private surface: Int32Array;
  private renderer: Renderer;
  private overlay: GameOverlay;
  private canvas: HTMLCanvasElement;
  private controls: Controls;
  private lockstep: Lockstep;
  private sfx = new Sfx();
  private opts: GameOpts;
  private raf = 0;
  private last = 0;
  private running = false;
  private rttMs = 60;
  private pingTimer = 0;
  private desyncPaused = false;
  /** Wall-clock ms when a snapshot was last requested, to avoid asking twice
   *  for the same recovery. Zero means nothing is pending. */
  private awaitingSnapshotSince = 0;
  /** Wall-clock ms since the input stream first showed a hole, or 0. */
  private gapSince = 0;
  private predicted: Predicted = { x: 0, y: 0, valid: false };
  private wakeLock: WakeLockSentinelLike | null = null;
  private firstDigDone = false;
  private hudFrame = 0;
  private resultShown = false;
  private aimWorldX = 0;
  private aimWorldY = 0;
  private showAim = false;

  constructor(canvas: HTMLCanvasElement, overlay: GameOverlay, opts: GameOpts) {
    this.opts = opts;
    this.overlay = overlay;

    const round = startRound({
      seed: opts.seed,
      playerCount: opts.playerCount,
      teamCount: opts.teamCount,
      goldToWin: opts.goldToWin,
      mode: opts.mode,
      bots: opts.bots,
    });
    this.world = round.world;
    this.surface = surfaceFrom(round.world);

    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.controls = new Controls(overlay);
    this.lockstep = new Lockstep(
      opts.playerCount,
      opts.relay ? (f) => opts.relay!.sendInput(f) : null,
    );
    this.controls.onTactical = (on) => {
      this.renderer.camera.tactical = on;
      this.overlay.hint(on ? 'Tactical view' : 'Close view', 1200);
    };
    this.controls.onZoom = (d) => this.renderer.camera.nudgeZoom(d);

    const id = this.world.playerEnt[opts.you];
    this.renderer.reset(
      this.world,
      this.surface,
      id >= 0 ? Fx.floor(this.world.ents.x[id]) : GRID_W / 2,
      id >= 0 ? Fx.floor(this.world.ents.y[id]) : GRID_H / 2,
    );

    this.sfx.unlock();
    void this.acquireWakeLock();
    this.overlay.hint(
      'Hold DIG and lean the stick where you want to dig. Gold is a few metres down.',
      6000,
    );
  }

  // --- lifecycle -----------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** Development hook: advances the loop by hand, for headless verification. */
  stepFrames(count: number, msPerFrame = 1000 / 60): void {
    for (let i = 0; i < count; i++) {
      this.last = performance.now() - msPerFrame;
      this.frame(performance.now());
    }
  }

  /** Development hook: the live input frame, so tests can drive the clonk. */
  devControls(): Controls {
    return this.controls;
  }

  /** Development hook: read-only view of simulation state for assertions. */
  probe(): Record<string, number> {
    const w = this.world;
    const id = w.playerEnt[this.opts.you];
    return {
      tick: w.tick,
      phase: w.phase,
      gold: w.gold[0],
      entCount: w.entCount,
      x: id >= 0 ? Fx.floor(w.ents.x[id]) : -1,
      y: id >= 0 ? Fx.floor(w.ents.y[id]) : -1,
      carry: id >= 0 ? w.ents.carry[id] : -1,
      frameMs: this.renderer.frameMs,
      hash: stateHash(w),
      streamHash: this.lockstep.streamHash,
      buffered: this.lockstep.buffered,
      stalls: this.lockstep.stalls,
      stale: this.lockstep.stale,
      gap: this.lockstep.gap ? 1 : 0,
    };
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.controls.destroy();
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  // --- net -----------------------------------------------------------------

  pushBundle(b: Bundle): void {
    this.lockstep.pushBundle(b);
  }

  handleControl(msg: ServerMsg): void {
    if (msg.t === 'pong') {
      this.rttMs = Math.max(8, performance.now() - msg.ts);
    } else if (msg.t === 'desync' || msg.t === 'needSnapshot') {
      if (msg.t === 'desync') {
        this.desyncPaused = true;
        // A snapshot is already on its way, so do not also ask for one.
        this.awaitingSnapshotSince = performance.now();
        this.overlay.net('Desync detected — resyncing…');
      }
      if (this.opts.isHost && this.opts.relay) {
        const snap = serialize(this.world);
        this.opts.relay.sendSnapshot(this.world.tick, snap);
        // The host rebuilds from its own snapshot too, so every peer ends up
        // with identical material *and* identical pending-chunk scheduling.
        this.applySnapshot(snap);
      }
    }
  }

  /** Replaces local state with the host's snapshot. Ugly but honest (PRD 6.4). */
  applySnapshot(payload: Uint8Array): void {
    try {
      const w = deserialize(payload);
      this.world = w;
      this.surface = surfaceFrom(w);
      const id = w.playerEnt[this.opts.you];
      this.renderer.reset(
        w,
        this.surface,
        id >= 0 ? Fx.floor(w.ents.x[id]) : GRID_W / 2,
        id >= 0 ? Fx.floor(w.ents.y[id]) : GRID_H / 2,
      );
      this.lockstep.dropUntil(w.tick);
      this.desyncPaused = false;
      this.awaitingSnapshotSince = 0;
      this.gapSince = 0;
      this.overlay.net(null);
      this.overlay.hint('Resynced', 1500);
    } catch (err) {
      this.overlay.net(`Resync failed: ${(err as Error).message}`);
    }
  }

  // --- frame ---------------------------------------------------------------

  private frame(now: number): void {
    const dtMs = Math.min(now - this.last, 250);
    this.last = now;
    const dt = dtMs / 1000;
    this.updateAim();
    const local = this.controls.read();

    if (this.opts.relay) {
      this.pingTimer += dtMs;
      if (this.pingTimer > 2000) {
        this.pingTimer = 0;
        this.opts.relay.send({ t: 'ping', ts: performance.now() });
      }
    }

    if (this.lockstep.gap) {
      if (this.gapSince === 0) this.gapSince = now;
    } else {
      this.gapSince = 0;
    }

    // A hole in the input stream is only fatal if it does not fill in: the
    // relay may be replaying the missing ticks right now.
    const stuckOnGap = this.gapSince > 0 && now - this.gapSince > 500;
    if (this.opts.relay && (this.lockstep.needsResync || stuckOnGap)) {
      const pending = this.awaitingSnapshotSince > 0 && now - this.awaitingSnapshotSince < 5000;
      if (!pending) {
        this.awaitingSnapshotSince = now;
        this.desyncPaused = true;
        this.overlay.net(stuckOnGap ? 'Lost sync — recovering…' : 'Catching up…');
        this.opts.relay.send({ t: 'resync' });
      }
    }

    if (!this.desyncPaused) {
      for (const inputs of this.lockstep.pump(dtMs, local, this.world.tick)) {
        this.renderer.capturePrev(this.world);
        tickWorld(this.world, inputs);
        this.drainEvents();
        if (this.opts.relay && this.world.tick % HASH_PERIOD === 0) {
          this.opts.relay.send({
            t: 'hash',
            tick: this.world.tick,
            hash: stateHash(this.world),
            stream: this.lockstep.streamHash,
          });
        }
      }
    }

    const localEnt = this.world.playerEnt[this.opts.you];
    if (!this.lockstep.solo && !this.desyncPaused) {
      const latencyTicks = Math.ceil(this.rttMs / TICK_MS) + this.lockstep.buffered;
      predictLocal(this.world, localEnt, local, Math.min(latencyTicks, 6), this.predicted);
    } else {
      this.predicted.valid = false;
    }

    this.renderer.frame(
      this.world,
      {
        localEnt,
        predictX: this.predicted.x,
        predictY: this.predicted.y,
        usePredicted: this.predicted.valid,
        alpha: this.lockstep.alpha,
        aimX: this.aimWorldX,
        aimY: this.aimWorldY,
        showAim: this.showAim,
      },
      dt,
    );

    this.updateHud();
  }

  /**
   * Turns the mouse cursor into the aim channel of the input frame.
   *
   * Done here rather than in the input layer because this is the only place
   * that knows both the camera and where the clonk actually is. The result goes
   * through the relay like any other input, so a desktop player's aim is as
   * deterministic as a phone player's stick.
   */
  private updateAim(): void {
    if (!this.controls.desktop || !this.controls.hasCursor) {
      this.aimWorldX = 0;
      this.aimWorldY = 0;
      this.showAim = false;
      return;
    }
    const id = this.world.playerEnt[this.opts.you];
    if (id < 0) {
      this.showAim = false;
      return;
    }
    const [wx, wy] = this.renderer.camera.toWorld(
      this.controls.cursorX,
      this.controls.cursorY,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
    const cx = this.predicted.valid ? this.predicted.x : Fx.floor(this.world.ents.x[id]);
    const cy = this.predicted.valid ? this.predicted.y : Fx.floor(this.world.ents.y[id]);
    this.controls.setAim(wx - cx, wy - cy);
    this.aimWorldX = wx;
    this.aimWorldY = wy;
    this.showAim = true;
  }

  private drainEvents(): void {
    const ev = this.world.events;
    for (let i = 0; i < ev.length; i += 5) {
      const type = ev[i];
      if (type === EV.DIG) {
        this.sfx.dig(ev[i + 3]);
        if (!this.firstDigDone) {
          this.firstDigDone = true;
          this.overlay.hint('Carry what you dig back inside your flag ring to bank it.', 4500);
        }
      } else if (type === EV.DEPOSIT) {
        this.sfx.deposit();
      } else if (type === EV.BUILD) {
        this.sfx.build();
      } else if (type === EV.SPLASH) {
        this.sfx.splash();
      } else if (type === EV.EXPLODE) {
        this.sfx.explode();
      } else if (type === EV.FUSE) {
        this.sfx.fuse();
        this.overlay.hint('Fuse lit — get clear.', 1600);
      } else if (type === EV.HIT) {
        this.sfx.clang();
      } else if (type === EV.LOAD || type === EV.UNLOAD) {
        if (type === EV.UNLOAD) this.sfx.deposit();
        else this.sfx.load();
      } else if (type === EV.PLACE) {
        this.sfx.place();
      } else if (type === EV.WRECK) {
        this.sfx.wreck();
      } else if (type === EV.HURT) {
        if (ev[i + 4] === this.world.playerTeam[this.opts.you]) this.sfx.hurt();
      } else if (type === EV.DIE) {
        this.sfx.die();
        if (this.world.playerTeam[this.opts.you] === ev[i + 3]) {
          this.overlay.hint('Your clonk died. A new one is on its way.', 2600);
        }
      } else if (type === EV.DENY) {
        this.sfx.deny();
        this.overlay.hint(denyReason(ev[i + 3]), 1800);
      }
    }
    this.renderer.consumeEvents(this.world);
  }

  private updateHud(): void {
    const w = this.world;
    if (this.lockstep.waiting) this.overlay.net('Waiting for players…');
    else if (!this.desyncPaused) this.overlay.net(null);

    this.overlay.showKeys(this.controls.desktop);

    if (++this.hudFrame % 4 === 0) {
      const team = w.playerTeam[this.opts.you];
      const id = w.playerEnt[this.opts.you];
      const carry = id >= 0 && w.ents.carry[id] >= 0 ? w.ents.item[w.ents.carry[id]] : -1;
      this.overlay.setTimer(ticksRemaining(w) / TICK_HZ);
      const melee = w.mode === MODE.MELEE;
      this.overlay.setScores(
        melee ? w.kills : w.gold,
        w.teamCount,
        melee ? w.killsToWin : w.goldToWin,
        melee,
      );
      this.overlay.setStock(w.stock, team);
      this.overlay.setVitals(
        TEAM_COLORS[team] ?? '#d8453f',
        id >= 0 ? Fx.idiv(w.ents.hp[id] * 100, CLONK_HP) : 0,
        id >= 0 ? Fx.idiv(w.ents.breath[id] * 100, MAX_BREATH) : 100,
        carry,
        id < 0,
      );
      this.overlay.setToolAvailability([
        true,
        w.stock[team * CHUNK_KIND_COUNT + CHUNK_KIND.LOAM] > 0,
        canAfford(w, team, DYNAMITE_COST),
        canAfford(w, team, FOUNDRY_COST),
        canAfford(w, team, ELEVATOR_COST),
        canAfford(w, team, LORRY_COST),
      ]);
      this.overlay.debug(
        `${this.renderer.frameMs.toFixed(1)} ms/frame  tick ${w.tick}  ` +
          (this.lockstep.solo
            ? 'solo'
            : `rtt ${Math.round(this.rttMs)} ms  buf ${this.lockstep.buffered}  stalls ${this.lockstep.stalls}`),
      );
    }

    if (w.phase === 1 && !this.resultShown) this.showResult();
  }

  private showResult(): void {
    this.resultShown = true;
    const w = this.world;
    const team = w.playerTeam[this.opts.you];
    const won = w.winner === team;
    this.sfx.over(won);
    const title = w.winner < 0 ? 'Draw' : won ? 'You win' : 'You lose';
    let rows = '';
    for (let t = 0; t < w.teamCount; t++) {
      let hauled = 0;
      for (let k = 0; k < CHUNK_KIND_COUNT; k++) hauled += w.stock[t * CHUNK_KIND_COUNT + k];
      rows +=
        `<li><span class="dot" style="background:var(--gold)"></span>` +
        `Team ${t + 1} — ${w.gold[t]} gold banked, ${hauled} chunks hauled</li>`;
    }
    const card = this.overlay.showBanner(`
      <h1>${title}</h1>
      <div class="tag">Round over after ${Math.round(w.tick / TICK_HZ)} s</div>
      <ul class="players">${rows}</ul>
      <button class="primary" id="again">Back to menu</button>
    `);
    card.querySelector('#again')!.addEventListener('click', () => {
      this.overlay.hideBanner();
      this.opts.onExit();
    });
  }

  private async acquireWakeLock(): Promise<void> {
    // iOS 18.4+ in a home-screen PWA. A screen sleeping mid-round kills the
    // session, so this matters more than it looks (PRD 6.7).
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
      };
      if (nav.wakeLock) this.wakeLock = await nav.wakeLock.request('screen');
    } catch {
      // Not fatal on platforms without it.
    }
  }
}
