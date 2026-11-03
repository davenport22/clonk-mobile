import { GRID_H, GRID_W } from '../data/config';

/** World pixels visible across the long edge during normal play. */
export const VIEW_NORMAL = 268;
/** Two-finger tap tactical view (PRD 5.2). */
export const VIEW_TACTICAL = 620;

export class Camera {
  x = 0;
  y = 0;
  viewW = VIEW_NORMAL;
  viewH = VIEW_NORMAL;
  tactical = false;
  /** Player zoom preference, multiplied into the view width. Desktop only:
   *  a mouse has a wheel and a monitor has room, so let people use both. */
  zoomBias = 1;
  private zoom = VIEW_NORMAL;
  private cx = GRID_W / 2;
  private cy = GRID_H / 2;

  snapTo(tx: number, ty: number): void {
    this.cx = tx;
    this.cy = ty;
    this.zoom = (this.tactical ? VIEW_TACTICAL : VIEW_NORMAL) * this.zoomBias;
  }

  /** One wheel notch. Kept coarse so it lands on repeatable steps. */
  nudgeZoom(direction: number): void {
    const step = direction > 0 ? 1.18 : 1 / 1.18;
    this.zoomBias = Math.max(0.55, Math.min(2.6, this.zoomBias * step));
  }

  update(dt: number, tx: number, ty: number, canvasW: number, canvasH: number): void {
    const wantZoom = (this.tactical ? VIEW_TACTICAL : VIEW_NORMAL) * this.zoomBias;
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
