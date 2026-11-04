import { GRID_H, GRID_W } from '../data/config';

/**
 * World pixels across the screen in normal play.
 *
 * Clonk draws its landscape at one world pixel per screen pixel: you see a
 * large stretch of the world and the clonks in it are small. The first version
 * of this camera showed 268 world pixels whatever the screen, which on a
 * monitor meant four screen pixels per world pixel - every material turned to
 * chunky pixel art and you saw a single hillside, which more than anything
 * else made it not look like Clonk. Desktop now sits near Clonk's own scale.
 * A phone stays closer, because a finger has to be able to aim at something,
 * but still shows far more than it used to.
 */
function baseView(cssWidth: number, touch: boolean): number {
  if (touch) return clamp(cssWidth / 2, 300, 520);
  return clamp(cssWidth / 1.25, 420, 900);
}
/** Two-finger tap tactical view (PRD 5.2), relative to the normal one. */
const TACTICAL_FACTOR = 1.7;

export class Camera {
  x = 0;
  y = 0;
  viewW = 420;
  viewH = 420;
  tactical = false;
  private readonly touch =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  private base = 420;
  /** Player zoom preference, multiplied into the view width. Desktop only:
   *  a mouse has a wheel and a monitor has room, so let people use both. */
  zoomBias = 1;
  private zoom = 420;
  private cx = GRID_W / 2;
  private cy = GRID_H / 2;

  snapTo(tx: number, ty: number): void {
    this.cx = tx;
    this.cy = ty;
    this.zoom = this.want();
  }

  private want(): number {
    return this.base * (this.tactical ? TACTICAL_FACTOR : 1) * this.zoomBias;
  }

  /** One wheel notch. Kept coarse so it lands on repeatable steps. */
  nudgeZoom(direction: number): void {
    const step = direction > 0 ? 1.18 : 1 / 1.18;
    this.zoomBias = Math.max(0.4, Math.min(1.8, this.zoomBias * step));
  }

  update(dt: number, tx: number, ty: number, canvasW: number, canvasH: number): void {
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    this.base = baseView(canvasW / dpr, this.touch);
    const wantZoom = this.want();
    const kz = 1 - Math.exp(-dt * 6);
    this.zoom += (wantZoom - this.zoom) * kz;

    // Camera leads slightly less than the clonk so digging stays centred.
    const k = 1 - Math.exp(-dt * 9);
    this.cx += (tx - this.cx) * k;
    this.cy += (ty - this.cy) * k;

    const aspect = canvasH / Math.max(1, canvasW);
    this.viewW = this.zoom;
    this.viewH = this.zoom * aspect;
    if (this.viewH > GRID_H) {
      this.viewH = GRID_H;
      this.viewW = GRID_H / Math.max(0.0001, aspect);
    }

    this.x = this.cx - this.viewW / 2;
    this.y = this.cy - this.viewH / 2;
    this.x = clamp(this.x, 0, Math.max(0, GRID_W - this.viewW));
    this.y = clamp(this.y, 0, Math.max(0, GRID_H - this.viewH));
  }

  /** Screen pixel -> world pixel. */
  toWorld(sx: number, sy: number, canvasW: number, canvasH: number): [number, number] {
    return [this.x + (sx / canvasW) * this.viewW, this.y + (sy / canvasH) * this.viewH];
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
