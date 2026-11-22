import { objectSpecs, packObjects } from './objects';
import { WORKER_FRAMES, WCELL, drawWorker } from './worker';
/**
 * Procedurally drawn sprite atlas, in the Clonk visual idiom: a small
 * big-headed figure in a coloured jumper with a hat, timber-and-stone
 * buildings, hard outlines, shading from the upper left.
 *
 * **Everything is drawn at three times the world resolution** and rendered back
 * down at a third scale. That is the same relationship Clonk has between its
 * sprites and its material map, and it is what allows a figure eleven world
 * pixels tall to have a hat brim, a belt, boots and a face: at the zoom the game
 * plays at, one world pixel covers about four screen pixels, so a sprite drawn
 * one-to-one with the world can only ever look like a mosaic.
 *
 * All original work. The workers are drawn from a jointed rig in worker.ts. Clonk Planet's own graphics are RedWolf Design's and are
 * only distributed as freeware, not under a free licence (PRD 3.2), so they
 * cannot be shipped. OpenClonk's CC-BY sprites are a legitimate drop-in later;
 * that would touch this file and nothing else.
 */
export const TEAM_COLORS = ['#d8453f', '#3d7fd6', '#4faa4a', '#e0b433'];
export const TEAM_COLORS_RGB: readonly number[][] = [
  [0xd8, 0x45, 0x3f],
  [0x3d, 0x7f, 0xd6],
  [0x4f, 0xaa, 0x4a],
  [0xe0, 0xb4, 0x33],
];

/** Atlas pixels per world pixel. */
export const S = 3;
export const ATLAS_SIZE = 2048;
const CELL = 96;
const COLS = ATLAS_SIZE / CELL;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Atlas pixels per world pixel, when it differs from S. */
  s?: number;
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  sprites: Record<string, Rect>;
}





/** Fills a rect in atlas pixels. */
function px(
  g: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w = 1,
  h = 1,
): void {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}


function drawParticle(g: CanvasRenderingContext2D, ox: number, oy: number): Rect {
  px(g, '#ffffff', ox + 44, oy + 44, 6, 6);
  return { x: ox + 44, y: oy + 44, w: 6, h: 6 };
}

/** A soft round blob, used for smoke and explosion puffs. */
function drawPuff(g: CanvasRenderingContext2D, ox: number, oy: number): Rect {
  const cx = ox + 48;
  const cy = oy + 48;
  const r = 15;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) continue;
      const a = Math.max(0, Math.min(1, 1 - d / r));
      px(g, `rgba(255,255,255,${(a * a).toFixed(3)})`, cx + dx, cy + dy, 1, 1);
    }
  }
  return { x: cx - r, y: cy - r, w: r * 2 + 1, h: r * 2 + 1 };
}

/** Grass tufts, drawn as individual blades. */
function drawTuft(g: CanvasRenderingContext2D, ox: number, oy: number, variant: number): Rect {
  const blades = [
    [0, 9, 3, 13, 6, 7],
    [0, 7, 3, 16, 6, 10, 9, 6],
    [0, 12, 3, 7, 6, 15, 9, 9],
  ][variant];
  const green = ['#3f7a28', '#4a8c2e', '#356b22'][variant];
  const tip = ['#65b03e', '#72c04a', '#54973a'][variant];
  const baseX = ox + 40;
  const baseY = oy + 60;
  let maxH = 0;
  for (let i = 0; i < blades.length; i += 2) {
    const bx = baseX + blades[i];
    const h = blades[i + 1];
    const bend = Math.round(h / 6);
    for (let k = 0; k < h; k++) {
      const yy = baseY - k - 1;
      const xx = bx + Math.round((k / h) * bend);
      px(g, k > h - 3 ? tip : green, xx, yy, 2, 1);
    }
    if (h > maxH) maxH = h;
  }
  return { x: baseX, y: baseY - maxH - 1, w: 14, h: maxH + 2 };
}


export function buildAtlas(): Atlas {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  const sprites: Record<string, Rect> = {};
  let cell = 0;
  const next = (): [number, number] => {
    const ox = (cell % COLS) * CELL;
    const oy = Math.floor(cell / COLS) * CELL;
    cell++;
    return [ox, oy];
  };

  for (let v = 0; v < 3; v++) {
    const [ox, oy] = next();
    sprites[`tuft${v}`] = drawTuft(g, ox, oy, v);
  }
  {
    const [ox, oy] = next();
    sprites.particle = drawParticle(g, ox, oy);
  }
  {
    const [ox, oy] = next();
    sprites.puff = drawPuff(g, ox, oy);
  }

  // Workers: their own band of larger cells below the small sprites.
  g.imageSmoothingEnabled = true;
  let k = 0;
  for (let t = 0; t < 4; t++) {
    for (let f = 0; f < WORKER_FRAMES; f++) {
      const per = ATLAS_SIZE / WCELL;
      const ox = (k % per) * WCELL;
      const oy = WORKER_Y + Math.floor(k / per) * WCELL;
      sprites[`worker${t}_${f}`] = drawWorker(g, ox, oy, TEAM_COLORS[t], f);
      k++;
    }
  }

  Object.assign(sprites, packObjects(g, ATLAS_SIZE, OBJECT_Y, objectSpecs(TEAM_COLORS)));

  return { canvas, sprites };
}

/** Top of the buildings-and-objects band, below the workers. */
const OBJECT_Y = 1056;

/** Top of the worker band in the atlas. */
const WORKER_Y = 384;
