import type { SpriteBatch } from './sprites';

const MAX = 1100;

/** Render-only effect particles. Never read by the simulation, so floats are fine. */
export class Particles {
  private x = new Float32Array(MAX);
  private y = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private full = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private col = new Uint8Array(MAX * 3);
  private grav = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  /** 0 = hard pixel, 1 = soft puff. */
  private kind = new Uint8Array(MAX);
  private next = 0;

  spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    rgb: readonly number[],
    grav = 60,
    kind = 0,
    drag = 0,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.full[i] = life;
    this.size[i] = size;
    this.grav[i] = grav;
    this.kind[i] = kind;
    this.drag[i] = drag;
    this.col[i * 3] = rgb[0];
    this.col[i * 3 + 1] = rgb[1];
    this.col[i * 3 + 2] = rgb[2];
  }

  burst(
    x: number,
    y: number,
    count: number,
    speed: number,
    life: number,
    size: number,
    rgb: readonly number[],
    grav = 60,
    kind = 0,
    drag = 0,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.spawn(
        x,
        y,
        Math.cos(a) * s,
        Math.sin(a) * s,
        life * (0.6 + Math.random() * 0.6),
        size,
        rgb,
        grav,
        kind,
        drag,
      );
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vy[i] += this.grav[i] * dt;
      if (this.drag[i] > 0) {
        const k = 1 - this.drag[i] * dt;
        this.vx[i] *= k;
        this.vy[i] *= k;
      }
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
    }
  }

  draw(batch: SpriteBatch): void {
    const hard = batch.atlas.sprites.particle;
    const soft = batch.atlas.sprites.puff;
    if (!hard || !soft) return;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      const t = this.life[i] / this.full[i];
      const isSoft = this.kind[i] === 1;
      const rect = isSoft ? soft : hard;
      // Puffs expand as they fade; debris shrinks.
      const grow = isSoft ? 1.5 - 0.7 * t : 0.4 + 0.6 * t;
      const s = (this.size[i] * grow) / rect.w;
      batch.push(
        rect,
        this.x[i],
        this.y[i],
        s,
        s,
        this.col[i * 3],
        this.col[i * 3 + 1],
        this.col[i * 3 + 2],
        Math.max(0, Math.min(255, Math.round((isSoft ? t * 0.8 : t) * 255))),
      );
    }
  }
}
