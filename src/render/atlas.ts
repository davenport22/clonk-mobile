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
 * All original work. Clonk Planet's own graphics are RedWolf Design's and are
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
export const ATLAS_SIZE = 1024;
const CELL = 96;
const COLS = ATLAS_SIZE / CELL;

/** Clonk animation frames, in the order the renderer indexes them. */
export const CF = {
  IDLE: 0,
  WALK1: 1,
  WALK2: 2,
  WALK3: 3,
  WALK4: 4,
  JUMP: 5,
  DIG1: 6,
  DIG2: 7,
  CLIMB1: 8,
  CLIMB2: 9,
  SWIM1: 10,
  SWIM2: 11,
};
export const CLONK_FRAMES = 12;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  sprites: Record<string, Rect>;
}

const SKIN = '#f2d2a8';
const SKIN_SHADE = '#cfa878';
const HAIR = '#3a2415';
const OUTLINE = '#15110e';
const BOOT = '#4a3320';
const BOOT_SOLE = '#2a1d12';
const WOOD = '#8a5f33';
const WOOD_DARK = '#5a3c20';
const WOOD_LIGHT = '#a97a46';
const STONE = '#8b8b93';
const STONE_DARK = '#5a5a63';
const STONE_LIGHT = '#a8a8b0';
const METAL = '#b9c0cb';
const METAL_DARK = '#7b8290';

/**
 * Fills a rect with a vertical gradient.
 *
 * Sprites are authored at three times the world resolution, which is enough for
 * a gradient to read as volume rather than as banding. This is the difference
 * between a flat-shaded pixel figure and one that looks lit - the thing that
 * separates Clonk Rage's rendered sprites from Clonk Planet's drawn ones.
 */
function grad(
  g: CanvasRenderingContext2D,
  top: string,
  bottom: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const gr = g.createLinearGradient(x, y, x, y + h);
  gr.addColorStop(0, top);
  gr.addColorStop(1, bottom);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}

/** Fills a rect with a diagonal gradient, lit from the upper left. */
function gradD(
  g: CanvasRenderingContext2D,
  light: string,
  dark: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, light);
  gr.addColorStop(1, dark);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}

/** Soft round shading, for heads and nuggets. */
function blob(
  g: CanvasRenderingContext2D,
  light: string,
  dark: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const gr = g.createRadialGradient(x + w * 0.32, y + h * 0.28, 1, x + w * 0.5, y + h * 0.5, Math.max(w, h) * 0.75);
  gr.addColorStop(0, light);
  gr.addColorStop(1, dark);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
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

/** Fills a rect given in world pixels, scaled up by S. */
function wpx(
  g: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  g.fillStyle = color;
  g.fillRect(Math.round(x * S), Math.round(y * S), Math.round(w * S), Math.round(h * S));
}

interface Pose {
  /** Front and back leg vertical offsets, in atlas pixels. */
  legF: number;
  legB: number;
  /** Horizontal stride between the feet, atlas pixels. */
  stride: number;
  /** Arm vertical offset. */
  arm: number;
  /** Whole-body bob. */
  bob: number;
  lean: number;
}

const POSES: Record<number, Pose> = {
  [CF.IDLE]: { legF: 0, legB: 0, stride: 5, arm: 0, bob: 0, lean: 0 },
  [CF.WALK1]: { legF: -2, legB: 2, stride: 9, arm: -3, bob: 0, lean: 1 },
  [CF.WALK2]: { legF: 1, legB: 0, stride: 3, arm: 0, bob: 2, lean: 1 },
  [CF.WALK3]: { legF: 2, legB: -2, stride: 9, arm: 3, bob: 0, lean: 1 },
  [CF.WALK4]: { legF: 0, legB: 1, stride: 3, arm: 0, bob: 2, lean: 1 },
  [CF.JUMP]: { legF: -3, legB: 3, stride: 8, arm: -6, bob: -1, lean: 2 },
  [CF.DIG1]: { legF: 0, legB: 0, stride: 6, arm: 2, bob: 0, lean: 2 },
  [CF.DIG2]: { legF: 0, legB: 0, stride: 6, arm: 8, bob: 2, lean: 3 },
  [CF.CLIMB1]: { legF: 0, legB: 5, stride: 3, arm: -8, bob: 0, lean: 0 },
  [CF.CLIMB2]: { legF: 5, legB: 0, stride: 3, arm: -3, bob: 0, lean: 0 },
  [CF.SWIM1]: { legF: -2, legB: 2, stride: 8, arm: -6, bob: 2, lean: 0 },
  [CF.SWIM2]: { legF: 2, legB: -2, stride: 4, arm: 3, bob: 3, lean: 0 },
};

/**
 * The clonk: a 9 x 13 world-pixel figure drawn at 27 x 39 atlas pixels.
 *
 * Anchored so the returned rect's centre lines up with the entity centre, with
 * the feet at the bottom of the collision box.
 */
function drawClonk(
  g: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  team: number,
  frame: number,
): Rect {
  const jumper = TEAM_COLORS[team];
  const jumperDark = shade(jumper, 0.72);
  const jumperLight = shade(jumper, 1.18);
  const p = POSES[frame] ?? POSES[CF.IDLE];

  // Origin of the figure inside the cell, in atlas pixels.
  const x = ox + 33;
  const y = oy + 24 + p.bob;

  // --- legs (each 6 atlas px wide) ---
  const footY = y + 30;
  const backX = x + 2 - Math.round(p.stride / 2);
  const frontX = x + 9 + Math.round(p.stride / 2) - 5;
  for (const [lx, ly, dark] of [
    [backX, p.legB, true],
    [frontX, p.legF, false],
  ] as Array<[number, number, boolean]>) {
    const tone = dark ? jumperDark : jumper;
    // trouser
    grad(g, tone, shade(tone, 0.7), lx, y + 22, 6, 8 + ly);
    // boot
    px(g, BOOT, lx - 1, footY + ly - 3, 8, 4);
    px(g, BOOT_SOLE, lx - 1, footY + ly, 8, 2);
    px(g, OUTLINE, lx - 1, footY + ly + 2, 8, 1);
  }

  // --- torso ---
  const tx = x + Math.round(p.lean);
  gradD(g, jumperLight, jumperDark, tx + 1, y + 12, 15, 11);
  px(g, shade(jumper, 1.32), tx + 2, y + 12, 9, 2);
  px(g, jumperDark, tx + 1, y + 20, 15, 2);
  px(g, OUTLINE, tx, y + 12, 1, 11);
  px(g, OUTLINE, tx + 16, y + 12, 1, 11);
  // belt
  px(g, '#5a4630', tx + 1, y + 21, 15, 2);
  px(g, '#c8a24a', tx + 7, y + 21, 3, 2);

  // --- arms and held tools ---
  if (frame === CF.DIG1 || frame === CF.DIG2) {
    // Both hands on a shovel, swung forward and down.
    const ay = y + 14 + p.arm;
    px(g, jumper, tx + 14, ay, 5, 4);
    px(g, SKIN, tx + 18, ay + 2, 4, 4);
    // shaft
    px(g, WOOD, tx + 21, ay + 3, 10, 3);
    px(g, WOOD_DARK, tx + 21, ay + 5, 10, 1);
    // blade
    px(g, METAL, tx + 29, ay + 5, 7, 8);
    px(g, METAL_DARK, tx + 29, ay + 11, 7, 2);
    px(g, OUTLINE, tx + 29, ay + 13, 7, 1);
    px(g, '#ffffff55', tx + 30, ay + 6, 4, 2);
  } else if (frame === CF.CLIMB1 || frame === CF.CLIMB2) {
    px(g, jumper, tx + 14, y + 8 + p.arm, 4, 8);
    px(g, SKIN, tx + 15, y + 4 + p.arm, 4, 5);
    px(g, jumperDark, tx - 2, y + 14, 4, 7);
    px(g, SKIN, tx - 2, y + 20, 4, 4);
  } else if (frame === CF.SWIM1 || frame === CF.SWIM2) {
    px(g, jumper, tx + 14, y + 13 + p.arm, 7, 4);
    px(g, SKIN, tx + 20, y + 14 + p.arm, 5, 4);
    px(g, jumperDark, tx - 4, y + 15, 6, 4);
    px(g, SKIN, tx - 6, y + 16, 4, 4);
  } else {
    px(g, jumper, tx + 14, y + 13 + p.arm, 4, 7);
    px(g, SKIN, tx + 14, y + 19 + p.arm, 4, 4);
    px(g, jumperDark, tx - 1, y + 13 - p.arm, 4, 7);
    px(g, SKIN_SHADE, tx - 1, y + 19 - p.arm, 4, 4);
  }

  // --- head: broad, with a hat. The silhouette is the whole point. ---
  const hx = x + Math.round(p.lean * 1.5);
  blob(g, '#ffe3bd', SKIN_SHADE, hx + 2, y + 1, 13, 12);
  px(g, shade(SKIN_SHADE, 0.9), hx + 2, y + 11, 13, 2);
  // Rounded corners, so the head is not a box. Cleared rather than painted:
  // a transparent fill in source-over mode draws nothing at all.
  g.clearRect(hx + 2, y + 1, 2, 1);
  g.clearRect(hx + 13, y + 1, 2, 1);
  g.clearRect(hx + 2, y + 11, 1, 2);
  g.clearRect(hx + 14, y + 11, 1, 2);
  px(g, OUTLINE, hx + 1, y + 2, 1, 10);
  px(g, OUTLINE, hx + 15, y + 2, 1, 10);
  // eye and mouth, on the facing side
  px(g, OUTLINE, hx + 10, y + 5, 2, 3);
  px(g, '#ffffff', hx + 10, y + 5, 1, 1);
  px(g, SKIN_SHADE, hx + 9, y + 10, 4, 1);
  // nose
  px(g, SKIN_SHADE, hx + 14, y + 7, 2, 2);
  // hair under the hat
  px(g, HAIR, hx + 2, y + 1, 13, 3);
  // hat: crown plus a brim that overhangs to the front
  grad(g, '#e8c65a', '#a4831c', hx + 3, y - 5, 11, 6);
  px(g, '#f2d98a', hx + 4, y - 5, 7, 2);
  px(g, '#8a6f18', hx + 3, y - 1, 11, 2);
  grad(g, '#d8b435', '#8a6f18', hx, y - 1, 19, 3);
  px(g, OUTLINE, hx, y + 2, 19, 1);
  px(g, OUTLINE, hx + 3, y - 6, 11, 1);

  return { x: ox + 18, y: oy + 14, w: 48, h: 54 };
}

/** Team flag: stone base, timber pole, cloth catching the wind. */
function drawFlag(
  g: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  team: number,
  wave: number,
): Rect {
  const cloth = TEAM_COLORS[team];
  const clothDark = shade(cloth, 0.7);
  // base
  wpx(g, STONE_DARK, ox / S + 7, oy / S + 24, 12, 4);
  wpx(g, STONE, ox / S + 8, oy / S + 24, 10, 1.5);
  wpx(g, STONE_LIGHT, ox / S + 9, oy / S + 24, 4, 0.7);
  // pole
  wpx(g, WOOD_DARK, ox / S + 12, oy / S + 3, 2, 21);
  wpx(g, WOOD_LIGHT, ox / S + 12, oy / S + 3, 0.7, 21);
  // finial
  wpx(g, '#ffd76a', ox / S + 11.5, oy / S + 1.6, 3, 2);
  // cloth, with a wave and a shaded trailing edge
  for (let i = 0; i < 30; i++) {
    const t = i / 29;
    const off = Math.sin((t * 3.4 + wave * 1.6) * Math.PI) * 3.2;
    const h = 20 - t * 5;
    const cx = ox + 42 + i;
    px(g, i > 22 ? clothDark : cloth, cx, oy + 12 + off, 1, h);
    px(g, clothDark, cx, oy + 12 + off + h - 2, 1, 2);
    px(g, shade(cloth, 1.2), cx, oy + 12 + off, 1, 2);
  }
  return { x: ox + 15, y: oy + 3, w: 60, h: 86 };
}

/** The foundry: timber walls, stone footing, a furnace mouth and a chimney. */
function drawFoundry(g: CanvasRenderingContext2D, ox: number, oy: number): Rect {
  const X = ox + 3;
  const Y = oy + 12;
  const W = 78; // 26 world px
  // chimney
  px(g, STONE_DARK, X + 56, Y - 12, 15, 22);
  px(g, STONE, X + 58, Y - 12, 10, 20);
  px(g, STONE_LIGHT, X + 58, Y - 12, 4, 3);
  px(g, OUTLINE, X + 56, Y - 13, 15, 2);
  px(g, '#2a2a30', X + 59, Y - 11, 8, 3);
  // roof: overhanging, with plank lines and a lit ridge
  for (let i = 0; i < 12; i++) {
    const inset = i;
    const t = i / 11;
    const tone = shade('#5a3f2c', 1.18 - t * 0.55);
    px(g, tone, X - 3 + inset, Y + i, W + 6 - inset * 2, 1);
  }
  px(g, '#7d5a3c', X - 3, Y, W + 6, 2);
  px(g, OUTLINE, X - 4, Y - 1, W + 8, 1);
  // walls
  grad(g, WOOD_LIGHT, shade(WOOD_DARK, 1.05), X, Y + 12, W, 32);
  px(g, shade(WOOD_LIGHT, 1.12), X, Y + 12, W, 2);
  for (let i = 0; i < 5; i++) px(g, WOOD_DARK, X + 6 + i * 15, Y + 12, 2, 32);
  px(g, WOOD_DARK, X, Y + 26, W, 2);
  px(g, OUTLINE, X - 1, Y + 12, 1, 32);
  px(g, OUTLINE, X + W, Y + 12, 1, 32);
  // window with a frame
  px(g, OUTLINE, X + 56, Y + 16, 16, 13);
  px(g, '#3a4a52', X + 57, Y + 17, 14, 11);
  px(g, '#5f7a84', X + 58, Y + 18, 5, 4);
  px(g, WOOD_DARK, X + 63, Y + 16, 2, 13);
  // furnace mouth: arched, glowing from the coals up
  px(g, OUTLINE, X + 18, Y + 20, 27, 24);
  px(g, '#241a14', X + 20, Y + 22, 23, 22);
  grad(g, '#5a2a10', '#ffe08a', X + 21, Y + 26, 21, 18);
  blob(g, '#fff8dc', '#e06a1c', X + 24, Y + 32, 15, 12);
  // stone footing
  px(g, STONE_DARK, X - 2, Y + 40, W + 4, 8);
  for (let i = 0; i < 6; i++) {
    grad(g, i % 2 === 0 ? STONE_LIGHT : STONE, STONE_DARK, X - 2 + i * 14, Y + 40, 13, 4);
  }
  px(g, OUTLINE, X - 2, Y + 47, W + 4, 1);
  return { x: ox, y: oy - 2, w: 84, h: 64 };
}

/** Elevator platform: planks, iron brackets, cables going up. */
function drawLift(g: CanvasRenderingContext2D, ox: number, oy: number): Rect {
  const X = ox + 24;
  const Y = oy + 36;
  px(g, METAL_DARK, X + 2, Y - 12, 3, 14);
  px(g, METAL, X + 2, Y - 12, 1, 14);
  px(g, METAL_DARK, X + 37, Y - 12, 3, 14);
  px(g, METAL, X + 37, Y - 12, 1, 14);
  px(g, WOOD, X, Y, 42, 8);
  px(g, WOOD_LIGHT, X, Y, 42, 2);
  px(g, WOOD_DARK, X, Y + 6, 42, 2);
  px(g, OUTLINE, X, Y + 8, 42, 2);
  for (let i = 0; i < 4; i++) px(g, WOOD_DARK, X + 8 + i * 9, Y, 1, 8);
  return { x: ox + 22, y: oy + 22, w: 46, h: 26 };
}

/** The lorry: an iron tub on wheels, with a load you can see. */
function drawLorry(g: CanvasRenderingContext2D, ox: number, oy: number, load: number): Rect {
  const X = ox + 18;
  const Y = oy + 30;
  // wheels
  for (const wx of [X + 7, X + 31]) {
    px(g, OUTLINE, wx - 6, Y + 22, 12, 12);
    blob(g, '#6a6a74', '#2e2e36', wx - 5, Y + 23, 10, 10);
    px(g, '#9aa0a8', wx - 2, Y + 26, 3, 3);
  }
  // tub
  gradD(g, '#8d939d', '#4a4e57', X, Y + 4, 46, 20);
  px(g, '#aab1bb', X, Y + 4, 46, 3);
  px(g, OUTLINE, X - 2, Y + 2, 50, 3);
  px(g, OUTLINE, X - 2, Y + 24, 50, 3);
  px(g, '#3a3e46', X, Y + 20, 46, 4);
  // rivets and ribs
  for (let i = 0; i < 4; i++) {
    px(g, '#3f434b', X + 6 + i * 12, Y + 5, 2, 19);
    px(g, '#b9c0cb', X + 5 + i * 12, Y + 7, 2, 2);
  }
  // load poking over the rim
  if (load === 1) {
    px(g, '#8a5f33', X + 6, Y - 2, 11, 7);
    px(g, '#2a282f', X + 18, Y - 4, 10, 9);
    px(g, '#c99518', X + 29, Y - 1, 9, 6);
    px(g, '#ffe07a', X + 31, Y - 1, 4, 2);
    px(g, OUTLINE, X + 6, Y - 3, 11, 1);
  }
  return { x: ox + 14, y: oy + 24, w: 54, h: 44 };
}

function drawRail(g: CanvasRenderingContext2D, ox: number, oy: number): Rect {
  px(g, '#77777faa', ox + 46, oy, 2, CELL);
  px(g, '#33333aaa', ox + 48, oy, 2, CELL);
  return { x: ox + 46, y: oy, w: 4, h: CELL };
}

/** Lit dynamite: a red stick, a wound fuse, a spark. */
function drawDynamite(g: CanvasRenderingContext2D, ox: number, oy: number, lit: number): Rect {
  const X = ox + 40;
  const Y = oy + 40;
  gradD(g, '#ec7a6c', '#7d1e19', X, Y, 13, 22);
  px(g, '#f2a196', X + 2, Y, 2, 22);
  px(g, '#e8ded0', X, Y + 5, 13, 3);
  px(g, '#e8ded0', X, Y + 14, 13, 3);
  px(g, OUTLINE, X, Y + 22, 13, 2);
  px(g, OUTLINE, X, Y - 1, 13, 1);
  // fuse
  px(g, '#6b5233', X + 8, Y - 7, 2, 7);
  px(g, '#6b5233', X + 9, Y - 10, 3, 3);
  if (lit === 1) {
    px(g, '#f2903a', X + 10, Y - 15, 5, 5);
    px(g, '#ffd76a', X + 11, Y - 14, 3, 3);
    px(g, '#fff6d2', X + 12, Y - 13, 1, 1);
  } else {
    px(g, '#f2903a', X + 11, Y - 12, 2, 2);
  }
  return { x: ox + 36, y: oy + 24, w: 22, h: 42 };
}

/** Carryable chunk: a lumpy nugget with a highlight and a contact shadow. */
function drawChunk(g: CanvasRenderingContext2D, ox: number, oy: number, kind: number): Rect {
  const body = ['#2a282f', '#7d5c46', '#c99518', '#a9b2bf', '#8a5f33', '#a8763e'][kind];
  const light = ['#55525e', '#a8815f', '#ffe07a', '#e2e8f0', '#b07f47', '#d1a066'][kind];
  const X = ox + 38;
  const Y = oy + 40;
  if (kind === 4) {
    // Wood reads as a short log with end grain.
    grad(g, light, shade(body, 0.72), X, Y + 2, 22, 11);
    px(g, OUTLINE, X, Y + 13, 22, 2);
    px(g, '#6b5233', X + 18, Y + 2, 4, 11);
    px(g, '#4a3520', X + 19, Y + 5, 2, 5);
    return { x: X - 2, y: Y, w: 26, h: 17 };
  }
  blob(g, light, shade(body, 0.72), X + 2, Y + 2, 15, 12);
  px(g, shade(body, 0.6), X + 2, Y + 11, 15, 3);
  px(g, OUTLINE, X + 2, Y + 14, 15, 2);
  px(g, OUTLINE, X, Y + 4, 2, 9);
  px(g, OUTLINE, X + 17, Y + 4, 2, 9);
  if (kind === 2) px(g, '#fff3c0', X + 6, Y + 4, 3, 2);
  return { x: X - 2, y: Y, w: 22, h: 18 };
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

/** Multiplies a hex colour by a factor, for cheap shading. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 0xff) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 0xff) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 0xff) * f)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
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

  for (let t = 0; t < 4; t++) {
    for (let f = 0; f < CLONK_FRAMES; f++) {
      const [ox, oy] = next();
      sprites[`clonk${t}_${f}`] = drawClonk(g, ox, oy, t, f);
    }
  }
  for (let t = 0; t < 4; t++) {
    for (let wv = 0; wv < 2; wv++) {
      const [ox, oy] = next();
      sprites[`flag${t}_${wv}`] = drawFlag(g, ox, oy, t, wv);
    }
  }
  for (let k = 0; k < 6; k++) {
    const [ox, oy] = next();
    sprites[`item${k}`] = drawChunk(g, ox, oy, k);
  }
  for (let lit = 0; lit < 2; lit++) {
    const [ox, oy] = next();
    sprites[`dyn${lit}`] = drawDynamite(g, ox, oy, lit);
  }
  for (let v = 0; v < 3; v++) {
    const [ox, oy] = next();
    sprites[`tuft${v}`] = drawTuft(g, ox, oy, v);
  }
  {
    const [ox, oy] = next();
    sprites.foundry = drawFoundry(g, ox, oy);
  }
  for (let load = 0; load < 2; load++) {
    const [ox, oy] = next();
    sprites[`lorry${load}`] = drawLorry(g, ox, oy, load);
  }
  {
    const [ox, oy] = next();
    sprites.lift = drawLift(g, ox, oy);
  }
  {
    const [ox, oy] = next();
    sprites.rail = drawRail(g, ox, oy);
  }
  {
    const [ox, oy] = next();
    sprites.particle = drawParticle(g, ox, oy);
  }
  {
    const [ox, oy] = next();
    sprites.puff = drawPuff(g, ox, oy);
  }

  return { canvas, sprites };
}
