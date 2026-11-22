/**
 * Buildings and objects, in the same style as the workers: vector shapes with
 * gradients and a soft outline, drawn at OS atlas pixels per world pixel and
 * filtered down smoothly.
 *
 * Each object keeps the world-space size and anchor the earlier pixel sprites
 * had, so the renderer places them exactly as before; only the drawing
 * changed. Coordinates inside every draw function are world pixels relative
 * to the sprite's top-left corner.
 */
import type { Rect } from './atlas';

/** Atlas pixels per world pixel for objects. */
export const OS = 6;

const OUTLINE = 'rgba(20,16,13,0.9)';

export function shadeHex(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${((c((n >> 16) & 0xff) << 16) | (c((n >> 8) & 0xff) << 8) | c(n & 0xff)).toString(16).padStart(6, '0')}`;
}

function lin(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: Array<[number, string]>): CanvasGradient {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c] of stops) gr.addColorStop(t, c);
  return gr;
}

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/** Deterministic pseudo-random for drawing detail (stone sizes, grain). */
function hrand(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// --- the objects ------------------------------------------------------------

function flag(g: CanvasRenderingContext2D, cloth: string, wave: number): void {
  // Stone plinth.
  g.fillStyle = lin(g, 0, 23, 0, 27, [[0, '#a9a8a4'], [1, '#5f5e5b']]);
  rrect(g, 2.5, 23.2, 11, 3.6, 0.8);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(3.2, 23.4, 9.6, 0.5);
  // Pole: turned timber with a brass finial.
  g.fillStyle = lin(g, 7, 0, 9, 0, [[0, '#a87c4c'], [0.4, '#c89a62'], [1, '#5e4024']]);
  g.fillRect(7.2, 2.2, 1.5, 21.2);
  g.fillStyle = lin(g, 6.8, 0.8, 9.2, 2.6, [[0, '#ffe9a0'], [1, '#a77a1a']]);
  g.beginPath();
  g.arc(7.95, 1.8, 1.05, 0, Math.PI * 2);
  g.fill();
  // Cloth: a waving sheet, shaded along its folds.
  const top = (t: number): number => 3.0 + Math.sin((t * 1.7 + wave * 0.55) * Math.PI) * 0.9 + t * 0.6;
  const bot = (t: number): number => 10.2 + Math.sin((t * 1.7 + wave * 0.55) * Math.PI) * 0.9 - t * 1.0;
  g.beginPath();
  g.moveTo(8.7, top(0));
  for (let i = 1; i <= 20; i++) g.lineTo(8.7 + (i / 20) * 10.3, top(i / 20));
  for (let i = 20; i >= 0; i--) g.lineTo(8.7 + (i / 20) * 10.3, bot(i / 20));
  g.closePath();
  const gr = g.createLinearGradient(8.7, 0, 19, 0);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const fold = 0.82 + 0.26 * Math.cos((t * 1.7 + wave * 0.55) * Math.PI * 2);
    gr.addColorStop(t, shadeHex(cloth, fold));
  }
  g.fillStyle = gr;
  g.fill();
  // An emblem: a crossed pick and shovel in pale stitching.
  g.strokeStyle = 'rgba(255,248,230,0.75)';
  g.lineWidth = 0.4;
  g.beginPath();
  g.moveTo(11.5, 4.8);
  g.lineTo(15.2, 8.6);
  g.moveTo(15.2, 4.8);
  g.lineTo(11.5, 8.6);
  g.stroke();
}

function foundry(g: CanvasRenderingContext2D): void {
  const X = 1;
  const W = 26;
  // Brick chimney with a soot-stained top.
  g.fillStyle = lin(g, 19.5, 0, 24.5, 0, [[0, '#9a4a36'], [0.5, '#b65c44'], [1, '#6c3426']]);
  g.fillRect(19.6, 0.8, 4.8, 9);
  g.strokeStyle = 'rgba(60,28,20,0.6)';
  g.lineWidth = 0.15;
  for (let r = 0; r < 9; r++) {
    g.beginPath();
    g.moveTo(19.6, 1.6 + r);
    g.lineTo(24.4, 1.6 + r);
    g.stroke();
    for (let c = 0; c < 3; c++) {
      const bx = 19.6 + c * 1.6 + (r % 2) * 0.8;
      g.beginPath();
      g.moveTo(bx, 0.6 + r);
      g.lineTo(bx, 1.6 + r);
      g.stroke();
    }
  }
  g.fillStyle = '#2b2522';
  g.fillRect(19.3, 0.5, 5.4, 0.9);
  // Walls: vertical planks over a timber frame.
  g.fillStyle = lin(g, 0, 8.6, 0, 18, [[0, '#b0844e'], [1, '#6f4b2a']]);
  g.fillRect(X, 8.6, W, 9.6);
  for (let i = 0; i < 18; i++) {
    const x = X + i * (W / 18);
    g.fillStyle = `rgba(0,0,0,${0.06 + hrand(i) * 0.1})`;
    g.fillRect(x, 8.6, 0.12, 9.6);
    g.fillStyle = `rgba(255,230,190,${hrand(i + 50) * 0.08})`;
    g.fillRect(x + 0.3, 8.6, 0.7, 9.6);
  }
  g.fillStyle = '#4e3520';
  for (const x of [X, X + 8.5, X + 17, X + W - 0.9]) g.fillRect(x, 8.6, 0.9, 9.6);
  g.fillRect(X, 13.0, W, 0.7);
  // Roof: slate, overhanging, darker at the eaves.
  g.beginPath();
  g.moveTo(X - 1.6, 9.2);
  g.lineTo(X + 4.5, 4.6);
  g.lineTo(X + W - 4.5, 4.6);
  g.lineTo(X + W + 1.6, 9.2);
  g.closePath();
  g.fillStyle = lin(g, 0, 4.6, 0, 9.2, [[0, '#6b7280'], [1, '#3a3f48']]);
  g.fill();
  g.save();
  g.clip();
  g.strokeStyle = 'rgba(20,24,30,0.45)';
  g.lineWidth = 0.14;
  for (let r = 0; r < 4; r++) {
    const y = 5.6 + r * 1.0;
    g.beginPath();
    g.moveTo(X - 1.0, y);
    g.lineTo(X + W + 1.0, y);
    g.stroke();
  }
  g.restore();
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(X + 4.5, 4.6, W - 9, 0.4);
  // Window with warm light behind it.
  g.fillStyle = '#3d2a18';
  g.fillRect(X + 18.8, 10.0, 5.2, 4.2);
  g.fillStyle = lin(g, 0, 10.4, 0, 13.8, [[0, '#ffd890'], [1, '#e08a3a']]);
  g.fillRect(X + 19.3, 10.5, 4.2, 3.2);
  g.fillStyle = '#3d2a18';
  g.fillRect(X + 21.25, 10.5, 0.3, 3.2);
  g.fillRect(X + 19.3, 11.95, 4.2, 0.3);
  // Furnace: a stone arch with a fire inside.
  g.fillStyle = lin(g, 0, 11, 0, 18, [[0, '#8f8c86'], [1, '#55534f']]);
  g.beginPath();
  g.moveTo(X + 5.3, 18.2);
  g.lineTo(X + 5.3, 13.6);
  g.arc(X + 9.9, 13.6, 4.6, Math.PI, 0);
  g.lineTo(X + 14.5, 18.2);
  g.closePath();
  g.fill();
  const fire = g.createRadialGradient(X + 9.9, 17.4, 0.3, X + 9.9, 16, 4.2);
  fire.addColorStop(0, '#fff6c8');
  fire.addColorStop(0.35, '#ffb43a');
  fire.addColorStop(0.75, '#c2410c');
  fire.addColorStop(1, '#2a140a');
  g.fillStyle = fire;
  g.beginPath();
  g.moveTo(X + 6.6, 18.2);
  g.lineTo(X + 6.6, 14.0);
  g.arc(X + 9.9, 14.0, 3.3, Math.PI, 0);
  g.lineTo(X + 13.2, 18.2);
  g.closePath();
  g.fill();
  // Stone footing.
  for (let i = 0; i < 9; i++) {
    const w = 2.6 + hrand(i + 9) * 0.9;
    const x = X - 0.8 + i * 3.1;
    g.fillStyle = lin(g, 0, 18, 0, 21, [[0, shadeHex('#9c9a94', 0.9 + hrand(i) * 0.25)], [1, '#55534f']]);
    rrect(g, x, 18.1, Math.min(w, X + W + 0.8 - x), 2.8, 0.5);
    g.fill();
  }
}

function lift(g: CanvasRenderingContext2D): void {
  // Steel hangers up to the cable.
  g.fillStyle = lin(g, 0, 0, 1, 0, [[0, '#c3c9d1'], [1, '#6e7682']]);
  g.fillRect(1.3, 0.6, 0.7, 4.4);
  g.fillRect(13.3, 0.6, 0.7, 4.4);
  g.strokeStyle = '#59606b';
  g.lineWidth = 0.35;
  g.beginPath();
  g.moveTo(1.6, 0.8);
  g.lineTo(7.65, 0.1);
  g.lineTo(13.6, 0.8);
  g.stroke();
  // Platform: planks on a steel frame.
  g.fillStyle = lin(g, 0, 4.6, 0, 7.4, [[0, '#c29462'], [1, '#6c4a2a']]);
  g.fillRect(0.6, 4.7, 14.1, 2.0);
  for (let i = 1; i < 6; i++) {
    g.fillStyle = 'rgba(40,24,12,0.45)';
    g.fillRect(0.6 + i * 2.35, 4.7, 0.12, 2.0);
  }
  g.fillStyle = lin(g, 0, 6.6, 0, 7.6, [[0, '#8d949e'], [1, '#4a5059']]);
  g.fillRect(0.4, 6.6, 14.5, 0.9);
}

function lorry(g: CanvasRenderingContext2D, load: number): void {
  // Load first, so the rim overlaps it.
  if (load === 1) {
    const lumps: Array<[number, number, number, string]> = [
      [4.2, 2.6, 1.6, '#2c2a28'], [7.0, 2.1, 1.8, '#8a624e'], [10.0, 2.5, 1.6, '#d8a83c'],
      [12.8, 2.3, 1.5, '#2c2a28'], [5.8, 1.6, 1.2, '#7a5634'], [11.3, 1.5, 1.1, '#9a9690'],
    ];
    for (const [x, y, r, c] of lumps) {
      const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.4, 0.1, x, y, r);
      gr.addColorStop(0, shadeHex(c, 1.5));
      gr.addColorStop(1, shadeHex(c, 0.75));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y + 0.6, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Tub: a tapered steel box with ribs and rivets.
  g.beginPath();
  g.moveTo(1.2, 2.9);
  g.lineTo(16.8, 2.9);
  g.lineTo(15.6, 9.4);
  g.lineTo(2.4, 9.4);
  g.closePath();
  g.fillStyle = lin(g, 0, 2.9, 0, 9.4, [[0, '#9aa1aa'], [0.5, '#6f7680'], [1, '#41464e']]);
  g.fill();
  g.fillStyle = lin(g, 0, 2.4, 0, 3.6, [[0, '#d2d7dd'], [1, '#7b828c']]);
  g.fillRect(0.8, 2.4, 16.4, 1.1);
  for (let i = 0; i < 4; i++) {
    const x = 3.6 + i * 3.6;
    g.fillStyle = 'rgba(30,32,36,0.35)';
    g.fillRect(x, 3.5, 0.5, 5.9);
    g.fillStyle = '#c9ced5';
    g.beginPath();
    g.arc(x + 0.25, 4.3, 0.22, 0, Math.PI * 2);
    g.arc(x + 0.25, 8.4, 0.22, 0, Math.PI * 2);
    g.fill();
  }
  // Rust streaks.
  g.fillStyle = 'rgba(140,70,30,0.25)';
  g.fillRect(5.2, 5.0, 0.5, 3.8);
  g.fillRect(12.4, 6.2, 0.4, 2.8);
  // Wheels: spoked iron.
  for (const wx of [4.8, 13.2]) {
    const gr = g.createRadialGradient(wx - 0.6, 10.6, 0.2, wx, 11.3, 2.1);
    gr.addColorStop(0, '#80858d');
    gr.addColorStop(1, '#2c2f34');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(wx, 11.3, 2.0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#a6abb2';
    g.lineWidth = 0.22;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI;
      g.beginPath();
      g.moveTo(wx - Math.cos(a) * 1.5, 11.3 - Math.sin(a) * 1.5);
      g.lineTo(wx + Math.cos(a) * 1.5, 11.3 + Math.sin(a) * 1.5);
      g.stroke();
    }
    g.fillStyle = '#c9ced5';
    g.beginPath();
    g.arc(wx, 11.3, 0.45, 0, Math.PI * 2);
    g.fill();
  }
}

function rail(g: CanvasRenderingContext2D, len: number): void {
  // Two steel cables.
  g.fillStyle = 'rgba(150,156,166,0.85)';
  g.fillRect(0.0, 0, 0.3, len);
  g.fillStyle = 'rgba(70,74,82,0.85)';
  g.fillRect(0.38, 0, 0.3, len);
}

function dynamite(g: CanvasRenderingContext2D, lit: number): void {
  // Stick: a waxed red paper tube with a printed band.
  g.fillStyle = lin(g, 1.3, 0, 5.7, 0, [[0, '#7a1712'], [0.35, '#e0473a'], [0.6, '#c83226'], [1, '#5c100c']]);
  rrect(g, 1.3, 5.4, 4.4, 7.6, 1.2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.28)';
  g.fillRect(2.5, 5.9, 0.5, 6.6);
  g.fillStyle = '#eadfc8';
  g.fillRect(1.3, 7.8, 4.4, 1.6);
  g.fillStyle = '#7a1712';
  g.fillRect(2.0, 8.4, 3.0, 0.35);
  // Fuse: a twisted cord.
  g.strokeStyle = '#6b5233';
  g.lineWidth = 0.45;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(3.5, 5.4);
  g.quadraticCurveTo(3.8, 3.4, 4.9, 2.6);
  g.stroke();
  if (lit === 1) {
    const sp = g.createRadialGradient(5.1, 2.3, 0.05, 5.1, 2.3, 1.6);
    sp.addColorStop(0, 'rgba(255,255,235,1)');
    sp.addColorStop(0.3, 'rgba(255,210,90,0.95)');
    sp.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = sp;
    g.beginPath();
    g.arc(5.1, 2.3, 1.6, 0, Math.PI * 2);
    g.fill();
  }
}

/** Carryable chunks: faceted nuggets per material, and a log for wood. */
function chunk(g: CanvasRenderingContext2D, kind: number): void {
  if (kind === 4) {
    // A log: bark along it, end grain rings on its face.
    g.fillStyle = lin(g, 0, 0.8, 0, 5.2, [[0, '#9b6b3e'], [0.5, '#7a5230'], [1, '#4d321c']]);
    rrect(g, 0.6, 0.8, 7.0, 4.4, 1.6);
    g.fill();
    g.strokeStyle = 'rgba(40,24,12,0.45)';
    g.lineWidth = 0.15;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.moveTo(1.2, 1.6 + i);
      g.lineTo(6.6, 1.5 + i + hrand(i) * 0.3);
      g.stroke();
    }
    g.fillStyle = '#d9b27a';
    g.beginPath();
    g.ellipse(7.3, 3.0, 1.1, 2.15, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(120,80,40,0.7)';
    for (const r of [0.4, 0.8, 1.2]) {
      g.beginPath();
      g.ellipse(7.3, 3.0, r * 0.5, r, 0, 0, Math.PI * 2);
      g.stroke();
    }
    return;
  }
  const base = ['#2c2a28', '#8a624e', '#d8a83c', '#b8c0cb', '', '#9a7452'][kind];
  // An irregular polygon, facets lit from the upper left.
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const r = 2.3 + hrand(kind * 13 + i) * 0.9;
    pts.push([3.6 + Math.cos(a) * r * 1.15, 3.2 + Math.sin(a) * r * 0.9]);
  }
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const nx = (ay + by) / 2 - 3.2;
    const lightness = 0.7 + 0.5 * Math.max(0, -((ax + bx) / 2 - 3.6) * 0.25 - nx * 0.3);
    g.fillStyle = shadeHex(base, Math.min(1.45, lightness));
    g.beginPath();
    g.moveTo(3.4, 2.9);
    g.lineTo(ax, ay);
    g.lineTo(bx, by);
    g.closePath();
    g.fill();
  }
  if (kind === 2 || kind === 3) {
    g.fillStyle = 'rgba(255,255,240,0.85)';
    g.beginPath();
    g.arc(2.4, 2.0, 0.45, 0, Math.PI * 2);
    g.fill();
  }
  if (kind === 1) {
    // Ore: specks of metal in the rock.
    g.fillStyle = '#d6c7a8';
    for (let i = 0; i < 4; i++) g.fillRect(1.8 + hrand(i) * 3.4, 1.8 + hrand(i + 9) * 2.6, 0.4, 0.4);
  }
}

// --- packing into the atlas -------------------------------------------------

export interface ObjectSpec {
  name: string;
  /** World size of the sprite, matching the old pixel sprite's rect. */
  w: number;
  h: number;
  draw: (g: CanvasRenderingContext2D) => void;
  outline?: boolean;
}

export function objectSpecs(teamColors: readonly string[]): ObjectSpec[] {
  const specs: ObjectSpec[] = [];
  for (let t = 0; t < teamColors.length; t++) {
    for (let wv = 0; wv < 2; wv++) {
      specs.push({ name: `flag${t}_${wv}`, w: 20, h: 28.67, draw: (g) => flag(g, teamColors[t], wv) });
    }
  }
  specs.push({ name: 'foundry', w: 28, h: 21.33, draw: foundry });
  specs.push({ name: 'lift', w: 15.33, h: 8.67, draw: lift });
  for (let l = 0; l < 2; l++) specs.push({ name: `lorry${l}`, w: 18, h: 14.67, draw: (g) => lorry(g, l) });
  specs.push({ name: 'rail', w: 1.33, h: 32, draw: (g) => rail(g, 32), outline: false });
  for (let l = 0; l < 2; l++) specs.push({ name: `dyn${l}`, w: 7.33, h: 14, draw: (g) => dynamite(g, l) });
  for (let k = 0; k < 6; k++) {
    const wood = k === 4;
    specs.push({ name: `item${k}`, w: wood ? 8.67 : 7.33, h: wood ? 5.67 : 6, draw: (g) => chunk(g, k) });
  }
  return specs;
}

/**
 * Draws every object into the atlas band starting at y0, packed into shelves,
 * and returns their rects. Each is drawn to a scratch canvas first and
 * stamped over a darkened, slightly grown copy of its silhouette.
 */
export function packObjects(g: CanvasRenderingContext2D, atlasSize: number, y0: number, specs: ObjectSpec[]): Record<string, Rect> {
  const out: Record<string, Rect> = {};
  const pad = 4;
  let x = 0;
  let y = y0;
  let shelf = 0;
  for (const sp of specs) {
    const w = Math.ceil(sp.w * OS);
    const h = Math.ceil(sp.h * OS);
    if (x + w + pad * 2 > atlasSize) {
      x = 0;
      y += shelf + pad * 2;
      shelf = 0;
    }
    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const s = scratch.getContext('2d')!;
    s.scale(OS, OS);
    sp.draw(s);
    const ox = x + pad;
    const oy = y + pad;
    if (sp.outline !== false) {
      const sil = document.createElement('canvas');
      sil.width = w;
      sil.height = h;
      const t = sil.getContext('2d')!;
      t.drawImage(scratch, 0, 0);
      t.globalCompositeOperation = 'source-in';
      t.fillStyle = OUTLINE;
      t.fillRect(0, 0, w, h);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        g.drawImage(sil, ox + Math.round(Math.cos(a) * 2), oy + Math.round(Math.sin(a) * 2));
      }
    }
    g.drawImage(scratch, ox, oy);
    out[sp.name] = { x: ox, y: oy, w, h, s: OS };
    x += w + pad * 2;
    if (h > shelf) shelf = h;
  }
  return out;
}
