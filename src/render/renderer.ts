import * as Fx from "../fx/fx";
import {
  CLONK_HP,
  ELEVATOR_LEN,
  FLAG_RADIUS,
  FUSE_TICKS,
  GRID_H,
  GRID_W,
  MAX_ENTITIES,
} from "../data/config";
import { LIQUID, MAT, PALETTE } from "../data/materials";
import { EF, EK, EV, lorryLoad, type World } from "../sim/world";
import { TEAM_COLORS_RGB, buildAtlas } from "./atlas";
import { WF } from "./worker";

/** Shovel stroke: drive in, lever, pull back, lever. */
const DIG_CYCLE = [0, 1, 2, 1];
import { Camera } from "./camera";
import { createContext } from "./gl";
import { Particles } from "./particles";
import { SpriteBatch } from "./sprites";
import { PostFx } from "./post";
import { MAX_LIGHTS, TerrainRenderer, type Light } from "./terrain";

export interface FrameView {
  /** Entity id of the clonk the camera follows, or -1. */
  localEnt: number;
  /** The local player's slot, for drawing their crew's orders. */
  localPlayer: number;
  /** Client-side predicted position of the local clonk, in world pixels. */
  predictX: number;
  predictY: number;
  usePredicted: boolean;
  /** Interpolation weight between the previous and the current tick. */
  alpha: number;
  /** Desktop aim point in world pixels, and whether to draw a reticle for it. */
  aimX: number;
  aimY: number;
  showAim: boolean;
}

const GOLD_RGB = [0xf2, 0xc1, 0x4e];
const WHITE = [0xf4, 0xf0, 0xe8];
const SMOKE = [0x9a, 0x92, 0x88];
const FIRE = [0xff, 0xa8, 0x3c];
const EMBER = [0xff, 0xe4, 0x8a];
const STEAM = [0xe8, 0xec, 0xf0];
const ACID_FUME = [0xb6, 0xe8, 0x6a];
const BLOOD = [0xc8, 0x3c, 0x34];

/** Walk cycle order, so the legs come back to neutral between strides. */

export class Renderer {
  readonly camera = new Camera();
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private terrain: TerrainRenderer;
  private batch: SpriteBatch;
  private post: PostFx;
  private particles = new Particles();
  private prevX = new Float32Array(MAX_ENTITIES);
  private prevY = new Float32Array(MAX_ENTITIES);
  private hasPrev = new Uint8Array(MAX_ENTITIES);
  private surface = new Int32Array(GRID_W);
  private lights: Light[] = [];
  /** Fades out after a blast, so the flash lingers for a moment. */
  private flash = 0;
  private flashX = 0;
  private flashY = 0;
  private time = 0;
  private shake = 0;
  /** Frame time in ms, averaged, for the debug overlay. */
  frameMs = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = createContext(canvas);
    this.terrain = new TerrainRenderer(this.gl);
    this.batch = new SpriteBatch(this.gl, buildAtlas());
    this.post = new PostFx(this.gl);
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  reset(w: World, surface: Int32Array, focusX: number, focusY: number): void {
    this.terrain.reset(w, surface);
    this.surface.set(surface);
    this.hasPrev.fill(0);
    this.shake = 0;
    this.camera.snapTo(focusX, focusY);
  }

  /** Called immediately before each simulation tick, for interpolation. */
  capturePrev(w: World): void {
    const e = w.ents;
    for (let i = 0; i < w.entCount; i++) {
      if (e.kind[i] === EK.NONE) {
        this.hasPrev[i] = 0;
        continue;
      }
      this.prevX[i] = Fx.floor(e.x[i]) + Fx.frac(e.x[i]) / Fx.ONE;
      this.prevY[i] = Fx.floor(e.y[i]) + Fx.frac(e.y[i]) / Fx.ONE;
      this.hasPrev[i] = 1;
    }
  }

  consumeEvents(w: World): void {
    const ev = w.events;
    for (let i = 0; i < ev.length; i += 5) {
      const type = ev[i];
      const x = ev[i + 1];
      const y = ev[i + 2];
      const a = ev[i + 3];

      if (type === EV.DIG) {
        // Dust takes the colour of whatever was dug, so chopping a tree throws
        // splinters and mining coal throws black grit.
        const rgb = PALETTE[a] ?? PALETTE[MAT.EARTH];
        this.particles.burst(x, y, 8, 38, 0.5, 2.5, rgb, 130);
        if (a === MAT.WOOD)
          this.particles.burst(x, y, 4, 26, 0.6, 2, PALETTE[MAT.LEAVES], 90);
      } else if (type === EV.DEPOSIT) {
        this.particles.burst(x, y - 12, 16, 48, 1.0, 2.5, GOLD_RGB, -22);
      } else if (type === EV.BUILD) {
        this.particles.burst(x, y, 14, 42, 0.7, 3, WHITE, 40);
      } else if (type === EV.SPLASH) {
        this.particles.burst(x, y, 14, 54, 0.6, 2.5, PALETTE[MAT.WATER], 160);
      } else if (type === EV.PICKUP || type === EV.DROP) {
        this.particles.burst(x, y, 5, 22, 0.35, 2, WHITE, 60);
      } else if (type === EV.DENY) {
        this.particles.burst(x, y, 10, 30, 0.5, 3, BLOOD, 0);
      } else if (type === EV.EXPLODE) {
        this.explosion(x, y, a);
      } else if (type === EV.HURT) {
        this.particles.burst(
          x,
          y,
          Math.min(10, 2 + (a >> 3)),
          30,
          0.4,
          2,
          BLOOD,
          90,
        );
      } else if (type === EV.DIE) {
        this.particles.burst(x, y, 22, 60, 0.9, 3, BLOOD, 120);
        this.particles.burst(x, y, 8, 30, 1.2, 7, SMOKE, -8, 1, 1.4);
      } else if (type === EV.SPAWN) {
        this.particles.burst(x, y, 16, 40, 0.7, 3, WHITE, -30);
      } else if (type === EV.FUSE) {
        this.particles.burst(x, y, 4, 18, 0.3, 2, EMBER, 30);
      } else if (type === EV.LOAD) {
        this.particles.burst(x, y - 6, 5, 20, 0.35, 2, WHITE, 70);
      } else if (type === EV.UNLOAD) {
        this.particles.burst(x, y - 10, 8, 34, 0.6, 2.5, GOLD_RGB, -14);
      } else if (type === EV.HIT) {
        this.particles.burst(x, y, 10, 44, 0.4, 2.5, BLOOD, 70);
        this.particles.burst(x, y, 4, 20, 0.25, 4, WHITE, 0);
      } else if (type === EV.PLACE) {
        this.particles.burst(x, y, 12, 30, 0.6, 3, PALETTE[MAT.LOAM], 90);
      } else if (type === EV.ORDER) {
        const tc = TEAM_COLORS_RGB[a] ?? WHITE;
        for (let k = 0; k < 14; k++) {
          const ang = (k / 14) * Math.PI * 2;
          this.particles.spawn(x, y, Math.cos(ang) * 26, Math.sin(ang) * 26, 0.45, 2.2, tc, 0);
        }
      } else if (type === EV.TAKE) {
        this.particles.burst(x, y - 8, 8, 24, 0.5, 2.2, WHITE, -20);
      } else if (type === EV.STEAM) {
        this.particles.burst(x, y, 6, 24, 1.3, 8, STEAM, -20, 1, 1.4);
      } else if (type === EV.FIZZ) {
        this.particles.burst(x + (Math.random() - 0.5) * 6, y, 2, 26, 0.45, 3, ACID_FUME, -4, 1, 1.3);
      } else if (type === EV.WRECK) {
        this.particles.burst(x, y, 26, 70, 1.0, 3.5, [0x8a, 0x5f, 0x33], 150);
        this.particles.burst(x, y, 10, 26, 1.4, 9, SMOKE, -12, 1, 1.2);
      }
    }
  }

  private explosion(x: number, y: number, radius: number): void {
    this.shake = Math.min(9, this.shake + 7);
    this.flash = 1;
    this.flashX = x;
    this.flashY = y;
    // Fireball, then debris, then smoke that lingers and rises.
    this.particles.burst(x, y, 26, 90, 0.45, 12, FIRE, -10, 1, 2.2);
    this.particles.burst(x, y, 14, 40, 0.3, 16, EMBER, -6, 1, 2.6);
    this.particles.burst(x, y, 40, 150, 0.9, 3, PALETTE[MAT.EARTH], 210);
    this.particles.burst(x, y, 22, 55, 2.0, 14, SMOKE, -16, 1, 1.0);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.particles.spawn(
        x + Math.cos(a) * radius * 0.6,
        y + Math.sin(a) * radius * 0.6,
        Math.cos(a) * 70,
        Math.sin(a) * 70,
        0.6,
        10,
        FIRE,
        -20,
        1,
        2.0,
      );
    }
  }

  /**
   * Gathers the point lights for this frame, nearest first.
   *
   * The clonk's own lamp always makes the list; furnaces, burning fuses and the
   * afterglow of a blast fill the rest. A cave lit only by what you brought
   * into it is most of what makes being underground feel like Clonk.
   */
  private collectLights(w: World, focusX: number, focusY: number): void {
    const e = w.ents;
    const out = this.lights;
    out.length = 0;
    out.push({ x: focusX, y: focusY, radius: 165, intensity: 0.85, r: 1.0, g: 0.94, b: 0.78 });

    if (this.flash > 0) {
      out.push({
        x: this.flashX,
        y: this.flashY,
        radius: 150,
        intensity: 2.4 * this.flash,
        r: 1.0,
        g: 0.72,
        b: 0.34,
      });
    }

    const cx = this.camera.x + this.camera.viewW / 2;
    const cy = this.camera.y + this.camera.viewH / 2;
    const reach = this.camera.viewW * 0.8;
    this.emissiveLights(w, out);
    for (let i = 0; i < w.entCount && out.length < MAX_LIGHTS; i++) {
      const kind = e.kind[i];
      if (kind !== EK.FOUNDRY && kind !== EK.DYNAMITE) continue;
      const x = Fx.floor(e.x[i]);
      const y = Fx.floor(e.y[i]);
      if (Math.abs(x - cx) > reach || Math.abs(y - cy) > reach) continue;
      if (kind === EK.FOUNDRY) {
        const flicker = 0.82 + 0.18 * Math.sin(this.time * 6 + i);
        out.push({ x, y: y + 2, radius: 84, intensity: 0.95 * flicker, r: 1.0, g: 0.62, b: 0.24 });
      } else {
        const flicker = 0.7 + 0.3 * Math.sin(this.time * 22 + i);
        out.push({ x, y: y - 5, radius: 40, intensity: 0.8 * flicker, r: 1.0, g: 0.82, b: 0.4 });
      }
    }
  }

  /**
   * Light from glowing ground: lava pools and fires.
   *
   * The view is cut into tiles and each tile sampled sparsely for lava and
   * fire. The brightest tiles become point lights, so a lava lake lights the
   * cave around it and a burning forest throws orange onto the hillside. Fire
   * tiles also send up smoke, which is cheaper here than as a simulation
   * event per burning cell.
   */
  private emissiveLights(w: World, out: Light[]): void {
    const T = 24;
    const x0 = Math.max(0, Math.floor(this.camera.x / T) - 1);
    const y0 = Math.max(0, Math.floor(this.camera.y / T) - 1);
    const x1 = Math.min(Math.ceil(GRID_W / T), Math.ceil((this.camera.x + this.camera.viewW) / T) + 1);
    const y1 = Math.min(Math.ceil(GRID_H / T), Math.ceil((this.camera.y + this.camera.viewH) / T) + 1);
    const tiles = this.glowTiles;
    tiles.length = 0;
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        let lava = 0;
        let fire = 0;
        for (let sy = 2; sy < T; sy += 4) {
          const row = (ty * T + sy) * GRID_W;
          for (let sx = 2; sx < T; sx += 4) {
            const m = w.mat[row + tx * T + sx];
            if (m === MAT.LAVA) lava++;
            else if (m === MAT.FIRE) fire++;
          }
        }
        if (lava + fire === 0) continue;
        tiles.push({ x: tx * T + T / 2, y: ty * T + T / 2, lava, fire });
        if (fire > 0 && Math.random() < 0.08 * fire) {
          this.particles.spawn(
            tx * T + Math.random() * T,
            ty * T + Math.random() * T,
            (Math.random() - 0.5) * 8,
            -16 - Math.random() * 10,
            2.2,
            8,
            SMOKE,
            -5,
            1,
            1.1,
          );
        }
      }
    }
    tiles.sort((a, b) => b.lava + b.fire * 2 - (a.lava + a.fire * 2));
    // A handful of glows, not one per tile: summed, a dozen of them wash the
    // whole underground orange.
    const room = Math.min(MAX_LIGHTS - 4, out.length + 6);
    for (let i = 0; i < tiles.length && out.length < room; i++) {
      const t = tiles[i];
      const strength = Math.min(1, (t.lava + t.fire * 2) / 12);
      if (t.fire > t.lava) {
        const flicker = 0.75 + 0.25 * Math.sin(this.time * 17 + t.x * 0.1);
        out.push({ x: t.x, y: t.y, radius: 50 + 30 * strength, intensity: 0.7 * strength * flicker, r: 1.0, g: 0.62, b: 0.25 });
      } else {
        const pulse = 0.88 + 0.12 * Math.sin(this.time * 1.7 + t.x * 0.05);
        out.push({ x: t.x, y: t.y, radius: 46 + 30 * strength, intensity: 0.45 * strength * pulse, r: 1.0, g: 0.45, b: 0.15 });
      }
    }
  }

  private glowTiles: { x: number; y: number; lava: number; fire: number }[] = [];

  /**
   * Soft contact shadows on the ground under every entity.
   *
   * Cheap and disproportionately effective: without them, sprites look pasted
   * onto the terrain; with them they stand on it.
   */
  private drawShadows(w: World, view: FrameView): void {
    const e = w.ents;
    const rect = this.batch.atlas.sprites.puff;
    if (!rect) return;
    for (let i = 0; i < w.entCount; i++) {
      const kind = e.kind[i];
      if (kind === EK.NONE || kind === EK.ELEVATOR) continue;
      const isLocal = i === view.localEnt && view.usePredicted;
      const x = isLocal ? view.predictX : Fx.floor(e.x[i]);
      const y = isLocal ? view.predictY : Fx.floor(e.y[i]);
      const gx = Math.round(x);
      // Find the ground within a short drop; beyond that the shadow would be
      // detached from anything and is better left out.
      let gy = -1;
      const startY = Math.round(y);
      for (let d = 0; d < 26; d++) {
        const yy = startY + d;
        if (yy < 0 || yy >= GRID_H) break;
        const mm = w.mat[yy * GRID_W + gx];
        if (mm !== MAT.SKY && LIQUID[mm] === 0 && mm !== MAT.LEAVES && mm !== MAT.FIRE) {
          gy = yy;
          break;
        }
      }
      if (gy < 0) continue;
      const drop = gy - startY;
      const fade = Math.max(0, 1 - drop / 26);
      const size = kind === EK.FOUNDRY ? 30 : kind === EK.FLAG ? 16 : kind === EK.LORRY ? 18 : 10;
      this.batch.pushWorld(
        rect,
        x,
        gy - 0.5,
        size * (0.7 + 0.3 * fade),
        4 * (0.6 + 0.4 * fade),
        0,
        0,
        0,
        Math.round(120 * fade),
      );
    }
  }

  /** Mouse crosshair: four ticks around the aim point, no cursor hiding. */
  private drawReticle(x: number, y: number): void {
    const rect = this.batch.atlas.sprites.particle;
    if (!rect) return;
    const r = 4;
    const pulse = 0.8 + 0.2 * Math.sin(this.time * 7);
    for (let i = 0; i < 4; i++) {
      const dx = i === 0 ? -r : i === 1 ? r : 0;
      const dy = i === 2 ? -r : i === 3 ? r : 0;
      this.batch.pushWorld(rect, x + dx, y + dy, 1.4, 1.4, 255, 245, 210, Math.round(190 * pulse));
    }
    this.batch.pushWorld(rect, x, y, 0.8, 0.8, 255, 255, 255, 150);
  }

  private clonkFrame(w: World, id: number): number {
    const e = w.ents;
    const flags = e.flags[id];
    const tick = w.tick;
    if ((flags & EF.IN_WATER) !== 0) return (tick >> 3) & 1 ? WF.SWIM2 : WF.SWIM1;
    if ((flags & EF.DIGGING) !== 0) return WF.DIG1 + DIG_CYCLE[(tick >> 2) & 3];
    if ((flags & EF.CLIMBING) !== 0) return (tick >> 3) & 1 ? WF.CLIMB2 : WF.CLIMB1;
    if ((flags & EF.IN_LIFT) !== 0) return WF.IDLE;
    if ((flags & EF.GROUNDED) === 0) return e.vy[id] < 0 ? WF.JUMP : WF.FALL;
    if (Fx.abs(e.vx[id]) > 8192) return WF.WALK1 + (Math.floor(tick / 3) % 6);
    return (tick >> 5) & 1 ? WF.IDLE2 : WF.IDLE;
  }

  frame(w: World, view: FrameView, dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    this.resize();
    this.particles.update(dt);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 22);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.4);

    const e = w.ents;
    const lerpPos = (id: number): [number, number] => {
      const cx = Fx.floor(e.x[id]) + Fx.frac(e.x[id]) / Fx.ONE;
      const cy = Fx.floor(e.y[id]) + Fx.frac(e.y[id]) / Fx.ONE;
      if (this.hasPrev[id] === 0) return [cx, cy];
      const a = view.alpha;
      return [
        this.prevX[id] + (cx - this.prevX[id]) * a,
        this.prevY[id] + (cy - this.prevY[id]) * a,
      ];
    };

    let focusX = this.camera.x + this.camera.viewW / 2;
    let focusY = this.camera.y + this.camera.viewH / 2;
    if (view.localEnt >= 0 && e.kind[view.localEnt] === EK.CLONK) {
      if (view.usePredicted) {
        focusX = view.predictX;
        focusY = view.predictY;
      } else {
        const [lx, ly] = lerpPos(view.localEnt);
        focusX = lx;
        focusY = ly;
      }
    }
    this.camera.update(
      dt,
      focusX,
      focusY,
      this.canvas.width,
      this.canvas.height,
    );

    // Explosions kick the camera. Deterministic-irrelevant: render only.
    let sx = 0;
    let sy = 0;
    if (this.shake > 0.05) {
      sx = (Math.random() * 2 - 1) * this.shake;
      sy = (Math.random() * 2 - 1) * this.shake;
    }
    const camX = this.camera.x + sx;
    const camY = this.camera.y + sy;

    this.terrain.sync(w);
    this.collectLights(w, focusX, focusY);
    this.post.begin(this.canvas.width, this.canvas.height);
    this.terrain.draw(camX, camY, this.camera.viewW, this.camera.viewH, this.time, this.lights);

    this.batch.begin();

    // Ownership rings, under everything else.
    for (let t = 0; t < w.teamCount; t++) {
      const flag = w.teamFlag[t];
      if (flag < 0 || e.kind[flag] !== EK.FLAG) continue;
      const fx = Fx.floor(e.x[flag]);
      const fy = Fx.floor(e.y[flag]) + 10;
      const rgb = TEAM_COLORS_RGB[t];
      for (let i = 0; i < 44; i++) {
        const ang = (i / 44) * Math.PI * 2 + this.time * 0.12;
        this.batch.pushWorld(
          this.batch.atlas.sprites.particle,
          fx + Math.cos(ang) * FLAG_RADIUS,
          fy + Math.sin(ang) * FLAG_RADIUS * 0.85,
          1.6,
          1.6,
          rgb[0],
          rgb[1],
          rgb[2],
          85,
        );
      }
    }

    const wave = ((this.time * 4) | 0) & 1;

    this.drawShadows(w, view);

    // Two passes: scenery first, then clonks and live charges on top. A player
    // must never lose their own figure behind a building they just put up.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < w.entCount; i++) {
        const kind = e.kind[i];
        if (kind === EK.NONE) continue;
        const front = kind === EK.CLONK || kind === EK.DYNAMITE;
        if ((pass === 1) !== front) continue;
        const isLocal = i === view.localEnt && view.usePredicted;
        let x: number;
        let y: number;
        if (isLocal) {
          x = view.predictX;
          y = view.predictY;
        } else {
          const p = lerpPos(i);
          x = p[0];
          y = p[1];
        }

        if (kind === EK.FLAG) {
          this.batch.named(`flag${e.team[i]}_${wave}`, x, y, 1);
        } else if (kind === EK.FOUNDRY) {
          this.batch.named("foundry", x, y - 4, 1);
          // Chimney smoke while it has something to smelt.
          if ((w.tick & 7) === 0) {
            this.particles.spawn(
              x + 9,
              y - 18,
              (Math.random() - 0.5) * 6,
              -14 - Math.random() * 8,
              1.6,
              7,
              SMOKE,
              -6,
              1,
              0.8,
            );
          }
        } else if (kind === EK.ELEVATOR) {
          const top = Fx.floor(e.y[i]);
          for (let s = 0; s < ELEVATOR_LEN; s += 32) {
            this.batch.named("rail", x, top + s + 16, 1);
          }
          let platY = top + 6;
          for (let c = 0; c < w.entCount; c++) {
            if (e.kind[c] !== EK.CLONK || (e.flags[c] & EF.IN_LIFT) === 0)
              continue;
            if (Math.abs(Fx.floor(e.x[c]) - Fx.floor(e.x[i])) > 12) continue;
            platY = Fx.floor(e.y[c]) + 8;
          }
          this.batch.named("lift", x, platY, 1);
        } else if (kind === EK.LORRY) {
          const loaded = lorryLoad(w, i) > 0 ? 1 : 0;
          this.batch.named(`lorry${loaded}`, x, y - 1, e.facing[i] < 0 ? -1 : 1);
        } else if (kind === EK.ITEM) {
          this.batch.named(`item${e.item[i]}`, x, y, 1);
        } else if (kind === EK.DYNAMITE) {
          // The fuse blinks faster the closer it is to going off.
          const fuse = e.aux[i];
          const rate = fuse > FUSE_TICKS / 2 ? 6 : fuse > 20 ? 3 : 1;
          const lit = (w.tick / rate) & 1 ? 1 : 0;
          this.batch.named(`dyn${lit}`, x, y, 1);
          if ((w.tick & 3) === 0) {
            this.particles.spawn(
              x + 2,
              y - 6,
              (Math.random() - 0.5) * 8,
              -18,
              0.4,
              3,
              EMBER,
              10,
            );
          }
        } else if (kind === EK.CLONK) {
          const frame = this.clonkFrame(w, i);
          const flip = e.facing[i] < 0 ? -1 : 1;
          // Flash red when badly hurt.
          const hp = e.hp[i];
          let r = 255;
          let g = 255;
          let b = 255;
          if (hp < CLONK_HP / 3 && ((w.tick >> 2) & 1) === 0) {
            g = 150;
            b = 140;
          }
          this.batch.named(`worker${e.team[i]}_${frame}`, x, y, flip, r, g, b);
          if (e.player[i] === view.localPlayer) {
            const tc = TEAM_COLORS_RGB[e.team[i]];
            if (i === view.localEnt) {
              // The worker being steered: a chevron bobbing over the helmet.
              const bob = Math.sin(this.time * 4) * 0.8;
              this.batch.named("chevron", x, y - 12 + bob, 1, 255, 255, 255);
              this.batch.named("chevron", x, y - 12.4 + bob, 1, tc[0], tc[1], tc[2]);
            } else if (e.order[i] !== 0 && e.order[i] !== 4) {
              // Where this worker was sent.
              this.batch.named("pin", e.ordX[i] + 1.5, e.ordY[i] - 3.5, 1, tc[0], tc[1], tc[2]);
            }
          }
        }
      }
    }

    if (view.showAim) this.drawReticle(view.aimX, view.aimY);

    this.particles.draw(this.batch);
    this.batch.flush(camX, camY, this.camera.viewW, this.camera.viewH);
    this.post.end(this.canvas.width, this.canvas.height);

    const ms = performance.now() - t0;
    this.frameMs += (ms - this.frameMs) * 0.1;
  }
}
